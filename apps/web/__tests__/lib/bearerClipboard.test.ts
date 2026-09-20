/**
 * bearerClipboard — the two branches the module was written for, and which
 * nothing was testing.
 *
 * 🚨 GATE r1, RED 7a. `lib/pay/bearerClipboard.ts` cites this file in its
 * header and this file did not exist. The two screens that use it
 * (`SendForm.test.tsx`, `SubscribePanel.test.tsx`, and since the r1 repair
 * `SubscriptionsPanel.test.tsx`) drive the HAPPY path only: copy, wait, find the
 * clipboard empty. The two outcomes the module's whole design rests on were
 * covered nowhere:
 *
 *   `replaced`  — someone copied something else in the meantime. A desktop
 *                 password manager blindly overwrites; a web page must not,
 *                 because whatever the person copied from another application
 *                 would be gone with no way back. THIS IS THE BRANCH THAT
 *                 DISTINGUISHES A CORRECT IMPLEMENTATION FROM A SIMPLER WRONG
 *                 ONE, and a blind `writeText('')` passes every happy-path test.
 *
 *   `unreadable` — the browser refuses the read. Firefox never grants
 *                 `clipboard-read` to a page and Chrome grants it only on a
 *                 gesture, so this is not an edge case, it is FIREFOX ALWAYS.
 *                 The module gives up and reports it, and the caller offers the
 *                 button (`clearBearerNow`) instead, which runs from a click.
 *
 * And the rule under all of it: nothing here ever throws. A clipboard that is
 * absent, blocked or in a headless context must not break a copy button.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  BEARER_CLIPBOARD_CLEAR_MS,
  clearBearerIfUnchanged,
  clearBearerNow,
  copyBearer,
  copyBearerAndScheduleClear,
  type BearerClearOutcome,
} from '@/lib/pay/bearerClipboard';

const KEY = 'P01-000G-40R4-0M30-E209-185G-R38E-1W';

/**
 * A clipboard, with each half independently switchable between "works",
 * "refuses" and "not implemented at all".
 */
function fakeClipboard(
  opts: {
    contents?: string;
    read?: 'ok' | 'refused';
    write?: 'ok' | 'refused';
  } = {},
) {
  const state = { contents: opts.contents ?? '' };
  const writes: string[] = [];
  const clipboard = {
    readText: vi.fn(async () => {
      if (opts.read === 'refused') throw new Error('NotAllowedError: Read permission denied.');
      return state.contents;
    }),
    writeText: vi.fn(async (text: string) => {
      if (opts.write === 'refused') throw new Error('NotAllowedError: Write permission denied.');
      writes.push(text);
      state.contents = text;
    }),
  };
  vi.stubGlobal('navigator', { clipboard });
  return { state, writes, clipboard };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a value that is still ours is taken back', () => {
  it('clears it, and reports that it did', async () => {
    const c = fakeClipboard({ contents: KEY });
    await expect(clearBearerIfUnchanged(KEY)).resolves.toBe('cleared');
    expect(c.state.contents, 'the credential is still on the clipboard').toBe('');
    expect(c.writes, 'the clear wrote something other than empty').toEqual(['']);
  });
});

describe("⛔ a value that is NOT ours is not ours to erase", () => {
  it('leaves another application’s clipboard alone and reports "replaced"', async () => {
    // The whole reason this module reads before it writes. A blind overwrite is
    // what a desktop password manager does; in a browser it would silently
    // delete whatever the person copied from another application in the
    // meantime, with no way to get it back.
    const c = fakeClipboard({ contents: 'a paragraph the user copied from their email' });

    await expect(clearBearerIfUnchanged(KEY)).resolves.toBe('replaced');

    expect(c.state.contents, 'the page erased something that was not its own').toBe(
      'a paragraph the user copied from their email',
    );
    expect(c.clipboard.writeText, 'the page wrote to a clipboard it did not own').not.toHaveBeenCalled();
  });

  it('treats an EMPTY clipboard as somebody else’s, not as ours', async () => {
    // The person cleared it themselves, or another app took it. Either way the
    // value on it is not the one we put there, so there is nothing to take back.
    const c = fakeClipboard({ contents: '' });
    await expect(clearBearerIfUnchanged(KEY)).resolves.toBe('replaced');
    expect(c.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe('⛔ a clipboard this page may not read is left alone', () => {
  it('reports "unreadable" and writes nothing when the read is refused', async () => {
    // Firefox never grants `clipboard-read` to a page, and Chrome grants it
    // only on a gesture — so this is the ordinary outcome of a timer firing
    // ninety seconds after a click, not an edge case. Writing anyway would be
    // the blind overwrite the case above exists to refuse.
    const c = fakeClipboard({ contents: KEY, read: 'refused' });

    await expect(clearBearerIfUnchanged(KEY)).resolves.toBe('unreadable');

    expect(c.state.contents, 'a refused READ still led to a write').toBe(KEY);
    expect(c.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('reports "unreadable" when the read works and the WRITE is refused', async () => {
    // Read allowed, write refused: the value is confirmed ours and still there.
    // The caller must be told nothing happened, so it can offer the button.
    const c = fakeClipboard({ contents: KEY, write: 'refused' });
    await expect(clearBearerIfUnchanged(KEY)).resolves.toBe('unreadable');
    expect(c.state.contents).toBe(KEY);
  });

  it('reports "unreadable" when there is no clipboard at all', async () => {
    vi.stubGlobal('navigator', {});
    await expect(clearBearerIfUnchanged(KEY)).resolves.toBe('unreadable');
  });
});

describe('nothing here ever throws, whatever the browser does', () => {
  it('copyBearer answers false instead of throwing', async () => {
    fakeClipboard({ write: 'refused' });
    await expect(copyBearer(KEY)).resolves.toBe(false);
    vi.stubGlobal('navigator', {});
    await expect(copyBearer(KEY)).resolves.toBe(false);
  });

  it('clearBearerNow answers false instead of throwing', async () => {
    fakeClipboard({ write: 'refused' });
    await expect(clearBearerNow()).resolves.toBe(false);
    vi.stubGlobal('navigator', {});
    await expect(clearBearerNow()).resolves.toBe(false);
  });

  it('clearBearerNow is UNCONDITIONAL: the click is the confirmation', async () => {
    // Deliberately not a read-then-write. The person asked, and a gesture is
    // also what makes the write permitted in every browser — including the ones
    // that will never allow the read.
    const c = fakeClipboard({ contents: 'something else entirely', read: 'refused' });
    await expect(clearBearerNow()).resolves.toBe(true);
    expect(c.state.contents).toBe('');
    expect(c.clipboard.readText, 'the button asked for a permission it does not need').not.toHaveBeenCalled();
  });
});

describe('the scheduled clear', () => {
  it('copies now and takes it back after the delay, reporting the outcome', async () => {
    vi.useFakeTimers();
    const c = fakeClipboard();
    const outcomes: BearerClearOutcome[] = [];

    copyBearerAndScheduleClear(KEY, (o) => outcomes.push(o));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state.contents, 'the value never reached the clipboard').toBe(KEY);

    await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
    expect(c.state.contents).toBe('');
    expect(outcomes).toEqual(['cleared']);
  });

  it('reports "replaced" rather than erasing what the person copied since', async () => {
    vi.useFakeTimers();
    const c = fakeClipboard();
    const outcomes: BearerClearOutcome[] = [];

    copyBearerAndScheduleClear(KEY, (o) => outcomes.push(o));
    await vi.advanceTimersByTimeAsync(0);
    c.state.contents = 'a bank card number the user copied a minute later';

    await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
    expect(outcomes).toEqual(['replaced']);
    expect(c.state.contents, 'the page erased what the person copied since').toBe(
      'a bank card number the user copied a minute later',
    );
  });

  it('🚨 the cancel function stops a stale timer erasing a NEWER copy', async () => {
    // A screen that copies twice, or unmounts, must not let the first timer run
    // against the second value — that would take a credential off the clipboard
    // the moment after the person copied it.
    vi.useFakeTimers();
    const c = fakeClipboard();

    const cancelFirst = copyBearerAndScheduleClear(KEY);
    await vi.advanceTimersByTimeAsync(0);
    cancelFirst();

    const SECOND = 'P01-SECOND-KEY-0000-0000-0000-0000-00';
    copyBearerAndScheduleClear(SECOND);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state.contents).toBe(SECOND);

    // Half the window: the cancelled timer would have fired by the end of this
    // one if it were still armed relative to the first copy.
    await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS / 2);
    expect(c.state.contents, 'a cancelled timer erased the newer copy').toBe(SECOND);

    // And the SECOND timer still does its job.
    await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS);
    expect(c.state.contents).toBe('');
  });

  it('survives a browser that refuses the copy itself', async () => {
    vi.useFakeTimers();
    fakeClipboard({ write: 'refused' });
    const outcomes: BearerClearOutcome[] = [];
    expect(() => copyBearerAndScheduleClear(KEY, (o) => outcomes.push(o))).not.toThrow();
    await vi.advanceTimersByTimeAsync(BEARER_CLIPBOARD_CLEAR_MS + 1_000);
    // Nothing of ours ever reached the clipboard, so there is nothing to take
    // back — and the caller is told so rather than left waiting.
    expect(outcomes).toEqual(['replaced']);
  });
});
