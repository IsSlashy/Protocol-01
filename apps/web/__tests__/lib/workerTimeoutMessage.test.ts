import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'lib/privacy/workerClient.ts'), 'utf8');

/**
 * 🚨 The watchdog fires on SILENCE, and it does not stop the worker. Whatever it
 * says has to survive the case where the job was still working and its money
 * already moved.
 */
describe('what the page says when the worker goes quiet', () => {
  it('⛔ never tells a spending job to retry', () => {
    // The old sentence — "The private-payment worker timed out. Please retry." —
    // was shown for withdrawals too. A retry there fails on the nullifier the
    // FIRST attempt spent, which reads as a second failure while the note is gone.
    const spendingBranch = SRC.slice(
      SRC.indexOf('KINDS_THAT_CAN_HAVE_SPENT.has(kind)'),
      SRC.indexOf("safe to retry"),
    );
    expect(spendingBranch).not.toMatch(/Please retry/i);
    expect(spendingBranch).toMatch(/Do NOT retry/);
    expect(spendingBranch).toMatch(/may already have landed/i);
  });

  it('names every job that can already have spent', () => {

    for (const kind of ['poolShieldExecute', 'poolUnshieldExecute', 'poolSubscribeExecute']) {
      expect(SRC).toContain(`'${kind}'`);
    }
  });

  it('⛔ lists EVERY execute-shaped kind, so a new one cannot be forgotten', () => {
    // 🚨 MEASURED 2026-08-31, AND IT COST A REAL 1.013 SOL. The contribution
    // kinds were added and this set was not updated, so a timeout on one told the
    // buyer a retry was safe while their wallet had already paid the till. They
    // retried. The till took 1.013 SOL twice and the tree gained one leaf.
    //
    // The case below pinned three names by hand and could never have caught it.
    // This one derives the list from the handlers themselves: any request kind
    // whose name ends in `Execute` moves money by construction, because funding
    // happens before it.
    const handlers = readFileSync(
      join(process.cwd(), 'lib/privacy/worker/poolHandlers.ts'),
      'utf8',
    );
    const kinds = [
      ...new Set(
        [...handlers.matchAll(/kind:\s*'(pool\w*Execute)'/g)].map((m) => m[1]),
      ),
    ];
    expect(kinds.length, 'no execute-shaped kinds found — the regex went stale').toBeGreaterThan(2);
    for (const kind of kinds) {
      expect(
        SRC,
        `${kind} moves money and is NOT in KINDS_THAT_CAN_HAVE_SPENT, so a timeout on it ` +
          'would tell the user a retry is free',
      ).toContain(`'${kind}',`);
    }
  });

  it('still lets a read-only job be retried, because nothing moved', () => {
    // A scan or an export submits nothing. Hedging there would train the user to
    // ignore the warning that matters.
    expect(SRC).toMatch(/Nothing was submitted, so it is safe to retry/);
    expect(SRC).not.toContain("'poolScan',");
  });

  it('⛔ does not terminate the worker on a timeout', () => {
    // Killing it mid-upload abandons a proof buffer holding ~0.565 SOL of rent —
    // how 46 of them came to hold 20.6 SOL nobody can close. The fix is the
    // sentence, not the kill.
    const fire = SRC.slice(SRC.indexOf('const fire = () =>'), SRC.indexOf('const entry: Pending'));
    expect(fire).not.toMatch(/terminate/);
  });
});
