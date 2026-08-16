/**
 * poolExportNote — the encrypted note handoff.
 *
 * What is worth testing here is NOT that a string comes back. It is:
 *
 *   1. that the string a recipient opens reconstructs the exact note, through
 *      the same validation an importing client runs (`shareableNoteToReceipt`
 *      recomputes the commitment from the secrets and refuses a mismatch);
 *   2. that the string is opaque to everyone else, including the sender;
 *   3. that NO secret crosses the worker boundary in the response — the whole
 *      reason the encode and the seal happen inside the worker;
 *   4. that a bad recipient address is refused BEFORE the pool is read, since
 *      that read is minutes of history-walking on devnet;
 *   5. that an already-spent note is refused, because a sealed note that was
 *      already withdrawn is indistinguishable from a good one to the recipient.
 *
 * `noteCrypto` is deliberately NOT mocked: the sealing is the feature, so the
 * real hybrid X25519 + ML-KEM-768 runs and the assertions are round-trips
 * rather than string comparisons against a stub. Everything that would touch
 * the chain is stubbed, exactly as `poolHandlersDerivation.test.ts` does it.
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { derivePoolSeedLegacy, derivePoolSeedSalted } from './seedDerivation';
import {
  MERKLE_DEPTH,
  createCommitmentV3,
  findPoolV3,
  pubkeyToField,
  shareableNoteToReceipt,
  type ShareableNote,
} from './denominatedPool';
import {
  createNoteEncryptionAddress,
  decryptNote,
  encryptNote,
  isEncryptedNoteBlob,
} from './noteCrypto';
import type { RecoveredNote } from './poolNotes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 7 + 3) & 0xff;

const PASSPHRASE = 'nine tigers argue quietly';
const LEGACY_SEED = derivePoolSeedLegacy(SIGNATURE);
const SALTED_SEED = derivePoolSeedSalted(SIGNATURE, PASSPHRASE);
const LEGACY_HEX = bytesToHex(LEGACY_SEED);
const SALTED_HEX = bytesToHex(SALTED_SEED);

/** The recipient is a different wallet entirely — this is the whole point. */
const RECIPIENT_SEED = new Uint8Array(32).fill(0x5a);
const RECIPIENT_ADDRESS = createNoteEncryptionAddress(RECIPIENT_SEED);

const DENOM = 0.1;
const POOL = findPoolV3('SOL', DENOM)!;
const POOL_58 = POOL.poolPDA.toBase58();
const TOKEN_MINT_FIELD = pubkeyToField(POOL.tokenMint);
const META = 'meta-under-test';

/** Leaf 11 was shielded BEFORE the passphrase; leaf 22 after; leaf 33 is spent. */
const LEGACY_LEAF = 11;
const SALTED_LEAF = 22;
const SPENT_LEAF = 33;

function note(leafIndex: number, spent = false): RecoveredNote {
  const secret = BigInt(leafIndex * 1_000_003 + 1);
  const nullifierPreimage = BigInt(leafIndex * 1_000_003 + 2);
  const noteBlinding = BigInt(leafIndex * 1_000_003 + 3);
  // A REAL commitment over the real secrets: `shareableNoteToReceipt` recomputes
  // it on import and throws on a mismatch, so a fabricated one would make the
  // round-trip assertion pass for the wrong reason (or not at all).
  const commitment = createCommitmentV3(nullifierPreimage, secret, noteBlinding, TOKEN_MINT_FIELD);
  return {
    counter: leafIndex,
    spent,
    receipt: {
      secret,
      nullifierPreimage,
      noteBlinding,
      tokenMint: TOKEN_MINT_FIELD,
      commitment,
      leafIndex,
      denomination: POOL.denominationAtomic,
      pool: POOL_58,
      token: 'SOL',
      denominationHuman: DENOM,
      shieldedAt: 1_700_000_000_000,
      source: 'shielded',
    },
  };
}

const LEGACY_NOTE = note(LEGACY_LEAF);
const SALTED_NOTE = note(SALTED_LEAF);
const SPENT_NOTE = note(SPENT_LEAF, true);

function notesForSeed(seed: Uint8Array): RecoveredNote[] {
  const hex = bytesToHex(seed);
  if (hex === LEGACY_HEX) return [LEGACY_NOTE];
  if (hex === SALTED_HEX) return [SALTED_NOTE, SPENT_NOTE];
  return [];
}

const seen = { recoverNotes: [] as string[], commitmentFetches: 0 };

// ---------------------------------------------------------------------------
// Chain stubs
// ---------------------------------------------------------------------------

vi.mock('./poolNotes', () => ({
  scanPoolForSeed: async (_c: unknown, _p: unknown, seed: Uint8Array) => ({
    notes: notesForSeed(seed),
  }),
  recoverNotes: async (_c: unknown, _p: unknown, seed: Uint8Array) => {
    seen.recoverNotes.push(bytesToHex(seed));
    return notesForSeed(seed);
  },
}));

vi.mock('./recoverFloat', () => ({ recoverStuckFloat: async () => [] }));

vi.mock('./shieldEphemeral', () => ({
  readTreeLeafCount: async () => 40,
  prepareShield: async () => {
    throw new Error('not exercised');
  },
  executeShield: async () => {
    throw new Error('not exercised');
  },
  recordShieldBreadcrumb: async () => undefined,
}));

vi.mock('./unshieldEphemeral', () => ({
  prepareUnshieldJob: async () => {
    throw new Error('not exercised');
  },
  executeUnshield: async () => {
    throw new Error('not exercised');
  },
}));

/**
 * The pool's leaves as an RPC would serve them. Every note above occupies its
 * own leaf index; the gaps stay empty, which is what the handler's densifier
 * has to fill correctly for the Merkle rebuild to produce a usable path.
 */
vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    fetchPoolCommitments: async () => {
      seen.commitmentFetches += 1;
      const map = new Map<string, { commitment: bigint; leafIndex: number }>();
      for (const n of [LEGACY_NOTE, SALTED_NOTE, SPENT_NOTE]) {
        map.set(n.receipt.commitment.toString(), {
          commitment: n.receipt.commitment,
          leafIndex: n.receipt.leafIndex,
        });
      }
      return map;
    },
    // Hoisted to `locateOwnedNote` since A5 (one pool-wide read shared across
    // the derivation loop), so it needs a stub here like the commitments do.
    fetchSpentNullifierSet: async () => new Set<string>(),
  };
});

// Imported after the mocks so the handler binds to the stubs.
const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  '../worker/poolHandlers'
);

// ---------------------------------------------------------------------------

function exportReq(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'poolExportNote' as const,
    meta: META,
    token: 'SOL' as const,
    denomination: DENOM,
    leafIndex: SALTED_LEAF,
    recipientAddress: RECIPIENT_ADDRESS,
    ...overrides,
  };
}

/** Open a sealed blob the way an importing client does. */
function open(sealed: string, seed: Uint8Array): ShareableNote {
  return JSON.parse(new TextDecoder().decode(decryptNote(seed, sealed))) as ShareableNote;
}

beforeEach(() => {
  clearPoolState();
  seen.recoverNotes = [];
  seen.commitmentFetches = 0;
  configurePoolHandlers('http://localhost:8899');
});

describe('sealing a note to a recipient', () => {
  beforeEach(() => setPoolSeed(META, SIGNATURE, PASSPHRASE));

  it('produces a blob the recipient reconstructs the exact note from', async () => {
    const res = await handlePoolRequest(exportReq());

    expect(isEncryptedNoteBlob(res.sealedNote)).toBe(true);

    // The full import path an extension/mobile client runs, including the
    // commitment recomputation that rejects a corrupted note.
    const receipt = shareableNoteToReceipt(open(res.sealedNote, RECIPIENT_SEED));
    expect(receipt.secret).toBe(SALTED_NOTE.receipt.secret);
    expect(receipt.nullifierPreimage).toBe(SALTED_NOTE.receipt.nullifierPreimage);
    expect(receipt.noteBlinding).toBe(SALTED_NOTE.receipt.noteBlinding);
    expect(receipt.commitment).toBe(SALTED_NOTE.receipt.commitment);
    expect(receipt.leafIndex).toBe(SALTED_LEAF);
    expect(receipt.denominationHuman).toBe(DENOM);
    expect(receipt.pool).toBe(POOL_58);
  });

  it('seals the plaintext as JSON, which is the only shape a client can open', async () => {
    // `apps/extension/src/shared/store/denominatedPool.ts:449-470` does
    // `JSON.parse(decode(decryptNote(...)))` with no fallback. If this ever
    // became the base64 `encodeShareableNote` form instead, every recipient
    // would fail to import and nothing else in this suite would notice.
    const res = await handlePoolRequest(exportReq());
    const raw = new TextDecoder().decode(decryptNote(RECIPIENT_SEED, res.sealedNote));
    expect(raw.startsWith('{')).toBe(true);
    expect(JSON.parse(raw).version).toBe(1);
  });

  it('is opaque to the sender who created it', async () => {
    // Sealed to the RECIPIENT's public key, not to a shared secret: even the
    // wallet that produced the blob cannot read it back.
    const res = await handlePoolRequest(exportReq());
    expect(() => open(res.sealedNote, SALTED_SEED)).toThrow(/decryption failed/i);
    expect(() => open(res.sealedNote, LEGACY_SEED)).toThrow(/decryption failed/i);
  });

  it('is opaque to a third party who intercepts it', async () => {
    const res = await handlePoolRequest(exportReq());
    const eavesdropper = new Uint8Array(32).fill(0x11);
    expect(() => open(res.sealedNote, eavesdropper)).toThrow(/decryption failed/i);
  });

  it('returns NO secret across the worker boundary', async () => {
    // The response is what the main thread gets to hold. `PoolNoteView` carries
    // no secret by design and this handler must not become the leak that makes
    // that pointless, so assert on the serialized response rather than on the
    // fields we remembered to check.
    const res = await handlePoolRequest(exportReq());
    const wire = JSON.stringify(res);
    for (const secret of [
      SALTED_NOTE.receipt.secret,
      SALTED_NOTE.receipt.nullifierPreimage,
      SALTED_NOTE.receipt.noteBlinding,
    ]) {
      expect(wire).not.toContain(secret.toString());
    }
    // The commitment IS in there, and that is correct: the deposit published it.
    expect(res.commitment).toBe(SALTED_NOTE.receipt.commitment.toString());
  });

  it('does not consume or mark the note — the sender can still export it again', async () => {
    // Not a nicety: it is the reason the UI has to say "you keep a spendable
    // copy". If this ever starts throwing on the second call, the copy is wrong.
    const first = await handlePoolRequest(exportReq());
    const second = await handlePoolRequest(exportReq());
    expect(open(first.sealedNote, RECIPIENT_SEED).secret).toBe(
      open(second.sealedNote, RECIPIENT_SEED).secret,
    );
    // Fresh ephemeral + nonce every time, so two seals of one note are not
    // byte-identical and cannot be matched to each other by an observer.
    expect(first.sealedNote).not.toBe(second.sealedNote);
  });

  it('carries a rebuilt Merkle path when no stored blob is available', async () => {
    const res = await handlePoolRequest(exportReq());
    expect(res.merklePath).toBe('rebuilt');
    const opened = open(res.sealedNote, RECIPIENT_SEED);
    expect(opened.merkle_path_elements).toHaveLength(MERKLE_DEPTH);
    expect(opened.merkle_path_indices).toHaveLength(MERKLE_DEPTH);
    expect(typeof opened.merkle_root).toBe('string');
  });

  it('prefers the exact path stored at shield time over a rebuild', async () => {
    // The stored witness was accepted on chain; a rebuild can only see the
    // leaves this RPC still serves. A real blob is used, sealed to the sender's
    // own derivation, so `extractStoredPath` runs its real decrypt-and-match.
    const stored = encryptNote(
      createNoteEncryptionAddress(SALTED_SEED),
      utf8ToBytes(
        JSON.stringify({
          version: 1,
          commitment: SALTED_NOTE.receipt.commitment.toString(),
          merklePath: {
            pathElements: Array.from({ length: MERKLE_DEPTH }, (_, i) => String(900 + i)),
            pathIndices: Array.from({ length: MERKLE_DEPTH }, () => 1),
            root: '123456789',
          },
        }),
      ),
    );

    const res = await handlePoolRequest(exportReq({ encryptedNotes: [stored] }));
    expect(res.merklePath).toBe('stored');
    const opened = open(res.sealedNote, RECIPIENT_SEED);
    expect(opened.merkle_root).toBe('123456789');
    expect(opened.merkle_path_elements?.[0]).toBe('900');
  });

  it('ignores a stored blob belonging to a different note', async () => {
    const otherNote = encryptNote(
      createNoteEncryptionAddress(SALTED_SEED),
      utf8ToBytes(
        JSON.stringify({
          version: 1,
          commitment: LEGACY_NOTE.receipt.commitment.toString(),
          merklePath: { pathElements: ['1'], pathIndices: [0], root: '999' },
        }),
      ),
    );
    const res = await handlePoolRequest(exportReq({ encryptedNotes: [otherNote] }));
    expect(res.merklePath).toBe('rebuilt');
    expect(open(res.sealedNote, RECIPIENT_SEED).merkle_root).not.toBe('999');
  });

  it('exports a pre-passphrase note under the LEGACY derivation', async () => {
    // Same trap as the withdrawal: a note shielded before the passphrase only
    // exists under the legacy seed, and searching only the active one would
    // report a note the user can plainly see as "not found".
    const res = await handlePoolRequest(exportReq({ leafIndex: LEGACY_LEAF }));
    expect(res.derivation).toBe(1);
    expect(seen.recoverNotes).toEqual([SALTED_HEX, LEGACY_HEX]);
    expect(shareableNoteToReceipt(open(res.sealedNote, RECIPIENT_SEED)).commitment).toBe(
      LEGACY_NOTE.receipt.commitment,
    );
  });
});

describe('what it refuses', () => {
  beforeEach(() => setPoolSeed(META, SIGNATURE, PASSPHRASE));

  it('rejects a recipient address that is not a p01pq address, before reading the pool', async () => {
    await expect(
      handlePoolRequest(exportReq({ recipientAddress: '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU' })),
    ).rejects.toThrow(/not a Protocol 01 note address/i);
    // The point of the early check: a pool scan is minutes of history-walking
    // on devnet, and reporting a typo only after all of it is what makes people
    // stop watching.
    expect(seen.commitmentFetches).toBe(0);
    expect(seen.recoverNotes).toEqual([]);
  });

  it('rejects a truncated p01pq address rather than sealing to a short key', async () => {
    await expect(
      handlePoolRequest(exportReq({ recipientAddress: 'p01pq:AAAA' })),
    ).rejects.toThrow(/not a Protocol 01 note address/i);
    expect(seen.commitmentFetches).toBe(0);
  });

  it('refuses a note that has already been spent', async () => {
    // A sealed note whose nullifier is already on chain looks exactly like a
    // good one to whoever receives it.
    await expect(handlePoolRequest(exportReq({ leafIndex: SPENT_LEAF }))).rejects.toThrow(
      /already been withdrawn/i,
    );
  });

  it('refuses a leaf this identity does not own', async () => {
    await expect(handlePoolRequest(exportReq({ leafIndex: 999 }))).rejects.toThrow(
      /No note of yours found/,
    );
  });

  it('refuses when no pool keys are derived for this session', async () => {
    clearPoolState();
    await expect(handlePoolRequest(exportReq())).rejects.toThrow(/No pool keys/);
  });
});
