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
