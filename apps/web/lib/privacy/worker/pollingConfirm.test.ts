/**
 * pollingConfirm's two refusals name no transaction (UI-1 fix round 2, ledger
 * row D14).
 *
 * The worker's confirmation wrapper confirms what a pool flow sends: the
 * deposit that creates a note, the spend of one, a subscription's opening. Its
 * error crosses to the page as a plain message, and the panels print that on
 * their error line: a signature there is one explorer lookup from the deposit
 * (its leaf and commitment) or the spend (its root and nullifier), and the
 * error line is what a screenshot or a support ticket carries. So each refusal
 * says what happened and names no transaction; the caller already holds the
 * signature it asked about.
 *
 * Run: cd apps/web && pnpm test:pool
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';

import { usePollingConfirmation } from './pollingConfirm';

/** Random base58: no 4-character run of it is in this module's own text. */
const SIG =
  '2ngvPM7UidHkNZpKnPz6Pf1eoVCZVPRocnzoPNUEpsByaKMLyTSC9gHuFfk6Df8xkbRaUrK1g7DgWcYSH1tXgZwg';

/** Every 4-character window of `id` found in `text`. */
function windowsIn(text: string, id: string): string[] {
  const found: string[] = [];
  for (let i = 0; i + 4 <= id.length; i++) if (text.includes(id.slice(i, i + 4))) found.push(id.slice(i, i + 4));
  return [...new Set(found)];
}

/** A connection whose status read always answers `status` for the signature. */
function connectionAnswering(status: unknown) {
  const getSignatureStatuses = vi.fn(async (_signatures: string[], _config?: unknown) => ({
    context: { slot: 1 },
    value: [status],
  }));
  const conn = usePollingConfirmation({ getSignatureStatuses } as unknown as Connection);
  return { conn, getSignatureStatuses };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pollingConfirm refusals name no transaction', () => {
  it('a transaction that failed on chain: says so and why, without its signature', async () => {
    const { conn, getSignatureStatuses } = connectionAnswering({
      err: { InstructionError: [0, { Custom: 6001 }] },
      confirmationStatus: 'confirmed',
    });
    const err = await conn.confirmTransaction(SIG, 'confirmed').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err, 'a failed transaction was reported as confirmed').toBeInstanceOf(Error);
    expect(windowsIn(err!.message, SIG)).toEqual([]);
    // Positive controls: the status read was about this signature, and the
    // refusal still says what failed and the program's reason.
    expect(getSignatureStatuses.mock.calls[0]![0]).toEqual([SIG]);
    expect(err!.message).toMatch(/failed on-chain/);
    expect(err!.message).toContain('6001');
  });

  it('a transaction never confirmed: says so after the ceiling, without its signature', async () => {
    vi.useFakeTimers();
    const { conn, getSignatureStatuses } = connectionAnswering(null);
    // The blockhash-strategy call shape, the other one the proof code uses.
    const pending = conn
      .confirmTransaction({ signature: SIG, blockhash: 'B', lastValidBlockHeight: 1 }, 'confirmed')
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    await vi.advanceTimersByTimeAsync(91_000);
    const err = await pending;

    expect(err, 'an unconfirmed transaction was reported as confirmed').toBeInstanceOf(Error);
    expect(windowsIn(err!.message, SIG)).toEqual([]);
    // Positive controls: it polled this signature until the ceiling.
    expect(getSignatureStatuses.mock.calls.length).toBeGreaterThan(10);
    expect(getSignatureStatuses.mock.calls[0]![0]).toEqual([SIG]);
    expect(err!.message).toMatch(/was not confirmed within 90s/);
  });
});
