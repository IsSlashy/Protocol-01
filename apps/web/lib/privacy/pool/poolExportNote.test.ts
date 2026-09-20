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
  buildMerkleProofFromLeavesV3,
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

/**
 * A note this wallet RECEIVED (issued to it, or handed over and imported). Its
 * secrets are the sender's, so no seed search finds it: only the blob
 * `handlePoolImportNote` filed resolves it. It sits below SPENT_LEAF, so the
 * tree the walk reads still ends past it.
 */
const RECEIVED_LEAF = 27;
const RECEIVED = { secret: 27_000_001n, nullifierPreimage: 27_000_002n, noteBlinding: 7_284_991_002_338_477_113n };
const RECEIVED_COMMITMENT = createCommitmentV3(
  RECEIVED.nullifierPreimage,
  RECEIVED.secret,
  RECEIVED.noteBlinding,
  TOKEN_MINT_FIELD,
);

function notesForSeed(seed: Uint8Array): RecoveredNote[] {
  const hex = bytesToHex(seed);
  if (hex === LEGACY_HEX) return [LEGACY_NOTE];
  if (hex === SALTED_HEX) return [SALTED_NOTE, SPENT_NOTE];
  return [];
}

/**
 * The path the export must ship: the pool leaves as this RPC serves them,
 * folded by the production builder. Computed here rather than written down so
 * it cannot drift from `leavesFromCommitments` + `buildMerkleProofFromLeavesV3`,
 * which is what the handler runs.
 */
function rebuiltRootOfSaltedNote(): string {
  const dense: bigint[] = new Array(SPENT_LEAF + 1).fill(0n);
  for (const n of [LEGACY_NOTE, SALTED_NOTE, SPENT_NOTE]) {
    dense[n.receipt.leafIndex] = n.receipt.commitment;
  }
  return buildMerkleProofFromLeavesV3({
    leavesByIndex: dense,
    targetLeafIndex: SALTED_LEAF,
  }).root.toString();
}

const seen = { recoverNotes: [] as string[], commitmentFetches: 0 };
/**
 * Which leaves the stubbed RPC serves. Below `servedBelow` only: an RPC behind
 * a deposit. `withReceived` adds the received note's leaf to the walk.
 * `report` is what the walk says it could not read (`PoolWalkReport.unread`),
 * or 'none' for a walk that makes no report.
 */
const rpc = {
  servedBelow: Number.POSITIVE_INFINITY,
  withReceived: false,
  report: 0 as number | 'none',
};

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
    fetchPoolCommitments: async (
      _conn: unknown,
      _pda: unknown,
      options?: { onWalked?: (report: { unread: number }) => void },
    ) => {
      seen.commitmentFetches += 1;
      // The real walk reports what it could not read once it ends; so does this one.
      if (rpc.report !== 'none') options?.onWalked?.({ unread: rpc.report });
      const map = new Map<string, { commitment: bigint; leafIndex: number }>();
      for (const n of [LEGACY_NOTE, SALTED_NOTE, SPENT_NOTE]) {
        if (n.receipt.leafIndex >= rpc.servedBelow) continue;
        map.set(n.receipt.commitment.toString(), {
          commitment: n.receipt.commitment,
          leafIndex: n.receipt.leafIndex,
        });
      }
      if (rpc.withReceived) {
        map.set(RECEIVED_COMMITMENT.toString(), { commitment: RECEIVED_COMMITMENT, leafIndex: RECEIVED_LEAF });
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
  rpc.servedBelow = Number.POSITIVE_INFINITY;
  rpc.withReceived = false;
  rpc.report = 0;
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
    // Since UI-1 neither is the leaf index nor the commitment: SendForm printed
    // both beside the sealed note, and the deposit published both. The note is
    // named by its tag (`poolNoteTag.test.ts`).
    expect(res).not.toHaveProperty('commitment');
    expect(res).not.toHaveProperty('leafIndex');
    expect(wire).not.toContain(SALTED_NOTE.receipt.commitment.toString());
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

  it('ships a rebuilt path, never the root stored at shield time', async () => {
    // 🚨 THE STORED ROOT DATES THE DEPOSIT. A path captured at shield time folds
    // to the root that note's OWN insertion created, so shipping it hands the
    // recipient — and the chain, the moment they spend — a value saying how many
    // leaves existed when this note was deposited. The pool accepts it (it is
    // still in the ring), so nothing fails and the link is simply published.
    // Measured: 1 v4 spend of 34 named a root 4 insertions stale
    // (`scratchpad/probe-stale-root-2026-09-15.log`).
    //
    // A REAL stored blob is used, sealed to the sender's own derivation, so
    // `extractStoredPath` runs its real decrypt-and-match: if the handler still
    // preferred the stored path, this case would see it.
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
    expect(res.merklePath).toBe('rebuilt');

    const opened = open(res.sealedNote, RECIPIENT_SEED);
    expect(opened.merkle_root).not.toBe('123456789');
    expect(opened.merkle_path_elements?.[0]).not.toBe('900');
    // And it is the CURRENT tree, not merely a different one.
    expect(opened.merkle_root).toBe(rebuiltRootOfSaltedNote());
    expect(opened.merkle_path_elements).toHaveLength(MERKLE_DEPTH);
  });

  it('ships no path, never the stored one, when the rebuild cannot place the note', async () => {
    // The case above only covers a rebuild that SUCCEEDS. When this RPC does
    // not serve the note's leaf yet (it is behind the deposit, e.g. a received
    // note handed over soon after issuance), the rebuild throws, and the stored
    // path is the one witness left in hand. It still folds to the root of the
    // note's own insertion, so the export ships no path at all and the
    // recipient rebuilds later. Control: mutant N8 (stored path shipped from
    // the catch branch), `scratchpad/web-run/logs/SPEND-1-web-fix1/`.
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
    // Anti-vacuity: the stored blob opens under the sender's seed and describes
    // THIS note, so a handler that shipped it would ship exactly this root...
    const storedPlain = JSON.parse(new TextDecoder().decode(decryptNote(SALTED_SEED, stored)));
    expect(storedPlain.commitment).toBe(SALTED_NOTE.receipt.commitment.toString());
    expect(storedPlain.merklePath.root).toBe('123456789');
    // ...and from the leaves this RPC serves, the rebuild really throws.
    rpc.servedBelow = SALTED_LEAF;
    const served = new Array<bigint>(LEGACY_LEAF + 1).fill(0n);
    served[LEGACY_LEAF] = LEGACY_NOTE.receipt.commitment;
    expect(() =>
      buildMerkleProofFromLeavesV3({ leavesByIndex: served, targetLeafIndex: SALTED_LEAF }),
    ).toThrow();

    const res = await handlePoolRequest(exportReq({ encryptedNotes: [stored] }));
    expect(seen.commitmentFetches, 'the export did not read the pool leaves').toBeGreaterThan(0);
    expect(res.merklePath).toBe('none');

    const raw = new TextDecoder().decode(decryptNote(RECIPIENT_SEED, res.sealedNote));
    const opened = JSON.parse(raw) as ShareableNote;
    expect(opened.merkle_root).toBeUndefined();
    expect(opened.merkle_path_elements).toBeUndefined();
    expect(opened.merkle_path_indices).toBeUndefined();
    expect(raw, 'the sealed note carries the stored root').not.toContain('"123456789"');
    expect(raw, 'the sealed note carries a stored path element').not.toContain('"900"');
    // The sealed blob is random bytes (read through `raw` above); the rest is not.
    expect(JSON.stringify({ ...res, sealedNote: '' }), 'the response carries the stored root').not.toContain(
      '123456789',
    );
    // Still a note the recipient can import: only the path is left off.
    expect(shareableNoteToReceipt(opened).commitment).toBe(SALTED_NOTE.receipt.commitment);
  });

  it('ships a rebuilt path, never the issuance-time path, for a note it RECEIVED', async () => {
    // Every case above exports a note the seed search found (source
    // 'shielded'). A RECEIVED note is resolved from the blob
    // `handlePoolImportNote` filed, and that blob carries the issuer's path: a
    // root taken at issuance, right after the buyer's own deposit. Handing it
    // on would give any client that prefers a carried path a root that dates
    // the purchase. Control: mutant EXRCV (a received note's filed path shipped
    // as 'stored'), `scratchpad/web-run/logs/verify-SPEND-1-r3b/mutants/`,
    // re-run in `scratchpad/web-run/logs2/SPEND-1-cr1/`.
    rpc.withReceived = true;
    const issuedPath = {
      pathElements: Array.from({ length: MERKLE_DEPTH }, (_, i) => String(700 + i)),
      pathIndices: Array.from({ length: MERKLE_DEPTH }, () => 0),
      root: '987654321',
    };
    // Sealed to the ACTIVE derivation, in the shape `handlePoolImportNote` files.
    const filed = encryptNote(
      createNoteEncryptionAddress(SALTED_SEED),
      utf8ToBytes(
        JSON.stringify({
          version: 1,
          pool: POOL_58,
          secret: RECEIVED.secret.toString(),
          nullifier_preimage: RECEIVED.nullifierPreimage.toString(),
          deposit_epoch: RECEIVED.noteBlinding.toString(),
          token_mint: TOKEN_MINT_FIELD.toString(),
          commitment: RECEIVED_COMMITMENT.toString(),
          leafIndex: RECEIVED_LEAF,
          merklePath: issuedPath,
          token: 'SOL',
          denominationHuman: DENOM,
          shieldedAt: 0,
          source: 'received',
        }),
      ),
    );

    const res = await handlePoolRequest(exportReq({ leafIndex: RECEIVED_LEAF, encryptedNotes: [filed] }));
    // Anti-vacuity: the note came from its filed blob (no seed search ran) and is the received one.
    expect(seen.recoverNotes, 'the seed search ran, so the note was not resolved from its blob').toEqual([]);
    // Which note was exported is read from the sealed note below (UI-1: the
    // response no longer names the commitment).
    expect(res).not.toHaveProperty('commitment');

    expect(res.merklePath).toBe('rebuilt');
    const raw = new TextDecoder().decode(decryptNote(RECIPIENT_SEED, res.sealedNote));
    const opened = JSON.parse(raw) as ShareableNote;
    expect(opened.merkle_root, 'the export shipped the issuance-time root').not.toBe('987654321');
    expect(raw, 'the sealed note carries the issuance-time root').not.toContain('"987654321"');
    expect(raw, 'the sealed note carries an issuance-time path element').not.toContain('"700"');
    // And it is the tree the walk read, not merely a different one.
    const dense: bigint[] = new Array(SPENT_LEAF + 1).fill(0n);
    for (const n of [LEGACY_NOTE, SALTED_NOTE, SPENT_NOTE]) dense[n.receipt.leafIndex] = n.receipt.commitment;
    dense[RECEIVED_LEAF] = RECEIVED_COMMITMENT;
    expect(opened.merkle_root).toBe(
      buildMerkleProofFromLeavesV3({ leavesByIndex: dense, targetLeafIndex: RECEIVED_LEAF }).root.toString(),
    );
    expect(shareableNoteToReceipt(opened).commitment).toBe(RECEIVED_COMMITMENT);
  });

  it('ships no path when the walk ends at the note or left listed inserts unread', async () => {
    // A rebuilt path is only as good as the walk behind it. When the note is
    // the newest leaf that walk read, the path folds to the note's own deposit
    // root; when the walk left listed inserts unread, the map may end where
    // this client last read, often its own purchase. A recipient that spends
    // on the carried path names a root that dates the note, and the v3 route
    // and the extension and mobile clients prefer a carried path. So the
    // export ships no path there, and the recipient rebuilds from history
    // (verifier r2 of the continued run, minor 3; controls in
    // `scratchpad/web-run/logs2/SPEND-1-cr2/`). The control worlds ship the
    // rebuilt path.
    const filedReceived = encryptNote(
      createNoteEncryptionAddress(SALTED_SEED),
      utf8ToBytes(
        JSON.stringify({
          version: 1,
          pool: POOL_58,
          secret: RECEIVED.secret.toString(),
          nullifier_preimage: RECEIVED.nullifierPreimage.toString(),
          deposit_epoch: RECEIVED.noteBlinding.toString(),
          token_mint: TOKEN_MINT_FIELD.toString(),
          commitment: RECEIVED_COMMITMENT.toString(),
          leafIndex: RECEIVED_LEAF,
          merklePath: {
            pathElements: Array.from({ length: MERKLE_DEPTH }, (_, i) => String(700 + i)),
            pathIndices: Array.from({ length: MERKLE_DEPTH }, () => 0),
            root: '987654321',
          },
          token: 'SOL',
          denominationHuman: DENOM,
          shieldedAt: 0,
          source: 'received',
        }),
      ),
    );
    const worlds: Array<{ label: string; received: boolean; servedBelow: number; report: number | 'none'; want: string }> = [
      { label: 'own note, the newest leaf the walk read, nothing unread', received: false, servedBelow: SPENT_LEAF, report: 0, want: 'none' },
      { label: 'own note, walk left 2 listed inserts unread', received: false, servedBelow: Number.POSITIVE_INFINITY, report: 2, want: 'none' },
      { label: 'own note, walk made no report', received: false, servedBelow: Number.POSITIVE_INFINITY, report: 'none', want: 'none' },
      { label: 'received note, the newest leaf the walk read, nothing unread', received: true, servedBelow: SPENT_LEAF, report: 0, want: 'none' },
      { label: 'received note, walk left 1 listed insert unread', received: true, servedBelow: Number.POSITIVE_INFINITY, report: 1, want: 'none' },
      { label: 'control: own note, map past the note, nothing unread', received: false, servedBelow: Number.POSITIVE_INFINITY, report: 0, want: 'rebuilt' },
      { label: 'control: received note, map past the note, nothing unread', received: true, servedBelow: Number.POSITIVE_INFINITY, report: 0, want: 'rebuilt' },
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const w of worlds) {
      rpc.withReceived = w.received;
      rpc.servedBelow = w.servedBelow;
      rpc.report = w.report;
      const res = await handlePoolRequest(
        w.received ? exportReq({ leafIndex: RECEIVED_LEAF, encryptedNotes: [filedReceived] }) : exportReq(),
      );
      const raw = new TextDecoder().decode(decryptNote(RECIPIENT_SEED, res.sealedNote));
      const opened = JSON.parse(raw) as ShareableNote;
      // Anti-vacuity: the note exported is the one this world names.
      expect(opened.commitment, w.label).toBe(
        (w.received ? RECEIVED_COMMITMENT : SALTED_NOTE.receipt.commitment).toString(),
      );
      const carried = opened.merkle_root === undefined && opened.merkle_path_elements === undefined
        ? 'no path in the sealed note'
        : 'a path in the sealed note';
      got.push(`${w.label} => ${res.merklePath}; ${carried}`);
      want.push(`${w.label} => ${w.want}; ${w.want === 'none' ? 'no path in the sealed note' : 'a path in the sealed note'}`);
      // Still a note the recipient can import: only the path is left off.
      expect(shareableNoteToReceipt(opened).commitment, w.label).toBe(
        w.received ? RECEIVED_COMMITMENT : SALTED_NOTE.receipt.commitment,
      );
    }
    expect(got).toEqual(want);
  });

  it('ships no path whose root is the one filed with the note, when the walk ends where that root was taken', async () => {
    // The walk can end exactly where the note's filed root was taken: a
    // received note's issuance-time root, right after the buyer's own deposit,
    // with nothing newer listed yet. That walk read all it listed and does not
    // end at the note, so no rule above holds its path back, and its root IS
    // the filed one, reached through the leaves. A recipient spending on the
    // carried path names the moment of the purchase, and the v3 route and the
    // extension and mobile clients prefer a carried path. So none ships,
    // whatever the note's source (verifier r4 of the continued run, minor;
    // `scratchpad/web-run/logs2/verify-SPEND-1-r4/probe/export-NONE.log`). The
    // control worlds carry a root filed at another point and ship the rebuilt path.
    const walkPath = (target: number, withReceived: boolean, upTo: number) => {
      const dense: bigint[] = new Array(upTo + 1).fill(0n);
      for (const n of [LEGACY_NOTE, SALTED_NOTE, SPENT_NOTE]) {
        if (n.receipt.leafIndex <= upTo) dense[n.receipt.leafIndex] = n.receipt.commitment;
      }
      if (withReceived && RECEIVED_LEAF <= upTo) dense[RECEIVED_LEAF] = RECEIVED_COMMITMENT;
      const p = buildMerkleProofFromLeavesV3({ leavesByIndex: dense, targetLeafIndex: target });
      return { pathElements: p.pathElements.map(String), pathIndices: p.pathIndices, root: p.root.toString() };
    };
    const filedReceived = (merklePath: ReturnType<typeof walkPath>) =>
      encryptNote(
        createNoteEncryptionAddress(SALTED_SEED),
        utf8ToBytes(
          JSON.stringify({
            version: 1,
            pool: POOL_58,
            secret: RECEIVED.secret.toString(),
            nullifier_preimage: RECEIVED.nullifierPreimage.toString(),
            deposit_epoch: RECEIVED.noteBlinding.toString(),
            token_mint: TOKEN_MINT_FIELD.toString(),
            commitment: RECEIVED_COMMITMENT.toString(),
            leafIndex: RECEIVED_LEAF,
            merklePath,
            token: 'SOL',
            denominationHuman: DENOM,
            shieldedAt: 0,
            source: 'received',
          }),
        ),
      );
    const storedOwn = (merklePath: ReturnType<typeof walkPath>) =>
      encryptNote(
        createNoteEncryptionAddress(SALTED_SEED),
        utf8ToBytes(JSON.stringify({ version: 1, commitment: SALTED_NOTE.receipt.commitment.toString(), merklePath })),
      );
    // The export walks to SPENT_LEAF with nothing unread (the defaults).
    const worlds = [
      {
        label: 'received note, filed root taken where the walk ends',
        received: true, filed: walkPath(RECEIVED_LEAF, true, SPENT_LEAF), ships: false,
      },
      {
        label: 'own note, stored root taken where the walk ends',
        received: false, filed: walkPath(SALTED_LEAF, false, SPENT_LEAF), ships: false,
      },
      {
        label: 'control: received note, filed root taken before the walk\'s end',
        received: true, filed: walkPath(RECEIVED_LEAF, true, RECEIVED_LEAF), ships: true,
      },
      {
        label: 'control: own note, stored root of its own insertion',
        received: false, filed: walkPath(SALTED_LEAF, false, SALTED_LEAF), ships: true,
      },
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const w of worlds) {
      rpc.withReceived = w.received;
      const walkRoot = walkPath(w.received ? RECEIVED_LEAF : SALTED_LEAF, w.received, SPENT_LEAF).root;
      // Anti-vacuity: the tied worlds' filed root IS the root this walk folds to; the controls' is not.
      expect(w.filed.root === walkRoot, w.label).toBe(!w.ships);
      const res = await handlePoolRequest(
        w.received
          ? exportReq({ leafIndex: RECEIVED_LEAF, encryptedNotes: [filedReceived(w.filed)] })
          : exportReq({ encryptedNotes: [storedOwn(w.filed)] }),
      );
      const raw = new TextDecoder().decode(decryptNote(RECIPIENT_SEED, res.sealedNote));
      const opened = JSON.parse(raw) as ShareableNote;
      // Anti-vacuity: the note exported is the one this world names.
      expect(opened.commitment, w.label).toBe((w.received ? RECEIVED_COMMITMENT : SALTED_NOTE.receipt.commitment).toString());
      const carried = opened.merkle_root === undefined && opened.merkle_path_elements === undefined
        ? 'no path in the sealed note'
        : opened.merkle_root === walkRoot ? 'the walk\'s path in the sealed note' : 'another path in the sealed note';
      const filedShipped = raw.includes(`"${w.filed.root}"`) ? 'the filed root shipped' : 'the filed root not shipped';
      got.push(`${w.label} => ${res.merklePath}; ${carried}; ${w.ships ? 'control' : filedShipped}`);
      want.push(
        w.ships
          ? `${w.label} => rebuilt; the walk's path in the sealed note; control`
          : `${w.label} => none; no path in the sealed note; the filed root not shipped`,
      );
      // Still a note the recipient can import: only the path is left off.
      expect(shareableNoteToReceipt(opened).commitment, w.label).toBe(
        w.received ? RECEIVED_COMMITMENT : SALTED_NOTE.receipt.commitment,
      );
    }
    expect(got).toEqual(want);
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

// ---------------------------------------------------------------------------
// Web sweep 4, round 1: what the sealed string tells whoever holds or sees it.
// ---------------------------------------------------------------------------

describe('the handoff carries no holder time and has one length', () => {
  beforeEach(() => setPoolSeed(META, SIGNATURE, PASSPHRASE));

  /** BN254: secrets, nullifier preimages and mint fields are reduced mod this. */
  const BN254 = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

  /**
   * A RECEIVED note in the shape `handlePoolImportNote` filed it before this
   * round: `shieldedAt` was the moment this device imported it, seconds after
   * the till payment that bought it, and the export sealed it on.
   */
  function filedReceived(
    shieldedAt: number | undefined,
    note: { secret: bigint; nullifierPreimage: bigint; noteBlinding: bigint } = RECEIVED,
  ): string {
    const commitment = createCommitmentV3(note.nullifierPreimage, note.secret, note.noteBlinding, TOKEN_MINT_FIELD);
    return encryptNote(
      createNoteEncryptionAddress(SALTED_SEED),
      utf8ToBytes(
        JSON.stringify({
          version: 1,
          pool: POOL_58,
          secret: note.secret.toString(),
          nullifier_preimage: note.nullifierPreimage.toString(),
          deposit_epoch: note.noteBlinding.toString(),
          token_mint: TOKEN_MINT_FIELD.toString(),
          commitment: commitment.toString(),
          leafIndex: RECEIVED_LEAF,
          token: 'SOL',
          denominationHuman: DENOM,
          ...(shieldedAt === undefined ? {} : { shieldedAt }),
          source: 'received',
        }),
      ),
    );
  }

  const plaintextOf = (sealed: string) => new TextDecoder().decode(decryptNote(RECIPIENT_SEED, sealed));

  it('hands the recipient no time: a note filed at two different moments seals the same plaintext', async () => {
    rpc.withReceived = true;
    const opened: string[] = [];
    for (const importedAt of [1_758_300_123_456, 1_758_399_999_999]) {
      const res = await handlePoolRequest(
        exportReq({ leafIndex: RECEIVED_LEAF, encryptedNotes: [filedReceived(importedAt)] }),
      );
      opened.push(plaintextOf(res.sealedNote));
    }
    // Anti-vacuity: both came from the filed blob and seal the received note.
    expect(seen.recoverNotes, 'the seed search ran, so the note was not resolved from its blob').toEqual([]);
    expect(shareableNoteToReceipt(JSON.parse(opened[0]) as ShareableNote).commitment).toBe(RECEIVED_COMMITMENT);
    expect(opened[1], 'the sealed plaintext moves with the moment the holder filed the note').toBe(opened[0]);

    // An own note hands over no time either, although its receipt carries one.
    const own = open((await handlePoolRequest(exportReq())).sealedNote, RECIPIENT_SEED);
    expect(SALTED_NOTE.receipt.shieldedAt, 'anti-vacuity: the receipt has a time to leak').toBeGreaterThan(0);
    expect(Object.keys(own)).not.toContain('shieldedAt');
  });

  it('seals every handoff to one length, whatever the note, its source, its path or its digits', async () => {
    const lengths: Record<string, number> = {};
    lengths['own, rebuilt path'] = (await handlePoolRequest(exportReq())).sealedNote.length;
    lengths['own before the passphrase, rebuilt path'] = (
      await handlePoolRequest(exportReq({ leafIndex: LEGACY_LEAF }))
    ).sealedNote.length;

    rpc.report = 1;
    const noPath = await handlePoolRequest(exportReq());
    expect(noPath.merklePath, 'anti-vacuity: this world ships no path').toBe('none');
    lengths['own, no path'] = noPath.sealedNote.length;
    rpc.report = 0;

    rpc.withReceived = true;
    lengths['received, filed with a time'] = (
      await handlePoolRequest(exportReq({ leafIndex: RECEIVED_LEAF, encryptedNotes: [filedReceived(1_758_300_123_456)] }))
    ).sealedNote.length;
    // The longest values a web note holds: three BN254-reduced fields at 77
    // digits and a 63-bit blinding.
    const longest = { secret: BN254 - 1n, nullifierPreimage: BN254 - 2n, noteBlinding: 2n ** 63n - 1n };
    const long = await handlePoolRequest(
      exportReq({ leafIndex: RECEIVED_LEAF, encryptedNotes: [filedReceived(undefined, longest)] }),
    );
    expect(open(long.sealedNote, RECIPIENT_SEED).secret, 'anti-vacuity: the long note was sealed').toBe(
      longest.secret.toString(),
    );
    expect(long.merklePath, 'anti-vacuity: the long note carries a path').toBe('rebuilt');
    lengths['received, longest values, rebuilt path'] = long.sealedNote.length;

    expect(new Set(Object.values(lengths)).size, JSON.stringify(lengths)).toBe(1);
    /**
     * ⛔ STILL ONE QR CODE, AND THE MARGIN IS PINNED WHERE THE CLIFF IS
     * (gate r1, RED 7b).
     *
     * SendForm draws the code while the sealed string is at most
     * `QR_BYTE_CAPACITY` and shows "Too long for a QR code" otherwise. This used
     * to assert `<= 2_900` against that same literal — and every handoff now
     * measures exactly 2,900, so the assertion had NO margin at all and read as
     * a guarantee.
     *
     * ⚠️ AND THE MARGIN IS NOT AT THE QR CEILING, IT IS AT THE PADDING BUCKET.
     * A sealed handoff is a fixed size because the plaintext is padded to
     * `SEALED_HANDOFF_BYTES` (1,008, `worker/poolHandlers.ts`). One byte past
     * that bucket pads to the NEXT one, 2,016, and the sealed string roughly
     * doubles — far past any QR code. So 53 characters of slack under the ISO
     * ceiling (2,953, version 40 / EC L / byte mode) would buy nothing: the
     * number a new field actually eats is the room left inside the bucket, and
     * that is what is asserted here.
     */
    const QR_BYTE_CAPACITY = 2_900;
    const SEALED_HANDOFF_BYTES = 1_008;
    /** One more field, generously sized, must still fit inside the bucket. */
    const BUCKET_MARGIN = 128;

    expect(
      Object.values(lengths)[0],
      'a sealed handoff no longer fits the QR code SendForm draws',
    ).toBeLessThanOrEqual(QR_BYTE_CAPACITY);

    const content = new TextEncoder().encode(
      JSON.stringify(open(long.sealedNote, RECIPIENT_SEED)),
    ).length;
    expect(
      content,
      `the longest handoff is within ${BUCKET_MARGIN} bytes of SEALED_HANDOFF_BYTES: one more field pads it into the next bucket, the sealed string roughly doubles, and the QR code disappears for every user at once`,
    ).toBeLessThanOrEqual(SEALED_HANDOFF_BYTES - BUCKET_MARGIN);
  });
});
