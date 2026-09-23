/**
 * poolHandlers — WHICH CIRCUIT A WITHDRAWAL MESSAGE ROUTES TO.
 *
 * `unshieldV4Job.test.ts` proves the circuit-7 job itself behaves (it refuses
 * its own funder, its job id cannot collide with the v3 one). This file proves
 * the WORKER picks the right one of the two and carries the choice through to
 * execute, which is where the interesting failures live:
 *
 *   a v3 request that silently became v4   the subscription proves on a circuit
 *                                          the program has no instruction for,
 *                                          and dies at the END of a ~150-tx
 *                                          upload.
 *   a v4 request that silently became v3   the note's commitment is published
 *                                          in cleartext again. Nothing fails.
 *                                          The withdrawal still lands. The only
 *                                          symptom is a privacy claim that has
 *                                          stopped being true.
 *   a v4 job that silently changed payee   the withdrawal lands, and it pays
 *                                          somebody else. This one is money.
 *
 * The middle one is why every assertion here is written in BOTH directions: the
 * fallback works, so nothing else in the suite would ever notice it.
 *
 * Everything that touches the chain or a prover is stubbed. What is measured is
 * exclusively which function the handler called, with which arguments, and what
 * it told the caller it had done.
 *
 * Runs under `vitest.pool.config.mts` (node) — its include is `lib/** /*.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { derivePoolSeeds, seedsInSearchOrder } from '../pool/seedDerivation';
import { createNoteEncryptionAddress, encryptNote } from '../pool/noteCrypto';

import type { RecoveredNote } from '../pool/poolNotes';
import { claimChallenge } from '../claimChallenge';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 7 + 3) & 0xff;

const META = 'meta-under-test';
const POOL_58 = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG'; // 0.1 SOL pool
const DENOM = 0.1;
const LEAF = 11;

/** The user's wallet. Identity only — it is what arms the payee refusal. */
const OWNER = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
/** A derived payout address: a third party, so the refusal must NOT fire. */
const RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
/** A DIFFERENT payee, for the mismatch. Circuit 7 was never proved for it. */
const OTHER_PAYEE = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/**
 * The circuit-7 job's ephemeral, a REAL keypair rather than a bare address:
 * the note-in exchange has the handler sign the claim challenge with its
 * secret, and a stub with no `secretKey` would make every such case fail for
 * a reason that has nothing to do with the handler.
 */
const V4_EPHEMERAL = Keypair.generate();

/**
 * THE REAL JOB-ID FORMULAE, not placeholders — and the difference is the entire
 * subject of the "two payees" describe below.
 *
 * The first draft of this file stubbed `'unshield-v4:job'`, a constant. A
 * constant is accidentally safe in the one way that matters here: it is
 * different from nothing, so nothing can collide with it. The real formula
 * (unshieldEphemeral.ts:445) is `unshield-v4:<pool>:<leaf>` and names NO payee,
 * while the job it identifies is bound to exactly one. A stub that does not
 * reproduce that cannot see the overwrite it causes, which is why the first
 * version of this file passed while the defect was live.
 */
/**
 * The opening of the refusal `prepareUnshieldV4` raises when the history it
 * can read is incomplete AND the note's saved path would name an older root.
 * Spelled out here and checked against the real source below, so this file
 * cannot pass by injecting a message the prepare never produces.
 */
const HISTORY_REFUSAL = 'The pool history this client can read is incomplete';

const V3_JOB_ID = `unshield:${POOL_58}:${LEAF}`;
const V4_JOB_ID = `unshield-v4:${POOL_58}:${LEAF}`;

const NOTE: RecoveredNote = {
  counter: LEAF,
  spent: false,
  receipt: {
    secret: 11_001n,
    nullifierPreimage: 11_002n,
    noteBlinding: 7n,
    tokenMint: 0n,
    commitment: 11_003n,
    leafIndex: LEAF,
    denomination: 100_000_000n,
    pool: POOL_58,
    token: 'SOL',
    denominationHuman: DENOM,
    shieldedAt: 0,
    source: 'shielded',
  },
};

/**
 * V3-1: the two kinds of note the C1 + C3 routing now tells apart. Both jobs
 * refuse a note whose blinding is below 2**32 (`LEGACY_BLINDING_CEILING` in
 * unshieldEphemeral.ts and subscribeEphemeral.ts): that value is a deposit
 * epoch (67,838 measured 2026-08-26), not a PRF draw.
 *   BLINDED_NOTE       2**60, the plan's figure for a PRF-blinded note. Every
 *                      note deposited since blinding landed is one.
 *   PRE_BLINDING_NOTE  a deposit epoch, as the legacy notes carry.
 * Same leaf and commitment as NOTE, so the walk and the stubs are unchanged.
 */
const BLINDED_NOTE: RecoveredNote = { ...NOTE, receipt: { ...NOTE.receipt, noteBlinding: 2n ** 60n } };
const PRE_BLINDING_NOTE: RecoveredNote = { ...NOTE, receipt: { ...NOTE.receipt, noteBlinding: 67_838n } };

/** The refusal both circuit-7 jobs raise for a pre-blinding note, as unshieldEphemeral.ts words it. */
const PRE_BLINDING = () =>
  new Error(
    'circuit 7 needs at least a randomised blinding, and this note carries its deposit ' +
      'epoch instead — it predates commitment blinding. Proving it on circuit 7 would hide the ' +
      'commitment while leaving the leaf recoverable from the published nullifier by trying a ' +
      'few thousand epochs, which is worse than the C1 + C3 pair only in that it looks private. ' +
      'Falling back to the pair.',
  );
/** The root pre-flight's refusal, as denominatedPool.ts words it. */
const PREFLIGHT_FAIL = () =>
  new Error(
    "PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots " +
      '(current + 100 historical). Aborting before proof rent is spent. Wait ~10s for the RPC ' +
      'to index recent transactions, then retry.',
  );
/** The subtree-depth refusal, as denominatedPool.ts words it. */
const DEPTH_FAIL = () => new Error('Merkle path is 9 deep; circuit 7 needs at least 12.');

/**
 * What a prepare answered, in words: which circuit it prepared on, or which of
 * the V3-1 refusals it raised. Anything else is spelled out whole, so a harness
 * that broke reads as itself and never as a refusal.
 */
function verdict(p: Promise<{ version: string }>): Promise<string> {
  return p.then(
    (r) => `prepared on ${r.version}`,
    (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      if (m === 'SUBSCRIBE_REACHED_PREPARE_SUBSCRIBE_JOB') return 'reached the C1 + C3 subscribe prepare';
      if (/press the same button again/i.test(m)) return 'disclosure';
      if (/not retried on the older C1 \+ C3 pair/i.test(m) && /then retry/i.test(m)) return 'refused, retry';
      return `other: ${m}`;
    },
  );
}

/**
 * Every call the handler made, in order, with the arguments that decide the
 * outcome. Recorded rather than spied so an assertion can pin ARGUMENT ORDER:
 * `prepareUnshieldJobV4(receipt, recipient, ownerPubkey, …)` puts two
 * interchangeable-looking `PublicKey`s side by side, and swapping them compiles,
 * runs, and turns the payee refusal into a check of the wallet against itself.
 */
const seen = {
  prepareV3: [] as Array<{ leafIndex: number }>,
  prepareV4: [] as Array<{ leafIndex: number; recipient: string; ownerPubkey: string }>,
  executeV3: [] as Array<{ jobId: string; recipient: string; ownerPubkey: string }>,
  // `boundPayee` is `ctx.recipient` — the payee circuit 7 was proved against,
  // read back off the STORED job. Recording it is what makes a swapped payee
  // observable at all: without it a test can only see that *a* v4 send happened,
  // which is precisely what a silent overwrite looks like from the outside.
  executeV4: [] as Array<{ jobId: string; boundPayee: string; ownerPubkey: string }>,
  // The relayed path takes NO ownerPubkey and NO sweepTo — the buyer neither
  // signs nor pays — so what is worth recording is the URL and the payee the
  // stored context is bound to.
  executeRelayed: [] as Array<{ jobId: string; boundPayee: string; relayerUrl: string }>,
  prepareSubscribe: [] as number[],
  /** The circuit-7 SUBSCRIPTION prepare: the leaf of every note it was asked to prove. */
  prepareSubscribeV4: [] as number[],
  /** The saved path the circuit-7 SUBSCRIPTION prepare was handed, per call (its 8th argument). */
  prepareSubscribeV4Saved: [] as unknown[],
  /**
   * The circuit-7 prepare's OPTIONS object, recorded separately from
   * `prepareV4` because those rows are asserted with `toEqual` and one
   * extra field would fail the argument-order test for an unrelated
   * reason. This is where the leaves the handler already walked show up.
   */
  prepareV4Opts: [] as unknown[],
  /** The note the circuit-7 prepare was handed: where it came from, and which commitment. */
  prepareV4Receipts: [] as Array<{ source: unknown; commitment: string; leafIndex: number }>,
  /** The circuit levels handed to the prover, per proof; only a real prepare reaches it. */
  proofLevels: [] as unknown[],
  /** [flow-speed W1] Every set the stubbed `fetchSpentNullifierSet` returned, in order. */
  spentSetsRead: [] as unknown[],
  /** [flow-speed W1] The spent set the circuit-7 withdrawal job was handed (its 9th argument). */
  prepareV4SpentSet: [] as unknown[],
  /** [flow-speed S1] The options the circuit-7 SUBSCRIPTION job was handed (its 9th argument). */
  prepareSubscribeV4Opts: [] as unknown[],
  /** [flow-speed X3] The order of prover warm-ups and history walks. */
  order: [] as string[],
  /** [flow-speed X1] The options every stubbed history walk was called with. */
  walkOptions: [] as unknown[],
};

/** [flow-speed X3] Set to hold the stubbed history walk open until released. */
let walkGate: Promise<void> | null = null;
/** [flow-speed X3] When set, the next `starkProver.start()` rejects with it, once. */
let proverStartFailOnce: Error | null = null;

/**
 * A fake RPC. When set, the handler's walk and the circuit-7 prepare run for
 * REAL on it: the real `fetchPoolCommitments`, and the real
 * `prepareUnshieldJobV4` and `prepareUnshieldV4` (the case "a note whose insert
 * no walk read places is refused on circuit 7 and never reaches the C1 + C3
 * pair: the real walk and the real prepare"). Otherwise the stubs answer.
 */
let realChain: unknown = null;

/**
 * Injected failure for the circuit-7 prepare.
 *
 * `prepareUnshieldV4` has no stored-path shortcut — it always rebuilds the
 * Merkle path from event history (unshieldEphemeral.ts:385-388) — so it can
 * fail on a note the C1 + C3 pair still spends, because that pair tries the
 * path captured at shield time first. That is a ROUTING fact about two
 * functions, and this variable is the only way to reach it without an RPC.
 */
let v4PrepareFailure: Error | null = null;
/** Injected failure for the circuit-7 SUBSCRIPTION prepare (`prepareSubscribeJobV4`). */
let subscribeV4PrepareFailure: Error | null = null;

/**
 * What the seed search finds at LEAF, and which commitment the walk holds
 * there. The received-note case sets both: the seed search finds nothing (a
 * received note's secrets are the SENDER's) and the leaf holds the received
 * commitment, so the handler can only resolve the note from its stored blob.
 */
let seedSearchNote: RecoveredNote | null = NOTE;
let commitmentAtLeaf: bigint = NOTE.receipt.commitment;
/**
 * What the walk reports it could not read (`PoolWalkReport.unread`), handed
 * to the walk's `onWalked` by the stub below. `undefined`: the walk makes no
 * report at all.
 */
let walkUnread: number | undefined = 0;

// ---------------------------------------------------------------------------
// Chain stubs
// ---------------------------------------------------------------------------

vi.mock('../pool/poolNotes', () => ({
  scanPoolForSeed: async () => ({ notes: [NOTE] }),
  // One seed, one note, at one leaf. Derivation search is `poolHandlersDerivation
  // .test.ts`'s subject and is deliberately not re-tested here.
  recoverNotes: async (_c: unknown, _p: unknown, _s: unknown, opts?: { onlyLeaf?: number }) =>
    opts?.onlyLeaf === LEAF && seedSearchNote ? [seedSearchNote] : [],
}));

vi.mock('../pool/recoverFloat', () => ({ recoverStuckFloat: async () => [] }));

vi.mock('../pool/shieldEphemeral', () => ({
  readTreeLeafCount: async () => 40,
  prepareShield: async () => {
    throw new Error('not exercised');
  },
  executeShield: async () => {
    throw new Error('not exercised');
  },
  recordShieldBreadcrumb: async () => undefined,
}));

/**
 * The subscribe path, stubbed at the ONE function that proves the point: it
 * records the call and stops, so `handlePoolSubscribePrepare` never reaches the
 * STARK wasm it would otherwise import to compute `subscriberCommitment`. The
 * real `prepareSubscribeJob` calls `prepareUnshieldJob` verbatim
 * (subscribeEphemeral.ts:115) and is pinned as such by `spendRouting.test.ts`.
 */
vi.mock('../pool/subscribeEphemeral', () => ({
  prepareSubscribeJob: async (receipt: { leafIndex: number }) => {
    seen.prepareSubscribe.push(receipt.leafIndex);
    throw new Error('SUBSCRIBE_REACHED_PREPARE_SUBSCRIBE_JOB');
  },
  // The circuit-7 subscription prepare: records the attempt and the saved path
  // it was handed, then fails the way the case under test injects.
  prepareSubscribeJobV4: async (receipt: { leafIndex: number }, ...rest: unknown[]) => {
    seen.prepareSubscribeV4.push(receipt.leafIndex);
    // (poolConfig, connection, walletSeed, terms, onProgress, spentSet, savedPath, opts)
    seen.prepareSubscribeV4Saved.push(rest[6]);
    seen.prepareSubscribeV4Opts.push(rest[7]);
    throw subscribeV4PrepareFailure ?? new Error('not exercised');
  },
  executeSubscribe: async () => {
    throw new Error('not exercised');
  },
}));

// `handlePoolSubscribePrepare` computes the subscriber commitment with the wasm
// prover before the circuit-7 prepare; only the subscription case reaches it.
vi.mock('../pool/starkProver', () => ({
  starkProver: {
    start: async () => {
      seen.order.push('prover.start');
      if (proverStartFailOnce) {
        const err = proverStartFailOnce;
        proverStartFailOnce = null;
        throw err;
      }
    },
    computeCommitment: async () => '987654321',
    // Reached only by a REAL circuit-7 prepare (`realChain`). It publishes the
    // recipient limbs it was handed, as circuit 7 does, so the prepare accepts it.
    generateSpendProof: async (...a: unknown[]) => {
      seen.proofLevels.push(a[4]);
      return { circuitId: 7, publicInputs: ['99', '1234', ...(a[6] as string[])], proofHex: '00'.repeat(32), proofSize: 32, durationMs: 1 };
    },
  },
}));

vi.mock('../pool/unshieldEphemeral', () => ({
  prepareUnshieldJob: async (receipt: { leafIndex: number }, poolConfig: unknown) => {
    seen.prepareV3.push({ leafIndex: receipt.leafIndex });
    return {
      jobId: V3_JOB_ID,
      poolConfig,
      receipt,
      ephemeral: { publicKey: { toBase58: () => 'EPH_V3' } },
      requiredLamports: 456,
      rawRequiredLamports: 400,
      prepared: {},
    };
  },
  executeUnshield: async (
    ctx: { jobId: string },
    _conn: unknown,
    recipient: PublicKey,
    ownerPubkey: PublicKey,
  ) => {
    seen.executeV3.push({
      jobId: ctx.jobId,
      recipient: recipient.toBase58(),
      ownerPubkey: ownerPubkey.toBase58(),
    });
    return { txSig: 'V3_TX' };
  },
  prepareUnshieldJobV4: async (
    receipt: { leafIndex: number; source?: unknown; commitment?: bigint },
    recipient: PublicKey,
    ownerPubkey: PublicKey,
    poolConfig: unknown,
    _conn?: unknown,
    _seed?: unknown,
    _onProgress?: unknown,
    opts?: { leaves?: Map<string, { leafIndex: number }>; savedPath?: unknown },
    spentSet?: unknown,
  ) => {
    seen.prepareV4SpentSet.push(spentSet);
    seen.prepareV4.push({
      leafIndex: receipt.leafIndex,
      recipient: recipient.toBase58(),
      ownerPubkey: ownerPubkey.toBase58(),
    });
    seen.prepareV4Opts.push(opts);
    seen.prepareV4Receipts.push({
      source: receipt.source,
      commitment: String(receipt.commitment),
      leafIndex: receipt.leafIndex,
    });
    if (realChain) {
      // The REAL job, on the fake RPC instead of the handler's localhost connection.
      const actual = await vi.importActual<typeof import('../pool/unshieldEphemeral')>('../pool/unshieldEphemeral');
      return actual.prepareUnshieldJobV4(
        receipt as never, recipient, ownerPubkey, poolConfig as never, realChain as never,
        _seed as never, _onProgress as never, opts as never,
      );
    }
    // Recorded BEFORE the throw: a fallback test has to be able to see that
    // circuit 7 was genuinely attempted and not skipped.
    if (v4PrepareFailure) throw v4PrepareFailure;
    return {
      // ⛔ PAYEE-INDEPENDENT, exactly as the real one is. Do NOT "fix" this stub
      // by adding the payee to it: keeping two payees apart is the handler's
      // job, and a stub that does it for them measures nothing.
      jobId: V4_JOB_ID,
      poolConfig,
      receipt,
      ephemeral: V4_EPHEMERAL,
      // Carried in the context because circuit 7 bound it at prove time. The
      // execute handler reads it back off this field, so it is the fixture the
      // mismatch and collision tests both turn on.
      recipient,
      // Materially smaller than the v3 figure: one proof buffer, not two.
      requiredLamports: 231,
      rawRequiredLamports: 200,
      prepared: {},
    };
  },
  executeUnshieldV4: async (
    ctx: { jobId: string; recipient: PublicKey },
    _conn: unknown,
    ownerPubkey: PublicKey,
  ) => {
    // `ctx.recipient`, never an argument: `executeUnshieldV4` TAKES no recipient
    // — the payee it pays comes off the stored context. That is exactly why an
    // overwritten context redirects the money rather than failing.
    seen.executeV4.push({
      jobId: ctx.jobId,
      boundPayee: ctx.recipient.toBase58(),
      ownerPubkey: ownerPubkey.toBase58(),
    });
    return { txSig: 'V4_TX' };
  },
  executeUnshieldV4Relayed: async (
    ctx: { jobId: string; recipient: PublicKey },
    _conn: unknown,
    relayerUrl: string,
  ) => {
    seen.executeRelayed.push({
      jobId: ctx.jobId,
      boundPayee: ctx.recipient.toBase58(),
      relayerUrl,
    });
    return { txSig: 'RELAYED_TX' };
  },
}));

/**
 * The pool history as `locateOwnedNote` walks it: the note's leaf, one leaf
 * below it and three ABOVE it. The leaves after the note are what separate the
 * pool's current root from the root the note's own insertion made, which the
 * ring still holds. With the note's leaf alone, a handler that cut the map down
 * at the note would hand on the same map as one that passed the whole walk, and
 * the prepare would then name that older root (`spendRootIsCurrent.test.ts`,
 * "a walked map one or more insertions behind is accepted from the ring, with
 * no refetch"). A fresh map per call; the extra commitments match no receipt in
 * this file. The note's leaf holds `commitmentAtLeaf`.
 */
function walkedCommitments(): Map<string, { commitment: bigint; leafIndex: number }> {
  const rows: Array<[bigint, number]> = [
    [90_010n, LEAF - 1],
    [commitmentAtLeaf, LEAF],
    [90_012n, LEAF + 1],
    [90_013n, LEAF + 2],
    [90_014n, LEAF + 3],
  ];
  return new Map(rows.map(([commitment, leafIndex]) => [commitment.toString(), { commitment, leafIndex }]));
}

vi.mock('../pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pool/denominatedPool')>();
  return {
    ...actual,
    // The real walk reports what it could not read once it ends; so does this
    // one, unless a case sets `walkUnread` to undefined.
    fetchPoolCommitments: async (
      _conn: unknown,
      _pda: unknown,
      options?: { onWalked?: (report: { unread: number }) => void },
    ) => {
      seen.order.push('walk');
      seen.walkOptions.push(options);
      if (walkGate) await walkGate;
      // The REAL walk, on the fake RPC, when a case sets one.
      if (realChain) return actual.fetchPoolCommitments(realChain as never, _pda as never, options as never);
      if (walkUnread !== undefined) options?.onWalked?.({ unread: walkUnread });
      return walkedCommitments();
    },
    fetchSpentNullifierSet: async () => {
      const set = new Set<string>();
      seen.spentSetsRead.push(set);
      return set;
    },
    readPoolUnspentCount: async () => 7,
  };
});

// Imported after the mocks so the handler binds to the stubs.
const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  './poolHandlers'
);
// The real ones: the mock above spreads the actual module.
const {
  C7_SUBTREE_DEPTH,
  HistoryIncompleteError,
  buildMerkleProofFromLeavesV3,
  createCommitmentV3,
  findPoolV3,
  goldilocksToLeBytes32,
} = await import('../pool/denominatedPool');
const { memoryPoolHistoryStore, setPoolHistoryStore } = await import('../pool/poolHistoryCache');

// ---------------------------------------------------------------------------

function prepareReq(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'poolUnshieldPrepare' as const,
    meta: META,
    token: 'SOL' as const,
    denomination: DENOM,
    leafIndex: LEAF,
    ...overrides,
  };
}

/** A circuit-7 subscribe prepare: all three terms, as the pay app's subscribe sends them. */
function subscribeReq() {
  return {
    kind: 'poolSubscribePrepare' as const,
    meta: META,
    token: 'SOL' as const,
    denomination: DENOM,
    leafIndex: LEAF,
    retailer: RECIPIENT,
    rate: '1000000',
    intervalSlots: '6480000',
  };
}

/**
 * The C1 + C3 route for a pre-blinding note, the only way it opens since V3-1:
 * the first prepare must come back as the disclosure, with nothing prepared,
 * and only the SAME request again reaches the pair.
 */
async function preparePreBlindingAfterDisclosure(req: ReturnType<typeof prepareReq>) {
  seedSearchNote = PRE_BLINDING_NOTE;
  v4PrepareFailure = PRE_BLINDING();
  expect(await verdict(handlePoolRequest(req)), 'the first prepare was not the disclosure').toBe(
    'disclosure',
  );
  expect(seen.prepareV3, 'the disclosure prepared the C1 + C3 pair anyway').toEqual([]);
  return handlePoolRequest(req);
}

beforeEach(() => {
  clearPoolState();
  seen.prepareV3 = [];
  seen.prepareV4 = [];
  seen.executeV3 = [];
  seen.executeV4 = [];
  seen.executeRelayed = [];
  seen.prepareSubscribe = [];
  seen.prepareSubscribeV4 = [];
  seen.prepareSubscribeV4Saved = [];
  seen.prepareV4Opts = [];
  seen.prepareV4Receipts = [];
  seen.proofLevels = [];
  seen.spentSetsRead = [];
  seen.prepareV4SpentSet = [];
  seen.prepareSubscribeV4Opts = [];
  seen.order = [];
  seen.walkOptions = [];
  walkGate = null;
  proverStartFailOnce = null;
  realChain = null;
  v4PrepareFailure = null;
  subscribeV4PrepareFailure = null;
  seedSearchNote = NOTE;
  commitmentAtLeaf = NOTE.receipt.commitment;
  walkUnread = 0;
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE);
});

// ===========================================================================

describe('a prepare with no payee is the v3 path, unchanged', () => {
  it('proves on C1 + C3 and never touches the circuit-7 prepare', async () => {
    const res = await handlePoolRequest(prepareReq());

    expect(seen.prepareV3).toEqual([{ leafIndex: LEAF }]);
    // The other direction, and it is the one that matters: a v3 request that
    // reached circuit 7 would prove against an instruction the subscription
    // has no on-chain equivalent of.
    expect(seen.prepareV4).toEqual([]);
    expect(res.jobId).toBe(V3_JOB_ID);
    expect(res.requiredLamports).toBe(456);
    expect(res.ephemeralPubkey).toBe('EPH_V3');
  });

  it('says v3 out loud, so the caller never has to infer it from the job id', async () => {
    const res = await handlePoolRequest(prepareReq());
    expect(res.version).toBe('v3');
  });

  /**
   * The HALF-SPECIFIED request — exactly one of the pair.
   *
   * 🚨 THIS USED TO BE A SILENT v3, AND THAT WAS THE DEFECT. A caller that means
   * circuit 7 and drops one field got the C1 + C3 pair, which republishes the
   * note's commitment in cleartext, with nothing raised anywhere: the withdrawal
   * still lands, and the only symptom is a privacy claim that has quietly
   * stopped being true. No caller legitimately holds one of the two — the payee
   * is a circuit input and the wallet arms the payee refusal — so a request
   * carrying one is a programming error, and the one thing a programming error
   * must not do is succeed by publishing MORE than it was asked to.
   *
   * NEITHER field is still v3, unchanged, and neither is what the subscribe path
   * sends. The refusal is only for the half-specified shape.
   */
  it('refuses a half-specified request rather than silently publishing the commitment', async () => {
    await expect(handlePoolRequest(prepareReq({ recipient: RECIPIENT }))).rejects.toThrow(
      /both `recipient` and `ownerPubkey`/,
    );
    await expect(handlePoolRequest(prepareReq({ ownerPubkey: OWNER }))).rejects.toThrow(
      /both `recipient` and `ownerPubkey`/,
    );

    // NEITHER circuit ran. A refusal that still proved something would have
    // spent the ~5.5 seconds it exists to save.
    expect(seen.prepareV3).toEqual([]);
    expect(seen.prepareV4).toEqual([]);
  });

  it('names the field that is missing, because "invalid request" is not actionable', async () => {
    // ⚠️ Asserted on the phrase that names the ABSENT field, not on the field
    // name alone: the sentence mentions both fields, so `/ownerPubkey/` would
    // pass for either half and measure nothing.
    const missingWallet = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT }),
    ).catch((e: Error) => e);
    expect(String(missingWallet)).toContain('missing `ownerPubkey`');

    const missingPayee = await handlePoolRequest(prepareReq({ ownerPubkey: OWNER })).catch(
      (e: Error) => e,
    );
    expect(String(missingPayee)).toContain('missing `recipient`');
  });
});

describe('a prepare carrying a payee and a wallet routes to circuit 7', () => {
  it('proves on the single circuit-7 trace and never on the C1 + C3 pair', async () => {
    const res = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );

    expect(seen.prepareV4).toHaveLength(1);
    expect(seen.prepareV3).toEqual([]);
    // `toContain`, not `toBe`: the handler QUALIFIES the stored key with the
    // payee — see the "two payees" describe, which is where that shape is
    // pinned exactly. What this assertion is about is that a v4 request got a
    // v4 job.
    expect(res.jobId).toContain(V4_JOB_ID);
    expect(res.version).toBe('v4');
    expect(res.ephemeralPubkey).toBe(V4_EPHEMERAL.publicKey.toBase58());
    // Reported from the job, not assumed: one proof buffer is priced, not two.
    expect(res.requiredLamports).toBe(231);
  });

  /**
   * ARGUMENT ORDER, PINNED. `prepareUnshieldJobV4(receipt, recipient,
   * ownerPubkey, …)` puts two `PublicKey`s next to each other. Swapped, it
   * type-checks, it runs, and the refusal inside it compares the wallet against
   * the wallet — so it can never fire, and the note pays out to the wallet that
   * funded the withdrawal: the exact defect /pay shipped until 2026-08-04.
   * Nothing else in this file or the suite would see it.
   */
  it('hands the payee and the wallet down in the order the refusal depends on', async () => {
    await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));

    expect(seen.prepareV4[0]).toEqual({
      leafIndex: LEAF,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });
    expect(seen.prepareV4[0].recipient).not.toBe(seen.prepareV4[0].ownerPubkey);
  });

  it('sends it with executeUnshieldV4 and the payee the proof is bound to', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V4_TX');
    expect(done.denomination).toBe(DENOM);
    expect(seen.executeV4).toEqual([
      { jobId: V4_JOB_ID, boundPayee: RECIPIENT, ownerPubkey: OWNER },
    ]);
    expect(seen.executeV3).toEqual([]);
  });

  it('still accepts an execute with no recipient, because the proof already names one', async () => {
    // The contract keeps `recipient` optional at execute. This is the shape a
    // third-party caller may still send, and it must reach the STORED payee —
    // never a default, never the wallet.
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V4_TX');
    expect(seen.executeV4[0]!.boundPayee).toBe(RECIPIENT);
  });
});

// ===========================================================================
// 💰 TWO PAYEES, ONE NOTE
// ===========================================================================

/**
 * 🚨 FUND-LOSS CLASS, AND IT IS NOT THE OBVIOUS ONE.
 *
 * The v4 job id is `unshield-v4:<pool>:<leaf>` (unshieldEphemeral.ts:445) — it
 * names NO payee — while the v4 job is BOUND to one, because sha256(recipient)
 * is four of circuit 7's six public inputs. `preparedUnshields` is a Map. So a
 * second prepare of the same note for a different payee used to land on the same
 * key and replace the first job wholesale: proof, context and payee together.
 *
 * The ephemeral does not change with the payee either — it is deterministic in
 * (pool seed, pool, leaf) — so the first caller's pre-fund sits on exactly the
 * signer the second caller's proof will spend from. Execute the FIRST job id and
 * the money goes to the SECOND payee, with no error anywhere.
 *
 * ⛔ AND THE GUARD BUILT FOR THIS COULD NOT FIRE. The execute handler refuses a
 * recipient that disagrees with the stored one — but only when a recipient is
 * PASSED, and the client deliberately passed none on v4, on the reasoning that
 * "the only value that can never be wrong is no value at all". That reasoning is
 * circular: passing nothing is exactly what makes the disagreement invisible.
 *
 * The v3 path was never exposed to this. Its payee travels on the execute
 * message, so an overwritten v3 context still pays the address the caller named.
 *
 * Fixed in two independent places, and both are asserted below, because either
 * one alone leaves the other caller unprotected:
 *   1. the handler keys the store by (job, payee), so the two jobs coexist;
 *   2. the client sends the payee at execute, so the guard is live on the one
 *      path that ships (`unshieldV4ClientRouting.test.ts` pins that half).
 */
describe('two payees for one note cannot be confused for each other', () => {
  it('pays the FIRST job its own payee after a second prepare for someone else', async () => {
    const a = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const b = await handlePoolRequest(
      prepareReq({ recipient: OTHER_PAYEE, ownerPubkey: OWNER }),
    );
    expect(seen.prepareV4).toHaveLength(2);

    // Executed with NO recipient — the weakest shape a caller can send, and the
    // one the mismatch guard cannot inspect. The store alone has to be right.
    await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: a.jobId,
      ownerPubkey: OWNER,
    });

    expect(
      seen.executeV4[0]!.boundPayee,
      "the first job paid the second prepare's payee — the store was overwritten",
    ).toBe(RECIPIENT);

    // And the second job is still there, still bound to its own payee: the fix
    // must keep both, not merely protect whichever ran first.
    await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: b.jobId,
      ownerPubkey: OWNER,
    });
    expect(seen.executeV4[1]!.boundPayee).toBe(OTHER_PAYEE);
  });

  it('gives the two prepares different job ids, because the note alone does not identify one', async () => {
    const a = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const b = await handlePoolRequest(
      prepareReq({ recipient: OTHER_PAYEE, ownerPubkey: OWNER }),
    );

    expect(a.jobId).not.toBe(b.jobId);
    // The payee IS the qualifier, pinned exactly here and nowhere else. The
    // `unshield-v4:` prefix survives, because `poolRecover` and every log line
    // read job ids by eye.
    expect(a.jobId).toBe(`${V4_JOB_ID}:${RECIPIENT}`);
    expect(b.jobId).toBe(`${V4_JOB_ID}:${OTHER_PAYEE}`);
  });

  /**
   * The v3 id must NOT gain a payee. A v3 prepare does not know one — that is
   * the whole difference between the circuits — so qualifying it would key the
   * map on `undefined` and quietly make every v3 job collide with every other.
   */
  it('leaves the v3 job id alone, which never had a payee to be qualified by', async () => {
    const res = await handlePoolRequest(prepareReq());
    expect(res.jobId).toBe(V3_JOB_ID);
  });
});

describe('a v4 job refuses a payee it was not proved for', () => {
  it('throws instead of quietly preferring one of the two', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldExecute',
        jobId: prep.jobId,
        recipient: OTHER_PAYEE,
        ownerPubkey: OWNER,
      }),
    ).rejects.toThrow(/cannot pay/);

    // NOTHING WAS SENT. The refusal is worth nothing if the withdrawal went out
    // anyway and the error only described it.
    expect(seen.executeV4).toEqual([]);
    expect(seen.executeV3).toEqual([]);
  });

  it('names both payees, because "mismatch" tells the caller nothing it can act on', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const err = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: OTHER_PAYEE,
      ownerPubkey: OWNER,
    }).catch((e: Error) => e);

    expect(String(err)).toContain(RECIPIENT);
    expect(String(err)).toContain(OTHER_PAYEE);
    // The float is on the ephemeral by now and the job is dropped. Saying so is
    // the difference between recoverable money and money the user thinks is gone.
    expect(String(err)).toMatch(/Recover funds/);
  });

  it('drops the job, so the recovery path it points at is not blocked by it', async () => {
    // `handlePoolRecover` refuses while any withdrawal is in flight. A retained
    // job would lock the user out of the one path that returns the pre-fund the
    // refusal just stranded — so the throw stays inside the handler's `finally`.
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldExecute',
        jobId: prep.jobId,
        recipient: OTHER_PAYEE,
        ownerPubkey: OWNER,
      }),
    ).rejects.toThrow(/cannot pay/);

    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldExecute',
        jobId: prep.jobId,
        ownerPubkey: OWNER,
      }),
    ).rejects.toThrow(/Unknown withdrawal job/);
  });
});

// ===========================================================================
// ⛔ v3 IS NOT LEGACY — IT HAS TO STAY REACHABLE
// ===========================================================================

/**
 * 🚨 V3-1: A BLINDED NOTE IS NEVER PROVED ON THE PAIR THAT PUBLISHES ITS
 * COMMITMENT. The C1 + C3 pair carries `stark_commitment` in the clear, and the
 * deposit published that same value in its `LeafInserted` event, so a chain
 * reader joins the spend to the deposit and its payer in one lookup. Until
 * V3-1 a circuit-7 rebuild that failed its root pre-flight (`PRE-FLIGHT FAIL`)
 * or its depth check was answered with that pair and nothing on screen said
 * so. 30 of 64 devnet spends were v3 (plan V3-1, `probes/logs/05-analyze.log`);
 * how many came through this fallback was not measured. Since V3-1 the handler
 * refuses such a note with a retry message, before anything is proved, funded
 * or sent. The subscription gets the same refusal from the same helper.
 */
describe('a blinded note is never proved on the commitment-publishing pair (V3-1)', () => {
  it('blinded note refused, not proved on v3', async () => {
    // Anti-vacuity: the note is past the ceiling both circuit-7 jobs apply, so
    // nothing but the handler's routing decides this case.
    expect(BLINDED_NOTE.receipt.noteBlinding >= 2n ** 32n).toBe(true);
    seedSearchNote = BLINDED_NOTE;
    const got: string[] = [];
    for (const [label, failure] of [['PRE-FLIGHT FAIL', PREFLIGHT_FAIL], ['subtree depth', DEPTH_FAIL]] as const) {
      seen.prepareV3 = [];
      seen.prepareV4 = [];
      v4PrepareFailure = failure();
      const outcome = await verdict(handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })));
      got.push(`${label} => ${outcome}; circuit 7 attempted ${seen.prepareV4.length}; C1 + C3 prepares ${seen.prepareV3.length}`);
    }
    expect(got).toEqual([
      'PRE-FLIGHT FAIL => refused, retry; circuit 7 attempted 1; C1 + C3 prepares 0',
      'subtree depth => refused, retry; circuit 7 attempted 1; C1 + C3 prepares 0',
    ]);
  });

  it('the refusal says nothing was sent and to retry, names no note value and carries no needle', async () => {
    seedSearchNote = BLINDED_NOTE;
    v4PrepareFailure = PREFLIGHT_FAIL();
    const err = await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'the blinded note was prepared instead of refused').toBeInstanceOf(Error);
    const message = (err as Error).message;
    // What happened, why, and what to do: the page shows this line as it is.
    expect(message).toMatch(/nothing was proved, funded or sent/i);
    expect(message).toMatch(/publishes the note.s commitment/i);
    expect(message).toMatch(/then retry/i);
    // No value that names the note: its leaf, its commitment, its blinding.
    expect(message).not.toMatch(new RegExp(`\\b${LEAF}\\b`));
    expect(message).not.toContain(String(NOTE.receipt.commitment));
    expect(message).not.toContain(String(BLINDED_NOTE.receipt.noteBlinding));
    // No allow-list needle either: nothing that routes on one may send this
    // refusal to the pair it refuses.
    expect(message).not.toContain('PRE-FLIGHT FAIL');
    expect(message).not.toContain('circuit 7 needs at least');
  });

  it('a blinded subscription is refused, not proved on v3', async () => {
    seedSearchNote = BLINDED_NOTE;
    const got: string[] = [];
    for (const [label, failure] of [['PRE-FLIGHT FAIL', PREFLIGHT_FAIL], ['subtree depth', DEPTH_FAIL]] as const) {
      seen.prepareSubscribe = [];
      seen.prepareSubscribeV4 = [];
      subscribeV4PrepareFailure = failure();
      const outcome = await verdict(handlePoolRequest(subscribeReq()));
      got.push(
        `${label} => ${outcome}; circuit 7 attempted ${seen.prepareSubscribeV4.length}; ` +
          `C1 + C3 prepares ${seen.prepareSubscribe.length}`,
      );
    }
    expect(got).toEqual([
      'PRE-FLIGHT FAIL => refused, retry; circuit 7 attempted 1; C1 + C3 prepares 0',
      'subtree depth => refused, retry; circuit 7 attempted 1; C1 + C3 prepares 0',
    ]);
  });

  it('a pre-blinding refusal from a blinded note is refused too: the handler re-checks the ceiling', async () => {
    // The needle alone would let a reworded or misplaced message open the pair
    // for a blinded note; the handler reads the note's own blinding as well, so
    // the two jobs and the handler must agree before the pair is reachable.
    seedSearchNote = BLINDED_NOTE;
    v4PrepareFailure = PRE_BLINDING();
    subscribeV4PrepareFailure = PRE_BLINDING();
    const got: string[] = [];
    for (const kind of ['withdrawal', 'subscription'] as const) {
      // Asked twice: a disclosure the second request could confirm must not exist.
      for (const attempt of [1, 2]) {
        const outcome =
          kind === 'withdrawal'
            ? await verdict(handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })))
            : await verdict(handlePoolRequest(subscribeReq()));
        got.push(`${kind} ${attempt} => ${outcome}`);
      }
    }
    expect(got).toEqual([
      'withdrawal 1 => refused, retry',
      'withdrawal 2 => refused, retry',
      'subscription 1 => refused, retry',
      'subscription 2 => refused, retry',
    ]);
    expect(seen.prepareV3).toEqual([]);
    expect(seen.prepareSubscribe).toEqual([]);
  });
});

/**
 * ⛔ v3 STAYS REACHABLE FOR THE ONE NOTE THAT HAS NOTHING ELSE, AND ONLY AFTER
 * THE USER HAS BEEN TOLD. The web client asks for circuit 7 on every withdrawal
 * (`unshieldFromPool` sends `recipient` and `owner` unconditionally), so this
 * handler is the only place apps/web can still reach the C1 + C3 pair. Since
 * V3-1 the one note it reaches the pair for is a pre-blinding note: its
 * commitment's third input is its deposit epoch, both circuit-7 jobs refuse it
 * by construction, and the pair is the only spend left for it.
 *
 * It never gets there silently. The first prepare comes back as a disclosure
 * the page shows as its error line: the pair publishes the note's commitment,
 * so the spend matches its deposit, and nothing was proved, funded or sent.
 * Only the same request again (same note, same payee, within ten minutes, once)
 * proves on the pair.
 *
 * ⛔ AN ALLOW-LIST, NOT A DENY-LIST, and that is still the safety property.
 * Anything unrecognised is rethrown, so a new failure mode fails CLOSED rather
 * than finding its way onto the path that republishes the commitment.
 */
describe('a note circuit 7 cannot prove still reaches the C1 + C3 pair', () => {
  it('a pre-blinding note gets the disclosure first, and nothing is prepared', async () => {
    seedSearchNote = PRE_BLINDING_NOTE;
    v4PrepareFailure = PRE_BLINDING();
    const err = await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'the pre-blinding note was prepared on the pair with no disclosure').toBeInstanceOf(Error);
    const message = (err as Error).message;
    // Circuit 7 was genuinely attempted, and neither circuit prepared anything.
    expect(seen.prepareV4).toHaveLength(1);
    expect(seen.prepareV3).toEqual([]);
    // What the pair publishes, what that lets a reader do, what happened, and
    // the one way on.
    expect(message).toMatch(/deposited before we randomised the blinding/);
    expect(message).toMatch(/publishes the note.s commitment/i);
    expect(message).toMatch(/can match this withdrawal to that deposit/);
    expect(message).toMatch(/nothing was proved, funded or sent/i);
    expect(message).toMatch(/press the same button again within 10 minutes/);
    // No value that names the note: its leaf, its commitment, its epoch.
    expect(message).not.toMatch(new RegExp(`\\b${LEAF}\\b`));
    expect(message).not.toContain(String(NOTE.receipt.commitment));
    expect(message).not.toMatch(/67[,.\s]?838/);
  });

  it('falls back to the v3 prepare on the same request once the disclosure was shown', async () => {
    const res = await preparePreBlindingAfterDisclosure(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));

    // Circuit 7 was genuinely ATTEMPTED both times and then fell back — not skipped.
    expect(seen.prepareV4).toHaveLength(2);
    expect(seen.prepareV3).toEqual([{ leafIndex: LEAF }]);
    expect(res.jobId).toBe(V3_JOB_ID);
  });

  it('reports v3, so no screen upgrades its disclosure on a spend that publishes the commitment', async () => {
    const res = await preparePreBlindingAfterDisclosure(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));
    expect(res.version).toBe('v3');
  });

  it('produces a job that executes as v3 — the payee is required, not stored', async () => {
    const prep = await preparePreBlindingAfterDisclosure(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V3_TX');
    expect(seen.executeV3).toEqual([
      { jobId: V3_JOB_ID, recipient: RECIPIENT, ownerPubkey: OWNER },
    ]);
    expect(seen.executeV4).toEqual([]);
  });

  it('the confirmation is one-shot, scoped to its payee, expires after ten minutes, and dies with the pool state', async () => {
    seedSearchNote = PRE_BLINDING_NOTE;
    v4PrepareFailure = PRE_BLINDING();
    const T0 = 1_800_000_000_000;
    const MIN = 60_000;
    let now = T0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const got: string[] = [];
    const ask = async (label: string, at: number, payee: string) => {
      now = T0 + at;
      got.push(`${label} => ${await verdict(handlePoolRequest(prepareReq({ recipient: payee, ownerPubkey: OWNER })))}`);
    };
    try {
      await ask('shown for the payee', 0, RECIPIENT);
      await ask('another payee', 1 * MIN, OTHER_PAYEE);
      await ask('the payee again', 2 * MIN, RECIPIENT);
      await ask('the payee a third time', 3 * MIN, RECIPIENT);
      await ask('ten minutes and a moment later', 13 * MIN + 1, RECIPIENT);
      await ask('again inside the window', 14 * MIN, RECIPIENT);
      await ask('shown once more', 15 * MIN, RECIPIENT);
      clearPoolState();
      configurePoolHandlers('http://localhost:8899');
      setPoolSeed(META, SIGNATURE);
      await ask('after the pool state was cleared', 16 * MIN, RECIPIENT);
    } finally {
      clock.mockRestore();
    }
    expect(got).toEqual([
      'shown for the payee => disclosure',
      // A disclosure shown for one payee does not confirm a spend to another.
      'another payee => disclosure',
      'the payee again => prepared on v3',
      // One confirmation, one prepare.
      'the payee a third time => disclosure',
      'ten minutes and a moment later => disclosure',
      'again inside the window => prepared on v3',
      'shown once more => disclosure',
      'after the pool state was cleared => disclosure',
    ]);
    expect(seen.prepareV3).toHaveLength(2);
  });

  it('a pre-blinding subscription gets the same disclosure, and a withdrawal disclosure does not confirm it', async () => {
    seedSearchNote = PRE_BLINDING_NOTE;
    v4PrepareFailure = PRE_BLINDING();
    subscribeV4PrepareFailure = PRE_BLINDING();
    const got: string[] = [];
    got.push(`withdrawal => ${await verdict(handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })))}`);
    const first = await handlePoolRequest(subscribeReq()).then(() => null, (e: unknown) => e);
    got.push(`subscription => ${await verdict(Promise.reject(first))}`);
    got.push(`subscription again => ${await verdict(handlePoolRequest(subscribeReq()))}`);
    expect(got).toEqual([
      'withdrawal => disclosure',
      'subscription => disclosure',
      // The stubbed C1 + C3 subscribe prepare throws its marker once reached.
      'subscription again => reached the C1 + C3 subscribe prepare',
    ]);
    expect(seen.prepareSubscribeV4).toHaveLength(2);
    expect(seen.prepareSubscribe).toEqual([LEAF]);
    expect(String((first as Error).message)).toMatch(/can match this subscription to that deposit/);
  });

  it('a pre-blinding note whose rebuild failed for another reason gets the retry refusal, not the disclosure', async () => {
    // The disclosure answers ONE refusal, the jobs' pre-blinding one. Any other
    // recognised failure is the retry refusal whatever the note's blinding, so
    // the needle and the ceiling must both hold (mutant M3, "ceiling only",
    // `scratchpad/web-run/logs2/V3-1/mutants.log`).
    seedSearchNote = PRE_BLINDING_NOTE;
    const got: string[] = [];
    for (const [label, failure] of [['PRE-FLIGHT FAIL', PREFLIGHT_FAIL], ['subtree depth', DEPTH_FAIL]] as const) {
      v4PrepareFailure = failure();
      subscribeV4PrepareFailure = failure();
      got.push(`withdrawal, ${label} => ${await verdict(handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })))}`);
      got.push(`subscription, ${label} => ${await verdict(handlePoolRequest(subscribeReq()))}`);
    }
    expect(got).toEqual([
      'withdrawal, PRE-FLIGHT FAIL => refused, retry',
      'subscription, PRE-FLIGHT FAIL => refused, retry',
      'withdrawal, subtree depth => refused, retry',
      'subscription, subtree depth => refused, retry',
    ]);
    expect(seen.prepareV3).toEqual([]);
    expect(seen.prepareSubscribe).toEqual([]);
  });

  it('the pre-blinding needle and ceiling match both circuit-7 jobs', () => {
    // ANTI-VACUITY. The cases above inject the job's message themselves, so a
    // reword in either job, or a moved ceiling, would leave them green while the
    // real note went nowhere. This reads all three sources.
    const handlers = readFileSync(join(__dirname, 'poolHandlers.ts'), 'utf8');
    expect(handlers).toContain("const PRE_BLINDING_REFUSAL = 'circuit 7 needs at least a randomised blinding';");
    expect(handlers).toContain('const LEGACY_BLINDING_CEILING = 2n ** 32n;');
    for (const job of ['../pool/unshieldEphemeral.ts', '../pool/subscribeEphemeral.ts']) {
      const src = readFileSync(join(__dirname, job), 'utf8');
      expect(src, `${job} reworded the pre-blinding refusal`).toContain(
        "'circuit 7 needs at least a randomised blinding, and this note carries its deposit '",
      );
      expect(src, `${job} moved the ceiling`).toContain('const LEGACY_BLINDING_CEILING = 2n ** 32n;');
      expect(src, `${job} no longer refuses below the ceiling`).toContain(
        'if (receipt.noteBlinding < LEGACY_BLINDING_CEILING) {',
      );
    }
  });

  /**
   * ⛔ THE PAYEE REFUSAL MUST NOT BE LAUNDERED INTO A v3 JOB.
   *
   * `prepareUnshieldJobV4` refuses `recipient === ownerPubkey` at PROVE time.
   * `prepareUnshieldJob` makes no such check — on the v3 path the refusal lives
   * inside `executeUnshield`, which runs AFTER the pre-fund has landed. So a
   * fallback that swallowed this error would convert a free refusal into a
   * stranded pre-fund, and undo the single reason the payee moved to prepare.
   */
  it('does NOT fall back when the payee is the wallet funding the withdrawal', async () => {
    v4PrepareFailure = new Error(
      'Refusing to withdraw to the wallet that funded this withdrawal — that names it ' +
        'on-chain as the pool payee.',
    );
    await expect(
      handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })),
    ).rejects.toThrow(/Refusing to withdraw to the wallet/);

    expect(seen.prepareV3, 'the refused payee reached the C1 + C3 prepare').toEqual([]);
  });

  it('does NOT fall back when the note is already spent', async () => {
    v4PrepareFailure = new Error('This note has already been withdrawn.');
    await expect(
      handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })),
    ).rejects.toThrow(/already been withdrawn/);
    expect(seen.prepareV3).toEqual([]);
  });

  it('does NOT fall back on an unrecognised failure — the allow-list fails closed', async () => {
    v4PrepareFailure = new Error('wasm prover panicked while generating the spend trace');
    await expect(
      handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })),
    ).rejects.toThrow(/wasm prover panicked/);
    expect(seen.prepareV3).toEqual([]);
  });

  /**
   * ANTI-VACUITY for the allow-list. The two strings it matches on are produced
   * by another file; if they were reworded the fallback would silently stop
   * firing and every test above would still pass, because they inject the
   * message themselves. This is the only assertion that reads the real source.
   */
  it('matches failures the circuit-7 prepare can actually produce', () => {
    const src = readFileSync(join(__dirname, '../pool/denominatedPool.ts'), 'utf8');
    expect(src, 'the root pre-flight no longer says PRE-FLIGHT FAIL').toContain(
      'PRE-FLIGHT FAIL',
    );
    expect(src, 'the subtree-depth refusal was reworded').toContain('circuit 7 needs at least');

    // And the two it deliberately does NOT match, for the same reason.
    const eph = readFileSync(join(__dirname, '../pool/unshieldEphemeral.ts'), 'utf8');
    expect(eph).toContain('Refusing to withdraw to the wallet');
    expect(eph).toContain('already been withdrawn');
  });
});

// ===========================================================================
// 🚨 THE ROOT A SPEND NAMES, AND THE WALK THAT PRODUCES IT
// ===========================================================================

/**
 * `unshield_denominated_stark_v4` carries `merkle_root` IN THE CLEAR, and the
 * chain accepts any root still in the pool ring. So a spend that names the root
 * its OWN deposit created publishes a one-hop link back to that deposit — and
 * the transaction succeeds, so nothing anywhere complains. Measured on devnet:
 * 1 v4 spend of 34 named a root 4 insertions stale, and in v3 all 4 stale roots
 * were the spending note's own deposit root (`scratchpad/probe-stale-root-
 * 2026-09-15.log`, map C headline).
 *
 * `spendRootIsCurrent.test.ts` pins the prepare itself. The two cases here are
 * the HANDLER half, which that file cannot see:
 *   1. the handler hands down the leaf map it ALREADY walked, so the root is a
 *      function of pool state rather than of the note, and the second walk —
 *      the cost that made a saved path attractive — is gone;
 *   2. a refusal about incomplete history does NOT fall through to the C1 + C3
 *      pair, which would republish this note's commitment and undo the refusal.
 */
describe('the root a circuit-7 withdrawal names comes from the freshest leaf map', () => {
  /**
   * The map handed to the prepare must be the WHOLE walk. Cut down at the note,
   * it folds to the root the note's own insertion made, which the ring still
   * holds, so the prepare accepts it with no refetch and the spend names its
   * own deposit. Cut down to the note alone, or dropped whenever a saved path
   * exists, it costs a second history walk on every withdrawal. Controls:
   * mutants V13 (cut at the note), V13b (the note alone), V13d (everything
   * below the note dropped) and V2 (dropped when a saved path exists),
   * `scratchpad/web-run/logs/SPEND-1-web-fix2/`. The benign mutant HB (a copy
   * of the same map) stays green, so this pins the content, not the identity.
   */
  function expectTheWholeWalk(leaves: Map<string, { leafIndex: number }> | undefined): void {
    // Anti-vacuity: the fixture walk has leaves on both sides of the note, so
    // a cut map cannot equal it.
    const walk = walkedCommitments();
    const indices = [...walk.values()].map((e) => e.leafIndex);
    expect(indices.filter((i) => i > LEAF), 'the fixture walk has no leaf after the note').toHaveLength(3);
    expect(indices.filter((i) => i < LEAF), 'the fixture walk has no leaf before the note').toHaveLength(1);

    expect(leaves, 'the handler walked the history and then dropped it').toBeInstanceOf(Map);
    const afterNote = [...(leaves?.values() ?? [])].filter((e) => e.leafIndex > LEAF).length;
    expect(afterNote, 'the handler cut the walked map down at the note').toBe(3);
    expect(leaves, 'the handler handed on something other than the walk it made').toEqual(walk);
  }

  it('hands the circuit-7 prepare the leaves it already walked', async () => {
    await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));

    const opts = seen.prepareV4Opts[0] as
      | { leaves?: Map<string, { leafIndex: number }>; savedPath?: unknown }
      | undefined;
    // `locateOwnedNote` has already pulled the pool history — the heaviest call
    // on this path. Dropping it made the prepare walk a second time, and that
    // cost is exactly what a saved path used to be preferred over.
    expect(opts?.leaves, 'the handler walked the history and then dropped it').toBeInstanceOf(
      Map,
    );
    expect(opts?.leaves?.get(NOTE.receipt.commitment.toString())?.leafIndex).toBe(LEAF);
    expectTheWholeWalk(opts?.leaves);
  });

  it('hands the circuit-7 prepare what its walk could not read', async () => {
    // The prepare proves a ring root the pool is not on NOW only when the walk
    // behind the map left nothing it listed unread: a map that stops at an
    // unread insert may stop where this client last read, right after its own
    // deposit, and its root would date the note (`spendRootIsCurrent.test.ts`,
    // "a history cache left short by its last walk, with newer inserts listed
    // but not served, is never proved"). A handler that reported 0 whatever
    // the walk said would let that root through; one that dropped the count
    // costs a refetch on every lagging map. Controls:
    // `scratchpad/web-run/logs2/SPEND-1-cr1/`.
    // A walk that made NO report is passed on as none (undefined), which the
    // prepare reads as "not shown clean"; a handler that turned it into 0 would
    // fail open (mutant H_UNDEF0, `scratchpad/web-run/logs2/verify-SPEND-1-r3/`;
    // control in `scratchpad/web-run/logs2/SPEND-1-cr3/`).
    for (const unread of [2, 0, 5, undefined]) {
      clearPoolState();
      configurePoolHandlers('http://localhost:8899');
      setPoolSeed(META, SIGNATURE);
      seen.prepareV4Opts = [];
      walkUnread = unread;
      await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));
      const opts = seen.prepareV4Opts[0] as { unread?: unknown; leaves?: Map<string, { leafIndex: number }> } | undefined;
      expect(opts?.unread, `the walk reported ${unread ?? 'nothing'} unread`).toBe(unread);
      expectTheWholeWalk(opts?.leaves);
    }
  });

  it('hands the circuit-7 prepare the saved witness it read from the stored blob', async () => {
    // The prepare uses a saved path only when its root is the pool's CURRENT
    // root (`spendRootIsCurrent.test.ts`, "a saved root equal to the current
    // root is used"). If the handler dropped it, a holed history with a current
    // saved witness would end in PRE-FLIGHT FAIL and go to the C1 + C3 pair,
    // which publishes the commitment. A REAL stored blob is sealed to every seed
    // this identity searches, so `extractStoredPath` runs its real decrypt and
    // match. Control: mutant R2 (handler passes `{ leaves }` only),
    // `scratchpad/wp-logs/SPEND-1-fix2-mutants/`.
    const witness = {
      pathElements: Array.from({ length: 15 }, (_, i) => String(4_000 + i)),
      pathIndices: Array.from({ length: 15 }, (_, i) => i % 2),
      root: '424242',
    };
    const blobs = seedsInSearchOrder(derivePoolSeeds(SIGNATURE, null)).map((c) =>
      encryptNote(
        createNoteEncryptionAddress(c.seed),
        utf8ToBytes(
          JSON.stringify({
            version: 1,
            commitment: NOTE.receipt.commitment.toString(),
            merklePath: witness,
          }),
        ),
      ),
    );

    await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER, encryptedNotes: blobs }),
    );

    expect(seen.prepareV4).toHaveLength(1);
    const opts = seen.prepareV4Opts[0] as
      | { leaves?: Map<string, { leafIndex: number }>; savedPath?: unknown }
      | undefined;
    expect(opts?.savedPath, 'the handler read the saved witness and then dropped it').toEqual(
      witness,
    );
    // The saved witness travels WITH the walked leaves, never instead of them.
    // A stored path is the common case for inventory notes, so a handler that
    // dropped the leaves whenever one exists would walk the history twice on
    // most withdrawals (mutant V2).
    expectTheWholeWalk(opts?.leaves);
  });

  /**
   * ⛔ THE MESSAGE IS THE MECHANISM. `isV4RebuildFailure` is an ALLOW-LIST over
   * message needles, so a refusal that happened to contain one of them would be
   * routed to the pair that publishes the commitment — the exact outcome the
   * refusal exists to prevent, reached by wording rather than by logic.
   */
  it('does NOT fall back to the C1 + C3 pair when the history is incomplete', async () => {
    // ANTI-VACUITY FIRST. The sentence injected below has to be one the prepare
    // can really produce, or this case measures a string agreeing with itself.
    const src = readFileSync(join(__dirname, '../pool/denominatedPool.ts'), 'utf8');
    expect(src, 'the incomplete-history refusal is not in denominatedPool.ts').toContain(
      HISTORY_REFUSAL,
    );
    // ...and it must carry NEITHER needle of the allow-list.
    expect(HISTORY_REFUSAL).not.toContain('PRE-FLIGHT FAIL');
    expect(HISTORY_REFUSAL).not.toContain('circuit 7 needs at least');

    v4PrepareFailure = Object.assign(new Error(`${HISTORY_REFUSAL}. Nothing was spent.`), {
      name: 'HistoryIncompleteError',
    });
    await expect(
      handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })),
    ).rejects.toThrow(/history this client can read is incomplete/);

    // Circuit 7 was genuinely attempted, and the pair was NOT reached.
    expect(seen.prepareV4).toHaveLength(1);
    expect(
      seen.prepareV3,
      'an incomplete history reached the pair that republishes the commitment',
    ).toEqual([]);
  });

  it('a RECEIVED note resolved from its real blob gets the whole walk and its issuance-time path, and its refusal stays off C1 + C3', async () => {
    // Every case above resolves the note through the (mocked) seed search, so
    // its source is 'shielded'. An issued or imported note is resolved by
    // `receivedNoteFromBlobs` from the blob `handlePoolImportNote` files, and
    // it carries the path the issuer saved: a root AFTER later deposits (the
    // buyer's own among them), not the note's own. A handler that sent
    // received notes to the C1 + C3 pair (mutant HRCV,
    // `scratchpad/web-run/logs/verify-SPEND-1-r3/mutants/`), cut or dropped
    // their walk or path, or let their HistoryIncompleteError fall back to that
    // pair passed every case above. Controls:
    // `scratchpad/web-run/logs/SPEND-1-web-fix3b/`.
    const sender = {
      secret: 5_550_001n,
      nullifierPreimage: 5_550_002n,
      // A PRF draw, well above the legacy-epoch ceiling, as an issued note carries.
      noteBlinding: 7_284_991_002_338_477_113n,
      tokenMint: 0n,
    };
    const commitment = createCommitmentV3(
      sender.nullifierPreimage, sender.secret, sender.noteBlinding, sender.tokenMint,
    );
    // The seed search finds nothing at LEAF, and the walk holds the received commitment there.
    seedSearchNote = null;
    commitmentAtLeaf = commitment;
    // ...and the walk left three listed signatures unread, which the prepare must be told.
    walkUnread = 3;
    const walk = walkedCommitments();
    const denseUpTo = (upto: number) => {
      const leaves = new Array<bigint>(upto + 1).fill(0n);
      for (const e of walk.values()) if (e.leafIndex <= upto) leaves[e.leafIndex] = e.commitment;
      return leaves;
    };
    // The issuer's saved path: the note in the tree as it stood two insertions later.
    const issued = buildMerkleProofFromLeavesV3({ leavesByIndex: denseUpTo(LEAF + 2), targetLeafIndex: LEAF });
    const own = buildMerkleProofFromLeavesV3({ leavesByIndex: denseUpTo(LEAF), targetLeafIndex: LEAF });
    const whole = buildMerkleProofFromLeavesV3({ leavesByIndex: denseUpTo(LEAF + 3), targetLeafIndex: LEAF });
    // Anti-vacuity: the saved root is a LATER root, neither the note's own nor the walk's.
    expect(new Set([issued.root, own.root, whole.root].map(String)).size).toBe(3);
    const issuedPath = {
      pathElements: issued.pathElements.map(String),
      pathIndices: issued.pathIndices,
      root: issued.root.toString(),
    };
    // Sealed to the ACTIVE seed, in the shape `handlePoolImportNote` files.
    const blob = encryptNote(
      createNoteEncryptionAddress(derivePoolSeeds(SIGNATURE, null).active),
      utf8ToBytes(
        JSON.stringify({
          version: 1,
          pool: POOL_58,
          secret: sender.secret.toString(),
          nullifier_preimage: sender.nullifierPreimage.toString(),
          deposit_epoch: sender.noteBlinding.toString(),
          token_mint: sender.tokenMint.toString(),
          commitment: commitment.toString(),
          leafIndex: LEAF,
          merklePath: issuedPath,
          token: 'SOL',
          denominationHuman: DENOM,
          shieldedAt: 0,
          source: 'received',
        }),
      ),
    );
    const req = prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER, encryptedNotes: [blob] });

    // 1. Circuit 7, with the received note, the whole walk and the issuer's path.
    const res = await handlePoolRequest(req);
    expect(res.version, 'a received note was sent to the C1 + C3 pair').toBe('v4');
    expect(seen.prepareV3).toEqual([]);
    expect(seen.prepareV4Receipts, 'the note did not come from its blob').toEqual([
      { source: 'received', commitment: commitment.toString(), leafIndex: LEAF },
    ]);
    const opts = seen.prepareV4Opts[0] as
      | { leaves?: Map<string, { leafIndex: number }>; savedPath?: unknown }
      | undefined;
    expect(opts?.savedPath, 'the handler dropped the received note\'s saved path').toEqual(issuedPath);
    expectTheWholeWalk(opts?.leaves);
    expect((opts as { unread?: unknown } | undefined)?.unread, 'the handler did not pass on what its walk left unread').toBe(3);

    // 2. The prepare's refusal is rethrown; the pair is never reached.
    seen.prepareV4 = [];
    seen.prepareV4Receipts = [];
    v4PrepareFailure = new HistoryIncompleteError();
    const refused = await handlePoolRequest(req).then(
      (r) => `prepared on ${r.version}`,
      (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
    );
    expect(refused).toBe('refused: HistoryIncompleteError');
    expect(seen.prepareV4Receipts.map((r) => r.source), 'circuit 7 was not attempted').toEqual(['received']);
    expect(
      seen.prepareV3,
      'a received note\'s refusal reached the pair that republishes its commitment',
    ).toEqual([]);
  });

  it('a note whose insert no walk read places is refused on circuit 7 and never reaches the C1 + C3 pair: the real walk and the real prepare', async () => {
    // Every case above injects the circuit-7 prepare's failure. Here nothing
    // is injected: the handler's walk is the REAL `fetchPoolCommitments` and
    // the prepare the REAL `prepareUnshieldJobV4` -> `prepareUnshieldV4`, on a
    // fake RPC that lists the note's insert and does not serve its transaction
    // (a 429 on that read), or has not listed it yet. The note is resolved from
    // its stored blob, which `receivedNoteFromBlobs` accepts while the walk
    // does not hold its commitment: a RECEIVED note filed with no path, as
    // ISSUE-2 files issued notes, or an own note's shield-time blob, whose
    // path folds to its deposit root, gone from the ring. The prepare ended in
    // PRE-FLIGHT FAIL there, a needle the handler routed to the C1 + C3 pair
    // until V3-1 (verifier r4 of the continued run,
    // `scratchpad/web-run/logs2/verify-SPEND-1-r4/probe/handler-NONE.log`). It
    // must end in HistoryIncompleteError with the pair never prepared. The
    // control world serves the transaction and proves on circuit 7 at the
    // pool's current root.
    const pool = findPoolV3('SOL', DENOM)!;
    expect(pool.poolPDA.toBase58()).toBe(POOL_58);
    const disc = sha256(utf8ToBytes('event:LeafInserted')).slice(0, 8);
    const leafLog = (i: number, c: bigint): string => {
      const d = new Uint8Array(144);
      d.set(disc, 0);
      d.set(pool.poolPDA.toBytes(), 8);
      for (let k = 0; k < 8; k++) d[40 + k] = Number((BigInt(i) >> BigInt(8 * k)) & 0xffn);
      d.set(new Uint8Array(goldilocksToLeBytes32(c)), 48);
      return `Program data: ${Buffer.from(d).toString('base64')}`;
    };
    /** The pool account as `parsePoolV3Account` reads it (see `spendRootIsCurrent.test.ts`). */
    const account = (current: bigint, ring: bigint[], next: number): Uint8Array => {
      const d = new Uint8Array(182 + ring.length * 32);
      d.set(new Uint8Array(goldilocksToLeBytes32(current)), 88);
      d[120] = 15;
      d[121] = next;
      d[177] = 1;
      d[178] = ring.length;
      ring.forEach((r, i) => d.set(new Uint8Array(goldilocksToLeBytes32(r)), 182 + i * 32));
      return d;
    };
    const notes = {
      received: { secret: 5_550_001n, nullifierPreimage: 5_550_002n, noteBlinding: 7_284_991_002_338_477_113n, tokenMint: 0n },
      own: { secret: 6_660_001n, nullifierPreimage: 6_660_002n, noteBlinding: 8_111_222_333_444_555_666n, tokenMint: 0n },
    };
    const worlds = [
      { label: 'received note filed with no path, its insert listed and never served', kind: 'received' as const, listedUpTo: 14, served: false },
      { label: 'received note filed with no path, its insert not listed yet', kind: 'received' as const, listedUpTo: LEAF - 1, served: true },
      { label: 'own note from its shield-time blob (deposit root gone from the ring), insert listed and never served', kind: 'own' as const, listedUpTo: 14, served: false },
      { label: 'control: received note, its insert served', kind: 'received' as const, listedUpTo: 14, served: true },
    ];
    const got: string[] = [];
    const want: string[] = [];
    try {
      for (const w of worlds) {
        const n = notes[w.kind];
        // Anti-vacuity: both notes are blinded, so no pre-blinding refusal decides instead.
        expect(n.noteBlinding >= 2n ** 32n).toBe(true);
        const commitment = createCommitmentV3(n.nullifierPreimage, n.secret, n.noteBlinding, n.tokenMint);
        const leaves = Array.from({ length: 15 }, (_, i) => (i === LEAF ? commitment : 70_000n + BigInt(i)));
        const rootAfter = (k: number) => buildMerkleProofFromLeavesV3({ leavesByIndex: leaves.slice(0, k + 1), targetLeafIndex: LEAF });
        // The pool is at R14; its ring holds R12 and R13, so R11, the note's own deposit root, is gone.
        const acct = account(rootAfter(14).root, [rootAfter(12).root, rootAfter(13).root], 15);
        clearPoolState();
        configurePoolHandlers('http://localhost:8899');
        setPoolSeed(META, SIGNATURE);
        seen.prepareV3 = [];
        seen.prepareV4 = [];
        seen.proofLevels = [];
        seedSearchNote = null; // the seed search needs the leaf in the map
        setPoolHistoryStore(memoryPoolHistoryStore());
        realChain = {
          rpcEndpoint: 'https://devnet.helius-rpc.com/?api-key=NOT-A-REAL-KEY',
          getSignaturesForAddress: async (_pda: unknown, o?: { until?: string; before?: string }) => {
            const until = o?.until ? Number(o.until.replace('SIG', '')) : -1;
            const before = o?.before ? Number(o.before.replace('SIG', '')) : Number.POSITIVE_INFINITY;
            return leaves.map((_, i) => i).filter((i) => i <= w.listedUpTo && i > until && i < before)
              .reverse().map((i) => ({ signature: `SIG${i}`, err: null }));
          },
          getTransaction: async (sig: string) => {
            const i = Number(sig.replace('SIG', ''));
            if (i === LEAF && !w.served) return null;
            return {
              slot: 100 + i,
              transaction: { message: { staticAccountKeys: [{ toBase58: () => `PAYER${i}` }] } },
              meta: { logMessages: [leafLog(i, leaves[i])] },
            };
          },
          getAccountInfo: async () => ({ data: acct }),
          getMinimumBalanceForRentExemption: async () => 1_000_000,
        };
        // The blob, sealed to the ACTIVE seed: `handlePoolImportNote`'s shape with
        // no path, or `poolShieldExecute`'s with the path of the note's own insertion.
        const own = rootAfter(LEAF);
        const blob = encryptNote(
          createNoteEncryptionAddress(derivePoolSeeds(SIGNATURE, null).active),
          utf8ToBytes(JSON.stringify({
            version: 1,
            pool: POOL_58,
            secret: n.secret.toString(),
            nullifier_preimage: n.nullifierPreimage.toString(),
            deposit_epoch: n.noteBlinding.toString(),
            token_mint: n.tokenMint.toString(),
            commitment: commitment.toString(),
            leafIndex: LEAF,
            ...(w.kind === 'own'
              ? { merklePath: { pathElements: own.pathElements.map(String), pathIndices: own.pathIndices, root: own.root.toString() } }
              : {}),
            token: 'SOL',
            denominationHuman: DENOM,
            shieldedAt: 0,
            ...(w.kind === 'received' ? { source: 'received' } : {}),
          })),
        );
        const outcome = await handlePoolRequest(
          prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER, encryptedNotes: [blob] }),
        ).then(
          (r) => `prepared on ${r.version}`,
          (e: unknown) => {
            const name = e instanceof Error ? e.name : typeof e;
            const m = e instanceof Error ? e.message : String(e);
            if (name === 'HistoryIncompleteError') return 'refused: HistoryIncompleteError';
            if (/not retried on the older C1 \+ C3 pair/.test(m)) return `refused: ${name}, the handler's V3-1 retry refusal of a PRE-FLIGHT FAIL`;
            return `refused: ${name}: ${m.slice(0, 120)}`;
          },
        );
        // The root proved, read off the levels the prover got: the pool's current root, R14.
        const current = rootAfter(14);
        const proved = seen.proofLevels.length === 0
          ? 'no proof'
          : JSON.stringify(seen.proofLevels[0]) === JSON.stringify(current.pathElements.slice(0, C7_SUBTREE_DEPTH).map(String))
            ? 'proved at R14, the current root'
            : 'proved at another root';
        got.push(
          `${w.label} => ${outcome}; ${proved}; circuit 7 attempted ${seen.prepareV4.length}; ` +
            `C1 + C3 prepares ${seen.prepareV3.length}`,
        );
        want.push(
          w.label.startsWith('control')
            ? `${w.label} => prepared on v4; proved at R14, the current root; circuit 7 attempted 1; C1 + C3 prepares 0`
            : `${w.label} => refused: HistoryIncompleteError; no proof; circuit 7 attempted 1; C1 + C3 prepares 0`,
        );
      }
    } finally {
      realChain = null;
      setPoolHistoryStore(null);
    }
    expect(got).toEqual(want);
  });
});

describe('a v3 job still requires the payee at execute, because its proof names none', () => {
  it('passes the payee straight through when it is there', async () => {
    const prep = await handlePoolRequest(prepareReq());
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V3_TX');
    expect(seen.executeV3).toEqual([
      { jobId: V3_JOB_ID, recipient: RECIPIENT, ownerPubkey: OWNER },
    ]);
    expect(seen.executeV4).toEqual([]);
  });

  it('refuses rather than inventing one when it is missing', async () => {
    // Making the recipient optional on the wire is what makes this reachable at
    // all. Defaulting to the wallet here is exactly how `owner` reached
    // `recipient` in PoolPanel.tsx:125 and paid the pool out to the funder.
    const prep = await handlePoolRequest(prepareReq());
    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldExecute',
        jobId: prep.jobId,
        ownerPubkey: OWNER,
      }),
    ).rejects.toThrow(/names no payee/);
    expect(seen.executeV3).toEqual([]);
  });
});

// ===========================================================================
// ⛔ THE SUBSCRIPTION MUST NOT MOVE
// ===========================================================================

/**
 * 🚨 UPDATED 2026-08-27. This block used to open "There is no
 * `subscribe_private_stark_v4` on chain". THERE NOW IS
 * (`programs/zk_shielded/src/lib.rs:549`), and the subscribe path is wired to it
 * through `prepareSubscribeJobV4` / `executeSubscribeV4`. Everything below still
 * holds, and the reason it matters is now STRONGER rather than gone: the two v4
 * instructions bind DIFFERENT digests — the withdrawal `sha256(recipient)`, the
 * subscribe a 132-byte `"P01:C7:SUBSCRIBE:v1" || vault || rate ||
 * interval_slots || vk_hash || license` composite. A subscription that reached
 * the WITHDRAWAL's circuit-7 branch would build a proof the subscribe handler
 * refuses at the END of a ~78-chunk upload, in the flow the 2026-09-04 demo is
 * entirely about.
 *
 * TWO independent reasons it cannot happen, checked below by two different
 * methods. It was written as THREE, and the third was measured false:
 *
 *   DISPATCH  the two kinds land in two different handlers. Measured by the
 *             runtime test below, which smuggles the v4 fields into a subscribe
 *             message through a cast so that ONLY the dispatch is under test.
 *   SOURCE    `handlePoolSubscribePrepare` contains no reference to the v4
 *             prepare at all, and `prepareSubscribeJob` calls
 *             `prepareUnshieldJob` itself (subscribeEphemeral.ts:115).
 *
 * ⛔ THE RETRACTED ONE: "`PoolSubscribePrepareRequest` has no `recipient` and no
 * `ownerPubkey`, so `tsc` refuses a subscribe message carrying either." IT DOES
 * NOT. Measured 2026-08-26 in a scratch file inside this package's tsconfig: a
 * FRESH OBJECT LITERAL of kind `poolSubscribePrepare` carrying both fields, passed
 * to `handlePoolRequest`, raised nothing — while a deliberate type error in the
 * same file raised, proving tsc had the file in the program. The cause is that
 * `handlePoolRequest` is `<R extends PoolRequest>(req: R, …)`: excess-property
 * checking does not apply when the contextual type is a bare type parameter, and
 * the constraint check is plain assignability, which two extra string fields
 * satisfy. Nothing here depended on the claim, but it was written to be leaned
 * on by the next reader, which is worse than not writing it.
 */
describe('the subscribe path cannot reach the circuit-7 branch', () => {
  it('goes to prepareSubscribeJob, and would even if the v4 fields were smuggled in', async () => {
    // The cast is NOT belt-and-braces against the typecheck — the typecheck does
    // not stop this shape (see above). It is here because `handlePoolRequest`'s
    // parameter is a union and the literal has to be admitted to reach dispatch.
    await expect(
      handlePoolRequest({
        kind: 'poolSubscribePrepare',
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: LEAF,
        recipient: RECIPIENT,
        ownerPubkey: OWNER,
      } as unknown as Parameters<typeof handlePoolRequest>[0]),
    ).rejects.toThrow('SUBSCRIBE_REACHED_PREPARE_SUBSCRIBE_JOB');

    // It reached the C1 + C3 prepare the subscription shares with the v3
    // withdrawal, and the circuit-7 prepare was never called.
    expect(seen.prepareSubscribe).toEqual([LEAF]);
    expect(seen.prepareV4).toEqual([]);
  });

  it('leaves no v4 reference inside handlePoolSubscribePrepare', () => {
    // Newlines normalised FIRST. The repo checks out CRLF on Windows, and the
    // first draft of the extractor below searched for '\n}\n' and found nothing
    // — which the anti-vacuity assertion caught as "could not find the end of
    // handlePoolUnshieldPrepare" instead of passing a vacuous negative.
    const src = readFileSync(join(__dirname, 'poolHandlers.ts'), 'utf8').replace(/\r\n/g, '\n');

    /** The body of one top-level `async function`, up to its closing brace. */
    function bodyOf(name: string): string {
      const start = src.indexOf(`async function ${name}(`);
      expect(start, `${name} is not a top-level async function in poolHandlers.ts`).toBeGreaterThan(
        -1,
      );
      const end = src.indexOf('\n}\n', start);
      expect(end, `could not find the end of ${name}`).toBeGreaterThan(start);
      return src.slice(start, end);
    }

    // ANTI-VACUITY FIRST. Both assertions below are `indexOf` over an extracted
    // string; if the extraction were broken — a renamed function, a changed
    // brace style — the negative assertion would pass while measuring nothing.
    // A guard that matched the wrong text has already shipped once on this
    // project (2026-08-25, a scan that matched a destructuring instead of the
    // `require!`), so the positive case is asserted before anything leans on it.
    expect(bodyOf('handlePoolUnshieldPrepare')).toContain('prepareUnshieldJobV4');
    expect(bodyOf('handlePoolSubscribePrepare')).not.toContain('prepareUnshieldJobV4');
    expect(bodyOf('handlePoolSubscribePrepare')).toContain('prepareSubscribeJob');
  });
});

describe('the circuit-7 subscription keeps its incomplete-history refusal off C1 + C3', () => {
  it('a circuit-7 subscription refused for an incomplete history does NOT fall back to the C1 + C3 pair', async () => {
    // `prepareSubscribeV4` raises HistoryIncompleteError when the only root it
    // can build is tied to the note (`spendRootIsCurrent.test.ts`, "the
    // circuit-7 SUBSCRIPTION prepare never proves a root tied to the note
    // either"). The subscribe handler shares `isV4RebuildFailure` with the
    // withdrawal, and must rethrow it: the pair publishes the commitment.
    // The pre-blinding world, asked twice, is this harness's positive control:
    // it shows the stub CAN reach the pair, so a 0 in the other worlds is the
    // handler's choice, not a harness that never gets there. Since V3-1 a
    // PRE-FLIGHT FAIL no longer reaches the pair either ("a blinded
    // subscription is refused, not proved on v3").
    const preflight = new Error(
      "PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots " +
        '(current + 4 historical). Aborting before proof rent is spent.',
    );
    const refusal = new HistoryIncompleteError('subscription');
    // The screen names the action the user took.
    expect(refusal.message).toContain('so the subscription could not be built');
    const outcomes: string[] = [];
    for (const [label, failure, note, asks] of [
      ['PRE-FLIGHT FAIL', preflight, BLINDED_NOTE, 1],
      ['HistoryIncompleteError', refusal, BLINDED_NOTE, 1],
      ['pre-blinding, asked twice', PRE_BLINDING(), PRE_BLINDING_NOTE, 2],
    ] as const) {
      seen.prepareSubscribe = [];
      seen.prepareSubscribeV4 = [];
      seedSearchNote = note;
      subscribeV4PrepareFailure = failure;
      let outcome = '';
      for (let i = 0; i < asks; i++) {
        outcome = await handlePoolRequest(subscribeReq()).then(
          (r) => `prepared on ${r.version}`,
          (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
        );
      }
      outcomes.push(
        `${label} => ${outcome}; circuit 7 attempted ${seen.prepareSubscribeV4.length}; ` +
          `C1 + C3 reached ${seen.prepareSubscribe.length}`,
      );
    }
    expect(outcomes).toEqual([
      'PRE-FLIGHT FAIL => refused: Error; circuit 7 attempted 1; C1 + C3 reached 0',
      'HistoryIncompleteError => refused: HistoryIncompleteError; circuit 7 attempted 1; C1 + C3 reached 0',
      // The stubbed v3 prepare throws its marker once reached.
      'pre-blinding, asked twice => refused: Error; circuit 7 attempted 2; C1 + C3 reached 1',
    ]);
  });

  it('hands the circuit-7 SUBSCRIPTION prepare the saved witness it read from the stored blob', async () => {
    // `prepareSubscribeV4` reads the saved root as one more tie to the note,
    // as the withdrawal does (`spendRootIsCurrent.test.ts`, "the circuit-7
    // SUBSCRIPTION applies the saved-root tie as the withdrawal does (m == k)").
    // The handler used to read the stored path for the C1 + C3 route only, so
    // the subscription proved a map whose root WAS the saved one (verifier r3
    // of the continued run, minor 3, probe world PC,
    // `scratchpad/web-run/logs2/verify-SPEND-1-r3/probe/NONE.log`). Three
    // worlds: an own note with a sealed witness, a RECEIVED note resolved from
    // the blob `handlePoolImportNote` files (its issuance-time path), and no
    // blob at all. Control: `scratchpad/web-run/logs2/SPEND-1-cr3/`.
    const subscribeReq = (encryptedNotes: string[] | undefined) => ({
      kind: 'poolSubscribePrepare' as const,
      meta: META,
      token: 'SOL' as const,
      denomination: DENOM,
      leafIndex: LEAF,
      retailer: RECIPIENT,
      rate: '1000000',
      intervalSlots: '6480000',
      ...(encryptedNotes ? { encryptedNotes } : {}),
    });
    const witness = {
      pathElements: Array.from({ length: 15 }, (_, i) => String(4_000 + i)),
      pathIndices: Array.from({ length: 15 }, (_, i) => i % 2),
      root: '424242',
    };
    const ownBlobs = seedsInSearchOrder(derivePoolSeeds(SIGNATURE, null)).map((c) =>
      encryptNote(
        createNoteEncryptionAddress(c.seed),
        utf8ToBytes(
          JSON.stringify({ version: 1, commitment: NOTE.receipt.commitment.toString(), merklePath: witness }),
        ),
      ),
    );
    const sender = {
      secret: 5_550_001n,
      nullifierPreimage: 5_550_002n,
      noteBlinding: 7_284_991_002_338_477_113n,
      tokenMint: 0n,
    };
    const received = createCommitmentV3(
      sender.nullifierPreimage, sender.secret, sender.noteBlinding, sender.tokenMint,
    );
    const issuedPath = {
      pathElements: Array.from({ length: 15 }, (_, i) => String(6_000 + i)),
      pathIndices: Array.from({ length: 15 }, (_, i) => (i + 1) % 2),
      root: '535353',
    };
    const receivedBlob = encryptNote(
      createNoteEncryptionAddress(derivePoolSeeds(SIGNATURE, null).active),
      utf8ToBytes(
        JSON.stringify({
          version: 1,
          pool: POOL_58,
          secret: sender.secret.toString(),
          nullifier_preimage: sender.nullifierPreimage.toString(),
          deposit_epoch: sender.noteBlinding.toString(),
          token_mint: sender.tokenMint.toString(),
          commitment: received.toString(),
          leafIndex: LEAF,
          merklePath: issuedPath,
          token: 'SOL',
          denominationHuman: DENOM,
          shieldedAt: 0,
          source: 'received',
        }),
      ),
    );
    const worlds = [
      { label: 'own note, sealed witness', blobs: ownBlobs, isReceived: false, saved: witness as unknown },
      { label: 'received note, issuance-time path', blobs: [receivedBlob], isReceived: true, saved: issuedPath as unknown },
      { label: 'no blob', blobs: undefined, isReceived: false, saved: undefined as unknown },
    ];
    const got: unknown[] = [];
    for (const w of worlds) {
      seen.prepareSubscribe = [];
      seen.prepareSubscribeV4 = [];
      seen.prepareSubscribeV4Saved = [];
      seedSearchNote = w.isReceived ? null : NOTE;
      commitmentAtLeaf = w.isReceived ? received : NOTE.receipt.commitment;
      // The prepare refuses once it has recorded its arguments; the refusal stays off C1 + C3.
      subscribeV4PrepareFailure = new HistoryIncompleteError('subscription');
      const outcome = await handlePoolRequest(subscribeReq(w.blobs)).then(
        (r) => `prepared on ${r.version}`,
        (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
      );
      got.push({
        world: w.label,
        outcome,
        attempts: seen.prepareSubscribeV4.length,
        saved: seen.prepareSubscribeV4Saved[0],
        pair: seen.prepareSubscribe.length,
      });
    }
    expect(got).toEqual(
      worlds.map((w) => ({
        world: w.label,
        outcome: 'refused: HistoryIncompleteError',
        attempts: 1,
        saved: w.saved,
        pair: 0,
      })),
    );
  });
});

describe('handing the withdrawal to a relayer', () => {
  it('routes to the relayed path and never funds an ephemeral', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
      relayerUrl: 'https://relay.example',
    });

    expect(done.txSig).toBe('RELAYED_TX');
    expect(seen.executeRelayed).toEqual([
      { jobId: V4_JOB_ID, boundPayee: RECIPIENT, relayerUrl: 'https://relay.example' },
    ]);
    // 🚨 The direct path must not ALSO have run. Both firing would mean the note
    // was spent once and paid for twice, and the nullifier makes the second one
    // fail — after the buyer has already paid for an upload.
    expect(seen.executeV4).toEqual([]);
  });

  it('leaves the direct path exactly as it was when no relayer is named', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V4_TX');
    expect(seen.executeRelayed).toEqual([]);
  });

  it('🚨 refuses to relay a v3 job, whose proof binds no payee', async () => {
    // A C1+C3 pair names no recipient, so a stranger holding it can point the
    // payout anywhere. Ignoring the field here would hand a relayer a proof it
    // could rob, which is the defect v4 closed.
    const prep = await handlePoolRequest(prepareReq());
    const err = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
      relayerUrl: 'https://relay.example',
    }).catch((e: Error) => e);

    expect(String(err)).toContain('binds no payee');
    expect(seen.executeRelayed).toEqual([]);
    expect(seen.executeV3).toEqual([]);
  });

  it('still refuses a payee that differs from the one the proof is bound to', async () => {
    // The relayed branch sits BEFORE the send and AFTER the payee comparison;
    // routing through a relayer must not become a way around that check.
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const err = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: OWNER, // not the bound payee
      ownerPubkey: OWNER,
      relayerUrl: 'https://relay.example',
    }).catch((e: Error) => e);

    expect(String(err)).toContain('cannot pay');
    expect(seen.executeRelayed).toEqual([]);
  });
});

// ===========================================================================

/**
 * The note-in exchange: a circuit-7 withdrawal whose recipient is the
 * deployment's till, and whose fee payer (the ephemeral) signs the claim.
 *
 * What is measured is the PROOF, not that a flag was echoed: it must verify
 * under the ephemeral prepare reported, over `claimChallenge(txSig)` and
 * nothing else, because `/api/claim-for-payment` hands the note to whoever
 * can produce exactly that. And the two refusals must fire BEFORE any send,
 * because after one the pre-fund is on the ephemeral.
 */
describe('signing the claim for a note-in withdrawal', () => {
  function verifies(proofB64: string, txSig: string, pubkey: string): boolean {
    return nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(claimChallenge(txSig), 'utf8')),
      new Uint8Array(Buffer.from(proofB64, 'base64')),
      new PublicKey(pubkey).toBytes(),
    );
  }

  it('returns a proof that verifies under the ephemeral prepare reported, over this payment', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
      signClaim: true,
    });

    expect(done.txSig).toBe('V4_TX');
    // The fee payer IS the key the route verifies against.
    expect(done.feePayer).toBe(prep.ephemeralPubkey);
    expect(done.claimProof).toBeTruthy();
    expect(Buffer.from(done.claimProof!, 'base64')).toHaveLength(64);
    expect(verifies(done.claimProof!, 'V4_TX', prep.ephemeralPubkey)).toBe(true);
    // Bound to THIS transaction: the same bytes prove nothing about another.
    expect(verifies(done.claimProof!, 'SOME_OTHER_TX', prep.ephemeralPubkey)).toBe(false);
    // And under nobody else: the wallet did not sign it.
    expect(verifies(done.claimProof!, 'V4_TX', OWNER)).toBe(false);
    expect(seen.executeV4).toHaveLength(1);
  });

  it('returns no proof unless asked, so an ordinary withdrawal is what it was', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V4_TX');
    expect(done.claimProof).toBeUndefined();
    // The fee payer is reported either way; it costs nothing and names no secret.
    expect(done.feePayer).toBe(prep.ephemeralPubkey);
  });

  it('refuses a relayer, whose key would be the fee payer, before anything is sent', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const err = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
      relayerUrl: 'https://relay.example',
      signClaim: true,
    }).catch((e: Error) => e);

    expect(String(err)).toContain('cannot go through a relayer');
    // Neither path ran: no relayed send, and no direct send either.
    expect(seen.executeRelayed).toEqual([]);
    expect(seen.executeV4).toEqual([]);
  });

  it('refuses a v3 job, whose proof would republish the commitment, before anything is sent', async () => {
    const prep = await handlePoolRequest(prepareReq());
    expect(prep.version).toBe('v3');
    const err = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
      signClaim: true,
    }).catch((e: Error) => e);

    expect(String(err)).toContain('cannot be a note-in exchange');
    expect(seen.executeV3).toEqual([]);
    expect(seen.executeRelayed).toEqual([]);
  });

  it('drops the refused job, so Recover is not blocked by it', async () => {
    const prep = await handlePoolRequest(prepareReq());
    await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
      signClaim: true,
    }).catch(() => undefined);

    const again = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    }).catch((e: Error) => e);
    expect(String(again)).toContain('Unknown withdrawal job');
  });
});

// ===========================================================================
// [flow-speed 2026-09-23] W1, S1 and X3 at the handler
// ===========================================================================

describe('[flow-speed] one spent set, one walk, and a prover warmed beside the walk', () => {
  /** The whole fixture walk, as `expectTheWholeWalk` above reads it. */
  function expectWholeWalk(leaves: unknown): void {
    expect(leaves, 'the handler walked the history and then dropped it').toBeInstanceOf(Map);
    expect(leaves, 'the handler handed on something other than the walk it made').toEqual(walkedCommitments());
  }

  it('[W1] hands the circuit-7 withdrawal job the SAME spent set locateOwnedNote read', async () => {
    // RED at HEAD: the handler passed no set and the job read the pool-wide set
    // a second time. `toBe`, not `toEqual`: a handler that passed `new Set()`
    // would behave identically here (locate has already refused a spent note)
    // and skip the job's spent check for real.
    await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));
    expect(seen.spentSetsRead, 'the handler read the spent set more than once').toHaveLength(1);
    expect(seen.prepareV4SpentSet).toHaveLength(1);
    expect(seen.prepareV4SpentSet[0]).toBe(seen.spentSetsRead[0]);
  });

  it('[S1] hands the circuit-7 SUBSCRIPTION prepare the leaves it already walked', async () => {
    // RED at HEAD: the subscription job got no leaves and the prepare walked the
    // history a second time. Same shape as the withdrawal's "hands the circuit-7
    // prepare the leaves it already walked".
    await handlePoolRequest(subscribeReq()).catch(() => undefined);
    expect(seen.prepareSubscribeV4).toEqual([LEAF]);
    const opts = seen.prepareSubscribeV4Opts[0] as { leaves?: unknown } | undefined;
    expectWholeWalk(opts?.leaves);
  });

  it('[S1] hands the circuit-7 SUBSCRIPTION prepare what its walk could not read, undefined kept undefined', async () => {
    for (const unread of [2, 0, 5, undefined]) {
      clearPoolState();
      configurePoolHandlers('http://localhost:8899');
      setPoolSeed(META, SIGNATURE);
      seen.prepareSubscribeV4Opts = [];
      walkUnread = unread;
      await handlePoolRequest(subscribeReq()).catch(() => undefined);
      const opts = seen.prepareSubscribeV4Opts[0] as { unread?: unknown; leaves?: unknown } | undefined;
      expect(opts, `no options reached the job (unread ${unread ?? 'none'})`).toBeDefined();
      // `toBe`: a 0 the walk did not report would show a lagging map clean.
      expect(opts?.unread, `the walk reported ${unread ?? 'nothing'} unread`).toBe(unread);
      expect('unread' in (opts ?? {}), "the key is always present, its value is the walk's").toBe(true);
      expectWholeWalk(opts?.leaves);
    }
  });

  it('[X3] the withdrawal prepare warms the prover while the history walk is still running', async () => {
    // RED at HEAD: with the job stubbed, nothing started the prover at all; with
    // the real job it started only after the walk and the pre-flight.
    let release!: () => void;
    walkGate = new Promise<void>((r) => {
      release = r;
    });
    const done = handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));
    await vi.waitFor(() => expect(seen.order).toContain('prover.start'));
    expect(seen.order, 'the walk had not started').toContain('walk');
    release();
    await done;
    expect(seen.prepareV4).toHaveLength(1);
  });

  it('[X3] the direct/relayed-agnostic prepare warms the v3 route too, and a half request warms nothing', async () => {
    await handlePoolRequest(prepareReq());
    expect(seen.order.filter((o) => o === 'prover.start').length).toBe(1);
    seen.order = [];
    await expect(handlePoolRequest(prepareReq({ recipient: RECIPIENT }))).rejects.toThrow(/both/);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.order, 'a malformed request started the prover or walked').toEqual([]);
  });

  it('[X3] a warm-up that fails changes nothing about the prepare', async () => {
    proverStartFailOnce = new Error('wasm failed to load (warm-up)');
    const res = await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));
    expect(res.version).toBe('v4');
    expect(seen.prepareV4).toHaveLength(1);
    expect(seen.order.filter((o) => o === 'prover.start').length).toBe(1);
  });

  it('[X3] the subscription prepare warms the prover before its walk resolves', async () => {
    let release!: () => void;
    walkGate = new Promise<void>((r) => {
      release = r;
    });
    const done = handlePoolRequest(subscribeReq()).catch(() => undefined);
    await vi.waitFor(() => expect(seen.order).toContain('prover.start'));
    expect(seen.order[0]).toBe('walk');
    release();
    await done;
    // The warm-up, then `computeSubscriberCommitment`'s own start: one promise
    // in the real prover, two calls here.
    expect(seen.order.filter((o) => o === 'prover.start').length).toBe(2);
  });

  it('[X3] a half-specified subscription is refused before any walk and before the warm-up', async () => {
    // The all-three-terms check now runs first, the shape the withdrawal uses.
    const half = { ...subscribeReq(), intervalSlots: undefined };
    await expect(handlePoolRequest(half as never)).rejects.toThrow(/all on the prepare/);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.order).toEqual([]);
  });

  it('[X1] a spend locate joins a walk already in flight (opt-in), withdrawal and subscription alike', async () => {
    // RED at HEAD: no option, so a click during the page-load scan walked the
    // same history beside it. Same budget as the scan's walk (no maxSignatures).
    await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));
    await handlePoolRequest(subscribeReq()).catch(() => undefined);
    expect(seen.walkOptions).toHaveLength(2);
    for (const o of seen.walkOptions as Array<Record<string, unknown>>) {
      expect(o.joinInFlight).toBe(true);
      expect(o.maxSignatures).toBeUndefined();
      expect(o.incremental).toBeUndefined();
      expect(typeof o.onWalked).toBe('function');
    }
  });

  it('[X3] a subscription warm-up that fails is retried by the commitment step, and nothing else changes', async () => {
    proverStartFailOnce = new Error('wasm failed to load (warm-up)');
    subscribeV4PrepareFailure = new Error('STOP after the commitment');
    await expect(handlePoolRequest(subscribeReq())).rejects.toThrow('STOP after the commitment');
    expect(seen.prepareSubscribeV4).toEqual([LEAF]);
  });
});
