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

/**
 * Confirmation cadence (shield-speed proposal C).
 *
 * MEASURED 2026-09-22 (shield-speed MEASURE.md): every single-transaction
 * confirmation took 1845-1941 ms from send to seen. The first poll (~+230 ms)
 * was always null and the second, 1.5 s later, always confirmed, while the
 * same transaction type confirmed over a WebSocket in 537-632 ms. So the first
 * poll moves to +400 ms, polls repeat every 400 ms for the first 5 s, then every
 * 1.5 s. Unchanged: the 90 s ceiling, the history search after 20 s, the
 * 'confirmed' rule ('processed' never satisfies it), the throw on status.err.
 */
describe('pollingConfirm cadence (proposal C)', () => {
  /** Statuses that turn `confirmed` once `confirmAtMs` has elapsed since the call. */
  function connectionConfirmingAt(confirmAtMs: number, level = 'confirmed') {
    const t0 = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the Connection signature, read via mock.calls
    const getSignatureStatuses = vi.fn(async (_signatures: string[], _config?: unknown) => ({
      context: { slot: 1 },
      value: [Date.now() - t0 >= confirmAtMs ? { err: null, confirmationStatus: level } : null],
    }));
    const conn = usePollingConfirmation({ getSignatureStatuses } as unknown as Connection);
    return { conn, getSignatureStatuses };
  }

  it('RED: a transaction confirmed at +600 ms is seen by +1000 ms, in at most 3 status reads', async () => {
    vi.useFakeTimers();
    const { conn, getSignatureStatuses } = connectionConfirmingAt(600);
    let doneAt = -1;
    const t0 = Date.now();
    const p = conn.confirmTransaction(SIG, 'confirmed').then(() => {
      doneAt = Date.now() - t0;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(doneAt).toBeGreaterThanOrEqual(600);
    expect(doneAt).toBeLessThanOrEqual(1_000);
    expect(getSignatureStatuses.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('the first read waits 400 ms (the immediate read was always null)', async () => {
    vi.useFakeTimers();
    const { conn, getSignatureStatuses } = connectionConfirmingAt(0);
    const p = conn.confirmTransaction(SIG, 'confirmed');
    await vi.advanceTimersByTimeAsync(399);
    expect(getSignatureStatuses).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
  });

  it('after 5 s the cadence falls back to 1.5 s, and the ceiling stays 90 s with at most 90 reads', async () => {
    vi.useFakeTimers();
    const { conn, getSignatureStatuses } = connectionConfirmingAt(Number.POSITIVE_INFINITY);
    const t0 = Date.now();
    const at: number[] = [];
    getSignatureStatuses.mockImplementation(async () => {
      at.push(Date.now() - t0);
      return { context: { slot: 1 }, value: [null] };
    });
    const p = conn.confirmTransaction(SIG, 'confirmed').then(
      () => null,
      (e: unknown) => e as Error,
    );
    await vi.advanceTimersByTimeAsync(91_000);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/was not confirmed within 90s/);
    expect(at.length).toBeLessThanOrEqual(90);
    // Reads between 10 s and 20 s: 1.5 s apart, so at most 7.
    expect(at.filter((t) => t >= 10_000 && t < 20_000).length).toBeLessThanOrEqual(7);
    // Reads in the first 5 s: 400 ms apart.
    expect(at.filter((t) => t < 5_000).length).toBeGreaterThanOrEqual(10);
    // The history search still only starts after 20 s.
    const configs = getSignatureStatuses.mock.calls.map((c) => (c[1] as { searchTransactionHistory?: boolean })?.searchTransactionHistory);
    expect(configs.slice(0, at.filter((t) => t <= 20_000).length).every((s) => s === false)).toBe(true);
    expect(configs.at(-1)).toBe(true);
  });

  it("CONTROL: 'processed' still never satisfies a 'confirmed' request", async () => {
    vi.useFakeTimers();
    const { conn } = connectionConfirmingAt(0, 'processed');
    const p = conn.confirmTransaction(SIG, 'confirmed').then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(91_000);
    expect(await p).toBe('rejected');
  });
});
