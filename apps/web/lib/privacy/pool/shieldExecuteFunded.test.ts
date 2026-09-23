/**
 * executeShield re-reads E's balance before calling it underfunded
 * (shield-speed proposal P0 part 3).
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * The pre-fund is confirmed on the page's connection, then the worker reads
 * E's balance at 'confirmed' through a load-balanced provider: a node a few
 * hundred milliseconds behind answers "underfunded" for a pre-fund that has
 * landed. The throw sits inside the try, so the `finally` then sweeps E to
 * `sweepTo` — on the relayed path the float — and if the pre-fund lands between
 * the check and the sweep, the funding goes back to the float while the relay
 * claim stays held (correctness skeptic, P0 (3)). So the check reads again, up
 * to 3 times 500 ms apart, before it refuses. No new party: Helius already
 * reads E, from the same IP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, type Connection } from '@solana/web3.js';

const shieldV3 = vi.fn();
vi.mock('./denominatedPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./denominatedPool')>()),
  shieldV3: (...args: unknown[]) => shieldV3(...args),
}));
vi.mock('./relayEphemeralRecovery', () => ({
  addPendingRelay: vi.fn(async () => undefined),
  markPendingRelayErrored: vi.fn(async () => undefined),
  removePendingRelay: vi.fn(async () => undefined),
}));

import { executeShield, type PreparedShield } from './shieldEphemeral';

const REQUIRED = 1_573_486_080;

function ctx(): PreparedShield {
  return {
    jobId: 'shield:test:7',
    poolConfig: {} as PreparedShield['poolConfig'],
    ephemeral: Keypair.generate(),
    requiredLamports: REQUIRED,
    valueLamports: 1_003_475_300,
    prepared: { c6ProofResult: {}, insertParams: {} } as unknown as PreparedShield['prepared'],
  };
}

/** A connection whose getBalance answers the given sequence, then 0 forever (E swept). */
function balances(seq: number[]) {
  const at: number[] = [];
  const t0 = Date.now();
  const getBalance = vi.fn(async () => {
    at.push(Date.now() - t0);
    return seq.length ? seq.shift()! : 0;
  });
  return { conn: { getBalance } as unknown as Connection, getBalance, at };
}

async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: Error }> {
  const out: { value?: T; error?: Error } = {};
  const done = p.then(
    (v) => {
      out.value = v;
    },
    (e: unknown) => {
      out.error = e as Error;
    },
  );
  await vi.advanceTimersByTimeAsync(10_000);
  await done;
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  shieldV3.mockReset();
  shieldV3.mockResolvedValue({ txSig: 'INSERT', receipt: { leafIndex: 7 } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('executeShield: underfunded is a verdict of several reads (P0 part 3)', () => {
  it('RED: a pre-fund a lagging node has not seen yet is found on the re-read, and the shield runs', async () => {
    const { conn, getBalance, at } = balances([0, REQUIRED]);
    const out = await settle(executeShield(ctx(), conn, Keypair.generate().publicKey));
    expect(out.error).toBeUndefined();
    expect(out.value).toMatchObject({ txSig: 'INSERT' });
    expect(shieldV3).toHaveBeenCalledTimes(1);
    // First read, one re-read 500 ms later, then the sweep's read in `finally`.
    expect(getBalance).toHaveBeenCalledTimes(3);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(500);
  });

  it('CONTROL: a funded E is read once and waits for nothing', async () => {
    const { conn, getBalance, at } = balances([REQUIRED]);
    const out = await settle(executeShield(ctx(), conn, Keypair.generate().publicKey));
    expect(out.error).toBeUndefined();
    expect(shieldV3).toHaveBeenCalledTimes(1);
    expect(getBalance).toHaveBeenCalledTimes(2);
    expect(at[1]! - at[0]!).toBeLessThan(500);
  });

  it('a truly underfunded E still refuses, after 1 + 3 reads, with the same words, and the sweep still runs', async () => {
    const short = REQUIRED - 1;
    const { conn, getBalance } = balances([short, short, short, short]);
    const out = await settle(executeShield(ctx(), conn, Keypair.generate().publicKey));
    expect(out.error).toBeInstanceOf(Error);
    expect(out.error!.message).toMatch(/The shield signer is underfunded/);
    expect(out.error!.message).toMatch(/retry in a moment/);
    expect(shieldV3).not.toHaveBeenCalled();
    // 4 reads before the refusal, then the `finally` sweep read.
    expect(getBalance).toHaveBeenCalledTimes(5);
  });
});
