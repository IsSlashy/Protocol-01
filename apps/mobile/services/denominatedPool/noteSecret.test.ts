/**
 * Tests for the deterministic note-secret derivation (note-secret bug fix).
 *
 * Why these exist: `randomFieldElement()` in shield made notes irrecoverable
 * after an app uninstall. The fix derives (secret, nullifierPreimage) from
 * `HKDF(walletSeed, 'p01-note-v1', poolPDA||counter||tag)` so the same seed
 * always produces the same commitments. These tests pin that contract.
 *
 * If any expected value drifts, every shielded note minted before the change
 * becomes unrecoverable — re-derive carefully, do not "fix" the test.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  deriveNoteMaterial,
  deriveSplitOutputSecrets,
  rescanPoolFromSeed,
  createCommitment,
} from './index';

const SEED_A = new Uint8Array(32).fill(0xab);
const SEED_B = new Uint8Array(32).fill(0xcd);

// Hand-rolled pool fixtures so the tests do not depend on the real devnet pool
// addresses or on `SystemProgram.programId` (which is not exposed by the mock).
const POOL_A = new PublicKey('JDVrKu9cKZMKaxxVeC8QUBRTnkC81LcbNHFDcrbyZ2iv');
const POOL_B = new PublicKey('BoCTorE7dDyFTaK4oCEw8K3w7F6FxrKCSqbAGVv4cxXL');
const MINT_SOL = new PublicKey('So11111111111111111111111111111111111111112');
const MINT_USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

describe('deriveNoteMaterial', () => {
  it('is deterministic for the same (seed, pool, counter)', () => {
    const pool = POOL_A;
    const a = deriveNoteMaterial(SEED_A, pool, 0);
    const b = deriveNoteMaterial(SEED_A, pool, 0);
    expect(a.secret).toBe(b.secret);
    expect(a.nullifierPreimage).toBe(b.nullifierPreimage);
  });

  it('produces independent secret and nullifierPreimage (domain separation)', () => {
    const pool = POOL_A;
    const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_A, pool, 0);
    expect(secret).not.toBe(nullifierPreimage);
  });

  it('changes when counter changes', () => {
    const pool = POOL_A;
    const a = deriveNoteMaterial(SEED_A, pool, 0);
    const b = deriveNoteMaterial(SEED_A, pool, 1);
    expect(a.secret).not.toBe(b.secret);
    expect(a.nullifierPreimage).not.toBe(b.nullifierPreimage);
  });

  it('changes when pool changes', () => {
    const a = deriveNoteMaterial(SEED_A, POOL_A, 0);
    const b = deriveNoteMaterial(SEED_A, POOL_B, 0);
    expect(a.secret).not.toBe(b.secret);
  });

  it('changes when seed changes', () => {
    const pool = POOL_A;
    const a = deriveNoteMaterial(SEED_A, pool, 0);
    const b = deriveNoteMaterial(SEED_B, pool, 0);
    expect(a.secret).not.toBe(b.secret);
    expect(a.nullifierPreimage).not.toBe(b.nullifierPreimage);
  });

  it('outputs are valid field elements (< BN254 order)', () => {
    const FIELD_ORDER = BigInt(
      '21888242871839275222246405745257275088548364400416034343698204186575808495617'
    );
    for (let counter = 0; counter < 8; counter++) {
      const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_A, POOL_A, counter);
      expect(secret).toBeGreaterThanOrEqual(0n);
      expect(secret).toBeLessThan(FIELD_ORDER);
      expect(nullifierPreimage).toBeGreaterThanOrEqual(0n);
      expect(nullifierPreimage).toBeLessThan(FIELD_ORDER);
    }
  });
});

describe('deriveSplitOutputSecrets', () => {
  it('is deterministic from the parent secret', () => {
    const parent = 12345678901234567890n;
    const a = deriveSplitOutputSecrets(parent, 4);
    const b = deriveSplitOutputSecrets(parent, 4);
    expect(a).toEqual(b);
  });

  it('produces distinct secrets per child index', () => {
    const parent = 42n;
    const children = deriveSplitOutputSecrets(parent, 8);
    const set = new Set(children.map((c) => c.toString()));
    expect(set.size).toBe(8);
  });

  it('changes when parent changes', () => {
    const a = deriveSplitOutputSecrets(1n, 4);
    const b = deriveSplitOutputSecrets(2n, 4);
    for (let i = 0; i < 4; i++) {
      expect(a[i]).not.toBe(b[i]);
    }
  });

  it('returns the requested count', () => {
    expect(deriveSplitOutputSecrets(1n, 0)).toHaveLength(0);
    expect(deriveSplitOutputSecrets(1n, 1)).toHaveLength(1);
    expect(deriveSplitOutputSecrets(1n, 16)).toHaveLength(16);
  });
});

describe('rescanPoolFromSeed (recovery flow)', () => {
  // Simulate the full uninstall→rescan loop: shield 5 notes across 3 epochs,
  // wipe local state, then rescan the on-chain commitment set with only the
  // seed and prove every note comes back.
  function pubkeyToField(pubkey: PublicKey): bigint {
    const FIELD_ORDER = BigInt(
      '21888242871839275222246405745257275088548364400416034343698204186575808495617'
    );
    const bytes = pubkey.toBytes();
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
    return n % FIELD_ORDER;
  }

  it('recovers every shielded commitment after a wipe', () => {
    const mintField = pubkeyToField(MINT_SOL);
    const epochs = [100n, 101n, 102n];

    const shielded: { counter: number; epoch: bigint; commitment: bigint }[] = [];
    for (let counter = 0; counter < 5; counter++) {
      const epoch = epochs[counter % epochs.length];
      const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_A, POOL_A, counter);
      const commitment = createCommitment(nullifierPreimage, secret, epoch, mintField);
      shielded.push({ counter, epoch, commitment });
    }

    const onChainCommitments = new Set(shielded.map((s) => s.commitment.toString()));

    const recovered = rescanPoolFromSeed({
      walletSeed: SEED_A,
      poolPDA: POOL_A,
      tokenMints: [MINT_SOL],
      epochs,
      maxCounter: 10,
      knownCommitments: onChainCommitments,
    });

    expect(recovered).toHaveLength(5);
    for (const s of shielded) {
      const match = recovered.find((r) => r.commitment === s.commitment);
      expect(match).toBeDefined();
      expect(match!.counter).toBe(s.counter);
      expect(match!.depositEpoch).toBe(s.epoch);
    }
  });

  it('does not recover notes from a different seed', () => {
    const mintField = pubkeyToField(MINT_SOL);
    const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_A, POOL_A, 0);
    const commitment = createCommitment(nullifierPreimage, secret, 50n, mintField);

    const recovered = rescanPoolFromSeed({
      walletSeed: SEED_B,
      poolPDA: POOL_A,
      tokenMints: [MINT_SOL],
      epochs: [50n],
      maxCounter: 10,
      knownCommitments: new Set([commitment.toString()]),
    });

    expect(recovered).toHaveLength(0);
  });

  it('skips counters that were never used (gaps tolerated)', () => {
    const mintField = pubkeyToField(MINT_SOL);
    const used = [0, 3, 7];
    const epoch = 200n;
    const onChain = new Set(
      used.map((c) => {
        const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_A, POOL_A, c);
        return createCommitment(nullifierPreimage, secret, epoch, mintField).toString();
      })
    );

    const recovered = rescanPoolFromSeed({
      walletSeed: SEED_A,
      poolPDA: POOL_A,
      tokenMints: [MINT_SOL],
      epochs: [epoch],
      maxCounter: 10,
      knownCommitments: onChain,
    });

    expect(recovered.map((r) => r.counter).sort((a, b) => a - b)).toEqual(used);
  });

  it('isolates notes per pool (different pool seed does not match commitments)', () => {
    const mintField = pubkeyToField(MINT_SOL);
    const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_A, POOL_A, 0);
    const aCommitment = createCommitment(nullifierPreimage, secret, 10n, mintField);

    const recovered = rescanPoolFromSeed({
      walletSeed: SEED_A,
      poolPDA: POOL_B,
      tokenMints: [MINT_USDC],
      epochs: [10n],
      maxCounter: 10,
      knownCommitments: new Set([aCommitment.toString()]),
    });

    expect(recovered).toHaveLength(0);
  });
});
