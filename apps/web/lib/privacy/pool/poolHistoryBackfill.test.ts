/**
 * [HIST-1] The pool-history walk is COMPLETED, never frozen.
 *
 * Three defects this file pins. All three were re-read in `denominatedPool.ts`
 * on 2026-09-16, at today's line numbers, before a line was changed:
 *
 * 1. `maxSignatures` caps the walk at 1,000 signatures (2031) and the saved
 *    `newestSignature` is the newest signature of that same walk (2138), so
 *    every later call asks the RPC `until` that one and the older tail is
 *    never read again. The 1 SOL pool carries 193 signatures today
 *    (`scratchpad/probe-stale-root-2026-09-15.log`), so the truncation is
 *    latent, not live — and a griefer who pads the pool's signature list
 *    decides when it stops being latent.
 * 2. A `getTransaction` that rejects becomes `null` (2076), is skipped for
 *    want of logs (2083), and `newestSignature` advances regardless: that
 *    leaf is lost for good, on every client that shares the snapshot.
 * 3. Nothing records that a signature was never read, so a lost leaf is also
 *    an invisible one.
 *
 * Why this is an opacity defect and not only an uptime one: a treasury leaf
 * the issuer cannot see is a leaf it will not hand out, so the crowd a buyer's
 * note hides in shrinks silently, and `/api/issue-note` answers `notOurs` for
 * a note that is ours (map-A defect 4). The leaves in this file are synthetic.
 *
 * The fake here is a chain, not a mocked decoder: real `LeafInserted` event
 * bytes, `getSignaturesForAddress` paging with `before` and `until` exclusive
 * on both sides the way the RPC pages them, and a pool account that
 * `parsePoolV3Account` really parses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fetchPoolCommitments } from './denominatedPool';
import { poolHistoryKey, setPoolHistoryStore, type PoolHistoryStore } from './poolHistoryCache';

const POOL = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;

/** The V3 `LeafInserted` layout the walk decodes: disc | pool | idx@40 | commitment@48. */
function leafInsertedEvent(leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(sha256(new TextEncoder().encode('event:LeafInserted')).subarray(0, 8), 0);
  data.set(POOL.toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, BigInt(leafIndex), true);
  let c = commitment;
  for (let i = 0; i < 32; i++) {
    data[48 + i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return Buffer.from(data).toString('base64');
}

type FailureKind = 'reject' | 'null' | 'nologs';

interface FakeTx {
  signature: string;
  slot: number;
  leafIndex: number;
  commitment: bigint;
  /** Non-null for a transaction the chain rejected: it carries no leaf, ever. */
  err: unknown;
}

/**
 * Newest-first history, paged the way `getSignaturesForAddress` pages it, plus
 * the pool account the walk reads to learn `next_leaf_index`.
 */
class FakeChain {
  txs: FakeTx[] = [];
  getTransactionCalls = 0;
  getAccountInfoCalls = 0;
  fetched: string[] = [];
  signatureCalls: Array<{ before?: string; until?: string; limit?: number }> = [];
  /** signature -> how many more times this read fails, and how. */
  failures = new Map<string, { kind: FailureKind; remaining: number }>();
  rpcEndpoint = 'https://fake.rpc/';

  /** Set to make the pool account claim more leaves than the history lists. */
  nextLeafIndexOverride: number | null = null;
  private serial = 0;

  push(leafIndex: number, commitment: bigint, err: unknown = null): string {
    let signature = `sig_${leafIndex}_${commitment.toString(16)}`;
    // Padding transactions repeat the same (leaf, commitment); a real chain
    // never repeats a signature, so neither does this one.
    if (this.txs.some((t) => t.signature === signature)) signature += `_${(this.serial += 1)}`;
    this.txs.unshift({ signature, slot: 1000 + leafIndex, leafIndex, commitment, err });
    return signature;
  }

  /** What the pool account says: the tree holds leaves 0..nextLeafIndex-1. */
  get nextLeafIndex(): number {
    return this.nextLeafIndexOverride ?? this.txs.filter((t) => !t.err).length;
  }

  async getSignaturesForAddress(
    _pk: PublicKey,
    opts: { before?: string; until?: string; limit?: number } = {},
  ) {
    this.signatureCalls.push({ ...opts });
    let list = this.txs;
    if (opts.before) {
      const i = list.findIndex((t) => t.signature === opts.before);
      list = i >= 0 ? list.slice(i + 1) : list;
    }
    if (opts.until) {
      const i = list.findIndex((t) => t.signature === opts.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, opts.limit ?? 1000).map((t) => ({ signature: t.signature, err: t.err }));
  }

  async getTransaction(signature: string, _opts?: unknown) {
    this.getTransactionCalls++;
    this.fetched.push(signature);
    const plan = this.failures.get(signature);
    if (plan && plan.remaining > 0) {
      plan.remaining -= 1;
      if (plan.kind === 'reject') throw new Error('RPC 429 (fake)');
      if (plan.kind === 'null') return null;
      // 'nologs': a transaction the RPC served without its log messages.
      return { slot: 1, meta: {}, transaction: { message: { accountKeys: [PAYER] } } };
    }
    const t = this.txs.find((x) => x.signature === signature);
    if (!t) return null;
    return {
      slot: t.slot,
      // A failed transaction keeps its logs on a real chain, including any
      // event emitted before the instruction that failed; only `err` says the
      // insert was rolled back.
      meta: { err: t.err ?? null, logMessages: [`Program data: ${leafInsertedEvent(t.leafIndex, t.commitment)}`] },
      transaction: { message: { accountKeys: [PAYER] } },
    };
  }

  /** A pool account `parsePoolV3Account` parses: next_leaf_index at 121, 0 historical roots. */
  async getAccountInfo(_pk: PublicKey, _commitment?: unknown) {
    this.getAccountInfoCalls++;
    const d = new Uint8Array(182);
    new DataView(d.buffer).setBigUint64(121, BigInt(this.nextLeafIndex), true);
    d[120] = 15;
    d[177] = 1;
    return { data: Buffer.from(d) };
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

/**
 * A store whose rows the test can read. `unknown` on purpose: the same literal
 * has to compile against the snapshot shape before AND after this work package
 * changes it, so the test never has to be migrated between its red and green.
 */
function recordingStore() {
  const rows = new Map<string, unknown>();
  const store = {
    async load(key: string) {
      return rows.get(key) ?? null;
    },
    async save(snapshot: { key: string }) {
      rows.set(snapshot.key, snapshot);
    },
    async clear(key: string) {
      rows.delete(key);
    },
  } as unknown as PoolHistoryStore;
  return { rows, store };
}

/** The saved snapshot, read by the fields this work package adds. */
interface SnapshotShape {
  newestSignature?: string | null;
  oldestSignature?: string | null;
  reachedOldest?: boolean;
  complete?: boolean;
  retry?: Array<{ signature: string; attempts: number }>;
  dropped?: number;
  entries?: unknown[];
}

describe('[HIST-1] the pool-history walk is completed, not frozen', () => {
  let rows: Map<string, unknown>;

  beforeEach(() => {
    const s = recordingStore();
    rows = s.rows;
    setPoolHistoryStore(s.store);
  });

  const snapshotOf = (h: FakeChain): SnapshotShape | null =>
    (rows.get(poolHistoryKey(h.rpcEndpoint, POOL.toBase58())) as SnapshotShape | undefined) ?? null;

  it('a truncated walk is backfilled', async () => {
    const h = new FakeChain();
    for (let i = 0; i < 1500; i++) h.push(i, 10_000n + BigInt(i));

    // Call 1 spends the whole budget on the newest 1,000 signatures.
    const firstWalk = await fetchPoolCommitments(h.asConnection(), POOL, { maxSignatures: 1000 });
    expect(firstWalk.size).toBe(1000);
    expect(firstWalk.has('10000')).toBe(false); // leaf 0 is beyond the cap

    // Call 2 must spend its budget on what call 1 could not reach.
    const secondWalk = await fetchPoolCommitments(h.asConnection(), POOL, { maxSignatures: 1000 });
    expect(secondWalk.size).toBe(1500);
    expect(secondWalk.get('10000')?.leafIndex).toBe(0);
    expect(secondWalk.get('11499')?.leafIndex).toBe(1499);

    // And call 3 is quiet: the history is whole, so nothing is re-read.
    h.getTransactionCalls = 0;
    const thirdWalk = await fetchPoolCommitments(h.asConnection(), POOL, { maxSignatures: 1000 });
    expect(thirdWalk.size).toBe(1500);
    expect(h.getTransactionCalls).toBe(0);
    expect(snapshotOf(h)?.complete).toBe(true);
  });

  it('a rejected or null getTransaction is retried', async () => {
    const h = new FakeChain();
    for (let i = 0; i < 12; i++) h.push(i, 20_000n + BigInt(i));
    const rejected = `sig_3_${(20_003n).toString(16)}`;
    const nulled = `sig_7_${(20_007n).toString(16)}`;
    const logless = `sig_9_${(20_009n).toString(16)}`;
    h.failures.set(rejected, { kind: 'reject', remaining: 1 });
    h.failures.set(nulled, { kind: 'null', remaining: 1 });
    h.failures.set(logless, { kind: 'nologs', remaining: 1 });

    const firstWalk = await fetchPoolCommitments(h.asConnection(), POOL);
    // The three unread leaves are missing from the first answer in every
    // version of this code; what changes is whether they ever come back.
    expect(firstWalk.has('20003')).toBe(false);
    expect(firstWalk.has('20007')).toBe(false);
    expect(firstWalk.has('20009')).toBe(false);
    expect(firstWalk.size).toBe(9);

    const secondWalk = await fetchPoolCommitments(h.asConnection(), POOL);
    expect(secondWalk.get('20003')?.leafIndex).toBe(3);
    expect(secondWalk.get('20007')?.leafIndex).toBe(7);
    expect(secondWalk.get('20009')?.leafIndex).toBe(9);
    expect(secondWalk.size).toBe(12);

    const snap = snapshotOf(h);
    expect(snap?.retry).toEqual([]);
    expect(snap?.dropped).toBe(0);
    expect(snap?.complete).toBe(true);
  });

  it('a signature that never reads is dropped after 5 attempts, and counted', async () => {
    const h = new FakeChain();
    for (let i = 0; i < 6; i++) h.push(i, 30_000n + BigInt(i));
    const broken = `sig_2_${(30_002n).toString(16)}`;
    h.failures.set(broken, { kind: 'reject', remaining: 99 });

    // Attempt 1 is the initial read; attempts 2..5 are retries.
    for (let call = 1; call <= 4; call += 1) {
      await fetchPoolCommitments(h.asConnection(), POOL);
      const snap = snapshotOf(h);
      expect(snap?.retry).toEqual([{ signature: broken, attempts: call }]);
      expect(snap?.dropped).toBe(0);
    }

    await fetchPoolCommitments(h.asConnection(), POOL); // attempt 5
    const snap = snapshotOf(h);
    expect(snap?.retry).toEqual([]);
    expect(snap?.dropped).toBe(1);

    // Dropped means dropped: the sixth call does not ask for it again.
    h.fetched = [];
    await fetchPoolCommitments(h.asConnection(), POOL);
    expect(h.fetched).not.toContain(broken);
  });

  it('a transaction the chain rejected is not retried, an identical one that succeeded is', async () => {
    // The only difference between the two signatures is `err`. Without that
    // rule a griefer pads the pool with failing transactions and every later
    // walk re-reads all of them for ever.
    const h = new FakeChain();
    for (let i = 0; i < 4; i++) h.push(i, 40_000n + BigInt(i));
    const failedOnChain = h.push(4, 40_004n, { InstructionError: [0, 'Custom'] });
    const succeeded = h.push(5, 40_005n);
    h.failures.set(failedOnChain, { kind: 'null', remaining: 99 });
    h.failures.set(succeeded, { kind: 'null', remaining: 1 });

    await fetchPoolCommitments(h.asConnection(), POOL);
    expect(snapshotOf(h)?.retry).toEqual([{ signature: succeeded, attempts: 1 }]);

    h.fetched = [];
    const secondWalk = await fetchPoolCommitments(h.asConnection(), POOL);
    expect(h.fetched).toEqual([succeeded]);
    expect(secondWalk.get('40005')?.leafIndex).toBe(5);
    expect(snapshotOf(h)?.retry).toEqual([]);
  });

  it('the upgrade path: a snapshot saved by the old walk is completed, then goes quiet', async () => {
    // What a client upgrading to this code actually holds: a snapshot the old
    // walk wrote, with no oldest signature and no completeness, stopped at its
    // 1,000-signature cap. The cost of finishing it is paid once.
    const h = new FakeChain();
    for (let i = 0; i < 1500; i++) h.push(i, 50_000n + BigInt(i));
    const walked = h.txs.slice(0, 1000);
    rows.set(poolHistoryKey(h.rpcEndpoint, POOL.toBase58()), {
      version: 1,
      key: poolHistoryKey(h.rpcEndpoint, POOL.toBase58()),
      newestSignature: walked[0]!.signature,
      entries: walked.map((t) => ({
        commitment: t.commitment.toString(),
        leafIndex: t.leafIndex,
        depositPayer: PAYER.toBase58(),
        depositSlot: t.slot,
        signature: t.signature,
      })),
      savedAt: 1_700_000_000_000,
    });

    const upgraded = await fetchPoolCommitments(h.asConnection(), POOL, { maxSignatures: 1000 });
    expect(upgraded.size).toBe(1500);
    expect(upgraded.get('50000')?.leafIndex).toBe(0);

    // Then it stops costing anything: no transaction re-read, and exactly one
    // signature page (the delta) — no backfill page once the history is whole.
    h.getTransactionCalls = 0;
    h.signatureCalls = [];
    const warm = await fetchPoolCommitments(h.asConnection(), POOL, { maxSignatures: 1000 });
    expect(warm.size).toBe(1500);
    expect(h.getTransactionCalls).toBe(0);
    expect(h.signatureCalls).toHaveLength(1);
    expect(h.signatureCalls[0]?.until).toBe(h.txs[0]!.signature);
  });

  // ── Fix round 1 (2026-09-16). The adversary the plan names is a griefer who
  // pads the pool's signature list, so the budget can run out in the MIDDLE of
  // the history, between two warm calls, not only at its tail. Each case below
  // was first run against the round-0 walk, where it failed on an assertion
  // (`scratchpad/wp-logs/HIST-1-red.log`, fix round 1).

  /** Runs `n` calls and records, per call, the map size and what it cost. */
  async function walk(h: FakeChain, n: number) {
    const out: Array<{ size: number; pages: number; txs: number; map: Map<string, { leafIndex: number }> }> = [];
    for (let call = 0; call < n; call += 1) {
      h.signatureCalls = [];
      h.getTransactionCalls = 0;
      const map = await fetchPoolCommitments(h.asConnection(), POOL);
      out.push({ size: map.size, pages: h.signatureCalls.length, txs: h.getTransactionCalls, map });
    }
    return out;
  }

  it('growth past maxSignatures between two warm calls is completed, in a bounded number of pages', async () => {
    const h = new FakeChain();
    for (let i = 0; i < 100; i++) h.push(i, 60_000n + BigInt(i));
    expect((await fetchPoolCommitments(h.asConnection(), POOL)).size).toBe(100);
    // 1,200 new signatures before the next call: more than one call's budget.
    for (let i = 100; i < 1300; i++) h.push(i, 60_000n + BigInt(i));

    const calls = await walk(h, 3);
    expect(calls.map((c) => c.size)).toEqual([1100, 1300, 1300]);
    expect(calls[1]!.map.get('60100')).toBeDefined(); // the oldest of the 1,200
    expect(snapshotOf(h)?.complete).toBe(true);
    // Call 1: the delta page. Call 2: an empty delta + the one page of the gap
    // call 1 left. Call 3: quiet.
    expect(calls.map((c) => c.pages)).toEqual([1, 2, 1]);
    expect(calls.map((c) => c.txs)).toEqual([1000, 200, 0]);
  });

  it("a gap wider than one call's budget is paged across calls, never restarted", async () => {
    // Added after the fix-round-1 red, because mutant M9 (a gap whose cursor
    // never advances) survived every case above: each of their gaps closed in
    // one page. Killed by M1, M9 and M10 (`scratchpad/wp-logs/HIST-1-fix1-mutants.log`).
    const h = new FakeChain();
    for (let i = 0; i < 100; i++) h.push(i, 140_000n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);
    for (let i = 100; i < 3600; i++) h.push(i, 140_000n + BigInt(i));

    const calls = await walk(h, 5);
    expect(calls.map((c) => c.size)).toEqual([1100, 2100, 3100, 3600, 3600]);
    expect(calls.map((c) => c.pages)).toEqual([1, 2, 2, 2, 1]);
    expect(snapshotOf(h)?.complete).toBe(true);
  });

  it('sustained growth past the budget merges gaps past the cap and still loses nothing', async () => {
    // A tiny budget so every call overflows: one new gap per call, none paged,
    // until the cap merges the oldest two. Added after the fix-round-1 red;
    // killed by M11 and M12 (`scratchpad/wp-logs/HIST-1-fix1-mutants.log`).
    const h = new FakeChain();
    const opts = { maxSignatures: 10 };
    let leaf = 0;
    for (; leaf < 5; leaf++) h.push(leaf, 150_000n + BigInt(leaf));
    await fetchPoolCommitments(h.asConnection(), POOL, opts);
    const gapCounts: number[] = [];
    for (let round = 0; round < 20; round++) {
      for (let k = 0; k < 11; k++, leaf++) h.push(leaf, 150_000n + BigInt(leaf));
      await fetchPoolCommitments(h.asConnection(), POOL, opts);
      gapCounts.push(((rows.get(poolHistoryKey(h.rpcEndpoint, POOL.toBase58())) as { gaps?: unknown[] }).gaps ?? []).length);
    }
    expect(Math.max(...gapCounts)).toBe(16);
    let last = new Map<string, unknown>();
    for (let drain = 0; drain < 60 && snapshotOf(h)?.complete !== true; drain++) {
      last = await fetchPoolCommitments(h.asConnection(), POOL, opts);
    }
    expect(last.size).toBe(225);
    expect(snapshotOf(h)?.complete).toBe(true);
    // Completed by the gaps themselves: a merge that lost a stretch would only
    // be repaired by the re-walk safety net, which would set `rewalkAt`.
    expect((rows.get(poolHistoryKey(h.rpcEndpoint, POOL.toBase58())) as { rewalkAt?: unknown }).rewalkAt).toBeNull();
  });

  it("a griefer's failing padding above a real deposit does not hide the deposit", async () => {
    const h = new FakeChain();
    for (let i = 0; i < 100; i++) h.push(i, 70_000n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);
    h.push(100, 70_100n); // the victim's deposit, leaf 100
    // 1,000 failing transactions on top. Each keeps a LeafInserted event in its
    // logs, claiming the next free index, the way a transaction whose later
    // instruction fails does on a real chain.
    for (let k = 0; k < 1000; k++) h.push(101, 71_000n + BigInt(k), { InstructionError: [1, 'Custom'] });

    const calls = await walk(h, 3);
    expect(calls[2]!.map.get('70100')?.leafIndex).toBe(100);
    expect(calls[2]!.map.has('71000')).toBe(false); // a rolled-back insert is not a leaf
    expect(calls[2]!.size).toBe(101);
    expect(snapshotOf(h)?.complete).toBe(true);
    // The padding is listed, never fetched: it costs pages, not transactions.
    expect(calls.map((c) => c.pages)).toEqual([1, 2, 1]);
    expect(calls.map((c) => c.txs)).toEqual([0, 1, 0]);
  });

  it('a truncated cold walk and a later delta past the budget are both completed', async () => {
    const h = new FakeChain();
    for (let i = 0; i < 1500; i++) h.push(i, 80_000n + BigInt(i));
    expect((await fetchPoolCommitments(h.asConnection(), POOL)).size).toBe(1000);
    for (let i = 1500; i < 2600; i++) h.push(i, 80_000n + BigInt(i));

    const calls = await walk(h, 3);
    expect(calls.map((c) => c.size)).toEqual([2000, 2600, 2600]);
    expect(snapshotOf(h)?.complete).toBe(true);
    // Call 2: empty delta + the 100-signature gap + the 500-signature tail.
    expect(calls.map((c) => c.pages)).toEqual([1, 3, 1]);
  });

  it('a failed transaction that emitted a leaf event is not a leaf', async () => {
    const h = new FakeChain();
    for (let i = 0; i < 4; i++) h.push(i, 90_000n + BigInt(i));
    h.push(4, 90_004n, { InstructionError: [1, 'Custom'] });
    const m = await fetchPoolCommitments(h.asConnection(), POOL);
    expect(m.has('90004')).toBe(false);
    expect(m.size).toBe(4);
  });

  it('a contiguous legacy row costs one signature page and no transaction on the upgrade call', async () => {
    const h = new FakeChain();
    for (let i = 0; i < 50; i++) h.push(i, 100_000n + BigInt(i));
    const legacyKey = `${h.rpcEndpoint}|${POOL.toBase58()}`;
    rows.set(legacyKey, {
      version: 1,
      key: legacyKey,
      newestSignature: h.txs[0]!.signature,
      entries: h.txs.map((t) => ({
        commitment: t.commitment.toString(),
        leafIndex: t.leafIndex,
        depositPayer: PAYER.toBase58(),
        depositSlot: t.slot,
        signature: t.signature,
      })),
      savedAt: 1_700_000_000_000,
    });
    const [upgrade] = await walk(h, 1);
    expect(upgrade!.size).toBe(50);
    expect(upgrade!.txs).toBe(0);
    expect(upgrade!.pages).toBe(1);
    expect(snapshotOf(h)?.complete).toBe(true);
    expect(rows.has(legacyKey)).toBe(false);
  });

  it('a hole nothing accounts for is re-walked once, then goes quiet', async () => {
    // The state the round-0 walk left behind in the verifier's probe P1: whole
    // history seen, nothing to re-read, nothing dropped, and still a leaf short.
    const h = new FakeChain();
    for (let i = 0; i < 200; i++) h.push(i, 110_000n + BigInt(i));
    const key = poolHistoryKey(h.rpcEndpoint, POOL.toBase58());
    rows.set(key, {
      version: 2,
      key,
      newestSignature: h.txs[0]!.signature,
      oldestSignature: h.txs[h.txs.length - 1]!.signature,
      reachedOldest: true,
      complete: false,
      retry: [],
      dropped: 0,
      entries: h.txs
        .filter((t) => t.leafIndex !== 150)
        .map((t) => ({
          commitment: t.commitment.toString(),
          leafIndex: t.leafIndex,
          depositPayer: PAYER.toBase58(),
          depositSlot: t.slot,
          signature: t.signature,
        })),
      savedAt: 1_700_000_000_000,
    });

    const calls = await walk(h, 3);
    expect(calls.map((c) => c.size)).toEqual([199, 200, 200]);
    expect(calls[1]!.map.get('110150')).toBeDefined();
    expect(snapshotOf(h)?.complete).toBe(true);
    // The re-walk lists the history again but fetches only the unknown signature.
    expect(calls.map((c) => c.pages)).toEqual([1, 2, 1]);
    expect(calls.map((c) => c.txs)).toEqual([0, 1, 0]);
  });

  it('a hole no walk can fill is re-walked once, not on every call', async () => {
    // Leaf 150 is in the tree but its transaction is never listed. A hole at
    // the TOP of the range is not enough: an account read one slot ahead of the
    // signature list looks exactly like that, and must not buy a re-walk.
    const h = new FakeChain();
    for (let i = 0; i <= 200; i++) if (i !== 150) h.push(i, 120_000n + BigInt(i));
    h.nextLeafIndexOverride = 201;
    await fetchPoolCommitments(h.asConnection(), POOL);
    const calls = await walk(h, 6);
    expect(calls.map((c) => c.size)).toEqual([200, 200, 200, 200, 200, 200]);
    // The walk that found the hole scheduled one re-walk; call 1 pays it, in
    // pages only (every listed signature is already decoded); then quiet.
    expect(calls.map((c) => c.pages)).toEqual([2, 1, 1, 1, 1, 1]);
    expect(calls.map((c) => c.txs)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(snapshotOf(h)?.complete).toBe(false);
  });

  it('a hole only at the top (an account read ahead of the list) buys no re-walk', async () => {
    // Added after the fix-round-1 red: it passes on the round-0 walk too, which
    // never re-walked anything. It pins the latency side of the rule above
    // (mutant M7 in `scratchpad/wp-logs/HIST-1-fix1-mutants.log`).
    const h = new FakeChain();
    for (let i = 0; i < 200; i++) h.push(i, 130_000n + BigInt(i));
    h.nextLeafIndexOverride = 201;
    const calls = await walk(h, 4);
    expect(calls.map((c) => c.pages)).toEqual([1, 1, 1, 1]);
    expect(calls.map((c) => c.txs)).toEqual([200, 0, 0, 0]);
  });
});
