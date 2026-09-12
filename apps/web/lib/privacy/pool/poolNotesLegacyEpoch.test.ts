/**
 * [SCAN-EPOCH 2026-09-13] The legacy-note epoch search is bounded by the
 * leaf's deposit slot when the history walk carried one.
 *
 * Before: every leaf the wallet did not own cost the full 6,000-epoch window
 * of Poseidon hashes (~110 leaves x 6,000 = ~660,000 hashes, ~53 s measured
 * per scan on 2026-09-13). After: a leaf with a known deposit slot costs at
 * most four hashes, and a leaf without one keeps the full window, so a legacy
 * note stays findable either way.
 */
import { describe, it, expect, vi } from 'vitest';
import { Keypair, SystemProgram, type Connection } from '@solana/web3.js';

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return { ...actual, createCommitmentV3: vi.fn(actual.createCommitmentV3) };
});

import { recoverNotes } from './poolNotes';
import * as dp from './denominatedPool';
import type { OnChainCommitment, PoolConfig } from './denominatedPool';

const SLOTS_PER_EPOCH = 7200;
const poolPDA = Keypair.generate().publicKey;
const poolConfig = {
  token: 'SOL',
  tokenMint: SystemProgram.programId,
  denomination: 1,
  decimals: 9,
  poolPDA,
} as unknown as PoolConfig;
const seed = new Uint8Array(32).fill(7);
const mintField = dp.pubkeyToField(poolConfig.tokenMint);

function legacyEntry(counter: number, epoch: bigint, depositSlot: number | null): OnChainCommitment {
  const { secret, nullifierPreimage } = dp.deriveNoteMaterial(seed, poolPDA, counter);
  const commitment = dp.createCommitmentV3(nullifierPreimage, secret, epoch, mintField);
  return { commitment, leafIndex: counter, depositPayer: null, depositSlot, signature: `sig${counter}` };
}

function strangerEntry(counter: number, depositSlot: number | null): OnChainCommitment {
  return { commitment: 10_000_000n + BigInt(counter), leafIndex: counter, depositPayer: null, depositSlot, signature: `sig${counter}` };
}

describe('[SCAN-EPOCH] legacy epoch search bounded by the deposit slot', () => {
  it('finds a legacy note at its deposit epoch with a handful of hashes per leaf', async () => {
    const E = 1234n;
    const commitments = new Map<string, OnChainCommitment>();
    for (let c = 0; c < 50; c++) {
      const e = c === 3 ? legacyEntry(3, E, Number(E) * SLOTS_PER_EPOCH + 50) : strangerEntry(c, (Number(E) - c) * SLOTS_PER_EPOCH + 10);
      commitments.set(e.commitment.toString(), e);
    }
    const conn = { getSlot: async () => (Number(E) + 5) * SLOTS_PER_EPOCH } as unknown as Connection;
    const mocked = dp.createCommitmentV3 as unknown as ReturnType<typeof vi.fn>;
    mocked.mockClear();

    const notes = await recoverNotes(conn, poolConfig, seed, { commitments, spentSet: new Set() });

    expect(notes.map((n) => n.counter)).toEqual([3]);
    expect(notes[0]!.receipt.noteBlinding).toBe(E);
    // One blinded probe + at most four legacy probes per leaf, not 6,000.
    expect(mocked.mock.calls.length).toBeLessThanOrEqual(50 * 5);
  });

  it('a leaf whose deposit slot is unknown keeps the full window and is still found', async () => {
    // E large enough that E - 3000 is a real epoch inside the 6,000-epoch window.
    const E = 8000n;
    const commitments = new Map<string, OnChainCommitment>();
    const legacy = legacyEntry(7, E - 3000n, null);
    commitments.set(legacy.commitment.toString(), legacy);
    for (let c = 0; c < 5; c++) {
      const e = strangerEntry(c, Number(E) * SLOTS_PER_EPOCH);
      commitments.set(e.commitment.toString(), e);
    }
    const conn = { getSlot: async () => Number(E) * SLOTS_PER_EPOCH } as unknown as Connection;

    const notes = await recoverNotes(conn, poolConfig, seed, { commitments, spentSet: new Set() });
    expect(notes.map((n) => n.counter)).toEqual([7]);
    expect(notes[0]!.receipt.noteBlinding).toBe(E - 3000n);
  });

  it('a deposit epoch one after the client-read epoch (boundary crossed while sending) is still found', async () => {
    const E = 1234n;
    const commitments = new Map<string, OnChainCommitment>();
    // The client read slot in epoch E and computed E; the transaction landed in E + 1.
    const legacy = legacyEntry(2, E, Number(E + 1n) * SLOTS_PER_EPOCH + 3);
    commitments.set(legacy.commitment.toString(), legacy);
    const conn = { getSlot: async () => (Number(E) + 4) * SLOTS_PER_EPOCH } as unknown as Connection;
    const notes = await recoverNotes(conn, poolConfig, seed, { commitments, spentSet: new Set() });
    expect(notes.map((n) => n.counter)).toEqual([2]);
  });
});
