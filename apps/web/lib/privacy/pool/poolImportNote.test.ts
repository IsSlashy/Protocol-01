/**
 * poolImportNote + poolNoteAddress — receiving a sealed note.
 *
 * What is worth testing is NOT that a blob goes in and a view comes out. It is:
 *
 *   1. that the integrity guard actually guards: a note whose commitment does
 *      not recompute from its secrets is refused, whatever else is right;
 *   2. that NO secret crosses the worker boundary in the response — the whole
 *      reason the decrypt/validate/re-encrypt chain lives in the worker;
 *   3. that the re-encrypted blob is a first-class citizen of the local store:
 *      `poolScanLocal` lists it, which is the mechanism behind "the note shows
 *      up in the note lists with no pool scan";
 *   4. that the same note cannot enter the store twice, because two rows of
 *      the same money is how a user double-counts a balance;
 *   5. that a provably spent note is refused, but an RPC failure does NOT
 *      block the import — it downgrades the claim to `spentKnown: false`.
 *
 * `noteCrypto` is deliberately NOT mocked: the real hybrid X25519 + ML-KEM-768
 * runs end to end, and only the single chain read (`isNullifierSpent`) is
 * stubbed, the same style as `poolExportNote.test.ts`.
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { derivePoolSeedLegacy, derivePoolSeedSalted } from './seedDerivation';
import {
  createCommitmentV3,
  findPoolV3,
  pubkeyToField,
  type ShareableNote,
} from './denominatedPool';
import { createNoteEncryptionAddress, decryptNote, encryptNote } from './noteCrypto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 11 + 5) & 0xff;

const PASSPHRASE = 'nine tigers argue quietly';
const LEGACY_SEED = derivePoolSeedLegacy(SIGNATURE);
const SALTED_SEED = derivePoolSeedSalted(SIGNATURE, PASSPHRASE);

/** The address this identity publishes (active = salted derivation). */
const MY_ADDRESS = createNoteEncryptionAddress(SALTED_SEED);
/** The address it published BEFORE adopting the passphrase. */
const MY_LEGACY_ADDRESS = createNoteEncryptionAddress(LEGACY_SEED);

const DENOM = 0.1;
const POOL = findPoolV3('SOL', DENOM)!;
const POOL_58 = POOL.poolPDA.toBase58();
const TOKEN_MINT_FIELD = pubkeyToField(POOL.tokenMint);
const META = 'meta-under-test';

/** Distinctive secrets: the no-secret-crosses assertion greps the serialized
 *  response for these exact decimal strings. */
const SECRET = 987654321987654321n;
const NULLIFIER_PREIMAGE = 876543219876543212n;
const BLINDING = 765432198765432123n;
const LEAF = 47;

/** A ShareableNote whose commitment REALLY recomputes from its secrets. */
function shareable(over: Partial<ShareableNote> = {}): ShareableNote {
  const commitment = createCommitmentV3(NULLIFIER_PREIMAGE, SECRET, BLINDING, TOKEN_MINT_FIELD);
  return {
    version: 1,
    pool: POOL_58,
    secret: SECRET.toString(),
    nullifier_preimage: NULLIFIER_PREIMAGE.toString(),
    deposit_epoch: BLINDING.toString(),
    token_mint: TOKEN_MINT_FIELD.toString(),
    commitment: commitment.toString(),
    leafIndex: LEAF,
    token: 'SOL',
    denominationHuman: DENOM,
    shieldedAt: 1_700_000_000_000,
    ...over,
  };
}

/** What a sender's Send tab produces: the note JSON, sealed to an address. */
function seal(note: ShareableNote, address = MY_ADDRESS): string {
  return encryptNote(address, utf8ToBytes(JSON.stringify(note)));
}

// ---------------------------------------------------------------------------
// Chain stub: the import's ONLY network touch is one nullifier read.
// ---------------------------------------------------------------------------

const chain = { spent: false, fail: false, reads: 0 };

/** The pool's leaves as the RPC serves them, used by `locateOwnedNote`. */
const chainLeaves = new Map<string, { commitment: bigint; leafIndex: number }>();

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    isNullifierSpent: async () => {
      chain.reads += 1;
      if (chain.fail) throw new Error('rpc down');
      return chain.spent;
    },
    fetchPoolCommitments: async () => chainLeaves,
  };
});

// None of these are on the import path; stubbed so no test can drift onto the
// network by accident, same belt-and-braces as poolExportNote.test.ts.
vi.mock('./poolNotes', () => ({
  scanPoolForSeed: async () => ({ notes: [] }),
  recoverNotes: async () => [],
}));
vi.mock('./recoverFloat', () => ({ recoverStuckFloat: async () => [] }));
vi.mock('./shieldEphemeral', () => ({
  readTreeLeafCount: async () => 0,
  prepareShield: async () => {
    throw new Error('not exercised');
  },
  executeShield: async () => {
    throw new Error('not exercised');
  },
  recordShieldBreadcrumb: async () => undefined,
}));
/**
 * The withdraw handler's proving half, captured instead of run: what matters
 * here is WHAT locateOwnedNote hands it, because everything downstream is
 * receipt-driven. The real thing proves C1 + C3 for minutes against a cluster.
 */
const unshieldJobs: Array<{ receipt: Record<string, unknown>; storedPath: unknown }> = [];
const subscribeJobs: Array<{ receipt: Record<string, unknown>; storedPath: unknown }> = [];
vi.mock('./subscribeEphemeral', () => ({
  prepareSubscribeJob: async (
    receipt: Record<string, unknown>,
    _pool: unknown,
    _conn: unknown,
    _seed: unknown,
    _onProgress: unknown,
    storedPath: unknown,
  ) => {
    subscribeJobs.push({ receipt, storedPath });
    return {
      jobId: 'subscribe-job-under-test',
      ephemeral: { publicKey: { toBase58: () => 'SubscribeEphemeral' } },
      requiredLamports: 43,
      receipt,
    };
  },
  executeSubscribe: async () => {
    throw new Error('not exercised');
  },
}));

// The subscribe prepare computes the subscriber commitment through the STARK
// wasm; a canned value keeps this suite free of the prover.
vi.mock('./starkProver', () => ({
  starkProver: { start: async () => undefined, computeCommitment: async () => '424242' },
}));

vi.mock('./unshieldEphemeral', () => ({
  prepareUnshieldJob: async (
    receipt: Record<string, unknown>,
    _pool: unknown,
    _conn: unknown,
    _seed: unknown,
    _onProgress: unknown,
    storedPath: unknown,
  ) => {
    unshieldJobs.push({ receipt, storedPath });
    return {
      jobId: 'job-under-test',
      ephemeral: { publicKey: { toBase58: () => 'EphemeralPubkey' } },
      requiredLamports: 42,
    };
  },
  executeUnshield: async () => {
    throw new Error('not exercised');
  },
}));

// Imported after the mocks so the handlers bind to the stubs.
const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  '../worker/poolHandlers'
);

// ---------------------------------------------------------------------------

function importReq(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'poolImportNote' as const,
    meta: META,
    sealedNote: seal(shareable()),
    ...overrides,
  };
}

/** Open a stored blob the way the worker itself would, under the active seed. */
function openOwnBlob(blob: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decryptNote(SALTED_SEED, blob)));
}

beforeEach(() => {
  clearPoolState();
  chain.spent = false;
  chain.fail = false;
  chain.reads = 0;
  unshieldJobs.length = 0;
  subscribeJobs.length = 0;
  // By default the RPC serves the received note's leaf, sitting where the
  // note says it does.
  chainLeaves.clear();
  const c = shareable().commitment;
  chainLeaves.set(c, { commitment: BigInt(c), leafIndex: LEAF });
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE, PASSPHRASE);
});

describe('importing a received note', () => {
  it('accepts a good note and returns its public view only', async () => {
    const res = await handlePoolRequest(importReq());

    expect(res.note).toMatchObject({
      pool: POOL_58,
      token: 'SOL',
      denomination: DENOM,
      leafIndex: LEAF,
      commitment: shareable().commitment,
      spent: false,
      spentKnown: true,
    });
    expect(res.merklePath).toBe('none');

    // The boundary assertion: serialize the whole response and grep for the
    // three secrets, rather than checking only the fields we remembered.
    const wire = JSON.stringify(res);
    for (const secret of [SECRET, NULLIFIER_PREIMAGE, BLINDING]) {
      expect(wire).not.toContain(secret.toString());
    }
  });

  it('re-encrypts into the exact blob shape the store already speaks', async () => {
    const res = await handlePoolRequest(importReq());

    // Opens under the ACTIVE seed: the note now belongs to this identity.
    const stored = openOwnBlob(res.encryptedNote);
    expect(stored).toMatchObject({
      version: 1,
      pool: POOL_58,
      secret: SECRET.toString(),
      nullifier_preimage: NULLIFIER_PREIMAGE.toString(),
      // The wire key stays `deposit_epoch` even though it carries the blinding;
      // `extractStoredPath` and `poolScanLocal` parse this exact shape.
      deposit_epoch: BLINDING.toString(),
      commitment: shareable().commitment,
      leafIndex: LEAF,
      source: 'received',
    });
  });

  it('is listed by poolScanLocal from then on, with no pool scan', async () => {
    // The mechanism behind "the note appears in the note lists of the other
    // tabs": those lists paint from the local blobs.
    const res = await handlePoolRequest(importReq());
    const local = await handlePoolRequest({
      kind: 'poolScanLocal' as const,
      meta: META,
      blobs: [res.encryptedNote],
    });
    expect(local.skipped).toBe(0);
    expect(local.notes).toHaveLength(1);
    expect(local.notes[0]).toMatchObject({
      pool: POOL_58,
      denomination: DENOM,
      leafIndex: LEAF,
      spent: false,
      spentKnown: false,
    });
  });

  it('carries the Merkle path through into the stored blob', async () => {
    const withPath = shareable({
      merkle_root: '123456789',
      merkle_path_elements: ['11', '22', '33'],
      merkle_path_indices: [1, 0, 1],
    });
    const res = await handlePoolRequest(importReq({ sealedNote: seal(withPath) }));
    expect(res.merklePath).toBe('stored');
    expect(openOwnBlob(res.encryptedNote).merklePath).toEqual({
      pathElements: ['11', '22', '33'],
      pathIndices: [1, 0, 1],
      root: '123456789',
    });
  });

  it('opens a note sealed to the address published BEFORE the passphrase', async () => {
    // The sender may hold an address handed out months ago. Same candidate
    // search as every other blob reader: active seed first, then legacy.
    const res = await handlePoolRequest(
      importReq({ sealedNote: seal(shareable(), MY_LEGACY_ADDRESS) }),
    );
    expect(res.note.leafIndex).toBe(LEAF);
    // Re-encrypted to the ACTIVE address regardless of which one received it.
    expect(openOwnBlob(res.encryptedNote).commitment).toBe(shareable().commitment);
  });
});

describe('the spent check is best effort, in exactly one direction', () => {
  it('refuses a note the chain proves already withdrawn', async () => {
    chain.spent = true;
    await expect(handlePoolRequest(importReq())).rejects.toThrow(/already been withdrawn/i);
  });

  it('imports anyway when the RPC fails, and says the status is unknown', async () => {
    // Losing a real note over a 429 would be the worse outcome; the claim is
    // downgraded instead of the note being refused.
    chain.fail = true;
    const res = await handlePoolRequest(importReq());
    expect(chain.reads).toBe(1);
    expect(res.note.spentKnown).toBe(false);
    expect(res.note.spent).toBe(false);
  });
});

describe('what it refuses', () => {
  it('rejects anything that is not a p01enc1 blob, before any cryptography', async () => {
    await expect(
      handlePoolRequest(importReq({ sealedNote: 'p01pq:AAAA' })),
    ).rejects.toThrow(/starts with "p01enc1:"/);
    expect(chain.reads).toBe(0);
  });

  it('rejects a blob sealed to somebody else', async () => {
    const stranger = createNoteEncryptionAddress(new Uint8Array(32).fill(0x11));
    await expect(
      handlePoolRequest(importReq({ sealedNote: seal(shareable(), stranger) })),
    ).rejects.toThrow(/not sealed to your address/i);
  });

  it('rejects a note whose commitment does not match its secrets', async () => {
    // THE integrity guard. A blob that decrypts fine but lies about its
    // commitment must never enter the store looking like money.
    const tampered = shareable();
    tampered.commitment = (BigInt(tampered.commitment) + 1n).toString();
    await expect(
      handlePoolRequest(importReq({ sealedNote: seal(tampered) })),
    ).rejects.toThrow(/commitment does not match/i);
  });

  it('rejects a sealed blob whose plaintext is not a note at all', async () => {
    const notJson = encryptNote(MY_ADDRESS, utf8ToBytes('hello there'));
    await expect(handlePoolRequest(importReq({ sealedNote: notJson }))).rejects.toThrow(
      /not a note/i,
    );
  });

  it('rejects an unsupported note version', async () => {
    const v2 = { ...shareable(), version: 2 } as unknown as ShareableNote;
    await expect(handlePoolRequest(importReq({ sealedNote: seal(v2) }))).rejects.toThrow(
      /Unsupported note version/i,
    );
  });

  it('refuses to import the same note twice', async () => {
    const first = await handlePoolRequest(importReq());
    await expect(
      handlePoolRequest(importReq({ encryptedNotes: [first.encryptedNote] })),
    ).rejects.toThrow(/already in your list/i);
  });

  it('refuses when no pool keys are derived for this session', async () => {
    clearPoolState();
    await expect(handlePoolRequest(importReq())).rejects.toThrow(/No pool keys/);
  });
});

describe('poolNoteAddress', () => {
  it('returns the ACTIVE derivation address, the one new notes are sealed to', async () => {
    const res = await handlePoolRequest({ kind: 'poolNoteAddress' as const, meta: META });
    expect(res.address).toBe(MY_ADDRESS);
  });

  it('returns the legacy address for a wallet with no passphrase', async () => {
    clearPoolState();
    setPoolSeed(META, SIGNATURE);
    const res = await handlePoolRequest({ kind: 'poolNoteAddress' as const, meta: META });
    expect(res.address).toBe(MY_LEGACY_ADDRESS);
  });

  it('refuses when no pool keys are derived for this session', async () => {
    clearPoolState();
    await expect(
      handlePoolRequest({ kind: 'poolNoteAddress' as const, meta: META }),
    ).rejects.toThrow(/No pool keys/);
  });
});

describe('the EXISTING withdraw path can spend a received note', () => {
  // The founder's success criterion, as a test: import the note, then run the
  // same poolUnshieldPrepare the Pool tab's Withdraw button runs, passing the
  // stored blobs it already passes. The seed scan misses (the secrets are the
  // sender's), the blob fallback must produce the exact receipt.

  function prepareReq(encryptedNotes: string[], overrides: Record<string, unknown> = {}) {
    return {
      kind: 'poolUnshieldPrepare' as const,
      meta: META,
      token: 'SOL' as const,
      denomination: DENOM,
      leafIndex: LEAF,
      encryptedNotes,
      ...overrides,
    };
  }

  it('rebuilds the exact receipt from the stored blob and hands it to the prover', async () => {
    const imported = await handlePoolRequest(importReq());
    const prep = await handlePoolRequest(prepareReq([imported.encryptedNote]));

    expect(prep).toMatchObject({
      jobId: 'job-under-test',
      ephemeralPubkey: 'EphemeralPubkey',
      denomination: DENOM,
      // The ACTIVE derivation: the withdrawal ephemeral is ours, whatever seed
      // minted the note.
      derivation: 2,
    });
    expect(unshieldJobs).toHaveLength(1);
    const receipt = unshieldJobs[0]!.receipt;
    expect(receipt.secret).toBe(SECRET);
    // The nullifier is a function of the NOTE's own secrets, never of the
    // bearer's seed: a wrong preimage here would produce a proof that fails
    // on-chain after ~150 chunk uploads and ~1 SOL of locked buffer rent.
    expect(receipt.nullifierPreimage).toBe(NULLIFIER_PREIMAGE);
    expect(receipt.noteBlinding).toBe(BLINDING);
    expect(receipt.commitment).toBe(BigInt(shareable().commitment));
    expect(receipt.leafIndex).toBe(LEAF);
    expect(receipt.source).toBe('received');
  });

  it('poolSubscribePrepare finds it through the same fallback: a received note can pay a subscription', async () => {
    const imported = await handlePoolRequest(importReq());
    const prep = await handlePoolRequest({
      kind: 'poolSubscribePrepare' as const,
      meta: META,
      token: 'SOL' as const,
      denomination: DENOM,
      leafIndex: LEAF,
      encryptedNotes: [imported.encryptedNote],
    });

    expect(prep).toMatchObject({
      ephemeralPubkey: 'SubscribeEphemeral',
      denomination: DENOM,
      derivation: 2,
    });
    expect(subscribeJobs).toHaveLength(1);
    const receipt = subscribeJobs[0]!.receipt;
    expect(receipt.secret).toBe(SECRET);
    expect(receipt.nullifierPreimage).toBe(NULLIFIER_PREIMAGE);
    expect(receipt.commitment).toBe(BigInt(shareable().commitment));
  });

  it('feeds the Merkle path that travelled with the note as the stored path', async () => {
    const withPath = shareable({
      merkle_root: '123456789',
      merkle_path_elements: ['11', '22', '33'],
      merkle_path_indices: [1, 0, 1],
    });
    const imported = await handlePoolRequest(importReq({ sealedNote: seal(withPath) }));
    await handlePoolRequest(prepareReq([imported.encryptedNote]));

    expect(unshieldJobs[0]!.storedPath).toEqual({
      pathElements: ['11', '22', '33'],
      pathIndices: [1, 0, 1],
      root: '123456789',
    });
  });

  it('refuses once the chain says the note was spent, e.g. by the sender', async () => {
    // The race the UI warns about: the sender kept a spendable copy and used
    // it first. The location step must refuse before any proving or funding.
    const imported = await handlePoolRequest(importReq());
    chain.spent = true;
    await expect(handlePoolRequest(prepareReq([imported.encryptedNote]))).rejects.toThrow(
      /already been withdrawn/i,
    );
    expect(unshieldJobs).toHaveLength(0);
  });

  it('skips a blob whose commitment sits at a different on-chain leaf', async () => {
    // A wrong leaf claim would send the prover after a membership it can never
    // prove; the blob is dropped and the honest not-found error stands.
    const imported = await handlePoolRequest(importReq());
    const c = shareable().commitment;
    chainLeaves.clear();
    chainLeaves.set(c, { commitment: BigInt(c), leafIndex: LEAF + 1 });
    await expect(handlePoolRequest(prepareReq([imported.encryptedNote]))).rejects.toThrow(
      /No note of yours found/,
    );
  });

  it('proceeds when the RPC no longer serves the leaf at all', async () => {
    // A pruned RPC cannot disprove the note, and the stored Merkle path can
    // still carry the withdrawal; prepareUnshieldJob's root-ring pre-flight is
    // the guard that no rent is burned on a wrong claim.
    const imported = await handlePoolRequest(importReq());
    chainLeaves.clear();
    await handlePoolRequest(prepareReq([imported.encryptedNote]));
    expect(unshieldJobs).toHaveLength(1);
  });

  it('still refuses a leaf that no seed and no blob can explain', async () => {
    await expect(handlePoolRequest(prepareReq([], { leafIndex: 999 }))).rejects.toThrow(
      /No note of yours found/,
    );
    expect(unshieldJobs).toHaveLength(0);
  });
});
