/**
 * [flow-speed X4 2026-09-23] The circuit-7 withdrawal and subscription quote
 * their rent WHILE the proof runs, and quote the buffer once for prepare AND
 * execute.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * Today the withdrawal reads `getMinimumBalanceForRentExemption(83 + c7)` after
 * the ~5.5 s proof, then the allocation at execute reads it again; the
 * subscription reads the buffer and the vault after the proof, then the buffer
 * again at execute. The C7 wire length is a pure function of the circuit
 * (`MEASURED_PROOF_BYTES.c7`, pinned against the shipped blob), so the quote can
 * go out beside the proof, through the SAME shared quote the allocation uses
 * (`quoteProofBufferRent`, stark.ts, the shield run's E2), on the same
 * connection, with the same method and arguments.
 *
 * What does not move, and is pinned here:
 *   - the float: the same raw floor, jittered the same way;
 *   - a proof of another size gets a re-read at ITS size, and that value
 *     prices the float and the allocation (no stale carried value);
 *   - a failed prefetch is re-read once after the proof, and a failed proof
 *     surfaces its own error with no unhandled rejection;
 *   - the prefetch starts only through the prepare's `onProving` hook, i.e.
 *     after every refusal that can happen before the proof
 *     (`spendRootIsCurrent.test.ts`, "[X4] onProving ...").
 * The prepares themselves are replaced by a stub that calls the hook, then
 * waits on a proof the test releases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';

type Hooked = { onProving?: () => void };
const proof = vi.hoisted(() => ({
  size: 79_405,
  gate: null as Promise<void> | null,
  fail: null as Error | null,
  /** Whether the stubbed prepare calls the hook (a refused attempt does not reach it). */
  hook: true,
}));

vi.mock('./denominatedPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./denominatedPool')>()),
  prepareUnshieldV4: vi.fn(async (_r: unknown, recipient: unknown, _p: unknown, _c: unknown, _o: unknown, opts: Hooked) => {
    if (proof.hook) opts?.onProving?.();
    if (proof.gate) await proof.gate;
    if (proof.fail) throw proof.fail;
    return { c7ProofResult: { proofBytes: new Uint8Array(0), publicInputs: [], proofSize: proof.size }, recipient };
  }),
}));
vi.mock('./subscribePrivateStarkV4', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./subscribePrivateStarkV4')>()),
  prepareSubscribeV4: vi.fn(
    async (_r: unknown, _p: unknown, _c: unknown, binding: unknown, _sc: unknown, _rt: unknown, _o: unknown, _s: unknown, opts: Hooked) => {
      if (proof.hook) opts?.onProving?.();
      if (proof.gate) await proof.gate;
      if (proof.fail) throw proof.fail;
      return { c7ProofResult: { proofBytes: new Uint8Array(0), publicInputs: [], proofSize: proof.size }, binding };
    },
  ),
}));

import { findPoolV3, type ShieldReceipt } from './denominatedPool';
import { prepareUnshieldJobV4, NULLIFIER_RENT, E_TX_FEE_BUDGET } from './unshieldEphemeral';
import { prepareSubscribeJobV4 } from './subscribeEphemeral';
import { quoteProofBufferRent } from './stark';
import { MEASURED_PROOF_BYTES, SUBSCRIBE_FLOAT_LAMPORTS, SUBSCRIPTION_VAULT_LEN, rentExemptLamports } from './subscribeFloat';

const POOL = findPoolV3('SOL', 0.1)!;
const RECIPIENT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const OWNER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
const RECEIPT = { noteBlinding: 7_284_991_002_338_477_113n, leafIndex: 5, secret: 1n, nullifierPreimage: 2n } as unknown as ShieldReceipt;
const SEED = new Uint8Array(32).fill(9);
const TERMS = {
  retailer: RECIPIENT,
  subscriberCommitment: 5_555n,
  rate: 1_000_000n,
  intervalSlots: 6_480_000n,
  vkHashSubscriber: new Uint8Array(32),
};

/** A connection that answers rent faithfully and records each rent read (its `space`), in order. */
function rentConnection(opts: { failFirst?: boolean } = {}) {
  const reads: number[] = [];
  let failed = false;
  const conn = {
    getMinimumBalanceForRentExemption: vi.fn(async (space: number, commitment?: unknown) => {
      reads.push(space);
      expect(commitment, 'the quote grew a commitment argument').toBeUndefined();
      if (opts.failFirst && !failed) {
        failed = true;
        throw new Error('429 on the prefetch');
      }
      return rentExemptLamports(space);
    }),
  } as unknown as Connection;
  return { conn, reads };
}

let release: () => void;
function holdTheProof(): void {
  proof.gate = new Promise<void>((r) => {
    release = r;
  });
}

const C7_SPACE = 83 + MEASURED_PROOF_BYTES.c7;

beforeEach(() => {
  proof.size = MEASURED_PROOF_BYTES.c7;
  proof.gate = null;
  proof.fail = null;
  proof.hook = true;
});

describe('[X4] the circuit-7 withdrawal quotes its buffer once, while the proof runs', () => {
  it('T1+T3: one read, sent before the proof resolves, and the allocation then reads nothing', async () => {
    const { conn, reads } = rentConnection();
    holdTheProof();
    const job = prepareUnshieldJobV4(RECEIPT, RECIPIENT, OWNER, POOL, conn, SEED, undefined, {}, new Set());
    await vi.waitFor(() => expect(reads, 'no quote went out while the proof ran').toEqual([C7_SPACE]));
    release();
    const ctx = await job;
    expect(reads).toEqual([C7_SPACE]);
    // The same raw floor as before: the buffer's exact rent-exempt minimum.
    expect(ctx.rawRequiredLamports).toBe(rentExemptLamports(C7_SPACE) + NULLIFIER_RENT + E_TX_FEE_BUDGET);
    // What `allocateProofBuffer` will ask at execute, on this connection: no read.
    expect(await quoteProofBufferRent(conn, ctx.prepared.c7ProofResult.proofSize)).toBe(rentExemptLamports(C7_SPACE));
    expect(reads, 'the allocation would read the rent a second time').toEqual([C7_SPACE]);
  });

  it('T5: a proof of another size is re-read at ITS size, which prices the float and the allocation', async () => {
    const { conn, reads } = rentConnection();
    proof.size = 32;
    const ctx = await prepareUnshieldJobV4(RECEIPT, RECIPIENT, OWNER, POOL, conn, SEED, undefined, {}, new Set());
    expect(reads).toEqual([C7_SPACE, 83 + 32]);
    expect(ctx.rawRequiredLamports).toBe(rentExemptLamports(83 + 32) + NULLIFIER_RENT + E_TX_FEE_BUDGET);
    expect(await quoteProofBufferRent(conn, 32)).toBe(rentExemptLamports(83 + 32));
    expect(reads).toHaveLength(2);
  });

  it('T6: the proof fails and the prefetch fails later -> the prover error, and no unhandled rejection', async () => {
    const { conn } = rentConnection({ failFirst: true });
    proof.fail = new Error('prover: out of memory');
    await expect(
      prepareUnshieldJobV4(RECEIPT, RECIPIENT, OWNER, POOL, conn, SEED, undefined, {}, new Set()),
    ).rejects.toThrow('prover: out of memory');
  });

  it('T7: the prefetch fails, the proof succeeds -> exactly one re-read after the proof', async () => {
    const { conn, reads } = rentConnection({ failFirst: true });
    const ctx = await prepareUnshieldJobV4(RECEIPT, RECIPIENT, OWNER, POOL, conn, SEED, undefined, {}, new Set());
    expect(reads).toEqual([C7_SPACE, C7_SPACE]);
    expect(ctx.rawRequiredLamports).toBe(rentExemptLamports(C7_SPACE) + NULLIFIER_RENT + E_TX_FEE_BUDGET);
  });

  it('control: a prepare that never reaches the prover hook quotes after the proof, as before', async () => {
    const { conn, reads } = rentConnection();
    proof.hook = false;
    holdTheProof();
    const job = prepareUnshieldJobV4(RECEIPT, RECIPIENT, OWNER, POOL, conn, SEED, undefined, {}, new Set());
    await new Promise((r) => setTimeout(r, 10));
    expect(reads, 'a quote went out with no hook call').toEqual([]);
    release();
    await job;
    expect(reads).toEqual([C7_SPACE]);
  });
});

describe('[X4] the circuit-7 subscription quotes buffer then vault while the proof runs', () => {
  it('T2+T3: two reads, buffer first, both before the proof resolves; the float is the disclosed one', async () => {
    const { conn, reads } = rentConnection();
    holdTheProof();
    const job = prepareSubscribeJobV4(RECEIPT, POOL, conn, SEED, TERMS, undefined, new Set());
    await vi.waitFor(() => expect(reads).toEqual([C7_SPACE, SUBSCRIPTION_VAULT_LEN]));
    release();
    const ctx = await job;
    expect(reads).toEqual([C7_SPACE, SUBSCRIPTION_VAULT_LEN]);
    expect(ctx.rawRequiredLamports).toBe(SUBSCRIBE_FLOAT_LAMPORTS.c7);
    expect(await quoteProofBufferRent(conn, ctx.prepared.c7ProofResult.proofSize)).toBe(rentExemptLamports(C7_SPACE));
    expect(reads, 'the allocation would read the rent a second time').toHaveLength(2);
  });

  it('T5: another proof size re-reads the buffer at its size; the vault quote is kept', async () => {
    const { conn, reads } = rentConnection();
    proof.size = 32;
    const ctx = await prepareSubscribeJobV4(RECEIPT, POOL, conn, SEED, TERMS, undefined, new Set());
    expect(reads).toEqual([C7_SPACE, SUBSCRIPTION_VAULT_LEN, 83 + 32]);
    expect(ctx.rawRequiredLamports).toBe(
      rentExemptLamports(83 + 32) + NULLIFIER_RENT + E_TX_FEE_BUDGET + rentExemptLamports(SUBSCRIPTION_VAULT_LEN),
    );
  });

  it('T7: the buffer prefetch fails -> re-read after the proof, in the old order (buffer, then vault)', async () => {
    const { conn, reads } = rentConnection({ failFirst: true });
    const ctx = await prepareSubscribeJobV4(RECEIPT, POOL, conn, SEED, TERMS, undefined, new Set());
    // The vault prefetch waits for the buffer's, so a failed buffer quote sends
    // no vault quote ahead of it: the after-proof reads keep today's order.
    expect(reads).toEqual([C7_SPACE, C7_SPACE, SUBSCRIPTION_VAULT_LEN]);
    expect(ctx.rawRequiredLamports).toBe(SUBSCRIBE_FLOAT_LAMPORTS.c7);
  });

  it('T6: the proof fails -> its own error, no unhandled rejection', async () => {
    const { conn } = rentConnection({ failFirst: true });
    proof.fail = new Error('prover: out of memory');
    await expect(prepareSubscribeJobV4(RECEIPT, POOL, conn, SEED, TERMS, undefined, new Set())).rejects.toThrow(
      'prover: out of memory',
    );
  });

  it('control: no hook call -> both quotes after the proof, buffer then vault, as the disclosure test pins', async () => {
    const { conn, reads } = rentConnection();
    proof.hook = false;
    const ctx = await prepareSubscribeJobV4(RECEIPT, POOL, conn, SEED, TERMS, undefined, new Set());
    expect(reads).toEqual([C7_SPACE, SUBSCRIPTION_VAULT_LEN]);
    expect(ctx.rawRequiredLamports).toBe(SUBSCRIBE_FLOAT_LAMPORTS.c7);
  });
});

void Keypair;
