/**
 * WHICH ROOT A CIRCUIT-7 WITHDRAWAL NAMES, AND WHY IT MUST BE THE CURRENT ONE.
 *
 * 🚨 THE LEAK THIS GUARDS IS PUBLISHED ON THE WIRE, AND THE TRANSACTION
 * SUCCEEDS. `unshield_denominated_stark_v4` carries `merkle_root` in the clear
 * and the chain accepts any root that is current OR still in the pool's
 * historical ring. The ring advances one step per insertion, so a named root
 * says how many leaves existed at that moment — and the path captured at shield
 * time folds to the root THAT NOTE'S OWN INSERTION created. Naming it is a
 * one-hop link from a spend back to its own deposit, published by the spender,
 * with nothing on chain complaining.
 *
 * MEASURED on devnet, not argued: 1 v4 spend of 34 (1 withdrawal of 18) named a
 * root 4 insertions stale, and in v3 all 4 stale roots were the spending note's
 * own deposit root (`scratchpad/probe-stale-root-2026-09-15.log`,
 * `scratchpad/map-C-onchain-observability.md` headline).
 *
 * WHAT THIS FILE PINS (SPEND-1):
 *   1. the root proved is the one the pool is on NOW, even when the note
 *      carries a complete, still-accepted path of its own;
 *   2. the root is a function of POOL STATE, not of the note — two notes
 *      deposited at different times name the same root;
 *   3. a hole in the readable history REFUSES, rather than falling back to the
 *      note's older saved root, and the refusal carries neither needle of
 *      `V4_REBUILD_FAILURES` (poolHandlers.ts), so it cannot be routed to the
 *      C1 + C3 pair that republishes the commitment;
 *   4. the 255-root ring the program actually keeps
 *      (`DenominatedPoolV3::MAX_HISTORICAL_ROOTS`, pool_v3.rs) is parsed. A
 *      client that gives up at 100 sees no ring at all on a migrated pool, and
 *      "no ring" is what selects the saved root;
 *   5. a ring root the pool is not on NOW is proved only when nothing ties it
 *      to the note: the walk behind the map left nothing it listed unread, the
 *      map does not end at the note's own leaf, and the root is not the one
 *      saved with the note. A map can end exactly where the saved root was
 *      taken (a history cache last completed right after the note's own
 *      deposit or purchase, then newer inserts listed but not served), and its
 *      root is then the saved root, reached through the leaves.
 *
 * ⚠️ THE POSITIVE CONTROL MATTERS MORE THAN USUAL. Every assertion below
 * compares a root against `R_CUR`, so a fixture whose roots were equal would
 * pass no matter what the code did. `the fixture is discriminating…` asserts the
 * three roots differ and that the ring would have ACCEPTED the stale ones.
 * `an implementation that preferred the saved path…` is a fixture check only;
 * the controls on the production code are the in-memory mutants in
 * `scratchpad/wp-logs/SPEND-1-mutants.log` (M1-M7),
 * `scratchpad/wp-logs/SPEND-1-fix1-mutants/` (MA, MC, MW),
 * `scratchpad/wp-logs/SPEND-1-fix2-mutants/` (R1-R7),
 * `scratchpad/web-run/logs/SPEND-1-web-fix1/` (N1, N7, N10, Q1, Q2, MSG) and
 * `scratchpad/web-run/logs/SPEND-1-web-fix2/` (V21, V21L, V21w: a lagging map
 * yields to the note's older saved root) and
 * `scratchpad/web-run/logs/SPEND-1-web-fix3/` (V21r and its variants: the same
 * swap after the refetch, or after the whole pre-flight) and
 * `scratchpad/web-run/logs/SPEND-1-web-fix3b/` (NEWER, RECENT, RCVF, RCVL,
 * RCVPF: a saved root newer than the map, the newest ring entry, or a received
 * note, all against the ring in `update_root`'s order) and
 * `scratchpad/web-run/logs2/SPEND-1-cr1/` (a map that ends where the saved
 * root was taken, a walk that left listed signatures unread or gave up on
 * them, a map handed down with no walk report, an unreadable pool account
 * crossed with the note's source and the progress callback) and
 * `scratchpad/web-run/logs2/SPEND-1-cr3/` (a root held back at the first map
 * with an unknown refetched root, a walk whose own account read failed, an
 * unparsable account, and the subscription's saved-root tie).
 *
 * The extension twin is already correct and is guarded against acquiring this
 * behaviour by `apps/extension/src/shared/services/rootRule.test.ts`, which
 * names this work package.
 *
 * Runs under `vitest.pool.config.mts` (node).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** The prover is the only part that cannot run here — it is WASM in a worker. */
const h = vi.hoisted(() => ({
  generateSpendProof: vi.fn(),
  start: vi.fn(async () => {}),
}));

vi.mock('./starkProver', () => ({
  starkProver: {
    start: h.start,
    generateSpendProof: (...a: unknown[]) => h.generateSpendProof(...a),
  },
}));

import {
  C7_SUBTREE_DEPTH,
  HistoryIncompleteError,
  buildMerkleProofFromLeavesV3,
  fetchPoolCommitments,
  fetchPoolLeavesByIndex,
  findPoolV3,
  goldilocksToLeBytes32,
  goldilocksU64To32,
  parsePoolV3Account,
  prepareUnshield,
  prepareUnshieldV4,
  recipientHashLimbs,
  type OnChainCommitment,
  type PoolConfig,
  type ShieldReceipt,
} from './denominatedPool';
import { isRootAccepted } from './unshieldFromPath';
import { prepareUnshieldJobV4 } from './unshieldEphemeral';
import { prepareSubscribeV4, type SubscribeBinding } from './subscribePrivateStarkV4';
import { prepareSubscribeJobV4 } from './subscribeEphemeral';
import { deriveSubscriptionVaultPDA } from './subscribePrivateStark';
import {
  MAX_HISTORY_READ_ATTEMPTS,
  getPoolHistoryStore,
  loadPoolHistory,
  memoryPoolHistoryStore,
  setPoolHistoryStore,
  type PoolHistoryStore,
} from './poolHistoryCache';

// ---------------------------------------------------------------------------
// The chain, as a fixture
// ---------------------------------------------------------------------------

const POOL = findPoolV3('SOL', 1) as PoolConfig;
const RECIPIENT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

/** Eight leaves. The notes spent below sit at 3 and 6, so the tree grew after both. */
const LEAVES = [1001n, 1002n, 1003n, 1004n, 1005n, 1006n, 1007n, 1008n];
const NOTE_A = 3;
const NOTE_B = 6;
/** The leaf whose insert transaction the RPC will not serve, in the hole world. */
const HOLE = 2;

/** The dense leaf array with leaf HOLE unread, zero-filled (`ZERO_VALUE_V3` is 0n) as the walk leaves it. */
function leavesWithHole(): bigint[] {
  return LEAVES.map((l, i) => (i === HOLE ? 0n : l));
}

/** The path a rebuild from EVERY event produces — what the pool is on now. */
function freshPath(targetLeafIndex: number) {
  return buildMerkleProofFromLeavesV3({ leavesByIndex: LEAVES, targetLeafIndex });
}

/**
 * The path captured at shield time: the tree as it stood when that leaf was
 * inserted. This is exactly what a stored blob carries, and what the fast path
 * under test used to prefer.
 */
function pathAtInsertion(targetLeafIndex: number) {
  return buildMerkleProofFromLeavesV3({
    leavesByIndex: LEAVES.slice(0, targetLeafIndex + 1),
    targetLeafIndex,
  });
}

const R_CUR = freshPath(NOTE_A).root;
const R_AT_A = pathAtInsertion(NOTE_A).root;
const R_AT_B = pathAtInsertion(NOTE_B).root;

/** The saved witness, in the string shape `extractStoredPath` produces. */
function savedPathFor(targetLeafIndex: number) {
  const p = pathAtInsertion(targetLeafIndex);
  return {
    pathElements: p.pathElements.map(String),
    pathIndices: p.pathIndices,
    root: p.root.toString(),
  };
}

/**
 * The commitment map `locateOwnedNote` hands the prepare: every leaf, as a
 * complete walk of this fixture returns it.
 */
function walkedLeaves(): Map<string, OnChainCommitment> {
  return new Map(
    LEAVES.map((commitment, leafIndex) => [
      commitment.toString(),
      { commitment, leafIndex, depositPayer: null, depositSlot: null, signature: `SIG${leafIndex}` },
    ]),
  );
}

const anchorEventDisc = (name: string) => sha256(utf8ToBytes(`event:${name}`)).slice(0, 8);

/** A `LeafInserted` event, laid out as merkle_tree_v3.rs emits it. */
function leafInsertedLog(leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(anchorEventDisc('LeafInserted'), 0);
  data.set(POOL.poolPDA.toBytes(), 8);
  for (let i = 0; i < 8; i++) {
    data[40 + i] = Number((BigInt(leafIndex) >> BigInt(8 * i)) & 0xffn);
  }
  data.set(new Uint8Array(goldilocksToLeBytes32(commitment)), 48);
  return `Program data: ${Buffer.from(data).toString('base64')}`;
}

/**
 * The pool account, byte for byte as `parsePoolV3Account` reads it: current root
 * at 88, tree depth at 120, `next_leaf_index` at 121, the ring length at 178 and
 * the ring itself from 182.
 */
function poolAccount(currentRoot: bigint, historical: bigint[], nextLeafIndex = LEAVES.length): Uint8Array {
  const data = new Uint8Array(182 + historical.length * 32);
  data.set(new Uint8Array(goldilocksToLeBytes32(currentRoot)), 88);
  data[120] = 15; // tree depth
  for (let i = 0; i < 8; i++) {
    data[121 + i] = Number((BigInt(nextLeafIndex) >> BigInt(8 * i)) & 0xffn);
  }
  data[177] = 1; // is_active
  const n = historical.length;
  data[178] = n & 0xff;
  data[179] = (n >> 8) & 0xff;
  data[180] = (n >> 16) & 0xff;
  data[181] = (n >> 24) & 0xff;
  historical.forEach((r, i) => {
    data.set(new Uint8Array(goldilocksToLeBytes32(r)), 182 + i * 32);
  });
  return data;
}

/** A ring of `n` distinct roots, none of which is any real root of this tree. */
function ringOf(n: number): bigint[] {
  return Array.from({ length: n }, (_, i) => 900_000n + BigInt(i));
}

/**
 * THE RING HOLDS BOTH STALE ROOTS. That is the whole reason this cannot be left
 * to the on-chain check: the program would accept either one and the withdrawal
 * would confirm.
 */
const POOL_ACCOUNT = poolAccount(R_CUR, [R_AT_A, R_AT_B, 7777n, 8888n]);

interface Counters {
  signatures: number;
  transactions: number;
  accountInfo: number;
}

const newCounters = (): Counters => ({ signatures: 0, transactions: 0, accountInfo: 0 });

/**
 * An RPC that serves the pool's history. `hideLeaf` withholds ONE leaf's insert
 * transaction: the signature is still listed as successful, so the walk counts
 * it as a read that did not happen (HIST-1) and the rebuilt tree is missing a
 * leaf — which is exactly the state in which the old code reached for the saved
 * root.
 */
function connection(
  opts: {
    hideLeaf?: number;
    /** Hide `hideLeaf` only on the first history walk: a lagging RPC that catches up. */
    hideOnFirstWalkOnly?: boolean;
    /** Withhold every leaf at or after this index, on every walk: an RPC behind the deposit. */
    hideFrom?: number;
    /** Do not even LIST the signature of any leaf at or after this index, on every walk: signature-index lag. */
    unlistedFrom?: number;
    /** `hideFrom`, on the first history walk only: an RPC further behind that then catches up. */
    firstWalkHideFrom?: number;
    /** `unlistedFrom`, on the first history walk only. */
    firstWalkUnlistedFrom?: number;
    counters?: Counters;
    /** `null`: the RPC returns no pool account at all. */
    account?: Uint8Array | null;
  } = {},
) {
  const counters = opts.counters ?? newCounters();
  const account = opts.account === undefined ? POOL_ACCOUNT : opts.account;
  const below = (i: number, bound: number | undefined) => bound === undefined || i < bound;
  return {
    rpcEndpoint: 'https://devnet.helius-rpc.com/?api-key=NOT-A-REAL-KEY',
    getSignaturesForAddress: async () => {
      counters.signatures += 1;
      const firstWalk = counters.signatures <= 1;
      return LEAVES.map((_, i) => ({ signature: `SIG${i}`, err: null })).filter(
        (_, i) => below(i, opts.unlistedFrom) && (!firstWalk || below(i, opts.firstWalkUnlistedFrom)),
      );
    },
    getTransaction: async (sig: string) => {
      counters.transactions += 1;
      const i = Number(sig.replace('SIG', ''));
      if (i === opts.hideLeaf && (!opts.hideOnFirstWalkOnly || counters.signatures <= 1)) return null;
      if (opts.hideFrom !== undefined && i >= opts.hideFrom) return null;
      if (counters.signatures <= 1 && !below(i, opts.firstWalkHideFrom)) return null;
      return {
        slot: 100 + i,
        // `feePayerOf` reads this without guarding, so a fake that omits it
        // fails for a reason that has nothing to do with the subject.
        transaction: { message: { staticAccountKeys: [{ toBase58: () => `PAYER${i}` }] } },
        meta: { logMessages: [leafInsertedLog(i, LEAVES[i])] },
      };
    },
    getAccountInfo: async () => {
      counters.accountInfo += 1;
      return account === null ? null : { data: account };
    },
  } as never;
}

/**
 * A note at `leafIndex`, carrying no path of its own. `source` is what the
 * store records: `'received'` for an issued or imported note, whose saved path
 * was filed at issuance, not at its own deposit.
 */
function receipt(leafIndex: number, source: 'shielded' | 'received' = 'shielded'): ShieldReceipt {
  return {
    secret: 123456789012345678n,
    nullifierPreimage: 42n,
    // A PRF draw, well above the legacy-epoch ceiling, so no routing guard fires.
    noteBlinding: 7284991002338477113n,
    tokenMint: 0n,
    commitment: LEAVES[leafIndex],
    leafIndex,
    denomination: 1_000_000_000n,
    pool: POOL.poolPDA.toBase58(),
    token: 'SOL',
    denominationHuman: 1,
    shieldedAt: 0,
    source,
  };
}

/**
 * The needles `isV4RebuildFailure` routes on, READ FROM THE REAL SOURCE. A
 * refusal containing one of them is sent to the C1 + C3 pair, which republishes
 * the note's commitment — so "the refusal contains neither" is a claim about
 * another file, and must be checked against that file rather than against a
 * copy of it that can go stale.
 */
function v4RebuildNeedles(): string[] {
  const src = readFileSync(join(__dirname, '../worker/poolHandlers.ts'), 'utf8');
  const block = src.match(/const V4_REBUILD_FAILURES = \[([^\]]*)\]/);
  expect(block, 'V4_REBUILD_FAILURES is no longer an array literal in poolHandlers.ts').not.toBeNull();
  const needles = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(needles.length, 'no needle could be parsed out of V4_REBUILD_FAILURES').toBeGreaterThan(0);
  return needles;
}

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh in-memory history per test: IndexedDB does not exist here, and a
  // shared cache would let one test's leaves answer another test's question.
  setPoolHistoryStore(memoryPoolHistoryStore());
  const limbs = recipientHashLimbs(RECIPIENT);
  h.generateSpendProof.mockResolvedValue({
    circuitId: 7,
    publicInputs: [99n, 1234n, ...limbs].map(String),
    proofHex: '00'.repeat(32),
    proofSize: 32,
    durationMs: 1,
  });
});

describe('the v4 withdrawal proves against the freshest leaf map', () => {
  it('the fixture is discriminating: the roots differ and the ring holds the stale ones', () => {
    // ⛔ ANTI-VACUITY, FIRST. Everything below compares a root against R_CUR. If
    // the fixture's roots coincided — one leaf, or a builder ignoring the slice
    // — every assertion would pass whatever the prepare did, and so would the
    // positive control.
    expect(R_AT_A).not.toBe(R_CUR);
    expect(R_AT_B).not.toBe(R_CUR);
    expect(R_AT_A).not.toBe(R_AT_B);

    // And the chain would have taken either stale one: both are in the ring.
    // This is why the guard cannot be left to the on-chain check.
    const parsed = parsePoolV3Account(POOL_ACCOUNT);
    expect(parsed).not.toBeNull();
    const ring = (parsed?.historicalRoots ?? []).map((r) => Buffer.from(r).toString('hex'));
    const asHex = (v: bigint) => Buffer.from(new Uint8Array(goldilocksToLeBytes32(v))).toString('hex');
    expect(ring).toContain(asHex(R_AT_A));
    expect(ring).toContain(asHex(R_AT_B));
    expect(ring).not.toContain(asHex(R_CUR));

    // The saved path really is a complete, usable witness — so preferring it is
    // a choice the code makes, not a fallback forced by a short path.
    expect(savedPathFor(NOTE_A).pathElements.length).toBeGreaterThanOrEqual(C7_SUBTREE_DEPTH);
  });

  it('saved older path, current root proved', async () => {
    const result = await prepareUnshieldV4(
      receipt(NOTE_A),
      RECIPIENT,
      POOL,
      connection(),
      undefined,
      { savedPath: savedPathFor(NOTE_A) },
    );

    expect(result.merkleRoot).toBe(R_CUR);
    expect(result.merkleRoot).not.toBe(R_AT_A);

    // The root is only half of it: a prepare that NAMED the current root while
    // proving the saved path would be refused on chain after the whole upload.
    // The circuit levels handed to the prover must be the fresh path's.
    const args = h.generateSpendProof.mock.calls[0];
    const fresh = freshPath(NOTE_A);
    expect(args[4]).toEqual(fresh.pathElements.slice(0, C7_SUBTREE_DEPTH).map(String));
    expect(args[5]).toEqual(fresh.pathIndices.slice(0, C7_SUBTREE_DEPTH));
    // ...and the saved path's levels are NOT the same, so that is not an
    // assertion the stale path could also satisfy.
    expect(args[4]).not.toEqual(savedPathFor(NOTE_A).pathElements.slice(0, C7_SUBTREE_DEPTH));
  });

  it('root is a function of pool state', async () => {
    // Two notes deposited at different moments, each carrying its own saved
    // path. If the root were a function of the NOTE, these two spends would
    // name different values and an observer would date each deposit from its
    // own withdrawal. They must be indistinguishable.
    const a = await prepareUnshieldV4(
      receipt(NOTE_A), RECIPIENT, POOL, connection(), undefined, { savedPath: savedPathFor(NOTE_A) },
    );
    const b = await prepareUnshieldV4(
      receipt(NOTE_B), RECIPIENT, POOL, connection(), undefined, { savedPath: savedPathFor(NOTE_B) },
    );

    expect(a.merkleRoot).toBe(b.merkleRoot);
    expect(a.merkleRoot).toBe(R_CUR);
  });

  it('an implementation that preferred the saved path would name the stale root (positive control)', async () => {
    // ⚠️ THE NAME IS KEPT; THE BODY IS NOT A SEPARATE CONTROL. It is a declared
    // red test in `wp-logs/SPEND-1-red.log` and the green check refuses a
    // renamed one. Fix round 2 removed its two self-agreeing `preferSaved`
    // lines: every assertion below reads the real prepare's output. It checks
    // that output against what a saved-path-first rule would hand the chain
    // (the saved root) and the prover (the saved circuit levels), so it
    // overlaps "saved older path, current root proved". The controls on the
    // production code are the in-memory mutants M1 (old saved-path-first order,
    // `scratchpad/wp-logs/SPEND-1-mutants.log`) and R5 (saved path preferred
    // when leaves are passed, `scratchpad/wp-logs/verify/SPEND-1-r2-mutants/`).
    const saved = savedPathFor(NOTE_A);
    const result = await prepareUnshieldV4(
      receipt(NOTE_A), RECIPIENT, POOL, connection(), undefined, { savedPath: saved },
    );

    // A saved-path-first rule names the saved root. The real prepare did not.
    expect(result.merkleRoot).not.toBe(BigInt(saved.root));
    // It would prove the saved circuit levels. The prover did not receive them.
    const args = h.generateSpendProof.mock.calls[0];
    expect(args?.[4]).not.toEqual(saved.pathElements.slice(0, C7_SUBTREE_DEPTH));
    // ...and the real one names the pool's current root.
    expect(result.merkleRoot).toBe(R_CUR);
  });

  it('one walk per prepare', async () => {
    // The caller (`locateOwnedNote`) has already walked the pool's history —
    // the heaviest call on the withdrawal path. The prepare must not walk it a
    // second time, and the root pre-flight must be satisfied from the ONE
    // account read rather than from a refetch.
    const counters = newCounters();
    const result = await prepareUnshieldV4(
      receipt(NOTE_A), RECIPIENT, POOL, connection({ counters }), undefined,
      { leaves: walkedLeaves(), savedPath: savedPathFor(NOTE_A) },
    );

    expect(result.merkleRoot).toBe(R_CUR);
    expect(counters.signatures, 'the prepare walked the history again').toBe(0);
    expect(counters.transactions, 'the prepare re-read insert transactions').toBe(0);
    expect(counters.accountInfo, 'the root pre-flight cost more than one account read').toBe(1);
  });

  it('a walked map one or more insertions behind is accepted from the ring, with no refetch', async () => {
    // The rule is "current OR in the ring", not "current". A walk that stopped
    // one insertion short (leaves 0..6 here) folds to a root the ring still
    // holds; accepting it costs nothing and the root is a function of what the
    // RPC served, not of which note is spent (the note is at 3, the map ends at
    // 6). A prepare that refetched whenever the root was not CURRENT would add
    // a full history walk to every withdrawal made while the pool is moving.
    //
    // 🚨 AND THE NOTE'S OWN OLDER SAVED ROOT MUST NOT WIN THERE. A map that lags
    // the chain is the everyday case (the pool moves faster than the RPC), and
    // the saved path is usually in the ring too. A prepare that, seeing a
    // walked root that is not current, swapped in the saved path would name
    // R_AT_A, the root the note's own deposit created: the exact leak this file
    // guards, on every withdrawal made while the pool is moving. So the same
    // lagging map is passed again WITH the older saved path, and once more
    // through the prepare's own walk on an RPC one insertion behind. Controls:
    // mutants V21 / V21L / V21w (saved path preferred over a lagging map's
    // ring root, on both routes or on one), `scratchpad/web-run/logs/SPEND-1-web-fix2/`.
    //
    // The lag here is the RPC's SIGNATURE INDEX: the newest insert is not
    // listed yet, so the walk read everything it was shown (`unread: 0`, the
    // report `fetchPoolCommitments` gives the handler). Where the map ends is
    // then a fact about the RPC, not about this client. A map that stops
    // because a LISTED insert was not served is not accepted from the ring
    // (describe "the saved root's age and the note's source never pick the
    // root" below).
    const behind = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex <= NOTE_B));
    const behindPath = buildMerkleProofFromLeavesV3({ leavesByIndex: LEAVES.slice(0, NOTE_B + 1), targetLeafIndex: NOTE_A });
    const ringRoot = behindPath.root;
    // Anti-vacuity: that root is in POOL_ACCOUNT's ring and is not current.
    expect(ringRoot).toBe(R_AT_B);
    expect(ringRoot).not.toBe(R_CUR);
    // ...and the saved path passed below folds to a DIFFERENT root the ring
    // also holds, so preferring it is a choice the code could make.
    const saved = savedPathFor(NOTE_A);
    expect(BigInt(saved.root)).toBe(R_AT_A);
    expect(R_AT_A).not.toBe(ringRoot);
    expect(saved.pathElements.length).toBeGreaterThanOrEqual(C7_SUBTREE_DEPTH);

    const worlds = [
      // `walks`: signature listings. 0 = the caller's map is used as is; 1 = the prepare's own walk, no refetch.
      { label: 'walked map, no saved path', rpc: {}, opts: { leaves: behind, unread: 0 }, walks: 0 },
      { label: 'walked map + the note\'s older saved path', rpc: {}, opts: { leaves: behind, unread: 0, savedPath: saved }, walks: 0 },
      { label: 'own walk on an RPC whose signature index is one insertion behind + the note\'s older saved path', rpc: { unlistedFrom: NOTE_B + 1 }, opts: { savedPath: saved }, walks: 1 },
    ];
    for (const w of worlds) {
      vi.clearAllMocks();
      setPoolHistoryStore(memoryPoolHistoryStore());
      const counters = newCounters();
      const result = await prepareUnshieldV4(
        receipt(NOTE_A), RECIPIENT, POOL, connection({ ...w.rpc, counters }), undefined, w.opts,
      );

      const named = result.merkleRoot === R_AT_A
        ? 'R_AT_A (the note\'s own saved, older root)'
        : result.merkleRoot === R_AT_B ? 'R_AT_B' : result.merkleRoot.toString();
      expect(named, w.label).toBe('R_AT_B');
      expect(result.merkleRoot).toBe(ringRoot);
      expect(counters.signatures, `${w.label}: a ring root triggered a history refetch`).toBe(w.walks);
      if (w.walks === 0) expect(counters.transactions, w.label).toBe(0);
      // The prover got the lagging map's levels, so the root named is the root proved.
      const args = h.generateSpendProof.mock.calls[0];
      expect(args?.[4], `${w.label}: proved a path other than the lagging map's`).toEqual(
        behindPath.pathElements.slice(0, C7_SUBTREE_DEPTH).map(String),
      );
    }
  });

  it('a lagging map is proved as read on every route to it: the note\'s older saved root is never named', async () => {
    // The case above reaches a lagging map at step 1 only (the FIRST map lags).
    // Step 2 can end on one too: the first map has a hole or does not hold the
    // note yet, and the ONE refetch returns a map that still lags the chain (a
    // hole in the first read, then signature-index lag on the refetch). Its
    // root is in the ring and is not current; so is the note's older saved
    // root. Swapping one for the other there names R_AT_A, the root the note's
    // own deposit created. Mutant V21r (that swap, placed after the refetch)
    // passed every case above
    // (`scratchpad/web-run/logs/verify-SPEND-1-r2/mutants/summary-wp.log`).
    //
    // So this is a world matrix, not one more case. Every route that ends on
    // the lagging map, always with the note's older saved path, crossed with:
    //   - the two ways an RPC lags (the signature is not listed yet; it is
    //     listed but its transaction is not served);
    //   - with and without a progress callback (the handler passes one; every
    //     other case here passes none).
    // A rule that prefers the in-ring saved root, placed at step 1, after the
    // refetch or after the whole pre-flight, or keyed on the route, on why the
    // first map failed, on the lag, or on the callback, names R_AT_A in at
    // least one world. Controls: V21r and its variants in
    // `scratchpad/web-run/logs/SPEND-1-web-fix3/` (V21, V21L, V21w re-run there too).
    //
    // CHANGED IN THE CONTINUED RUN (`scratchpad/web-run/logs2/SPEND-1-cr1/`):
    // when the newest insert is LISTED but its transaction is not served, the
    // walk knows it left that signature unread, and a map that stops there may
    // stop where this client last read, not where the RPC is. Those 12 worlds
    // now get the refetch (which re-reads it) and, still unread, refuse with
    // HistoryIncompleteError and prove nothing. The walked-leaves route carries
    // the report the real walk gives on the same RPC, as the handler does.
    const LAGGING = NOTE_B + 1; // the RPC never returns leaf 7: one insertion behind
    const behindArray = LEAVES.slice(0, LAGGING);
    const behindPath = buildMerkleProofFromLeavesV3({ leavesByIndex: behindArray, targetLeafIndex: NOTE_A });
    const saved = savedPathFor(NOTE_A);

    // ---- anti-vacuity: the three roots, and what the ring holds ----
    const parsed = parsePoolV3Account(POOL_ACCOUNT)!;
    const asHex = (v: bigint) => Buffer.from(new Uint8Array(goldilocksToLeBytes32(v))).toString('hex');
    const ring = new Set(parsed.historicalRoots.map((r) => Buffer.from(r).toString('hex')));
    const poolKnows = (root: bigint) => root === R_CUR || ring.has(asHex(root));
    expect(behindPath.root).toBe(R_AT_B);
    expect(poolKnows(R_AT_B) && R_AT_B !== R_CUR, 'the lagging root is not a non-current ring root').toBe(true);
    expect(BigInt(saved.root)).toBe(R_AT_A);
    expect(poolKnows(R_AT_A) && R_AT_A !== R_AT_B, 'the saved root is not a second ring root').toBe(true);
    const behind = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex < LAGGING));
    // The first maps that send the prepare to step 2: one folds to a root the
    // pool never had, the other does not hold the note, so the builder throws.
    const holedBehind = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex < LAGGING && e.leafIndex !== HOLE));
    const holedArray = behindArray.map((l, i) => (i === HOLE ? 0n : l));
    expect(poolKnows(buildMerkleProofFromLeavesV3({ leavesByIndex: holedArray, targetLeafIndex: NOTE_A }).root)).toBe(false);
    const shortOfNote = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex < NOTE_A));
    const shortArray = LEAVES.slice(0, NOTE_A);
    expect(() => buildMerkleProofFromLeavesV3({ leavesByIndex: shortArray, targetLeafIndex: NOTE_A })).toThrow();

    // `readsAll`: the walk reads every signature it is shown, so where its map
    // ends says nothing about this client.
    const lags = [
      { kind: 'newest signature not listed yet', every: { unlistedFrom: LAGGING }, firstWalkFrom: (i: number) => ({ firstWalkUnlistedFrom: i }), readsAll: true },
      { kind: 'newest transaction listed, not served', every: { hideFrom: LAGGING }, firstWalkFrom: (i: number) => ({ firstWalkHideFrom: i }), readsAll: false },
    ];
    const firstReads = [
      { kind: 'first map one insertion behind (step 1)', leaves: behind, firstArray: behindArray, ownWalk: () => ({}), refetch: 0 },
      { kind: 'first map holed below the note (step 2)', leaves: holedBehind, firstArray: holedArray, ownWalk: () => ({ hideLeaf: HOLE, hideOnFirstWalkOnly: true }), refetch: 1 },
      { kind: 'first map short of the note (step 2)', leaves: shortOfNote, firstArray: shortArray, ownWalk: (lag: (typeof lags)[number]) => lag.firstWalkFrom(NOTE_A), refetch: 1 },
    ];

    // One line per world, compared as a whole: a red diff names EVERY world
    // that went wrong, not only the first.
    const levels = (elements: unknown, indices: unknown) => JSON.stringify([elements, indices]);
    const laggingLevels = levels(
      behindPath.pathElements.slice(0, C7_SUBTREE_DEPTH).map(String),
      behindPath.pathIndices.slice(0, C7_SUBTREE_DEPTH),
    );
    const got: string[] = [];
    const want: string[] = [];
    for (const lag of lags) {
      for (const first of firstReads) {
        // Anti-vacuity for the prepare's own walk: on this fake RPC, a first
        // walk returns exactly the first map this world claims, and a second
        // walk returns the lagging map.
        setPoolHistoryStore(memoryPoolHistoryStore());
        const probe = connection({ ...lag.every, ...first.ownWalk(lag) });
        const firstWalk = await fetchPoolLeavesByIndex(probe, POOL.poolPDA);
        expect(firstWalk.leavesByIndex, `${lag.kind}, ${first.kind}: first walk`).toEqual(first.firstArray);
        expect((await fetchPoolLeavesByIndex(probe, POOL.poolPDA)).leavesByIndex, `${lag.kind}, ${first.kind}: second walk`).toEqual(behindArray);

        for (const route of ['walked leaves passed', 'the prepare\'s own walk'] as const) {
          for (const withProgress of [false, true]) {
            const label = `${lag.kind}, ${first.kind}, ${route}, ${withProgress ? 'with' : 'no'} progress callback`;
            vi.clearAllMocks();
            setPoolHistoryStore(memoryPoolHistoryStore());
            const counters = newCounters();
            const rpc = route === 'walked leaves passed' ? lag.every : { ...lag.every, ...first.ownWalk(lag) };
            const steps: string[] = [];
            const outcome = await prepareUnshieldV4(
              receipt(NOTE_A), RECIPIENT, POOL, connection({ ...rpc, counters }),
              withProgress ? (s: string) => void steps.push(s) : undefined,
              route === 'walked leaves passed' ? { leaves: first.leaves, unread: firstWalk.unread, savedPath: saved } : { savedPath: saved },
            ).then(
              (r) => (r.merkleRoot === R_AT_A
                ? 'R_AT_A (the note\'s own saved, older root)'
                : r.merkleRoot === R_AT_B ? 'R_AT_B' : r.merkleRoot === R_CUR ? 'R_CUR' : r.merkleRoot.toString()),
              (e: unknown) => `refused: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
            );

            // The root named is the root proved: the prover got the lagging map's levels.
            const calls = h.generateSpendProof.mock.calls;
            const proved = calls.length !== 1
              ? `${calls.length} proofs`
              : levels(calls[0]?.[4], calls[0]?.[5]) === laggingLevels ? 'the lagging map\'s levels' : 'other levels';
            // The route really ran: the walk (own walk only) plus the refetch
            // (step 2, and every world whose walk left a listed insert unread).
            const walks = (route === 'walked leaves passed' ? 0 : 1) + (lag.readsAll ? first.refetch : 1);
            const callback = withProgress ? `; callback ${steps.length > 0 ? 'called' : 'never called'}` : '';
            got.push(`${label} => ${outcome}; ${counters.signatures} listing(s); proved ${proved}${callback}`);
            want.push(
              lag.readsAll
                ? `${label} => R_AT_B; ${walks} listing(s); proved the lagging map's levels${withProgress ? '; callback called' : ''}`
                : `${label} => refused: HistoryIncompleteError: ${new HistoryIncompleteError().message}; ${walks} listing(s); proved 0 proofs${withProgress ? '; callback called' : ''}`,
            );
          }
        }
      }
    }
    // 2 lags x 3 first maps x 2 routes x 2 callbacks: a loop that silently ran fewer proves less.
    expect(want).toHaveLength(24);
    expect(got).toEqual(want);
  });

  it('the withdrawal job hands its options to the prepare unchanged (one walk, end to end)', async () => {
    // `poolHandlersUnshieldV4.test.ts` mocks the job and the cases above call
    // the prepare directly, so neither sees the one line that joins them. Here
    // the REAL `prepareUnshieldJobV4` runs: if it dropped `opts`, the prepare
    // would walk the history again (signatures > 0) and, in the holed world,
    // lose the saved witness that is still current.
    const counters = newCounters();
    const base = connection({ counters }) as unknown as Record<string, unknown>;
    const jobConnection = {
      ...base,
      getProgramAccounts: async () => [],
      getMinimumBalanceForRentExemption: async () => 1_000_000,
    } as never;
    const owner = new PublicKey('11111111111111111111111111111112');
    const seed = new Uint8Array(32).fill(7);

    const job = await prepareUnshieldJobV4(
      receipt(NOTE_A), RECIPIENT, owner, POOL, jobConnection, seed, undefined,
      { leaves: walkedLeaves(), savedPath: savedPathFor(NOTE_A) },
    );
    expect(job.prepared.merkleRoot).toBe(R_CUR);
    expect(counters.signatures, 'the job dropped opts.leaves, so the prepare walked again').toBe(0);
    expect(counters.transactions).toBe(0);

    // Holed history, no leaves: only the saved witness (current root) can answer.
    const holed = {
      ...(connection({ hideLeaf: HOLE }) as unknown as Record<string, unknown>),
      getProgramAccounts: async () => [],
      getMinimumBalanceForRentExemption: async () => 1_000_000,
    } as never;
    const currentWitness = {
      pathElements: freshPath(NOTE_A).pathElements.map(String),
      pathIndices: freshPath(NOTE_A).pathIndices,
      root: R_CUR.toString(),
    };
    const viaSaved = await prepareUnshieldJobV4(
      receipt(NOTE_A), RECIPIENT, owner, POOL, holed, seed, undefined, { savedPath: currentWitness },
    ).then(
      (j) => j.prepared.merkleRoot.toString(),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(viaSaved, 'the job dropped opts.savedPath').toBe(R_CUR.toString());

    // `opts.unread` travels too. The same lagging map (leaves 0..6, root R_AT_B
    // in the ring) is refused through the job when its walk left a listed
    // insert unread, and proved with no refetch when the walk read all it
    // listed. A job that reset it to 0 would prove the first; one that dropped
    // it would refetch the second (controls JOBU0 and JOBUX,
    // `scratchpad/web-run/logs2/SPEND-1-cr1/`).
    const behind = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex <= NOTE_B));
    const viaJob: string[] = [];
    for (const unread of [1, 0]) {
      setPoolHistoryStore(memoryPoolHistoryStore());
      const c = newCounters();
      const lagging = {
        ...(connection({ hideFrom: NOTE_B + 1, counters: c }) as unknown as Record<string, unknown>),
        getProgramAccounts: async () => [],
        getMinimumBalanceForRentExemption: async () => 1_000_000,
      } as never;
      const outcome = await prepareUnshieldJobV4(
        receipt(NOTE_A), RECIPIENT, owner, POOL, lagging, seed, undefined, { leaves: behind, unread },
      ).then(
        (j) => (j.prepared.merkleRoot === R_AT_B ? 'R_AT_B' : j.prepared.merkleRoot.toString()),
        (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
      );
      viaJob.push(`walk left ${unread} unread => ${outcome}; ${c.signatures} listing(s)`);
    }
    expect(viaJob).toEqual([
      'walk left 1 unread => refused: HistoryIncompleteError; 1 listing(s)',
      'walk left 0 unread => R_AT_B; 0 listing(s)',
    ]);
  });

  it('a short walked map gets ONE refetch, and the refetched root is proved (not refused, not v3)', async () => {
    // Step 2 of the prepare. `locateOwnedNote` handed down a map with a hole
    // (an RPC that had not served leaf HOLE yet), so the build folds to a root
    // the pool never published. The prepare must refetch once and prove the
    // pool's current root. Without that refetch, a note whose older saved root
    // is still in the ring can only get HistoryIncompleteError, and a note with
    // no saved path gets PRE-FLIGHT FAIL, which the handler sends to the C1 + C3
    // pair that publishes the commitment. Control: mutant R1 (refetch deleted),
    // `scratchpad/wp-logs/SPEND-1-fix2-mutants/`.
    const holed = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex !== HOLE));
    const holedRoot = buildMerkleProofFromLeavesV3({
      leavesByIndex: leavesWithHole(),
      targetLeafIndex: NOTE_A,
    }).root;
    // Anti-vacuity: the holed map's root is neither current nor in the ring.
    for (const r of [R_CUR, R_AT_A, R_AT_B]) expect(holedRoot).not.toBe(r);

    for (const opts of [{ leaves: holed, savedPath: savedPathFor(NOTE_A) }, { leaves: holed }]) {
      vi.clearAllMocks();
      setPoolHistoryStore(memoryPoolHistoryStore());
      const counters = newCounters();
      const outcome = await prepareUnshieldV4(
        receipt(NOTE_A), RECIPIENT, POOL, connection({ counters }), undefined, opts,
      ).then(
        (r) => ({ kind: 'prepared', root: r.merkleRoot.toString(), message: '' }),
        (e: unknown) => ({ kind: 'refused', root: '', message: e instanceof Error ? e.message : String(e) }),
      );
      expect(outcome, `saved path passed: ${opts.savedPath ? 'yes' : 'no'}`).toEqual({
        kind: 'prepared', root: R_CUR.toString(), message: '',
      });
      expect(counters.signatures, 'not exactly one history refetch').toBe(1);
      expect(h.generateSpendProof).toHaveBeenCalledTimes(1);
    }
  });

  it('a walked map that does not hold the note yet gets the refetch too', async () => {
    // The builder throws when the note is past the end of the map (an RPC
    // behind the deposit). The prepare handles that like an unknown root: one
    // refetch, then the current root. Control: mutant R1.
    const beforeNote = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex < NOTE_A));
    expect(() =>
      buildMerkleProofFromLeavesV3({ leavesByIndex: LEAVES.slice(0, NOTE_A), targetLeafIndex: NOTE_A }),
    ).toThrow();

    const counters = newCounters();
    const outcome = await prepareUnshieldV4(
      receipt(NOTE_A), RECIPIENT, POOL, connection({ counters }), undefined, { leaves: beforeNote },
    ).then(
      (r) => r.merkleRoot.toString(),
      (e: unknown) => `refused: ${e instanceof Error ? e.message : String(e)}`,
    );
    expect(outcome).toBe(R_CUR.toString());
    expect(counters.signatures, 'not exactly one history refetch').toBe(1);
  });

  it('a first walk that misses a leaf is refetched once, with no leaves passed', async () => {
    // The same step, reached from the prepare's own walk: the RPC hides leaf
    // HOLE on the first walk only. Control: mutant R1.
    const counters = newCounters();
    const outcome = await prepareUnshieldV4(
      receipt(NOTE_A), RECIPIENT, POOL,
      connection({ hideLeaf: HOLE, hideOnFirstWalkOnly: true, counters }), undefined,
      { savedPath: savedPathFor(NOTE_A) },
    ).then(
      (r) => r.merkleRoot.toString(),
      (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
    );
    expect(outcome).toBe(R_CUR.toString());
    // One walk, then one refetch.
    expect(counters.signatures, 'the prepare did not walk, then refetch once').toBe(2);
  });

  it('an unreadable pool account never makes the saved path the answer', async () => {
    // With no pool account (the RPC returns null), or one the parser refuses
    // (a 256-entry ring), no pre-flight can run. A saved path cannot be shown
    // to be current, so the root proved must be the rebuilt one, never the
    // note's older saved root. Control: mutant R6 (saved path used when the
    // account is unreadable), `scratchpad/wp-logs/SPEND-1-fix2-mutants/`.
    const unparsable = poolAccount(R_CUR, ringOf(256));
    expect(parsePoolV3Account(unparsable), 'the fixture account is not one the parser refuses').toBeNull();

    // Crossed with the route, the note's source and the progress callback (the
    // handler always passes one): a saved-path rule keyed on any of them named
    // R_AT_A while every world here ran without a callback on a shielded note
    // (mutants UNRCV, UNCB, UNLV, `scratchpad/web-run/logs/verify-SPEND-1-r3b/`;
    // controls in `scratchpad/web-run/logs2/SPEND-1-cr1/`).
    const fresh = freshPath(NOTE_A);
    const freshLevels = JSON.stringify([
      fresh.pathElements.slice(0, C7_SUBTREE_DEPTH).map(String),
      fresh.pathIndices.slice(0, C7_SUBTREE_DEPTH),
    ]);
    const got: string[] = [];
    const want: string[] = [];
    for (const account of [null, unparsable]) {
      for (const route of ['own walk', 'walked leaves'] as const) {
        for (const source of ['shielded', 'received'] as const) {
          for (const withProgress of [false, true]) {
            vi.clearAllMocks();
            setPoolHistoryStore(memoryPoolHistoryStore());
            const label = `account: ${account === null ? 'null' : 'unparsable'}, ${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
            const outcome = await prepareUnshieldV4(
              receipt(NOTE_A, source), RECIPIENT, POOL, connection({ account }),
              withProgress ? () => undefined : undefined,
              route === 'walked leaves'
                ? { leaves: walkedLeaves(), unread: 0, savedPath: savedPathFor(NOTE_A) }
                : { savedPath: savedPathFor(NOTE_A) },
            ).then(
              (r) => (r.merkleRoot === R_CUR ? 'R_CUR' : r.merkleRoot === R_AT_A ? 'R_AT_A (the saved, older root)' : r.merkleRoot.toString()),
              (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
            );
            const calls = h.generateSpendProof.mock.calls;
            const proved = calls.length !== 1
              ? `${calls.length} proofs`
              : JSON.stringify([calls[0]?.[4], calls[0]?.[5]]) === freshLevels ? 'the fresh levels' : 'other levels';
            got.push(`${label} => ${outcome}; proved ${proved}`);
            want.push(`${label} => R_CUR; proved the fresh levels`);
          }
        }
      }
    }
    expect(want).toHaveLength(16);
    expect(got).toEqual(want);

    // The same, when the build FAILS too: the leaves do not hold the note, so
    // there is no rebuilt root AND no pre-flight. The saved path still cannot
    // be shown to be current, so the prepare refuses and proves nothing; it
    // never falls back to the older saved root. Control: mutant N1 (saved path
    // used when the account is unreadable and the build failed),
    // `scratchpad/web-run/logs/SPEND-1-web-fix1/`.
    const beforeNote = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex < NOTE_A));
    // Anti-vacuity: from these leaves the builder throws, so no rebuilt root exists.
    expect(() =>
      buildMerkleProofFromLeavesV3({ leavesByIndex: LEAVES.slice(0, NOTE_A), targetLeafIndex: NOTE_A }),
    ).toThrow();
    for (const account of [null, unparsable]) {
      for (const world of [
        { label: 'walked leaves passed', leaves: beforeNote, hideFrom: undefined },
        { label: 'own walk, RPC behind the deposit', leaves: undefined, hideFrom: NOTE_A },
      ]) {
        vi.clearAllMocks();
        setPoolHistoryStore(memoryPoolHistoryStore());
        const label = `account: ${account === null ? 'null' : 'unparsable'}, ${world.label}`;
        const outcome = await prepareUnshieldV4(
          receipt(NOTE_A), RECIPIENT, POOL, connection({ account, hideFrom: world.hideFrom }), undefined,
          { ...(world.leaves ? { leaves: world.leaves } : {}), savedPath: savedPathFor(NOTE_A) },
        ).then(
          (r) => `prepared with root ${r.merkleRoot === R_AT_A ? 'R_AT_A (the saved, older root)' : r.merkleRoot.toString()}`,
          () => 'refused',
        );
        expect(outcome, label).toBe('refused');
        expect(h.generateSpendProof, `${label}: a proof was built`).not.toHaveBeenCalled();
      }
    }
  });

  it('the refusal the screen shows names no leaf: no index, no count', async () => {
    // PoolPanel.tsx renders a failed withdrawal as `(e as Error).message`, so
    // every character of this refusal is on screen, and in any screenshot or
    // support ticket. With no readable pool account and leaves that do not
    // hold the note, the prepare rethrows the builder's own error, which read
    // "target leafIndex 3 not found among 3 non-empty leaves". The v3 prepare
    // and `prepareSubscribeV4` let the same builder error through, so its text
    // is pinned at the source as well. Red on the old text:
    // `scratchpad/web-run/logs/SPEND-1-web-fix1/msg-red.log`.
    const beforeNote = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex < NOTE_A));
    const outcome = await prepareUnshieldV4(
      receipt(NOTE_A), RECIPIENT, POOL, connection({ account: null }), undefined,
      { leaves: beforeNote, savedPath: savedPathFor(NOTE_A) },
    ).then(
      () => ({ kind: 'prepared', name: '', message: '' }),
      (e: unknown) => ({
        kind: 'refused',
        name: e instanceof Error ? e.name : typeof e,
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    expect(outcome.kind).toBe('refused');
    expect(h.generateSpendProof).not.toHaveBeenCalled();

    // Anti-vacuity: the refusal IS the builder's error for these leaves, not a
    // harness crash whose text happens to hold no number.
    let direct = '';
    try {
      buildMerkleProofFromLeavesV3({ leavesByIndex: LEAVES.slice(0, NOTE_A), targetLeafIndex: NOTE_A });
    } catch (e) {
      direct = e instanceof Error ? e.message : String(e);
    }
    expect(direct, 'the builder no longer throws for a note past the end of the map').not.toBe('');
    expect(outcome.name).toBe('Error');
    expect(outcome.message).toBe(direct);

    for (const message of [outcome.message, direct]) {
      // The leaf index and the leaf count are both numbers, so the text may
      // carry none (`\b` skips the "3" inside "V3").
      expect(message.match(/\b\d+\b/g), `the refusal carries a number: "${message}"`).toBeNull();
      // And it stays a refusal: no needle, so it is never routed to the C1 + C3 pair.
      for (const needle of v4RebuildNeedles()) expect(message).not.toContain(needle);
    }
  });
});

describe('a hole in the readable history refuses instead of naming an older root', () => {
  it('hole plus older saved root: refuse, never name it, no v3', async () => {
    // The RPC lists every signature as successful but will not serve one insert
    // transaction, so the rebuilt tree is missing a leaf and folds to a root the
    // pool has never published. The note's saved root IS still in the ring — so
    // the cheap answer is to name it, and the cheap answer is the leak.
    const counters = newCounters();
    const outcome = await prepareUnshieldV4(
      receipt(NOTE_A),
      RECIPIENT,
      POOL,
      connection({ hideLeaf: HOLE, counters }),
      undefined,
      { savedPath: savedPathFor(NOTE_A) },
    ).then(
      (r) => ({ kind: 'prepared' as const, root: r.merkleRoot.toString() }),
      // Rethrown as a VALUE, never wrapped in an expectation: an assertion whose
      // subject is a crash goes red whatever the code does and proves nothing.
      (e: unknown) => ({
        kind: 'refused' as const,
        name: e instanceof Error ? e.name : typeof e,
        message: e instanceof Error ? e.message : String(e),
      }),
    );

    expect(outcome).toMatchObject({ kind: 'refused', name: 'HistoryIncompleteError' });

    // NOTHING WAS PROVED. A refusal that still spent 5.5 seconds and an upload
    // would be a worse answer than the leak it avoids.
    expect(h.generateSpendProof, 'a proof was built for a root that dates the deposit').not.toHaveBeenCalled();

    const message = outcome.kind === 'refused' ? outcome.message : '';
    // ⛔ AND IT MUST NOT BE ROUTABLE TO THE C1 + C3 PAIR. `isV4RebuildFailure` is
    // an allow-list over message needles; a refusal carrying one of them is sent
    // to the pair that republishes this note's commitment, which would undo the
    // refusal by wording alone.
    for (const needle of v4RebuildNeedles()) {
      expect(message, `the refusal carries the v3 fallback needle "${needle}"`).not.toContain(needle);
    }
    // It names no note, either: the message reaches screens and logs.
    expect(message).not.toContain(LEAVES[NOTE_A].toString());
    expect(message).not.toContain(R_AT_A.toString());
    expect(message).not.toMatch(/leaf/i);
  });

  it('an RPC that never serves the note refuses too: no rebuild, and the older saved root is still not named', async () => {
    // The case above puts the hole BELOW the note, so every rebuild still
    // yields a (wrong) root. Here the RPC is behind the deposit: it never serves
    // the note's own leaf, or any leaf from it on, so every rebuild THROWS and
    // there is no rebuilt root at all after the refetch. The saved root is
    // still in the ring, and naming it is the leak (a note spent soon after
    // issuance). Control: mutant N10 (saved path used when the refetched build
    // threw), `scratchpad/web-run/logs/SPEND-1-web-fix1/`.
    const zeroAtNote = LEAVES.map((l, i) => (i === NOTE_A ? 0n : l));
    // Anti-vacuity: from what each RPC below serves, the builder throws.
    expect(() =>
      buildMerkleProofFromLeavesV3({ leavesByIndex: LEAVES.slice(0, NOTE_A), targetLeafIndex: NOTE_A }),
    ).toThrow();
    expect(() => buildMerkleProofFromLeavesV3({ leavesByIndex: zeroAtNote, targetLeafIndex: NOTE_A })).toThrow();

    const beforeNote = new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex < NOTE_A));
    const worlds = [
      // `walks`: the prepare's own walk (when no leaves are passed) plus the ONE refetch.
      { label: 'behind the deposit, own walk', rpc: { hideFrom: NOTE_A }, leaves: undefined, walks: 2 },
      { label: 'behind the deposit, walked leaves passed', rpc: { hideFrom: NOTE_A }, leaves: beforeNote, walks: 1 },
      { label: 'the note\'s leaf alone never served', rpc: { hideLeaf: NOTE_A }, leaves: undefined, walks: 2 },
    ];
    for (const w of worlds) {
      vi.clearAllMocks();
      setPoolHistoryStore(memoryPoolHistoryStore());
      const counters = newCounters();
      const outcome = await prepareUnshieldV4(
        receipt(NOTE_A), RECIPIENT, POOL, connection({ ...w.rpc, counters }), undefined,
        { ...(w.leaves ? { leaves: w.leaves } : {}), savedPath: savedPathFor(NOTE_A) },
      ).then(
        (r) => ({
          kind: 'prepared',
          name: '',
          root: r.merkleRoot === R_AT_A ? 'R_AT_A (the saved, older root)' : r.merkleRoot.toString(),
        }),
        (e: unknown) => ({ kind: 'refused', name: e instanceof Error ? e.name : typeof e, root: '' }),
      );
      expect(outcome, w.label).toEqual({ kind: 'refused', name: 'HistoryIncompleteError', root: '' });
      expect(h.generateSpendProof, `${w.label}: a proof was built`).not.toHaveBeenCalled();
      // The refusal comes AFTER the one refetch, not in place of it.
      expect(counters.signatures, `${w.label}: not the walk plus exactly one refetch`).toBe(w.walks);
    }

    // The refusal is for an OLDER saved root only. On the same RPC, a saved
    // witness that folds to the pool's current root dates nothing and is used.
    vi.clearAllMocks();
    setPoolHistoryStore(memoryPoolHistoryStore());
    const currentWitness = {
      pathElements: freshPath(NOTE_A).pathElements.map(String),
      pathIndices: freshPath(NOTE_A).pathIndices,
      root: R_CUR.toString(),
    };
    const viaCurrent = await prepareUnshieldV4(
      receipt(NOTE_A), RECIPIENT, POOL, connection({ hideFrom: NOTE_A }), undefined, { savedPath: currentWitness },
    ).then(
      (r) => r.merkleRoot.toString(),
      (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
    );
    expect(viaCurrent).toBe(R_CUR.toString());
    expect(h.generateSpendProof).toHaveBeenCalledTimes(1);
  });

  it('the missing-leaf warning prints a count, never which leaf', async () => {
    // `prepareUnshieldV4` warns when its own walk comes back with holes. The
    // line used to append up to five missing leaf indices; the standing
    // rule is that no production console line carries a leaf index.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await prepareUnshieldV4(
        receipt(NOTE_A), RECIPIENT, POOL, connection({ hideLeaf: HOLE }), undefined, {},
      ).catch(() => undefined);
      const lines = warn.mock.calls
        .map((args) => args.map(String).join(' '))
        .filter((s) => s.includes('prepareUnshieldV4:'));
      // Anti-vacuity: the hole world does reach the warning.
      expect(lines.length, 'the holed walk no longer reaches the warning').toBeGreaterThan(0);
      for (const line of lines) {
        const rest = line.slice(line.indexOf('prepareUnshieldV4:') + 'prepareUnshieldV4:'.length);
        // Exactly one number after the prefix: the count (one hole).
        expect(rest.match(/\d+/g), `the warning names a leaf: "${line}"`).toEqual(['1']);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it('the v3 prepare\'s missing-leaf warning prints a count, never which leaf', async () => {
    // The C1 + C3 prepare (`prepareUnshield`) walks the same history and had the
    // same line, appending up to five missing leaf indices. It is still reached
    // (the v3 route, V3-1), so the same rule applies. In this world the rebuilt
    // root is unknown on both reads, so it refuses before any proof.
    //
    // close-v1 (audit v1 F05): the C1 + C3 spend is now refused first unless
    // NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND is '1' (pinned in
    // closeV1L3C1C3SpendDisabled.test.ts). Where it is set, this walk still
    // runs, so the rule on its warning line still applies: opt in here.
    vi.stubEnv('NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = await prepareUnshield(
        receipt(NOTE_A), POOL, connection({ hideLeaf: HOLE }), undefined,
      ).then(
        () => 'prepared',
        (e: unknown) => (e instanceof Error ? e.message.slice(0, 'PRE-FLIGHT FAIL'.length) : String(e)),
      );
      // Anti-vacuity: the world is the one where the walk has a hole and the
      // prepare stops at its own pre-flight, not a harness crash.
      expect(outcome).toBe('PRE-FLIGHT FAIL');
      const lines = warn.mock.calls
        .map((args) => args.map(String).join(' '))
        .filter((s) => s.includes('prepareUnshield:'));
      expect(lines.length, 'the holed walk no longer reaches the v3 warning').toBeGreaterThan(0);
      for (const line of lines) {
        const rest = line.slice(line.indexOf('prepareUnshield:') + 'prepareUnshield:'.length);
        // Exactly one number after the prefix: the count (one hole).
        expect(rest.match(/\d+/g), `the v3 warning names a leaf: "${line}"`).toEqual(['1']);
      }
      expect(h.generateSpendProof).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('a saved root equal to the current root is used', async () => {
    // The saved path is not forbidden — it is only forbidden when it is STALE.
    // A note whose witness still folds to the pool's current root carries no
    // information about when it was deposited, so it is the same answer a
    // rebuild would give, for free. Here the history is holed, so the rebuild
    // cannot answer and this is the only route left.
    const currentWitness = {
      pathElements: freshPath(NOTE_A).pathElements.map(String),
      pathIndices: freshPath(NOTE_A).pathIndices,
      root: R_CUR.toString(),
    };

    const result = await prepareUnshieldV4(
      receipt(NOTE_A),
      RECIPIENT,
      POOL,
      connection({ hideLeaf: HOLE }),
      undefined,
      { savedPath: currentWitness },
    );

    expect(result.merkleRoot).toBe(R_CUR);
  });

  it('a hole with no known saved root keeps PRE-FLIGHT FAIL, so the v3 route still decides', async () => {
    // The refusal is for ONE case: a saved root the ring still holds. A saved
    // root the pool does not know dates nothing the chain would accept, and a
    // note with no saved path has nothing to date, so both keep the needle
    // `isV4RebuildFailure` routes on (V3-1 decides that route). The same for a
    // received note: the route does not depend on where the note came from.
    const unknownWitness = { ...savedPathFor(NOTE_A), root: '123456789' };
    for (const source of ['shielded', 'received'] as const) {
      for (const opts of [{ savedPath: unknownWitness }, {}]) {
        const outcome = await prepareUnshieldV4(
          receipt(NOTE_A, source), RECIPIENT, POOL, connection({ hideLeaf: HOLE }), undefined, opts,
        ).then(
          () => ({ name: 'prepared', message: '' }),
          (e: unknown) => ({
            name: e instanceof Error ? e.name : typeof e,
            message: e instanceof Error ? e.message : String(e),
          }),
        );
        expect(outcome.name, source).toBe('Error');
        expect(outcome.message, source).toContain('PRE-FLIGHT FAIL');
      }
    }
    expect(h.generateSpendProof).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The issued-note geometry: how old the saved root is, and where the note came from
// ---------------------------------------------------------------------------

/**
 * The path for the note at NOTE_A in the tree as it stood right after leaf `k`
 * was inserted. `pathAfter(NOTE_A)` folds to the note's own deposit root
 * (R_AT_A), `pathAfter(NOTE_B)` to R_AT_B and `pathAfter(7)` to R_CUR.
 */
function pathAfter(k: number) {
  return buildMerkleProofFromLeavesV3({ leavesByIndex: LEAVES.slice(0, k + 1), targetLeafIndex: NOTE_A });
}

/** `pathAfter(k)` in the string shape `extractStoredPath` produces. */
function savedAfter(k: number) {
  const p = pathAfter(k);
  return { pathElements: p.pathElements.map(String), pathIndices: p.pathIndices, root: p.root.toString() };
}

describe('the saved root\'s age and the note\'s source never pick the root', () => {
  /**
   * WHY THIS BLOCK. Every case above saves R_AT_A, the root of the note's own
   * insertion, and POOL_ACCOUNT holds it as its OLDEST ring entry. An issued
   * note is saved later: the issuer filed the root at issuance, which follows
   * the buyer's own funded deposit, so its saved root is NEWER than the note's
   * leaf and can be the newest root in the ring. Received notes already in
   * users' stores still carry such paths. A prepare that used the saved root
   * only when it is newer than the map's root (mutant NEWER), that proved it
   * instead of refusing when it is the newest ring entry (RECENT), or that
   * treated a received note differently (RCVF, RCVL, RCVPF) passed every case
   * above (`scratchpad/web-run/logs/verify-SPEND-1-r2-late/mutants/summary-wp.log`).
   * The controls for this block are in `scratchpad/web-run/logs/SPEND-1-web-fix3b/`.
   *
   * THE RING IS IN THE ORDER THE PROGRAM WRITES IT. `update_root` (pool_v3.rs)
   * pushes the outgoing root until the ring is full, then overwrites slot
   * `root_write_index % max`. With four slots, eight insertions leave
   * [R3, R4, R5, R6], oldest first, and R7 current; R3 is the note's own
   * deposit root. The cases cross EVERY ordered pair of those roots (the map's,
   * the saved one), so a rule keyed on which one is newer, older, adjacent or
   * last in the ring is exercised in both directions.
   */
  const RING_KS = [3, 4, 5, 6];
  const ROOT_AFTER = new Map([...RING_KS, 7].map((k) => [k, pathAfter(k).root] as const));
  const rootAfter = (k: number) => ROOT_AFTER.get(k)!;
  const RING_ACCOUNT = poolAccount(R_CUR, RING_KS.map(rootAfter));
  /**
   * The same ring padded to 256 entries, one more than the program keeps, as
   * `parsePoolV3Account`'s own 256 case: an account that is PRESENT but does
   * not parse, so no pre-flight can run. A tie check that ran only when the
   * account is absent proved the tied root here (mutants W_PARSENULL and
   * S_PARSENULL, `scratchpad/web-run/logs2/verify-SPEND-1-r3/`).
   */
  const UNPARSABLE_RING_ACCOUNT = poolAccount(R_CUR, [...RING_KS.map(rootAfter), ...ringOf(256 - RING_KS.length)]);
  const accountName = (a: Uint8Array | null) =>
    a === RING_ACCOUNT ? 'readable' : a === null ? 'absent' : 'unparsable (a 256-entry ring)';
  const asHex = (v: bigint) => Buffer.from(new Uint8Array(goldilocksToLeBytes32(v))).toString('hex');
  const poolKnows = (root: bigint | null) => root !== null && [...RING_KS, 7].some((k) => rootAfter(k) === root);
  const nameOf = (v: bigint): string => {
    for (const k of [...RING_KS, 7]) {
      if (v === rootAfter(k)) return k === 7 ? 'R_CUR' : k === NOTE_A ? 'R3 (the note\'s own deposit)' : `R${k}`;
    }
    return v.toString();
  };
  /** The root a leaf array folds to for the note, or null when the builder cannot place the note. */
  const rootOf = (leavesByIndex: bigint[]): bigint | null => {
    try {
      return buildMerkleProofFromLeavesV3({ leavesByIndex, targetLeafIndex: NOTE_A }).root;
    } catch {
      return null;
    }
  };
  /** The leaves up to `m` as `locateOwnedNote` hands them down, optionally without leaf `skip`. */
  const mapUpTo = (m: number, skip?: number) =>
    new Map([...walkedLeaves()].filter(([, e]) => e.leafIndex <= m && e.leafIndex !== skip));
  const levels = (elements: unknown, indices: unknown) => JSON.stringify([elements, indices]);

  /** ANTI-VACUITY for both cases: five distinct roots, the ring oldest first, every saved path complete. */
  function expectADiscriminatingRing(): void {
    const roots = [...RING_KS, 7].map(rootAfter);
    expect(new Set(roots.map(String)).size, 'two of R3..R7 coincide').toBe(5);
    expect(rootAfter(NOTE_A)).toBe(R_AT_A);
    expect(rootAfter(NOTE_B)).toBe(R_AT_B);
    expect(rootAfter(7)).toBe(R_CUR);
    const parsed = parsePoolV3Account(RING_ACCOUNT);
    expect(parsed, 'the ring fixture does not parse').not.toBeNull();
    expect(
      parsed!.historicalRoots.map((r) => Buffer.from(r).toString('hex')),
      'the ring is not R3..R6, oldest first',
    ).toEqual(RING_KS.map((k) => asHex(rootAfter(k))));
    expect(Buffer.from(parsed!.currentRoot).toString('hex')).toBe(asHex(R_CUR));
    for (const k of RING_KS) expect(savedAfter(k).pathElements.length).toBeGreaterThanOrEqual(C7_SUBTREE_DEPTH);
    expect(parsePoolV3Account(UNPARSABLE_RING_ACCOUNT), 'the 256-entry ring fixture parses').toBeNull();
  }

  it('a saved root of any age, on a note of either source, never replaces the root the leaf map folds to', async () => {
    // The map is complete (R_CUR) or lags the chain by one to three insertions
    // (R6, R5, R4, each in the ring). The note's saved path folds to any OTHER
    // ring root: older than the map's, newer (the issuance root, after the
    // buyer's own deposit) or the newest in the ring. The root proved is the
    // map's, whether it is reached at step 1 or after the one refetch, through
    // the walked leaves or the prepare's own walk, for a note the wallet
    // shielded or one it received, with or without a progress callback.
    //
    // CHANGED IN THE CONTINUED RUN (`scratchpad/web-run/logs2/SPEND-1-cr1/`):
    // a lagging map whose walk left a LISTED insert unread (the second lag
    // kind, maps to 4, 5 and 6) may end where this client last read rather
    // than where the RPC is, so it is refetched and, still unread, refused
    // with HistoryIncompleteError; nothing is proved (216 of the 624 worlds).
    // The saved root is never named in any world. The walked-leaves route
    // carries the report the real walk gives on the same RPC.
    expectADiscriminatingRing();

    const lags = [
      {
        kind: 'lag: signature not listed yet',
        every: (m: number) => (m < 7 ? { unlistedFrom: m + 1 } : {}),
        shortFirstWalk: { firstWalkUnlistedFrom: NOTE_A },
        readsAll: true,
      },
      {
        kind: 'lag: listed, transaction not served',
        every: (m: number) => (m < 7 ? { hideFrom: m + 1 } : {}),
        shortFirstWalk: { firstWalkHideFrom: NOTE_A },
        readsAll: false,
      },
    ];
    type Lag = (typeof lags)[number];
    const firstReads = [
      {
        kind: 'step 1 (first map is the map)',
        leaves: (m: number) => mapUpTo(m),
        array: (m: number) => LEAVES.slice(0, m + 1),
        ownWalk: (_lag: Lag) => ({}),
        refetch: 0,
      },
      {
        kind: 'step 2 (first map holed below the note)',
        leaves: (m: number) => mapUpTo(m, HOLE),
        array: (m: number) => LEAVES.slice(0, m + 1).map((l, i) => (i === HOLE ? 0n : l)),
        ownWalk: (_lag: Lag) => ({ hideLeaf: HOLE, hideOnFirstWalkOnly: true }),
        refetch: 1,
      },
      {
        kind: 'step 2 (first map short of the note)',
        leaves: (_m: number) => mapUpTo(NOTE_A - 1),
        array: (_m: number) => LEAVES.slice(0, NOTE_A),
        ownWalk: (lag: Lag) => lag.shortFirstWalk,
        refetch: 1,
      },
    ];
    const pairs: Array<{ m: number; k: number }> = [];
    for (const m of [4, 5, 6, 7]) for (const k of RING_KS) if (k !== m) pairs.push({ m, k });
    // Anti-vacuity: the issuance geometry is in the set, a saved root NEWER than the map's.
    expect(pairs.filter(({ m, k }) => k > m).map(({ m, k }) => `${m}<${k}`)).toEqual(['4<5', '4<6', '5<6']);

    const got: string[] = [];
    const want: string[] = [];
    for (const lag of lags) {
      for (const first of firstReads) {
        for (const m of [4, 5, 6, 7]) {
          const where = `${lag.kind}, ${first.kind}, map to ${m}`;
          // Anti-vacuity: a step-2 first map folds to no root the pool knows...
          if (first.refetch === 1) {
            expect(poolKnows(rootOf(first.array(m))), `${where}: the first map is already accepted`).toBe(false);
          }
          // ...and on this fake RPC a first walk reads exactly that map, a second walk the map.
          setPoolHistoryStore(memoryPoolHistoryStore());
          const probe = connection({ ...lag.every(m), ...first.ownWalk(lag), account: RING_ACCOUNT });
          const firstWalk = await fetchPoolLeavesByIndex(probe, POOL.poolPDA);
          expect(firstWalk.leavesByIndex, `${where}: first walk`).toEqual(first.array(m));
          expect((await fetchPoolLeavesByIndex(probe, POOL.poolPDA)).leavesByIndex, `${where}: second walk`).toEqual(LEAVES.slice(0, m + 1));
          // A map that stops at a listed insert the RPC did not serve is refused.
          const refuses = !lag.readsAll && m < 7;

          const mapPath = pathAfter(m);
          const mapLevels = levels(
            mapPath.pathElements.slice(0, C7_SUBTREE_DEPTH).map(String),
            mapPath.pathIndices.slice(0, C7_SUBTREE_DEPTH),
          );
          for (const { k } of pairs.filter((p) => p.m === m)) {
            for (const route of ['walked leaves', 'own walk'] as const) {
              for (const source of ['shielded', 'received'] as const) {
                for (const withProgress of [false, true]) {
                  const label = `${where}, saved R${k}, ${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
                  vi.clearAllMocks();
                  setPoolHistoryStore(memoryPoolHistoryStore());
                  const counters = newCounters();
                  const rpc = route === 'walked leaves' ? lag.every(m) : { ...lag.every(m), ...first.ownWalk(lag) };
                  const steps: string[] = [];
                  const outcome = await prepareUnshieldV4(
                    receipt(NOTE_A, source), RECIPIENT, POOL, connection({ ...rpc, account: RING_ACCOUNT, counters }),
                    withProgress ? (s: string) => void steps.push(s) : undefined,
                    route === 'walked leaves'
                      ? { leaves: first.leaves(m), unread: firstWalk.unread, savedPath: savedAfter(k) }
                      : { savedPath: savedAfter(k) },
                  ).then(
                    (r) => nameOf(r.merkleRoot),
                    (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
                  );
                  // The root named is the root proved: the prover got the map's levels.
                  const calls = h.generateSpendProof.mock.calls;
                  const proved = calls.length !== 1
                    ? `${calls.length} proofs`
                    : levels(calls[0]?.[4], calls[0]?.[5]) === mapLevels ? 'the map\'s levels' : 'other levels';
                  // The step really ran: the own walk, plus the refetch at step 2
                  // or after a walk that left a listed insert unread.
                  const walks = (route === 'walked leaves' ? 0 : 1) + (refuses ? 1 : first.refetch);
                  const callback = withProgress ? `; callback ${steps.length > 0 ? 'called' : 'never called'}` : '';
                  got.push(`${label} => ${outcome}; ${counters.signatures} listing(s); proved ${proved}${callback}`);
                  want.push(
                    (refuses
                      ? `${label} => refused: HistoryIncompleteError; ${walks} listing(s); proved 0 proofs`
                      : `${label} => ${nameOf(mapPath.root)}; ${walks} listing(s); proved the map's levels`) +
                      (withProgress ? '; callback called' : ''),
                  );
                }
              }
            }
          }
        }
      }
    }
    // 2 lags x 3 first maps x 13 (map, saved) pairs x 2 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(624);
    expect(want.filter((w) => w.includes('=> refused:')), 'the refusing worlds are not the 216 expected').toHaveLength(216);
    // Only the worlds that went wrong, each with what was due, so a red names every one.
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} worlds named or proved another root`).toEqual([]);
    // 624 prepares in one case: an explicit budget, so a loaded suite run cannot
    // turn it red by timing out (vitest's default is 5 s).
  }, 60_000);

  it('a hole on every read refuses whatever the saved root\'s age and the note\'s source, and proves nothing', async () => {
    // The RPC never serves one leaf, so no read rebuilds a root the pool knows.
    // The saved root is in the ring whatever its age: the note's own deposit
    // root (the oldest entry), a later one such as the issuance root, or the
    // newest entry, one insertion old. Naming any of them dates the note, so
    // every world refuses with HistoryIncompleteError, which the handler
    // rethrows, and never with a message carrying a `V4_REBUILD_FAILURES`
    // needle, which the handler routes to the C1 + C3 pair (poolHandlers.ts).
    // Nothing is proved.
    expectADiscriminatingRing();
    const needles = v4RebuildNeedles();
    const holes = [
      {
        kind: 'hole below the note',
        rpc: { hideLeaf: HOLE },
        leaves: mapUpTo(7, HOLE),
        array: LEAVES.map((l, i) => (i === HOLE ? 0n : l)),
      },
      {
        kind: 'RPC behind the deposit',
        rpc: { hideFrom: NOTE_A },
        leaves: mapUpTo(NOTE_A - 1),
        array: LEAVES.slice(0, NOTE_A),
      },
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const hole of holes) {
      // Anti-vacuity: both reads return the holed map, which yields no root the pool knows.
      setPoolHistoryStore(memoryPoolHistoryStore());
      const probe = connection({ ...hole.rpc, account: RING_ACCOUNT });
      for (const read of ['first', 'second']) {
        expect((await fetchPoolLeavesByIndex(probe, POOL.poolPDA)).leavesByIndex, `${hole.kind}: ${read} walk`).toEqual(hole.array);
      }
      expect(poolKnows(rootOf(hole.array)), `${hole.kind}: the holed map is accepted`).toBe(false);

      for (const k of RING_KS) {
        for (const route of ['walked leaves', 'own walk'] as const) {
          for (const source of ['shielded', 'received'] as const) {
            for (const withProgress of [false, true]) {
              const label = `${hole.kind}, saved R${k}, ${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
              vi.clearAllMocks();
              setPoolHistoryStore(memoryPoolHistoryStore());
              const counters = newCounters();
              const outcome = await prepareUnshieldV4(
                receipt(NOTE_A, source), RECIPIENT, POOL, connection({ ...hole.rpc, account: RING_ACCOUNT, counters }),
                withProgress ? () => undefined : undefined,
                route === 'walked leaves' ? { leaves: hole.leaves, savedPath: savedAfter(k) } : { savedPath: savedAfter(k) },
              ).then(
                (r) => `proved ${nameOf(r.merkleRoot)}`,
                (e: unknown) => {
                  const message = e instanceof Error ? e.message : String(e);
                  const needle = needles.find((n) => message.includes(n));
                  return `refused: ${e instanceof Error ? e.name : typeof e}${needle ? ` carrying the v3 needle "${needle}"` : ''}`;
                },
              );
              // The refusal comes after the walk and the one refetch, not in place of them.
              const walks = (route === 'walked leaves' ? 0 : 1) + 1;
              got.push(`${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ${counters.signatures} listing(s)`);
              want.push(`${label} => refused: HistoryIncompleteError; 0 proof(s); ${walks} listing(s)`);
            }
          }
        }
      }
    }
    // 2 holes x 4 saved roots x 2 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(64);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} worlds did not refuse cleanly`).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // A map that ends where the note's saved root was taken
  // -------------------------------------------------------------------------

  /**
   * An RPC that honours `until` and `before` as a real one does, so the
   * history cache behaves as it does in the app: a later walk lists only what
   * is newer than the newest signature it saved, and re-reads what it could
   * not read. Leaves up to `listedUpTo` are listed, newest first; only the
   * transactions of leaves up to `servedUpTo` are served, except
   * `unservedLeaf`'s. Both are read on
   * every call, so a case can move the RPC between two walks; `beforeList`
   * runs as each listing starts, with its number, which moves it between two
   * walks made inside one prepare (each walk here lists once). `account` may be
   * a function of the account read's number on this connection (1 = the first
   * read), so a case can make the walk's read fail and the pre-flight's succeed.
   */
  function historyRpc(
    state: { listedUpTo: number; servedUpTo: number; unservedLeaf?: number },
    opts: {
      account?: Uint8Array | null | ((read: number) => Uint8Array | null);
      counters?: Counters;
      beforeList?: (listing: number) => void;
    } = {},
  ) {
    const counters = opts.counters ?? newCounters();
    const account = opts.account === undefined ? RING_ACCOUNT : opts.account;
    let reads = 0;
    const indexOf = (sig: string | undefined, none: number) => (sig ? Number(sig.replace('SIG', '')) : none);
    return {
      rpcEndpoint: 'https://devnet.helius-rpc.com/?api-key=NOT-A-REAL-KEY',
      getSignaturesForAddress: async (_pda: unknown, o?: { until?: string; before?: string }) => {
        counters.signatures += 1;
        opts.beforeList?.(counters.signatures);
        const until = indexOf(o?.until, -1);
        const before = indexOf(o?.before, Number.POSITIVE_INFINITY);
        return LEAVES.map((_, i) => i)
          .filter((i) => i <= state.listedUpTo && i > until && i < before)
          .reverse()
          .map((i) => ({ signature: `SIG${i}`, err: null }));
      },
      getTransaction: async (sig: string) => {
        counters.transactions += 1;
        const i = Number(sig.replace('SIG', ''));
        if (i > state.servedUpTo || i === state.unservedLeaf) return null;
        return {
          slot: 100 + i,
          transaction: { message: { staticAccountKeys: [{ toBase58: () => `PAYER${i}` }] } },
          meta: { logMessages: [leafInsertedLog(i, LEAVES[i])] },
        };
      },
      getAccountInfo: async () => {
        counters.accountInfo += 1;
        reads += 1;
        const data = typeof account === 'function' ? account(reads) : account;
        return data === null ? null : { data };
      },
    } as never;
  }

  /** The walk `locateOwnedNote` makes: the map, the newest leaf in it, and what the walk reported it could not read. */
  async function walkAsTheHandlerDoes(
    conn: never,
  ): Promise<{ leaves: Map<string, OnChainCommitment>; top: number; unread: number | undefined }> {
    const report: { unread?: number } = {};
    const leaves = await fetchPoolCommitments(conn, POOL.poolPDA, {
      onWalked: (w) => {
        report.unread = w.unread;
      },
    });
    return { leaves, top: Math.max(-1, ...[...leaves.values()].map((e) => e.leafIndex)), unread: report.unread };
  }

  const outcomeOf = (p: Promise<{ merkleRoot: bigint }>) =>
    p.then(
      (r) => nameOf(r.merkleRoot),
      (e: unknown) => `refused: ${e instanceof Error ? e.name : String(e)}`,
    );

  it('a map that ends where the note\'s saved root was taken is never proved (m == k)', async () => {
    // Every case above pairs a map with a saved root taken at a DIFFERENT point
    // (k !== m). When the map ends exactly where the saved root was taken, its
    // root IS the saved root, reached through the leaves rather than the saved
    // path: R3 is the note's own deposit root, R5 the root a received note was
    // issued at, after the buyer's own deposit. A client holds such a map when
    // its history was last completed right after that deposit or purchase and
    // the RPC has not listed, or not served, anything newer. The prepare took
    // it from the ring and named it (probe
    // `scratchpad/web-run/logs/verify-SPEND-1-r3b/probe/NONE.log`, P1; mutant
    // LAGEQ's geometry, unpinned in either direction).
    //
    // Every world must refuse with HistoryIncompleteError after the one
    // refetch and prove nothing, with ONE exception: a map the walk read in
    // full (nothing listed was left unread), that ends past the note, with no
    // saved path. Its root is where the RPC's signature index stands, which
    // says nothing about the note, so it is proved as read.
    //
    // With no pool account there is no pre-flight and no refetch, and the same
    // rule decides at once: the saved-root tie holds there too (continued-run
    // fix round 3; the subscription's twin of this case is "the circuit-7
    // SUBSCRIPTION applies the saved-root tie as the withdrawal does (m == k)").
    expectADiscriminatingRing();
    const lags = [
      { kind: 'newer inserts not listed yet', state: (k: number) => ({ listedUpTo: k, servedUpTo: 7 }), unread: (_k: number) => 0 },
      { kind: 'newer inserts listed, not served', state: (k: number) => ({ listedUpTo: 7, servedUpTo: k }), unread: (k: number) => 7 - k },
    ];
    const got: string[] = [];
    const want: string[] = [];
    const reports: string[] = [];
    const wantReports: string[] = [];
    for (const k of RING_KS) {
      // Anti-vacuity: the saved root is the root of the map to k, in the ring, not current.
      expect(BigInt(savedAfter(k).root)).toBe(rootAfter(k));
      expect(poolKnows(rootAfter(k)) && rootAfter(k) !== R_CUR, `R${k} is not a non-current ring root`).toBe(true);
      for (const lag of lags) {
        for (const withSaved of [true, false]) {
          for (const account of [RING_ACCOUNT, null]) {
            for (const route of ['walked leaves', 'own walk'] as const) {
              for (const source of ['shielded', 'received'] as const) {
                for (const withProgress of [false, true]) {
                  const label =
                    `map to ${k}, ${lag.kind}, ${withSaved ? `saved R${k}` : 'no saved path'}, ` +
                    `account ${accountName(account)}, ${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
                  vi.clearAllMocks();
                  setPoolHistoryStore(memoryPoolHistoryStore());
                  const state = lag.state(k);
                  const saved = withSaved ? { savedPath: savedAfter(k) } : {};
                  let opts: Parameters<typeof prepareUnshieldV4>[5] = saved;
                  if (route === 'walked leaves') {
                    // The handler's walk, on the same RPC and the same history store.
                    const walk = await walkAsTheHandlerDoes(historyRpc(state, { account }));
                    expect(walk.top, `${label}: the walk does not end at ${k}`).toBe(k);
                    reports.push(`${label}: ${walk.unread}`);
                    wantReports.push(`${label}: ${lag.unread(k)}`);
                    opts = { leaves: walk.leaves, unread: walk.unread, ...saved };
                  }
                  const counters = newCounters();
                  const outcome = await outcomeOf(prepareUnshieldV4(
                    receipt(NOTE_A, source), RECIPIENT, POOL, historyRpc(state, { account, counters }),
                    withProgress ? () => undefined : undefined, opts,
                  ));
                  got.push(`${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ${counters.signatures} listing(s)`);
                  const walks = route === 'walked leaves' ? 0 : 1;
                  const provedAsRead = !withSaved && lag.unread(k) === 0 && k !== NOTE_A;
                  want.push(
                    provedAsRead
                      ? `${label} => ${nameOf(rootAfter(k))}; 1 proof(s); ${walks} listing(s)`
                      // The refetch needs an account to pre-flight against.
                      : `${label} => refused: HistoryIncompleteError; 0 proof(s); ${walks + (account ? 1 : 0)} listing(s)`,
                  );
                }
              }
            }
          }
        }
      }
    }
    // 4 maps x 2 lags x 2 saved-path choices x 2 accounts x 2 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(256);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} worlds named the map's root or refused wrongly`).toEqual([]);
    // What the handler's walk reported: nothing unread when it read all it was shown.
    expect(reports).toEqual(wantReports);
  }, 60_000);

  it('a history cache left short by its last walk, with newer inserts listed but not served, is never proved', async () => {
    // The adversary's chain (verifier probe P2, P3 and P5): the client last
    // completed its history right after its own deposit or purchase at leaf
    // k, so its cache ends at k. Newer inserts are then LISTED, but their
    // transactions are not served (a 429 burst reaches the walk as
    // `getTransaction(...).catch(() => null)`). The walk keeps them to re-read,
    // so the client knows its map is not the freshest, and the map still
    // folds to R_k, which the ring holds: the root of the note's own deposit
    // (k = 3) or of the purchase (k = 5), with or without a saved path. So:
    // one refetch, which re-reads them; still unread, HistoryIncompleteError
    // and no proof. With no readable pool account there is no pre-flight and
    // no refetch, and the prepare refuses at once: whether the account is
    // absent or present and unparsable (UNPARSABLE_RING_ACCOUNT).
    expectADiscriminatingRing();
    const got: string[] = [];
    const want: string[] = [];
    const reports: string[] = [];
    const wantReports: string[] = [];
    for (const k of RING_KS) {
      for (const account of [RING_ACCOUNT, null, UNPARSABLE_RING_ACCOUNT]) {
        for (const withSaved of [true, false]) {
          for (const route of ['walked leaves', 'own walk'] as const) {
            for (const source of ['shielded', 'received'] as const) {
              for (const withProgress of [false, true]) {
                const label =
                  `cache completed at ${k}, account ${accountName(account)}, ` +
                  `${withSaved ? `saved R${k}` : 'no saved path'}, ${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
                vi.clearAllMocks();
                setPoolHistoryStore(memoryPoolHistoryStore());
                // The client's own last walk, right after leaf k: the RPC knew no more.
                const state = { listedUpTo: k, servedUpTo: k };
                const primed = await walkAsTheHandlerDoes(historyRpc(state, { account }));
                expect(primed.top, `${label}: the cache does not end at ${k}`).toBe(k);
                // Later: the newer inserts are listed, and their transactions are not served.
                state.listedUpTo = 7;
                const saved = withSaved ? { savedPath: savedAfter(k) } : {};
                let opts: Parameters<typeof prepareUnshieldV4>[5] = saved;
                if (route === 'walked leaves') {
                  const walk = await walkAsTheHandlerDoes(historyRpc(state, { account }));
                  expect(walk.top, `${label}: the walk read past ${k}`).toBe(k);
                  reports.push(`${label}: ${walk.unread}`);
                  wantReports.push(`${label}: ${7 - k}`);
                  opts = { leaves: walk.leaves, unread: walk.unread, ...saved };
                }
                const counters = newCounters();
                const outcome = await outcomeOf(prepareUnshieldV4(
                  receipt(NOTE_A, source), RECIPIENT, POOL, historyRpc(state, { account, counters }),
                  withProgress ? () => undefined : undefined, opts,
                ));
                got.push(`${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ${counters.signatures} listing(s)`);
                // The own walk, then the refetch when there is an account to pre-flight against.
                const walks = (route === 'walked leaves' ? 0 : 1) + (account === RING_ACCOUNT ? 1 : 0);
                want.push(`${label} => refused: HistoryIncompleteError; 0 proof(s); ${walks} listing(s)`);
              }
            }
          }
        }
      }
    }
    // 4 cache ends x 3 accounts x 2 saved-path choices x 2 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(192);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} worlds named the cache's root or refused wrongly`).toEqual([]);
    expect(reports).toEqual(wantReports);
  }, 60_000);

  it('a map handed down with no walk report is not shown clean: a lagging root gets the refetch', async () => {
    // `unread` is how a caller says its walk read everything it listed. Leaves
    // handed down without it have shown nothing, so a lagging ring root from
    // them gets the one refetch, as if the walk had left something unread.
    // Here the refetch reads the same map in full (the newer inserts are not
    // listed yet), so its root is then proved as read.
    expectADiscriminatingRing();
    const got: string[] = [];
    for (const report of [undefined, 0] as const) {
      for (const source of ['shielded', 'received'] as const) {
        vi.clearAllMocks();
        setPoolHistoryStore(memoryPoolHistoryStore());
        const counters = newCounters();
        const outcome = await outcomeOf(prepareUnshieldV4(
          receipt(NOTE_A, source), RECIPIENT, POOL, historyRpc({ listedUpTo: 5, servedUpTo: 7 }, { counters }), undefined,
          report === undefined ? { leaves: mapUpTo(5) } : { leaves: mapUpTo(5), unread: report },
        ));
        got.push(`walk report ${report === undefined ? 'absent' : report}, ${source} => ${outcome}; ${counters.signatures} listing(s)`);
      }
    }
    expect(got).toEqual([
      'walk report absent, shielded => R5; 1 listing(s)',
      'walk report absent, received => R5; 1 listing(s)',
      'walk report 0, shielded => R5; 0 listing(s)',
      'walk report 0, received => R5; 0 listing(s)',
    ]);
  });

  it('signatures the walk gave up on keep a short map from being proved', async () => {
    // A listed insert the RPC never serves is re-read on every walk and given
    // up on after MAX_HISTORY_READ_ATTEMPTS (HIST-1). From then on the re-read
    // list is empty, and counting it alone would call the walk clean while the
    // map still ends where this client last read: leaf 5 here, the purchase.
    // While the map is short of the pool's `next_leaf_index`, the signatures
    // given up on count as unread too, so the prepare refuses.
    //
    // When the walk cannot read the pool account, it cannot show the map
    // whole, so what it gave up on still counts; the pre-flight's own read may
    // succeed a moment later. A walk that called itself read in full whenever
    // the account read failed and nothing waited to be re-read named R5, the
    // purchase root, on every route (mutant WALK_NULLACC, probe world PD,
    // `scratchpad/web-run/logs2/verify-SPEND-1-r3/probe/WALK_NULLACC.log`). So
    // the account is read in three schedules: always; never inside a walk (the
    // pre-flight's read succeeds); inside the first walk only. The subscription
    // walks the same history, so it runs on both of its routes too.
    expectADiscriminatingRing();
    echoingProver();
    const needles = v4RebuildNeedles();
    const schedules = [
      { kind: 'account readable', walkReadFails: (_walk: 'first' | 'refetch') => false },
      { kind: 'account unreadable inside every walk', walkReadFails: (_walk: 'first' | 'refetch') => true },
      { kind: 'account unreadable inside the first walk only', walkReadFails: (walk: 'first' | 'refetch') => walk === 'first' },
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const schedule of schedules) {
      for (const route of ALL_ROUTES) {
        for (const source of ['shielded', 'received'] as const) {
          for (const withProgress of [false, true]) {
            const label = `${schedule.kind}, ${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
            vi.clearAllMocks();
            setPoolHistoryStore(memoryPoolHistoryStore());
            const state = { listedUpTo: 5, servedUpTo: 5 };
            await walkAsTheHandlerDoes(historyRpc(state));
            state.listedUpTo = 7;
            // Earlier walks (balance scans, refused withdrawals) until both newer signatures are given up on.
            for (let i = 0; i < MAX_HISTORY_READ_ATTEMPTS; i += 1) await walkAsTheHandlerDoes(historyRpc(state));
            const { snapshot } = await loadPoolHistory(
              getPoolHistoryStore(), 'https://devnet.helius-rpc.com/?api-key=NOT-A-REAL-KEY', POOL.poolPDA.toBase58(),
            );
            // Anti-vacuity: nothing is left to re-read, both were given up on, and the cache still ends at 5.
            expect(snapshot?.retry, `${label}: signatures are still waiting to be re-read`).toEqual([]);
            expect(snapshot?.dropped, `${label}: the newer signatures were not given up on`).toBe(2);
            expect(Math.max(...(snapshot?.entries ?? []).map((e) => e.leafIndex))).toBe(5);
            // What each account read on the prepare's connection returned, in order.
            const reads: string[] = [];
            const answer = (fails: boolean) => {
              reads.push(fails ? 'none' : 'pool');
              return fails ? null : RING_ACCOUNT;
            };
            let walked: { leaves: Map<string, OnChainCommitment>; unread: number | undefined } | undefined;
            let account: (read: number) => Uint8Array | null;
            let wantReads: string;
            if (route === 'withdrawal, walked leaves') {
              // The handler's walk, on its own connection; then read 1 is the
              // pre-flight and read 2 the refetch's walk.
              const walk = await walkAsTheHandlerDoes(
                historyRpc(state, { account: schedule.walkReadFails('first') ? null : RING_ACCOUNT }),
              );
              expect(walk.unread, `${label}: the handler's walk showed the short map clean`).toBe(2);
              walked = walk;
              account = (read) => answer(read === 2 && schedule.walkReadFails('refetch'));
              wantReads = `pool,${schedule.walkReadFails('refetch') ? 'none' : 'pool'}`;
            } else {
              // Read 1 is the prepare's own walk, read 2 the pre-flight, read 3 the refetch's walk.
              account = (read) =>
                answer((read === 1 && schedule.walkReadFails('first')) || (read === 3 && schedule.walkReadFails('refetch')));
              wantReads =
                `${schedule.walkReadFails('first') ? 'none' : 'pool'},pool,${schedule.walkReadFails('refetch') ? 'none' : 'pool'}`;
            }
            const counters = newCounters();
            const outcome = await spendOutcome(
              spendOn(route, receipt(NOTE_A, source), historyRpc(state, { account, counters }), withProgress ? () => undefined : undefined, walked),
              needles,
            );
            got.push(
              `${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ` +
                `${counters.signatures} listing(s); account reads ${reads.join(',')}`,
            );
            // Held back at the first map, one refetch, held back again.
            const listings = (route === 'withdrawal, walked leaves' ? 0 : 1) + 1;
            want.push(
              `${label} => refused: HistoryIncompleteError; 0 proof(s); ${listings} listing(s); account reads ${wantReads}`,
            );
          }
        }
      }
    }
    // 3 schedules x 4 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(48);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} worlds proved a short map or refused wrongly`).toEqual([]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // The circuit-7 SUBSCRIPTION, and which map the tie rule reads after the refetch
  // -------------------------------------------------------------------------

  /** A retailer and the terms `handlePoolSubscribePrepare` hands `prepareSubscribeJobV4`. */
  const RETAILER = new PublicKey('SysvarRent111111111111111111111111111111111');
  const SUBSCRIBER_COMMITMENT = 5_555n;
  const SUBSCRIBE_TERMS = {
    retailer: RETAILER,
    subscriberCommitment: SUBSCRIBER_COMMITMENT,
    rate: 1_000_000n,
    intervalSlots: 6_480_000n,
    vkHashSubscriber: new Uint8Array(32),
  };
  /** The binding `prepareSubscribeJobV4` builds from those terms; the vault comes from its seeds. */
  function subscribeBinding(): SubscribeBinding {
    const [vault] = deriveSubscriptionVaultPDA(RETAILER, goldilocksU64To32(SUBSCRIBER_COMMITMENT), POOL.tokenMint);
    return {
      vault,
      rate: SUBSCRIBE_TERMS.rate,
      intervalSlots: SUBSCRIBE_TERMS.intervalSlots,
      vkHashSubscriber: SUBSCRIBE_TERMS.vkHashSubscriber,
    };
  }
  /**
   * The prover publishes the binding limbs it was handed, as circuit 7 does, so
   * the withdrawal (recipient limbs) and the subscription (terms limbs) both
   * accept their proof in one case.
   */
  function echoingProver(): void {
    h.generateSpendProof.mockImplementation(async (...a: unknown[]) => ({
      circuitId: 7,
      publicInputs: ['99', '1234', ...(a[6] as string[])],
      proofHex: '00'.repeat(32),
      proofSize: 32,
      durationMs: 1,
    }));
  }

  type SpendRoute = 'withdrawal, walked leaves' | 'withdrawal, own walk' | 'subscription prepare' | 'subscription job';
  const ALL_ROUTES: SpendRoute[] = ['withdrawal, walked leaves', 'withdrawal, own walk', 'subscription prepare', 'subscription job'];
  /**
   * One circuit-7 spend of the note on `conn`: the withdrawal as the handler
   * calls it (the leaves and report of its own walk) or with no leaves, or the
   * subscription through `prepareSubscribeV4` or through the REAL
   * `prepareSubscribeJobV4` the handler calls. The subscription takes no leaves:
   * it always walks the history itself. `savedPath` is the path saved with the
   * note, handed to every route as the handler hands it.
   */
  function spendOn(
    route: SpendRoute,
    rcpt: ShieldReceipt,
    conn: never,
    onProgress: ((s: string) => void) | undefined,
    walked?: { leaves: Map<string, OnChainCommitment>; unread: number | undefined },
    savedPath?: ReturnType<typeof savedAfter>,
  ): Promise<{ merkleRoot: bigint }> {
    const saved = savedPath ? { savedPath } : {};
    switch (route) {
      case 'withdrawal, walked leaves':
        return prepareUnshieldV4(rcpt, RECIPIENT, POOL, conn, onProgress, { leaves: walked!.leaves, unread: walked!.unread, ...saved });
      case 'withdrawal, own walk':
        return prepareUnshieldV4(rcpt, RECIPIENT, POOL, conn, onProgress, saved);
      case 'subscription prepare':
        return prepareSubscribeV4(rcpt, POOL, conn, subscribeBinding(), SUBSCRIBER_COMMITMENT, RETAILER, onProgress, savedPath);
      case 'subscription job': {
        const jobConn = {
          ...(conn as unknown as Record<string, unknown>),
          getMinimumBalanceForRentExemption: async () => 1_000_000,
        } as never;
        return prepareSubscribeJobV4(
          rcpt, POOL, jobConn, new Uint8Array(32).fill(7), SUBSCRIBE_TERMS, onProgress, new Set<string>(), savedPath,
        ).then((job) => job.prepared);
      }
    }
  }
  /** The root named, or the refusal's class and any v3 needle its message carries. */
  const spendOutcome = (p: Promise<{ merkleRoot: bigint }>, needles: string[]) =>
    p.then(
      (r) => nameOf(r.merkleRoot),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        const needle = needles.find((n) => message.includes(n));
        return `refused: ${e instanceof Error ? e.name : typeof e}${needle ? ` carrying the v3 needle "${needle}"` : ''}`;
      },
    );

  it('the circuit-7 SUBSCRIPTION prepare never proves a root tied to the note either', async () => {
    // WHY. `prepareSubscribeV4` is a deliberate copy of the withdrawal's root
    // rule, and it is reached in production: the pay app's subscribe sends
    // retailer, rate and interval, so `handlePoolSubscribePrepare` calls the
    // REAL `prepareSubscribeJobV4`, which calls it for every blinded note. It
    // walks the history itself, and it took any ring root. In the short-cache
    // geometry the withdrawal refuses (a history cache last completed at leaf
    // k, newer inserts listed but not served) it named R3, the note's own
    // deposit root, or R5, the purchase root (verifier probe
    // `scratchpad/web-run/logs2/verify-SPEND-1-r2/probe/SUBSCRIBE-NONE.log`).
    // It now holds such a root back as the withdrawal does: one refetch, then
    // HistoryIncompleteError, which carries no v3 needle, so the handler
    // rethrows it rather than falling back to the C1 + C3 pair. With no
    // readable pool account there is no refetch, and it refuses at once.
    //
    // The liveness half: a map the walk read in full that ends past the note
    // is proved as read (R4..R6: where the RPC's signature index stands), and
    // a complete map is proved at R_CUR, both with no refetch.
    //
    // The account is readable, absent, or present and unparsable
    // (UNPARSABLE_RING_ACCOUNT): the last two both mean no pre-flight.
    expectADiscriminatingRing();
    echoingProver();
    const needles = v4RebuildNeedles();
    const geometries = [
      { kind: 'cache completed at k, newer inserts listed, not served', ks: RING_KS, primed: true },
      { kind: 'newer inserts not listed yet', ks: [...RING_KS, 7], primed: false },
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const g of geometries) {
      for (const k of g.ks) {
        for (const account of [RING_ACCOUNT, null, UNPARSABLE_RING_ACCOUNT]) {
          for (const route of ['subscription prepare', 'subscription job'] as const) {
            for (const source of ['shielded', 'received'] as const) {
              for (const withProgress of [false, true]) {
                const label =
                  `${g.kind}, k=${k}, account ${accountName(account)}, ${route}, ` +
                  `${source}, ${withProgress ? 'with' : 'no'} callback`;
                vi.clearAllMocks();
                setPoolHistoryStore(memoryPoolHistoryStore());
                const state = g.primed ? { listedUpTo: k, servedUpTo: k } : { listedUpTo: k, servedUpTo: 7 };
                if (g.primed) {
                  // The client's own last walk, right after leaf k; later the
                  // newer inserts are listed and not served.
                  const primed = await walkAsTheHandlerDoes(historyRpc(state, { account }));
                  expect(primed.top, `${label}: the cache does not end at ${k}`).toBe(k);
                  state.listedUpTo = 7;
                }
                const counters = newCounters();
                const outcome = await spendOutcome(
                  spendOn(route, receipt(NOTE_A, source), historyRpc(state, { account, counters }), withProgress ? () => undefined : undefined),
                  needles,
                );
                got.push(`${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ${counters.signatures} listing(s)`);
                // Tied: the walk left listed inserts unread, or the map ends at the note's own leaf.
                const tied = g.primed || k === NOTE_A;
                want.push(
                  tied
                    ? `${label} => refused: HistoryIncompleteError; 0 proof(s); ${account === RING_ACCOUNT ? 2 : 1} listing(s)`
                    : `${label} => ${nameOf(rootAfter(k))}; 1 proof(s); 1 listing(s)`,
                );
              }
            }
          }
        }
      }
    }
    // (4 + 5) maps x 3 accounts x 2 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(216);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} subscription worlds named a root tied to the note or refused wrongly`).toEqual([]);
  }, 60_000);

  it('after the one refetch, the tie rule reads the REFETCHED map, not the first one', async () => {
    // The first map and the refetched map end at different leaves. A rule that
    // read the FIRST map's top after the refetch (mutant TOPFIRST, verifier r2
    // of the continued run) passed every case above; its probe is
    // `scratchpad/web-run/logs2/verify-SPEND-1-r2/probe/refetchTop.probe.test.ts`.
    //   T1  the first map does not hold the note yet (the RPC listed up to 2),
    //       and the refetch ends exactly at it: R3, the note's own deposit
    //       root. Refused.
    //   T2  the first map ends past the note with listed inserts unread; the
    //       saved history is lost (a store that keeps nothing, as a failed
    //       IndexedDB load leaves it), and the refetch reaches a lagging node
    //       that lists only up to the note: R3 again. Refused.
    //   T3  the first map ends AT the note, and the refetch reads past it, to
    //       5, with nothing unread: R5 is where the RPC stands. Proved as read.
    // The walk REPORT is read from the refetch too (a rule that kept the first
    // walk's report passed every case above for the subscription):
    //   T4  the first map ends at the note with nothing unread; the refetch
    //       lists up to 7 but is served only up to 5, so its map ends at 5
    //       with listed inserts unread: R5 may be where this client last read.
    //       Refused.
    //   T5  the first walk left listed inserts unread (map to 4); the saved
    //       history is lost and the refetch reads a lagging node in full, to 5:
    //       R5 is where that RPC stands. Proved as read.
    // The subscription walks the history itself, and its builder refuses a
    // map without the note before any refetch, so it runs T2 to T5.
    expectADiscriminatingRing();
    echoingProver();
    const needles = v4RebuildNeedles();
    const forgetful: PoolHistoryStore = {
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
    };
    const worlds = [
      {
        t: 'T1 first map short of the note, the refetch ends at it',
        first: { listedUpTo: 2, servedUpTo: 7 }, then: { listedUpTo: 3, servedUpTo: 7 }, forget: false,
        routes: ['withdrawal, walked leaves', 'withdrawal, own walk'] as SpendRoute[],
        walkedTop: 2, walkedUnread: 0, proves: null,
      },
      {
        t: 'T2 first map past the note with inserts unread, history lost, the refetch ends at it',
        first: { listedUpTo: 7, servedUpTo: 5 }, then: { listedUpTo: 3, servedUpTo: 7 }, forget: true,
        routes: ALL_ROUTES, walkedTop: 5, walkedUnread: 2, proves: null,
      },
      {
        t: 'T3 first map ends at the note, the refetch reads past it',
        first: { listedUpTo: 3, servedUpTo: 7 }, then: { listedUpTo: 5, servedUpTo: 7 }, forget: false,
        routes: ALL_ROUTES, walkedTop: 3, walkedUnread: 0, proves: 5,
      },
      {
        t: 'T4 first map ends at the note, the refetch ends at 5 with inserts unread',
        first: { listedUpTo: 3, servedUpTo: 7 }, then: { listedUpTo: 7, servedUpTo: 5 }, forget: false,
        routes: ALL_ROUTES, walkedTop: 3, walkedUnread: 0, proves: null,
      },
      {
        t: 'T5 first map with inserts unread, history lost, the refetch reads a lagging node in full past the note',
        first: { listedUpTo: 7, servedUpTo: 4 }, then: { listedUpTo: 5, servedUpTo: 7 }, forget: true,
        routes: ALL_ROUTES, walkedTop: 4, walkedUnread: 3, proves: 5,
      },
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const w of worlds) {
      for (const route of w.routes) {
        for (const source of ['shielded', 'received'] as const) {
          for (const withProgress of [false, true]) {
            const label = `${w.t}, ${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
            vi.clearAllMocks();
            setPoolHistoryStore(w.forget ? forgetful : memoryPoolHistoryStore());
            const state = { ...w.first };
            const counters = newCounters();
            let walked: { leaves: Map<string, OnChainCommitment>; unread: number | undefined } | undefined;
            let conn: never;
            if (route === 'withdrawal, walked leaves') {
              // The handler's walk, then the RPC moves before the prepare runs.
              const walk = await walkAsTheHandlerDoes(historyRpc(state));
              expect(`${walk.top} / ${walk.unread}`, `${label}: the handler's walk`).toBe(`${w.walkedTop} / ${w.walkedUnread}`);
              walked = walk;
              Object.assign(state, w.then);
              conn = historyRpc(state, { counters });
            } else {
              // The prepare's own walk lists once; the RPC moves when the refetch lists.
              conn = historyRpc(state, { counters, beforeList: (n) => void (n >= 2 && Object.assign(state, w.then)) });
            }
            const outcome = await spendOutcome(
              spendOn(route, receipt(NOTE_A, source), conn, withProgress ? () => undefined : undefined, walked),
              needles,
            );
            got.push(`${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ${counters.signatures} listing(s)`);
            // The walk (own routes only) plus the one refetch.
            const listings = (route === 'withdrawal, walked leaves' ? 0 : 1) + 1;
            want.push(
              w.proves === null
                ? `${label} => refused: HistoryIncompleteError; 0 proof(s); ${listings} listing(s)`
                : `${label} => ${nameOf(rootAfter(w.proves))}; 1 proof(s); ${listings} listing(s)`,
            );
          }
        }
      }
    }
    // (2 + 4 + 4 + 4 + 4) routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(72);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} worlds read the wrong map after the refetch`).toEqual([]);
  }, 60_000);

  it('a root held back at the first map, whose refetch rebuilds a root the pool does not know, is refused and never sent to the C1 + C3 pair', async () => {
    // The history cache ends at k, the client's last read (right after its own
    // deposit or purchase). The newer inserts are listed and not served, so
    // the first map is held back. On the one refetch a 429 burst serves some
    // re-reads and not others: every leaf but k + 1. The refetched map has a
    // hole, and its root is one the pool never published. The only root that
    // places the note was held back, so this is an incomplete history, not a
    // note the rebuild cannot place. It must end in HistoryIncompleteError:
    // PRE-FLIGHT FAIL is a `V4_REBUILD_FAILURES` needle, and the handlers send
    // it to the C1 + C3 pair, which publishes the note's commitment.
    // In every case above whose first map was held back, the refetched map was
    // held back too. So a prepare that forgot the first hold-back passed them
    // all (mutants W_FIRSTPF and S_FIRSTPF, probe world PA,
    // `scratchpad/web-run/logs2/verify-SPEND-1-r3/probe/`). No saved path, so
    // the saved-root rule cannot decide in its place.
    expectADiscriminatingRing();
    echoingProver();
    const needles = v4RebuildNeedles();
    const got: string[] = [];
    const want: string[] = [];
    for (const k of [3, 4, 5]) {
      const hole = k + 1;
      // Anti-vacuity: the refetched map places the note, and folds to a root the pool does not know.
      const holedRoot = rootOf(LEAVES.map((l, i) => (i === hole ? 0n : l)));
      expect(holedRoot, `k=${k}: the holed map does not place the note`).not.toBeNull();
      expect(poolKnows(holedRoot), `k=${k}: the holed map folds to a root the pool knows`).toBe(false);
      for (const route of ALL_ROUTES) {
        for (const source of ['shielded', 'received'] as const) {
          for (const withProgress of [false, true]) {
            const label =
              `cache completed at ${k}, the refetch served every leaf but ${hole}, ${route}, ${source}, ` +
              `${withProgress ? 'with' : 'no'} callback`;
            vi.clearAllMocks();
            setPoolHistoryStore(memoryPoolHistoryStore());
            const state: { listedUpTo: number; servedUpTo: number; unservedLeaf?: number } = { listedUpTo: k, servedUpTo: k };
            const primed = await walkAsTheHandlerDoes(historyRpc(state));
            expect(primed.top, `${label}: the cache does not end at ${k}`).toBe(k);
            // Later: the newer inserts are listed, and their transactions are not served.
            state.listedUpTo = 7;
            const atTheRefetch = { servedUpTo: 7, unservedLeaf: hole };
            const counters = newCounters();
            let walked: { leaves: Map<string, OnChainCommitment>; unread: number | undefined } | undefined;
            let conn: never;
            if (route === 'withdrawal, walked leaves') {
              // The handler's walk, then the RPC serves more before the prepare's refetch.
              const walk = await walkAsTheHandlerDoes(historyRpc(state));
              expect(`${walk.top} / ${walk.unread}`, `${label}: the handler's walk`).toBe(`${k} / ${7 - k}`);
              walked = walk;
              Object.assign(state, atTheRefetch);
              conn = historyRpc(state, { counters });
            } else {
              // The prepare's own walk lists once; the RPC serves more when the refetch lists.
              conn = historyRpc(state, { counters, beforeList: (n) => void (n >= 2 && Object.assign(state, atTheRefetch)) });
            }
            const outcome = await spendOutcome(
              spendOn(route, receipt(NOTE_A, source), conn, withProgress ? () => undefined : undefined, walked),
              needles,
            );
            // Anti-vacuity: the refetch DID read, and the history it saved ends at 7 missing only `hole`.
            const { snapshot } = await loadPoolHistory(
              getPoolHistoryStore(), 'https://devnet.helius-rpc.com/?api-key=NOT-A-REAL-KEY', POOL.poolPDA.toBase58(),
            );
            const held = new Set((snapshot?.entries ?? []).map((e) => e.leafIndex));
            const missing = LEAVES.map((_, i) => i).filter((i) => !held.has(i));
            got.push(
              `${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ` +
                `${counters.signatures} listing(s); history then missing [${missing.join(',')}]`,
            );
            // The walk (own routes only) plus the one refetch.
            const listings = (route === 'withdrawal, walked leaves' ? 0 : 1) + 1;
            want.push(
              `${label} => refused: HistoryIncompleteError; 0 proof(s); ${listings} listing(s); history then missing [${hole}]`,
            );
          }
        }
      }
    }
    // 3 cache ends x 4 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(48);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} worlds did not refuse cleanly`).toEqual([]);
  }, 60_000);

  it('the circuit-7 SUBSCRIPTION applies the saved-root tie as the withdrawal does (m == k)', async () => {
    // The two prepares must stay identical in behaviour (`prepareSubscribeV4`'s
    // doc comment). The withdrawal holds back a map whose root IS the root
    // saved with the note, reached through the leaves ("a map that ends where
    // the note's saved root was taken is never proved (m == k)"). Example: a
    // received note whose issuance-time path folds to R5, the purchase root,
    // and a map that ends at 5 because the RPC has not listed anything newer
    // yet, so nothing is unread. The subscription was never handed the saved
    // path, so it proved R5 there (probe world PC,
    // `scratchpad/web-run/logs2/verify-SPEND-1-r3/probe/NONE.log`).
    // `handlePoolSubscribePrepare` now hands the stored path down through
    // `prepareSubscribeJobV4` (`poolHandlersUnshieldV4.test.ts`, "hands the
    // circuit-7 SUBSCRIPTION prepare the saved witness it read from the stored
    // blob"). The subscription reads only its root, as one more tie; it never
    // proves the path.
    // The worlds mirror the withdrawal's m == k case: map to k (3..6), lag,
    // saved R_k or none, account readable or absent, both subscription routes,
    // both sources, callback or none.
    expectADiscriminatingRing();
    echoingProver();
    const needles = v4RebuildNeedles();
    const lags = [
      { kind: 'newer inserts not listed yet', state: (k: number) => ({ listedUpTo: k, servedUpTo: 7 }), unread: (_k: number) => 0 },
      { kind: 'newer inserts listed, not served', state: (k: number) => ({ listedUpTo: 7, servedUpTo: k }), unread: (k: number) => 7 - k },
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const k of RING_KS) {
      // Anti-vacuity: the saved root is the root of the map to k.
      expect(BigInt(savedAfter(k).root)).toBe(rootAfter(k));
      for (const lag of lags) {
        for (const withSaved of [true, false]) {
          for (const account of [RING_ACCOUNT, null]) {
            for (const route of ['subscription prepare', 'subscription job'] as const) {
              for (const source of ['shielded', 'received'] as const) {
                for (const withProgress of [false, true]) {
                  const label =
                    `map to ${k}, ${lag.kind}, ${withSaved ? `saved R${k}` : 'no saved path'}, ` +
                    `account ${accountName(account)}, ${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
                  vi.clearAllMocks();
                  setPoolHistoryStore(memoryPoolHistoryStore());
                  const counters = newCounters();
                  const outcome = await spendOutcome(
                    spendOn(
                      route, receipt(NOTE_A, source), historyRpc(lag.state(k), { account, counters }),
                      withProgress ? () => undefined : undefined, undefined, withSaved ? savedAfter(k) : undefined,
                    ),
                    needles,
                  );
                  got.push(`${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ${counters.signatures} listing(s)`);
                  const tied = withSaved || lag.unread(k) !== 0 || k === NOTE_A;
                  want.push(
                    tied
                      // The walk, plus the refetch when there is an account to pre-flight against.
                      ? `${label} => refused: HistoryIncompleteError; 0 proof(s); ${account ? 2 : 1} listing(s)`
                      : `${label} => ${nameOf(rootAfter(k))}; 1 proof(s); 1 listing(s)`,
                  );
                }
              }
            }
          }
        }
      }
    }
    // 4 maps x 2 lags x 2 saved-path choices x 2 accounts x 2 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(256);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} subscription worlds named the saved root or refused wrongly`).toEqual([]);
  }, 60_000);

  it('a note that is the newest leaf is proved on a map at the current root, by the withdrawal and the subscription', async () => {
    // The tie rule exempts the CURRENT root. A note deposited last and spent
    // before anything newer lands sits at the top of a map whose root is the
    // pool's current one; every spend made now names that root, whichever note
    // it spends. Refusing it would fail every quick spend. Both prepares prove
    // it with no refetch.
    echoingProver();
    const needles = v4RebuildNeedles();
    const current = rootAfter(NOTE_A);
    const account = poolAccount(current, [], NOTE_A + 1);
    const got: string[] = [];
    const want: string[] = [];
    for (const route of ALL_ROUTES) {
      for (const source of ['shielded', 'received'] as const) {
        for (const withProgress of [false, true]) {
          const label = `${route}, ${source}, ${withProgress ? 'with' : 'no'} callback`;
          vi.clearAllMocks();
          setPoolHistoryStore(memoryPoolHistoryStore());
          const state = { listedUpTo: NOTE_A, servedUpTo: NOTE_A };
          const walked = route === 'withdrawal, walked leaves'
            ? await walkAsTheHandlerDoes(historyRpc(state, { account }))
            : undefined;
          const counters = newCounters();
          const outcome = await spendOutcome(
            spendOn(route, receipt(NOTE_A, source), historyRpc(state, { account, counters }), withProgress ? () => undefined : undefined, walked),
            needles,
          );
          got.push(`${label} => ${outcome}; ${h.generateSpendProof.mock.calls.length} proof(s); ${counters.signatures} listing(s)`);
          want.push(`${label} => ${nameOf(current)}; 1 proof(s); ${route === 'withdrawal, walked leaves' ? 0 : 1} listing(s)`);
        }
      }
    }
    expect(want).toHaveLength(16);
    expect(got).toEqual(want);
  });

  it('a note that no leaf map read places is refused with HistoryIncompleteError, never with a v3 needle', async () => {
    // The note's own insert is listed and its transaction is not served (a 429
    // on that read), or it is not listed yet, so neither the first map nor the
    // one refetch holds the note. The pool account is readable, nothing was
    // held back, and no saved root decides. The withdrawal ended there in
    // PRE-FLIGHT FAIL, a `V4_REBUILD_FAILURES` needle the handlers answered
    // with the C1 + C3 pair, which publishes the commitment, and whose own
    // walk (a third read) can place the note. HEAD rethrew the builder's
    // error here, which carries no needle (verifier r4 of the continued run,
    // probe worlds B1 to B3, `scratchpad/web-run/logs2/verify-SPEND-1-r4/probe/`).
    // The history is incomplete; the pool refused no root. So every such world
    // ends in HistoryIncompleteError, whatever the saved path says, except a
    // saved path that folds to the pool's CURRENT root: it dates nothing and
    // is proved (step 3). With no readable account there is no pre-flight and
    // the builder's own error is rethrown, as before. The two subscription
    // routes read the same history and refuse at their builder; no route may
    // end in a needle, and nothing is proved.
    expectADiscriminatingRing();
    echoingProver();
    const needles = v4RebuildNeedles();
    // Anti-vacuity: the needle this case is about is one the handlers route on.
    expect(needles).toContain('PRE-FLIGHT FAIL');
    const geometries = [
      {
        kind: 'the note\'s insert listed, its transaction never served',
        state: () => ({ listedUpTo: 7, servedUpTo: 7, unservedLeaf: NOTE_A as number | undefined }),
        servedFromListing: Number.POSITIVE_INFINITY,
        walkUnread: 1,
      },
      {
        kind: 'the note not listed yet',
        state: () => ({ listedUpTo: NOTE_A - 1, servedUpTo: 7, unservedLeaf: undefined as number | undefined }),
        servedFromListing: Number.POSITIVE_INFINITY,
        walkUnread: 0,
      },
      {
        // What the C1 + C3 prepare's own walk would read after the two reads above.
        kind: 'the note\'s insert served from the third listing on',
        state: () => ({ listedUpTo: 7, servedUpTo: 7, unservedLeaf: NOTE_A as number | undefined }),
        servedFromListing: 3,
        walkUnread: 1,
      },
    ];
    type Geometry = (typeof geometries)[number];
    /** One world's RPC state, and a listing counter shared by every connection of that world. */
    const worldOf = (g: Geometry) => {
      const state = g.state();
      let listed = 0;
      const beforeList = () => {
        listed += 1;
        if (listed >= g.servedFromListing) state.unservedLeaf = undefined;
      };
      return { state, beforeList };
    };
    // Anti-vacuity: the third listing of the last geometry places the note, the first two do not.
    {
      setPoolHistoryStore(memoryPoolHistoryStore());
      const { state, beforeList } = worldOf(geometries[2]);
      const reads: boolean[] = [];
      for (let n = 0; n < 3; n += 1) {
        const r = await fetchPoolLeavesByIndex(historyRpc(state, { beforeList }), POOL.poolPDA);
        reads.push(r.leavesByIndex[NOTE_A] === LEAVES[NOTE_A]);
      }
      expect(reads, 'a third walk on the same store does not place the note').toEqual([false, false, true]);
    }
    const unknownSaved = { ...savedAfter(NOTE_A), root: '123456789' };
    expect(poolKnows(BigInt(unknownSaved.root))).toBe(false);
    expect(BigInt(savedAfter(7).root)).toBe(R_CUR);
    const saves = [
      { kind: 'no saved path', saved: undefined, current: false },
      { kind: 'a saved root the pool does not know', saved: unknownSaved, current: false },
      { kind: 'saved R3 (the note\'s own deposit, in the ring)', saved: savedAfter(NOTE_A), current: false },
      { kind: 'a saved root that is the current one', saved: savedAfter(7), current: true },
    ];
    const got: string[] = [];
    const want: string[] = [];
    const reports: string[] = [];
    const wantReports: string[] = [];
    for (const g of geometries) {
      for (const account of [RING_ACCOUNT, null, UNPARSABLE_RING_ACCOUNT]) {
        for (const s of saves) {
          for (const route of ALL_ROUTES) {
            for (const source of ['shielded', 'received'] as const) {
              for (const withProgress of [false, true]) {
                const label =
                  `${g.kind}, account ${accountName(account)}, ${s.kind}, ${route}, ${source}, ` +
                  `${withProgress ? 'with' : 'no'} callback`;
                vi.clearAllMocks();
                setPoolHistoryStore(memoryPoolHistoryStore());
                const { state, beforeList } = worldOf(g);
                let walked: { leaves: Map<string, OnChainCommitment>; unread: number | undefined } | undefined;
                if (route === 'withdrawal, walked leaves') {
                  // The handler's walk, on the same RPC and the same history store.
                  const walk = await walkAsTheHandlerDoes(historyRpc(state, { account, beforeList }));
                  expect([...walk.leaves.values()].some((e) => e.leafIndex === NOTE_A), `${label}: the handler's walk holds the note`).toBe(false);
                  reports.push(`${label}: ${walk.unread}`);
                  wantReports.push(`${label}: ${g.walkUnread}`);
                  walked = walk;
                }
                const counters = newCounters();
                const outcome = await spendOutcome(
                  spendOn(
                    route, receipt(NOTE_A, source), historyRpc(state, { account, counters, beforeList }),
                    withProgress ? () => undefined : undefined, walked, s.saved,
                  ),
                  needles,
                );
                const proofs = h.generateSpendProof.mock.calls.length;
                if (route === 'subscription prepare' || route === 'subscription job') {
                  // The subscription builds before any refetch and never proves a saved path.
                  const clean = outcome.startsWith('refused: ') && !outcome.includes('needle');
                  got.push(`${label} => ${clean ? 'refused with no v3 needle' : outcome}; ${proofs} proof(s)`);
                  want.push(`${label} => refused with no v3 needle; 0 proof(s)`);
                  continue;
                }
                got.push(`${label} => ${outcome}; ${proofs} proof(s); ${counters.signatures} listing(s)`);
                // The prepare's own walk, plus the one refetch when there is an account to pre-flight against.
                const walks = (route === 'withdrawal, own walk' ? 1 : 0) + (account === RING_ACCOUNT ? 1 : 0);
                want.push(
                  account !== RING_ACCOUNT
                    // No pre-flight: the builder's own error, rethrown as HEAD did.
                    ? `${label} => refused: Error; 0 proof(s); ${walks} listing(s)`
                    : s.current
                      ? `${label} => R_CUR; 1 proof(s); ${walks} listing(s)`
                      : `${label} => refused: HistoryIncompleteError; 0 proof(s); ${walks} listing(s)`,
                );
              }
            }
          }
        }
      }
    }
    // 3 geometries x 3 accounts x 4 saved-path choices x 4 routes x 2 sources x 2 callbacks.
    expect(want).toHaveLength(576);
    const wrong = got.flatMap((g, i) => (g === want[i] ? [] : [`${g}   <-- due: ${want[i].split(' => ')[1]}`]));
    expect(wrong, `${wrong.length} of ${want.length} worlds of a note in no map proved it or refused wrongly`).toEqual([]);
    // What the handler's walk reported: the note's listed insert unread, or nothing listed to read.
    expect(reports).toEqual(wantReports);
  }, 60_000);
});

describe('the 255-root ring the program keeps', () => {
  /**
   * `DenominatedPoolV3::MAX_HISTORICAL_ROOTS` is 255 (pool_v3.rs); pools created
   * before the capacity migration keep 100. A client that gives up above 100
   * parses NO ring at all on a migrated pool — and a pre-flight that can see no
   * ring is a pre-flight that cannot tell a fresh root from a stale one, which
   * is the condition under which the saved root gets named.
   */
  it('255-root ring parses', () => {
    const at150 = parsePoolV3Account(poolAccount(R_CUR, ringOf(150)));
    expect(at150, 'a 150-root ring made the parser give up').not.toBeNull();
    expect(at150?.historicalRoots).toHaveLength(150);
    expect(at150?.nextLeafIndex).toBe(BigInt(LEAVES.length));

    const at255 = parsePoolV3Account(poolAccount(R_CUR, ringOf(255)));
    expect(at255?.historicalRoots).toHaveLength(255);

    // The bound is still a bound: a length the program cannot hold is refused
    // rather than trusted, so a malformed account cannot make the client read
    // 2 GB of "ring".
    expect(parsePoolV3Account(poolAccount(R_CUR, ringOf(256)))).toBeNull();
  });

  it('the stored-path root check sees a 150-entry ring', () => {
    // The v3 twin has its own copy of this parser
    // (`unshieldFromPath.ts:isRootAccepted`), and a bound that disagrees with
    // the one above would make the two paths accept different roots.
    const ring = ringOf(150);
    const conn = {
      getAccountInfo: async () => ({ data: poolAccount(R_CUR, ring) }),
    } as never;
    // Pinned from above as well, like the parser's 255 and 256 cases: a full
    // 255-root ring is read to its last entry, and a 256-entry ring is more
    // than the program keeps, so it is refused even when it holds the root.
    // Control: mutant N7 (bound loosened to 100000),
    // `scratchpad/web-run/logs/SPEND-1-web-fix1/`.
    const ring255 = ringOf(255);
    const conn255 = { getAccountInfo: async () => ({ data: poolAccount(R_CUR, ring255) }) } as never;
    const ring256 = ringOf(256);
    const conn256 = { getAccountInfo: async () => ({ data: poolAccount(R_CUR, ring256) }) } as never;

    return Promise.all([
      expect(isRootAccepted(conn, POOL, ring[149]!)).resolves.toBe(true),
      expect(isRootAccepted(conn, POOL, R_CUR)).resolves.toBe(true),
      expect(isRootAccepted(conn, POOL, 123_456_789n)).resolves.toBe(false),
      expect(isRootAccepted(conn255, POOL, ring255[254]!)).resolves.toBe(true),
      expect(isRootAccepted(conn256, POOL, ring256[0]!)).resolves.toBe(false),
      expect(isRootAccepted(conn256, POOL, ring256[255]!)).resolves.toBe(false),
    ]);
  });
});
