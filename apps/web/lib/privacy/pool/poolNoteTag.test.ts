/**
 * The worker names every note it hands the page by its TAG (UI-1, ledger row
 * D14), and the hand-over response names it by nothing else.
 *
 * WHY THIS FILE EXISTS BESIDE THE RENDER TESTS. The panel tests
 * (`__tests__/components/PoolPanel.test.tsx` and friends) stub the worker and
 * feed the page a `tag`, so they cannot see whether the worker actually sends
 * one. This file runs the REAL handlers on the `poolImportNote.test.ts`
 * harness (real hybrid encryption, real commitments, only the chain stubbed)
 * and checks the five places a note view is made:
 *   - `poolImportNote` (a received or issued note),
 *   - `poolScanLocal` (the first paint of every note list), including the
 *     ORDER, which used to be leaf order and so oldest-deposit-first,
 *   - `poolScan` (the chain scan, `toNoteView`: the list every panel shows
 *     once the walk has answered; UI-1 fix round 1),
 *   - `poolShieldExecute` (the deposit's success card),
 *   - `poolExportNote` (the hand-over), which used to return the leaf index and
 *     the commitment to the page, where SendForm printed them beside the
 *     sealed note.
 * The expected tag is computed here with `noteTag` over the note's own
 * secrets; `noteTag.test.ts` pins that function to its vector.
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { derivePoolSeedSalted } from './seedDerivation';
import { createCommitmentV3, findPoolV3, pubkeyToField, type ShareableNote } from './denominatedPool';
import { createNoteEncryptionAddress, encryptNote } from './noteCrypto';
import { noteTag } from './noteTag';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 13 + 7) & 0xff;
const PASSPHRASE = 'seven owls count slowly';
const SALTED_SEED = derivePoolSeedSalted(SIGNATURE, PASSPHRASE);
const MY_ADDRESS = createNoteEncryptionAddress(SALTED_SEED);
const META = 'meta-note-tag';

const POOL = findPoolV3('SOL', 0.1)!;
const POOL_58 = POOL.poolPDA.toBase58();
const TOKEN_MINT_FIELD = pubkeyToField(POOL.tokenMint);

/** The UI-1 leaf canary: a response that carries it names the deposit. */
const CANARY_LEAF = 987654;

interface Secrets {
  secret: bigint;
  nullifierPreimage: bigint;
  blinding: bigint;
  leafIndex: number;
}

/** Three notes whose LEAF order is the reverse of their TAG order (checked below). */
const NOTES: Secrets[] = [
  { secret: 111111111111111111n, nullifierPreimage: 211111111111111111n, blinding: 311111111111111111n, leafIndex: 3 },
  { secret: 122222222222222222n, nullifierPreimage: 222222222222222222n, blinding: 322222222222222222n, leafIndex: 7 },
  { secret: 133333333333333333n, nullifierPreimage: 233333333333333333n, blinding: 333333333333333333n, leafIndex: CANARY_LEAF },
];

function shareable(s: Secrets, pool = POOL_58, denominationHuman = 0.1): ShareableNote {
  const commitment = createCommitmentV3(s.nullifierPreimage, s.secret, s.blinding, TOKEN_MINT_FIELD);
  return {
    version: 1,
    pool,
    secret: s.secret.toString(),
    nullifier_preimage: s.nullifierPreimage.toString(),
    deposit_epoch: s.blinding.toString(),
    token_mint: TOKEN_MINT_FIELD.toString(),
    commitment: commitment.toString(),
    leafIndex: s.leafIndex,
    token: 'SOL',
    denominationHuman,
    shieldedAt: 1_700_000_000_000,
  };
}

const tagOf = (s: Secrets, pool = POOL_58) =>
  noteTag({ pool, secret: s.secret, nullifierPreimage: s.nullifierPreimage });

const seal = (note: ShareableNote) => encryptNote(MY_ADDRESS, utf8ToBytes(JSON.stringify(note)));

// ---------------------------------------------------------------------------
// Chain stub (the same shape as poolImportNote.test.ts)
// ---------------------------------------------------------------------------

const chainLeaves = new Map<string, { commitment: bigint; leafIndex: number }>();

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    fetchSpentNullifierSet: async () => new Set<string>(),
    isNullifierSpentInSet: () => false,
    fetchPoolCommitments: async () => chainLeaves,
    readPoolUnspentCount: async () => 0,
  };
});

/** What the chain scan's blinded pass "finds": the seed-matching half of
 *  `scanPoolForSeed` is not under test here, the view built from its result is. */
const chainFound = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('./poolNotes', () => ({
  scanPoolForSeed: async (_conn: unknown, _pool: unknown, _seed: unknown, opts?: { blindedOnly?: boolean }) => ({
    notes: opts?.blindedOnly ? chainFound.value : [],
  }),
  recoverNotes: async () => [],
}));
vi.mock('./recoverFloat', () => ({ recoverStuckFloat: async () => [] }));

/** The shield's proving and sending halves, replaced by a canned receipt. */
const shieldReceipt = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('./shieldEphemeral', () => ({
  readTreeLeafCount: async () => 0,
  prepareShield: async () => ({
    jobId: 'shield-job-under-test',
    ephemeral: { publicKey: { toBase58: () => 'ShieldEphemeral' } },
    requiredLamports: 1,
    valueLamports: 1,
    prepared: {
      insertParams: { leafIndex: 5 },
      merklePath: { pathElements: [1n, 2n], pathIndices: [0, 1], root: 3n },
    },
  }),
  executeShield: async () => ({ txSig: 'ShieldTxSig', receipt: shieldReceipt.value }),
  recordShieldBreadcrumb: async () => undefined,
}));
vi.mock('./subscribeEphemeral', () => ({
  prepareSubscribeJob: async () => {
    throw new Error('not exercised');
  },
  executeSubscribe: async () => {
    throw new Error('not exercised');
  },
}));
vi.mock('./starkProver', () => ({
  starkProver: { start: async () => undefined, computeCommitment: async () => '424242' },
}));
vi.mock('./unshieldEphemeral', () => ({
  prepareUnshieldJob: async () => {
    throw new Error('not exercised');
  },
  executeUnshield: async () => {
    throw new Error('not exercised');
  },
}));

const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  '../worker/poolHandlers'
);

async function importNote(s: Secrets) {
  return handlePoolRequest({ kind: 'poolImportNote' as const, meta: META, sealedNote: seal(shareable(s)) });
}

beforeEach(() => {
  clearPoolState();
  chainFound.value = [];
  chainLeaves.clear();
  for (const s of NOTES) {
    const c = shareable(s).commitment;
    chainLeaves.set(c, { commitment: BigInt(c), leafIndex: s.leafIndex });
  }
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE, PASSPHRASE);
});

describe('the worker names each note by its tag', () => {
  it('the fixture is a real test of ordering: leaf order is not tag order', () => {
    // Anti-vacuity for the ordering case below: if the three tags happened to
    // sort like the three leaves, "ordered by tag" would pass on leaf order.
    const byLeaf = [...NOTES].sort((a, b) => a.leafIndex - b.leafIndex).map((s) => tagOf(s).text);
    const byTag = NOTES.map((s) => tagOf(s).text).sort();
    expect(byLeaf).not.toEqual(byTag);
  });

  it('poolImportNote returns the received note with its tag', async () => {
    const res = await importNote(NOTES[2]!);
    expect((res.note as { tag?: unknown }).tag).toEqual(tagOf(NOTES[2]!));
  });

  it('poolScanLocal tags every note and lists them by denomination then tag, not by leaf', async () => {
    const blobs: string[] = [];
    for (const s of NOTES) blobs.push((await importNote(s)).encryptedNote);
    const local = await handlePoolRequest({ kind: 'poolScanLocal' as const, meta: META, blobs });
    expect(local.skipped).toBe(0);
    const tags = local.notes.map((n) => (n as { tag?: { text: string } }).tag?.text ?? '(none)');
    expect(tags).toEqual(NOTES.map((s) => tagOf(s).text).sort());
  });

  it('poolScan (the chain scan) tags every note it finds', async () => {
    // The list every panel shows once the chain walk has answered is built
    // here (`toNoteView`), not by `poolScanLocal`: a view without its tag is a
    // row with no name after every scan.
    chainFound.value = NOTES.map((s, i) => ({
      counter: i,
      spent: false,
      receipt: {
        secret: s.secret,
        nullifierPreimage: s.nullifierPreimage,
        noteBlinding: s.blinding,
        tokenMint: TOKEN_MINT_FIELD,
        commitment: BigInt(shareable(s).commitment),
        leafIndex: s.leafIndex,
        denomination: 100_000_000n,
        pool: POOL_58,
        token: 'SOL',
        denominationHuman: 0.1,
        shieldedAt: 1_700_000_000_000,
      },
    }));
    const res = await handlePoolRequest({ kind: 'poolScan' as const, meta: META, token: 'SOL', denomination: 0.1 });
    expect(res.complete).toBe(true);
    // Anti-vacuity: the scan returned every note the stub found, in scan order.
    expect(res.notes.map((n) => n.leafIndex)).toEqual(NOTES.map((s) => s.leafIndex));
    expect(res.notes.map((n) => (n as { tag?: unknown }).tag ?? null)).toEqual(NOTES.map((s) => tagOf(s)));
  });

  it('poolShieldExecute returns the new note with its tag', async () => {
    const pool1 = findPoolV3('SOL', 1)!;
    const s = NOTES[1]!;
    shieldReceipt.value = {
      secret: s.secret,
      nullifierPreimage: s.nullifierPreimage,
      noteBlinding: s.blinding,
      tokenMint: TOKEN_MINT_FIELD,
      commitment: 42n,
      leafIndex: 5,
      denomination: 1_000_000_000n,
      pool: pool1.poolPDA.toBase58(),
      token: 'SOL',
      denominationHuman: 1,
      shieldedAt: 1_700_000_000_000,
    };
    const prep = await handlePoolRequest({
      kind: 'poolShieldPrepare' as const,
      meta: META,
      token: 'SOL',
      denomination: 1,
    });
    const done = await handlePoolRequest({
      kind: 'poolShieldExecute' as const,
      jobId: prep.jobId,
      ownerPubkey: '11111111111111111111111111111111',
    });
    expect((done as { tag?: unknown }).tag).toEqual(tagOf(s, pool1.poolPDA.toBase58()));
  });

  it('poolOpenRecords returns a payout record’s tag only when it has exactly the tag’s shape', async () => {
    // The payout row names a withdrawal by the paying note's tag, stored in the
    // sealed record. The whitelist copies it only in the tag's own shape, so a
    // record carrying anything else in that field (here a leaf number) cannot
    // put it on the screen through the payout list.
    const sealRecord = (rec: Record<string, unknown>) =>
      encryptNote(MY_ADDRESS, utf8ToBytes(JSON.stringify(rec)));
    const base = { p01store: 1, kind: 'payout', pool: POOL_58, address: 'PayoutAddr', txSig: 'Sig', denomination: 0.1 };
    const good = tagOf(NOTES[0]!);
    const res = await handlePoolRequest({
      kind: 'poolOpenRecords' as const,
      meta: META,
      blobs: [
        sealRecord({ ...base, leafIndex: 3, tag: good }),
        sealRecord({ ...base, leafIndex: 4, tag: { text: String(CANARY_LEAF), color: good.color } }),
        sealRecord({ ...base, leafIndex: 5 }),
      ],
    });
    expect(res.payouts.map((p) => (p as { tag?: unknown }).tag ?? null)).toEqual([good, null, null]);
  });

  it('poolExportNote names the note by its tag and hands the page neither its leaf nor its commitment', async () => {
    const s = NOTES[2]!;
    const imported = await importNote(s);
    const res = await handlePoolRequest({
      kind: 'poolExportNote' as const,
      meta: META,
      token: 'SOL',
      denomination: 0.1,
      leafIndex: s.leafIndex,
      recipientAddress: createNoteEncryptionAddress(new Uint8Array(32).fill(0x42)),
      encryptedNotes: [imported.encryptedNote],
    });
    // The ciphertext is left out of the check: base64 of random bytes can
    // contain any digit run, and it is sealed to the recipient anyway.
    const { sealedNote, ...visible } = res as unknown as Record<string, unknown>;
    expect(sealedNote).toMatch(/^p01enc1:/);
    expect(Object.keys(visible).sort()).not.toContain('leafIndex');
    expect(Object.keys(visible).sort()).not.toContain('commitment');
    const wire = JSON.stringify(visible);
    expect(wire).not.toContain(String(CANARY_LEAF));
    expect(wire).not.toContain(shareable(s).commitment);
    expect(visible.tag).toEqual(tagOf(s));
  });
});
