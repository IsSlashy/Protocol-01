/**
 * close-v1 lane L2, F35: an imported note is filed as money only if the pool's
 * tree holds its commitment, at the leaf it names.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/closeV1L2Import.test.ts
 *
 * Drives the real worker handler (`poolImportNote`), as the audit's probe did
 * (audit-v1-opus/r2-client/probes/importnote.probe.test.ts): a note sealed to
 * this identity, whose secrets open its commitment (so the integrity guard
 * passes), but which was never deposited. The two chain reads are pool-wide
 * and stubbed: the spent set (empty) and the leaf map (per case).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const chain = {
  leaves: new Map<string, { leafIndex: number; commitment: bigint; depositSlot: number }>(),
  leafMapFails: false,
};
vi.mock('./denominatedPool', async (orig) => {
  const actual = await orig<typeof import('./denominatedPool')>();
  return {
    ...actual,
    fetchSpentNullifierSet: async () => new Set<string>(),
    fetchPoolCommitments: async () => {
      if (chain.leafMapFails) throw new Error('429 Too Many Requests');
      return chain.leaves;
    },
  };
});

import { derivePoolSeedLegacy } from './seedDerivation';
import { createCommitmentV3, findPoolV3, pubkeyToField, secureRandomU64 } from './denominatedPool';
import { createNoteEncryptionAddress, encryptNote } from './noteCrypto';
import {
  clearPoolState,
  configurePoolHandlers,
  handlePoolRequest,
  setPoolSeed,
} from '../worker/poolHandlers';

const SIG = new Uint8Array(64).map((_, i) => (i * 13 + 1) & 0xff);
const META = 'close-v1-import';
const pool = findPoolV3('SOL', 0.1)!;

function sealedNote(leafIndex: number) {
  const mint = pubkeyToField(pool.tokenMint);
  const s = secureRandomU64();
  const np = secureRandomU64();
  const b = secureRandomU64() & ((1n << 63n) - 1n);
  const commitment = createCommitmentV3(np, s, b, mint);
  const note = {
    version: 1,
    pool: pool.poolPDA.toBase58(),
    secret: s.toString(),
    nullifier_preimage: np.toString(),
    deposit_epoch: b.toString(),
    token_mint: mint.toString(),
    commitment: commitment.toString(),
    leafIndex,
    token: 'SOL',
    denominationHuman: 0.1,
  };
  const address = createNoteEncryptionAddress(derivePoolSeedLegacy(SIG));
  return { commitment, sealed: encryptNote(address, utf8ToBytes(JSON.stringify(note))) };
}

function importNote(sealed: string) {
  return handlePoolRequest({ kind: 'poolImportNote', meta: META, sealedNote: sealed } as never);
}

beforeEach(() => {
  clearPoolState();
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIG, null);
  chain.leaves = new Map();
  chain.leafMapFails = false;
});

describe('F35 · an imported note must be on the tree, where it says', () => {
  it('🚨 refuses a note that was never deposited, with code IMPORT_NOT_ON_TREE', async () => {
    const { sealed } = sealedNote(3);
    await expect(importNote(sealed)).rejects.toThrow(/^IMPORT_NOT_ON_TREE:/);
  });

  it('🚨 refuses a note whose commitment sits at another leaf than the one it names', async () => {
    const { sealed, commitment } = sealedNote(3);
    chain.leaves.set(commitment.toString(), { leafIndex: 9, commitment, depositSlot: 1 });
    await expect(importNote(sealed)).rejects.toThrow(/^IMPORT_NOT_ON_TREE:/);
  });

  it('refuses, and imports nothing, when the tree cannot be read: a retry loses nothing', async () => {
    const { sealed } = sealedNote(3);
    chain.leafMapFails = true;
    await expect(importNote(sealed)).rejects.toThrow(/could not be read.*Nothing was imported/);
  });

  it('files a note the tree holds at its leaf', async () => {
    const { sealed, commitment } = sealedNote(3);
    chain.leaves.set(commitment.toString(), { leafIndex: 3, commitment, depositSlot: 1 });
    const res = (await importNote(sealed)) as { note: { leafIndex: number; spent: boolean } };
    expect(res.note.leafIndex).toBe(3);
    expect(res.note.spent).toBe(false);
  });
});
