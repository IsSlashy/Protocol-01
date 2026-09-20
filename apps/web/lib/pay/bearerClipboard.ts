/**
 * Copying bearer material, and taking it back.
 *
 * Web sweep 4, round 1, item 24 (ledger row D8, "le web ne l'efface jamais").
 *
 * Two strings in this app are money or a credential on their own: the sealed
 * note handoff (`SendForm`) and a subscription's license key (`SubscribePanel`,
 * `SubscriptionsPanel`). Both are copied with one click, and until this file
 * neither was ever taken off the clipboard again. That matters because the
 * clipboard is not a buffer any more: Windows keeps a clipboard HISTORY on
 * disk, phones sync it between devices, and any other app on the machine can
 * read it. So "copy, paste into a chat, close the tab" left the note spendable
 * by whoever reads that history — long after the page that showed it is gone.
 *
 * WHAT THIS DOES, AND THE ONE THING IT DELIBERATELY DOES NOT
 * ─────────────────────────────────────────────────────────
 * `scheduleBearerClear` puts the value back to empty after a delay, but ONLY
 * after reading the clipboard and finding our own string still there. A blind
 * overwrite would be simpler and it is what a desktop password manager does;
 * in a browser it would also delete whatever the person copied from another
 * application in the meantime, silently, with no way to get it back. So when
 * the browser refuses the read — Chrome grants `clipboard-read` on a gesture
 * and Firefox does not grant it to pages at all — this gives up and reports
 * `unreadable`, and the caller offers the button instead: `clearBearerNow`
 * runs from a click, which is the person asking for it.
 *
 * Nothing here ever throws: a clipboard that is absent, blocked or in a
 * headless context must not break a copy button.
 *
 * Tests: `__tests__/lib/bearerClipboard.test.ts` (the outcomes, including the
 * refused read), `__tests__/components/SendForm.test.tsx` and
 * `__tests__/components/SubscribePanel.test.tsx` (the two screens).
 */

/**
 * How long a bearer string may sit on the clipboard.
 *
 * 90 s is long enough to switch to another app and paste — the whole point of
 * copying — and short enough that the value is gone before the tab is.
 */
export const BEARER_CLIPBOARD_CLEAR_MS = 90_000;

export type BearerClearOutcome =
  /** Our string was still there, and is not any more. */
  | 'cleared'
  /** Something else is on the clipboard: it is not ours to erase. */
  | 'replaced'
  /** The browser would not let this page read the clipboard. Nothing was done. */
  | 'unreadable';

function clipboard(): Clipboard | null {
  try {
    return typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
  } catch {
    return null;
  }
}

/** Write `text` to the clipboard. Resolves to false when the browser refused. */
export async function copyBearer(text: string): Promise<boolean> {
  const c = clipboard();
  if (!c) return false;
  try {
    await c.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take `text` off the clipboard if it is still the thing on it.
 *
 * Never clears a value it could not confirm as ours — see the header.
 */
export async function clearBearerIfUnchanged(text: string): Promise<BearerClearOutcome> {
  const c = clipboard();
  if (!c) return 'unreadable';
  let current: string;
  try {
    current = await c.readText();
  } catch {
    return 'unreadable';
  }
  if (current !== text) return 'replaced';
  try {
    await c.writeText('');
    return 'cleared';
  } catch {
    return 'unreadable';
  }
}

/**
 * Clear the clipboard because the person asked, from their click.
 *
 * Unconditional on purpose: the click IS the confirmation, and a gesture is
 * also what makes the write permitted in every browser.
 */
export async function clearBearerNow(): Promise<boolean> {
  const c = clipboard();
  if (!c) return false;
  try {
    await c.writeText('');
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy `text`, then clear it after `delayMs` if it is still there.
 *
 * Returns a cancel function: call it when the component unmounts or copies
 * again, so a stale timer cannot erase a newer copy.
 */
export function copyBearerAndScheduleClear(
  text: string,
  onOutcome?: (outcome: BearerClearOutcome) => void,
  delayMs: number = BEARER_CLIPBOARD_CLEAR_MS,
): () => void {
  void copyBearer(text);
  const timer = setTimeout(() => {
    void clearBearerIfUnchanged(text).then((outcome) => onOutcome?.(outcome));
  }, delayMs);
  return () => clearTimeout(timer);
}
