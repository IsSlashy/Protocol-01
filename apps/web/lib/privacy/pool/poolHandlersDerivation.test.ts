/**
 * poolHandlers — dual-derivation plumbing.
 *
 * `seedDerivation.test.ts` proves the CRYPTO keeps old notes reachable. This
 * file proves the WIRING does, which is where a user's funds would actually go
 * missing: a scan that iterates only the active seed shows a smaller balance and
 * an unshield that proves against the wrong seed builds a proof for a commitment
 * that is not on the tree.
 *
 * Everything that touches the chain is stubbed. Ownership is decided by
 * comparing the seed bytes the handler passes down against the seeds the real
 * `seedDerivation` produces, so the assertions are about which seed reached
 * which call — nothing else.
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { derivePoolSeedLegacy, derivePoolSeedSalted } from './seedDerivation';
import type { RecoveredNote } from './poolNotes';

// ---------------------------------------------------------------------------
// Fixtures — the two seeds one wallet can hold
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 5 + 1) & 0xff;

const PASSPHRASE = 'nine tigers argue quietly';
const LEGACY_HEX = bytesToHex(derivePoolSeedLegacy(SIGNATURE));
const SALTED_HEX = bytesToHex(derivePoolSeedSalted(SIGNATURE, PASSPHRASE));

const POOL_58 = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG'; // 0.1 SOL pool
const DENOM = 0.1;
const META = 'meta-under-test';
const OWNER = new PublicKey('7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU');

/** Leaf 11 was shielded BEFORE the passphrase; leaf 22 after. */
const LEGACY_LEAF = 11;
const SALTED_LEAF = 22;

function note(leafIndex: number): RecoveredNote {
  return {
    counter: leafIndex,
    spent: false,
    receipt: {
      secret: BigInt(leafIndex * 1000 + 1),
      nullifierPreimage: BigInt(leafIndex * 1000 + 2),
      noteBlinding: 7n,
      tokenMint: 0n,
      commitment: BigInt(leafIndex * 1000 + 3),
      leafIndex,
      denomination: 100_000_000n,
      pool: POOL_58,
      token: 'SOL',
      denominationHuman: DENOM,
      shieldedAt: 0,
      source: 'shielded',
    },
  };
}

/** Which notes each seed owns. Anything else sees nothing. */
function notesForSeed(seed: Uint8Array): RecoveredNote[] {
  const hex = bytesToHex(seed);
  if (hex === LEGACY_HEX) return [note(LEGACY_LEAF)];
  if (hex === SALTED_HEX) return [note(SALTED_LEAF)];
  return [];
}

/** Seeds observed by each stubbed entry point, in call order. */
const seen = {
  scan: [] as string[],
  recoverNotes: [] as string[],
  stuckFloat: [] as string[],
  prepareUnshield: [] as string[],
  prepareShield: [] as string[],
  encryptionAddress: [] as string[],
};

// ---------------------------------------------------------------------------
// Chain stubs
// ---------------------------------------------------------------------------

vi.mock('./poolNotes', () => ({
  scanPoolForSeed: async (_c: unknown, _p: unknown, seed: Uint8Array) => {
    seen.scan.push(bytesToHex(seed));
    return { notes: notesForSeed(seed) };
  },
  recoverNotes: async (_c: unknown, _p: unknown, seed: Uint8Array) => {
    seen.recoverNotes.push(bytesToHex(seed));
    return notesForSeed(seed);
  },
}));

vi.mock('./recoverFloat', () => ({
  recoverStuckFloat: async (_c: unknown, _p: unknown, seed: Uint8Array) => {
    seen.stuckFloat.push(bytesToHex(seed));
    return [{ lamports: 1000, closedBuffers: 1 }];
  },
}));

vi.mock('./shieldEphemeral', () => ({
  readTreeLeafCount: async () => 30,
  prepareShield: async (_p: unknown, _c: unknown, seed: Uint8Array) => {
    seen.prepareShield.push(bytesToHex(seed));
    return {
      jobId: 'shield:job',
      poolConfig: null,
      ephemeral: { publicKey: { toBase58: () => 'EPHEMERAL' } },
      requiredLamports: 123,
      prepared: {
        insertParams: { leafIndex: 30 },
        merklePath: { pathElements: [1n, 2n], pathIndices: [0, 1], root: 5n },
      },
    };
  },
  executeShield: async () => ({
    txSig: 'SHIELD_TX',
    receipt: {
      pool: POOL_58,
      secret: 1n,
      nullifierPreimage: 2n,
      noteBlinding: 3n,
      tokenMint: 0n,
      commitment: 4n,
      leafIndex: 30,
      token: 'SOL',
      denominationHuman: DENOM,
      shieldedAt: 0,
    },
  }),
  recordShieldBreadcrumb: async () => undefined,
}));

/**
 * The note blob a shield hands back is encrypted to an address derived from the
 * seed, and only that seed can read it again. Recording the seed here is what
 * makes the "execute encrypts to the derivation that will read it back"
 * assertion possible — nothing else in the handler exposes it.
 */
vi.mock('./noteCrypto', () => ({
  createNoteEncryptionAddress: (seed: Uint8Array) => {
    seen.encryptionAddress.push(bytesToHex(seed));
    return `addr:${bytesToHex(seed).slice(0, 8)}`;
  },
  encryptNote: (address: string) => `blob-for:${address}`,
  decryptNote: () => {
    throw new Error('not ours');
  },
}));

vi.mock('./unshieldEphemeral', () => ({
  prepareUnshieldJob: async (
    _r: unknown,
    poolConfig: unknown,
    _c: unknown,
    seed: Uint8Array,
  ) => {
    seen.prepareUnshield.push(bytesToHex(seed));
    return {
      jobId: 'unshield:job',
      poolConfig,
      ephemeral: { publicKey: { toBase58: () => 'EPHEMERAL' } },
      requiredLamports: 456,
    };
  },
  executeUnshield: async () => {
    throw new Error('not exercised');
  },
}));

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return { ...actual, fetchPoolCommitments: async () => new Map() };
});

// Imported after the mocks so the handler binds to the stubs.
const {
  clearPoolState,
  configurePoolHandlers,
  handlePoolRequest,
  setPoolSeed,
} = await import('../worker/poolHandlers');

// ---------------------------------------------------------------------------

beforeEach(() => {
  clearPoolState();
  seen.scan = [];
  seen.recoverNotes = [];
  seen.stuckFloat = [];
  seen.prepareUnshield = [];
  seen.prepareShield = [];
  seen.encryptionAddress = [];
  configurePoolHandlers('http://localhost:8899');
});

describe('a wallet with no passphrase behaves exactly as before', () => {
  it('scans with the legacy seed only', async () => {
    setPoolSeed(META, SIGNATURE);
    const res = await handlePoolRequest({
      kind: 'poolScan',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    expect(seen.scan).toEqual([LEGACY_HEX]);
    expect(res.notes.map((n) => n.leafIndex)).toEqual([LEGACY_LEAF]);
    expect(res.notes[0].derivation).toBe(1);
    expect(res.shieldedBalance).toBe(DENOM);
  });

  it('shields under the legacy seed', async () => {
    setPoolSeed(META, SIGNATURE);
    await handlePoolRequest({
      kind: 'poolShieldPrepare',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    expect(seen.prepareShield).toEqual([LEGACY_HEX]);
  });
});

describe('a wallet that adopts a passphrase keeps its old notes', () => {
  beforeEach(() => setPoolSeed(META, SIGNATURE, PASSPHRASE));

  it('scans BOTH derivations and reports both notes', async () => {
    const res = await handlePoolRequest({
      kind: 'poolScan',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    // Active first, legacy second — a scan that stops after the first would
    // hide the pre-passphrase note and understate the balance.
    expect(seen.scan).toEqual([SALTED_HEX, LEGACY_HEX]);
    expect(res.notes.map((n) => n.leafIndex).sort((a, b) => a - b)).toEqual([
      LEGACY_LEAF,
      SALTED_LEAF,
    ]);
    expect(res.shieldedBalance).toBeCloseTo(DENOM * 2, 10);
  });

  it('tags each note with the derivation that owns it', async () => {
    const res = await handlePoolRequest({
      kind: 'poolScan',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    const byLeaf = Object.fromEntries(res.notes.map((n) => [n.leafIndex, n.derivation]));
    expect(byLeaf[SALTED_LEAF]).toBe(2);
    expect(byLeaf[LEGACY_LEAF]).toBe(1);
  });

  it('withdraws a pre-passphrase note with the LEGACY seed', async () => {
    const res = await handlePoolRequest({
      kind: 'poolUnshieldPrepare',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
      leafIndex: LEGACY_LEAF,
    });
    expect(res.derivation).toBe(1);
    // The seed that reached the prover is what decides whether the C1/C3 proofs
    // are for the commitment actually on the tree.
    expect(seen.prepareUnshield).toEqual([LEGACY_HEX]);
  });

  it('withdraws a post-passphrase note with the SALTED seed', async () => {
    const res = await handlePoolRequest({
      kind: 'poolUnshieldPrepare',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
      leafIndex: SALTED_LEAF,
    });
    expect(res.derivation).toBe(2);
    expect(seen.prepareUnshield).toEqual([SALTED_HEX]);
  });

  it('shields new notes under the SALTED seed only', async () => {
    await handlePoolRequest({
      kind: 'poolShieldPrepare',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    expect(seen.prepareShield).toEqual([SALTED_HEX]);
  });

  it('encrypts the stored note to the SAME derivation that prepared it', async () => {
    // Execute runs after prepare and picks its seed independently. If it picked
    // a different one, the blob would be sealed to an address the withdrawal
    // path cannot open: extractStoredPath swallows the failure and silently
    // falls back to rebuilding the Merkle path from history, so the fast path
    // would be dead for every note and nothing would ever say so.
    const prep = await handlePoolRequest({
      kind: 'poolShieldPrepare',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    const res = await handlePoolRequest({
      kind: 'poolShieldExecute',
      jobId: prep.jobId,
      ownerPubkey: OWNER.toBase58(),
    });
    expect(seen.encryptionAddress).toEqual([SALTED_HEX]);
    expect(seen.prepareShield).toEqual([SALTED_HEX]);
    expect(res.encryptedNote).toBe(`blob-for:addr:${SALTED_HEX.slice(0, 8)}`);
  });

  it('sweeps stranded float from BOTH derivations', async () => {
    // Proof-buffer rent left on a pre-passphrase ephemeral is ~1 SOL and is only
    // reachable through the legacy seed.
    const res = await handlePoolRequest({
      kind: 'poolRecover',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
      ownerPubkey: OWNER.toBase58(),
    });
    expect(seen.stuckFloat).toEqual([SALTED_HEX, LEGACY_HEX]);
    expect(res.keys).toBe(2);
    expect(res.lamports).toBe(2000);
  });

  it('still refuses a leaf that belongs to nobody', async () => {
    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldPrepare',
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: 999,
      }),
    ).rejects.toThrow(/No note of yours found/);
    // Both derivations were tried before giving up.
    expect(seen.recoverNotes).toEqual([SALTED_HEX, LEGACY_HEX]);
  });
});

describe('arming a passphrase', () => {
  it('drops derived seeds and says a re-derive is required', async () => {
    setPoolSeed(META, SIGNATURE);
    const res = await handlePoolRequest({
      kind: 'poolSetPassphrase',
      passphrase: PASSPHRASE,
    });
    expect(res.requiresRederive).toBe(true);
    expect(res.armed).toBe(true);
    // The old seed is gone — nothing keeps running under the old derivation.
    await expect(
      handlePoolRequest({ kind: 'poolScan', meta: META, token: 'SOL', denomination: DENOM }),
    ).rejects.toThrow(/No pool keys/);
  });

  it('is consumed by the next derive and applies to it', async () => {
    await handlePoolRequest({ kind: 'poolSetPassphrase', passphrase: PASSPHRASE });
    setPoolSeed(META, SIGNATURE);
    await handlePoolRequest({
      kind: 'poolScan',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    expect(seen.scan).toEqual([SALTED_HEX, LEGACY_HEX]);
  });

  it('is consumed, not sticky — a second derive without arming is legacy again', async () => {
    await handlePoolRequest({ kind: 'poolSetPassphrase', passphrase: PASSPHRASE });
    setPoolSeed(META, SIGNATURE);
    setPoolSeed('other-meta', SIGNATURE);
    await handlePoolRequest({
      kind: 'poolScan',
      meta: 'other-meta',
      token: 'SOL',
      denomination: DENOM,
    });
    expect(seen.scan).toEqual([LEGACY_HEX]);
  });

  it('disarms back to the legacy derivation', async () => {
    await handlePoolRequest({ kind: 'poolSetPassphrase', passphrase: PASSPHRASE });
    const res = await handlePoolRequest({ kind: 'poolSetPassphrase', passphrase: null });
    expect(res.armed).toBe(false);
    setPoolSeed(META, SIGNATURE);
    await handlePoolRequest({
      kind: 'poolScan',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    expect(seen.scan).toEqual([LEGACY_HEX]);
  });

  it('rejects a too-short passphrase WITHOUT dropping the live session', async () => {
    setPoolSeed(META, SIGNATURE);
    await expect(
      handlePoolRequest({ kind: 'poolSetPassphrase', passphrase: 'short' }),
    ).rejects.toThrow(/too short/i);
    // The session survived, so a typo cannot log a user out of their notes.
    const res = await handlePoolRequest({
      kind: 'poolScan',
      meta: META,
      token: 'SOL',
      denomination: DENOM,
    });
    expect(res.notes.map((n) => n.leafIndex)).toEqual([LEGACY_LEAF]);
  });
});
