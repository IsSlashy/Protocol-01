/**
 * The blob `poolShieldExecute` hands the page to store is ONE LENGTH.
 *
 * Runs under `vitest.pool.config.mts` (node).
 *
 * ## WHY THIS FILE EXISTS
 *
 * 🚨 A FIX WITH NO RED LOG. `worker/poolHandlers.ts` pads the shield-execute
 * note blob to `STORED_NOTE_BYTES`, and the gate of sweep round 1 proved that
 * setting that bucket to 1 — the whole pre-fix leak, restored — left the ENTIRE
 * web pool suite green. The only tests naming `poolShieldExecute` were
 * `ciLogHygiene` and four env-gated live suites, and none of them measured a
 * length. Its IMPORT twin was protected (`poolImportNote.test.ts`, "files every
 * note at one length, path or no path, whatever its digits"); the deposit half,
 * which is the one every buyer walks, was not.
 *
 * ## WHAT THE LENGTH SAID
 *
 * The stored blob is `p01enc1:` ciphertext in `localStorage`, so its LENGTH is
 * readable without any key — by a device thief, by any extension with the
 * `storage` permission, by a profile backup. Unpadded, the plaintext it wraps is
 * a JSON note whose size moves with:
 *
 *   - WHETHER A MERKLE PATH TRAVELS WITH THE NOTE, and how deep it is: a
 *     `pathElements` array of 77-digit field elements is hundreds of bytes,
 *     absent on a note stored without one;
 *   - HOW MANY DIGITS THE LEAF INDEX HAS, which brackets the deposit's position
 *     in a public tree: leaf 5 and leaf 987654 differ by five characters.
 *
 * Both are properties of the user's own deposit, and the swap exists to keep
 * them off this device in the clear.
 *
 * ## THE SHAPE OF THE TEST
 *
 * Two WORLDS that differ in exactly one thing — the plaintext's length — and the
 * row is read by what MOVES it (`wp-logs/PROTOCOL.md`). Every case carries its
 * own POSITIVE CONTROL: the plaintexts really do differ in length, so an equal
 * ciphertext length is the padding and not two equal notes.
 *
 * The chain and the prover are stubbed on the `poolNoteTag.test.ts` harness;
 * the encryption, the padding and the handler are real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { derivePoolSeedSalted } from './seedDerivation';
import { findPoolV3, pubkeyToField } from './denominatedPool';
import { decryptNote } from './noteCrypto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 13 + 7) & 0xff;
const PASSPHRASE = 'seven owls count slowly';
const SALTED_SEED = derivePoolSeedSalted(SIGNATURE, PASSPHRASE);
const META = 'meta-shield-blob';

const POOL = findPoolV3('SOL', 1)!;
const POOL_58 = POOL.poolPDA.toBase58();
const TOKEN_MINT_FIELD = pubkeyToField(POOL.tokenMint);

// ---------------------------------------------------------------------------
// Stubs: the chain, the prover, and the shield's proving/sending halves.
// ---------------------------------------------------------------------------

vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    fetchSpentNullifierSet: async () => new Set<string>(),
    isNullifierSpentInSet: () => false,
    fetchPoolCommitments: async () => new Map(),
    readPoolUnspentCount: async () => 0,
  };
});
vi.mock('./poolNotes', () => ({
  scanPoolForSeed: async () => ({ notes: [] }),
  recoverNotes: async () => [],
}));
vi.mock('./recoverFloat', () => ({ recoverStuckFloat: async () => [] }));
vi.mock('./starkProver', () => ({
  starkProver: { start: async () => undefined, computeCommitment: async () => '424242' },
}));

/**
 * The two dials a world turns: the Merkle path `prepareShield` hands over, and
 * the receipt `executeShield` returns. Nothing else differs between worlds.
 */
const world = vi.hoisted(() => ({
  pathDepth: 2,
  receipt: null as null | Record<string, unknown>,
}));

vi.mock('./shieldEphemeral', () => ({
  readTreeLeafCount: async () => 0,
  prepareShield: async () => ({
    jobId: 'shield-job-under-test',
    ephemeral: { publicKey: { toBase58: () => 'ShieldEphemeral' } },
    requiredLamports: 1,
    valueLamports: 1,
    prepared: {
      insertParams: { leafIndex: 5 },
      merklePath: {
        // 77-digit field elements, the real width of a path element.
        pathElements: Array.from({ length: world.pathDepth }, (_, i) =>
          BigInt(`${i + 1}`.repeat(1) + '8'.repeat(76)),
        ),
        pathIndices: Array.from({ length: world.pathDepth }, (_, i) => i % 2),
        root: 3n,
      },
    },
  }),
  executeShield: async () => ({ txSig: 'ShieldTxSig', receipt: world.receipt }),
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

function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    secret: 111111111111111111n,
    nullifierPreimage: 211111111111111111n,
    noteBlinding: 311111111111111111n,
    tokenMint: TOKEN_MINT_FIELD,
    commitment: 42n,
    leafIndex: 5,
    denomination: 1_000_000_000n,
    pool: POOL_58,
    token: 'SOL',
    denominationHuman: 1,
    shieldedAt: 1_700_000_000_000,
    ...over,
  };
}

/** Run one deposit and hand back its stored blob. */
async function shield(): Promise<string> {
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
  return (done as { encryptedNote: string }).encryptedNote;
}

/**
 * The length of the note INSIDE a blob, with the padding taken back off.
 *
 * ⚠️ NOT `decryptNote(...).length`, which is the padded size and therefore the
 * same in every world — a positive control built on it asserts `2048 > 2048`
 * and fails on the fixed code. The padding is trailing JSON whitespace, so
 * re-stringifying the parsed note recovers exactly what was sealed: this is the
 * number the unpadded store leaked through the ciphertext length.
 */
function noteLength(blob: string): number {
  const text = new TextDecoder().decode(decryptNote(SALTED_SEED, blob));
  return JSON.stringify(JSON.parse(text)).length;
}

beforeEach(() => {
  clearPoolState();
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE, PASSPHRASE);
  world.pathDepth = 2;
  world.receipt = receipt();
});

describe('🚨 the deposit files every note at one length', () => {
  it('does not say how deep the Merkle path that travels with the note is', async () => {
    world.pathDepth = 2;
    const shallow = await shield();
    world.pathDepth = 20;
    const deep = await shield();

    // POSITIVE CONTROL: the two plaintexts really do differ, by a lot — 18 more
    // 77-digit elements — so the equality below is the padding at work.
    expect(
      noteLength(deep),
      'the two worlds produced the same plaintext, so this case proves nothing',
    ).toBeGreaterThan(noteLength(shallow));

    expect(
      deep.length,
      "the stored blob's length says how deep this note's Merkle path is",
    ).toBe(shallow.length);
  });

  it('does not say how many digits the leaf index has', async () => {
    world.receipt = receipt({ leafIndex: 5 });
    const low = await shield();
    world.receipt = receipt({ leafIndex: 987654 });
    const high = await shield();

    expect(
      noteLength(high),
      'the two worlds produced the same plaintext, so this case proves nothing',
    ).toBeGreaterThan(noteLength(low));

    expect(
      high.length,
      "the stored blob's length brackets the deposit's leaf in the public tree",
    ).toBe(low.length);
  });

  it('does not move with the note secrets themselves', async () => {
    world.receipt = receipt({ secret: 1n, nullifierPreimage: 2n, noteBlinding: 3n, commitment: 4n });
    const small = await shield();
    world.receipt = receipt({
      secret: 10n ** 76n + 1n,
      nullifierPreimage: 10n ** 76n + 2n,
      noteBlinding: 10n ** 76n + 3n,
      commitment: 10n ** 76n + 4n,
    });
    const big = await shield();

    expect(
      noteLength(big),
      'the two worlds produced the same plaintext, so this case proves nothing',
    ).toBeGreaterThan(noteLength(small));

    expect(big.length, "the stored blob's length moves with the note's own secrets").toBe(
      small.length,
    );
  });

  it('files a tiny deposit at the same length as a large one', async () => {
    // One bucket for the whole store, not one bucket per size of note. Read
    // through a world far shorter than the bucket, so a padding that rounded
    // UP per record rather than to a fixed bucket would separate them.
    const deposited = await shield();
    // The bucket the padding targets, read through a world that is far shorter
    // than it: a 1-element path and a single-digit leaf still fills it.
    world.pathDepth = 1;
    world.receipt = receipt({ leafIndex: 0, commitment: 1n });
    const tiny = await shield();
    expect(tiny.length, 'a short deposit is stored shorter than a long one').toBe(
      deposited.length,
    );
  });
});
