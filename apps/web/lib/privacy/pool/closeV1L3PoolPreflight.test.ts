/**
 * close-v1, lane L3: the deposit pre-flight refuses, BEFORE any proof or
 * payment, a pool the deployed program can no longer insert into, and says why
 * with a stable code (close-v1 contract C2). Both are founder items on chain
 * (redeploy); these are the web mitigations.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/closeV1L3PoolPreflight.test.ts
 *
 * F28. One deposit that stores a non-canonical 32-byte value (upper 24 bytes not
 *      zero, or a low limb at or above the Goldilocks modulus) in the tree
 *      account's `filled_subtrees` bricks every later deposit and v3 transfer:
 *      the program reads EVERY entry through `felt_from_bytes`
 *      (shield_denominated_v3.rs:435-437) and answers InvalidMerkleRoot
 *      (audit-v1-opus/r2-pool, litesvm 7/7; v4 withdrawals still land). The web
 *      root fold reads only the levels the next insertion turns right at, so an
 *      unread level held the value unseen: the pre-flight passed, the proof was
 *      generated, the float paid, and the insert refused on chain.
 *      Now: `POOL_DEPOSITS_BRICKED:` before anything.
 *
 * F01. The C6 insert position is bound to nothing: a depositor can write their
 *      leaf into another empty slot of the subtree while the event announces
 *      `leaf_count`. From then on the tree rebuilt from the events never
 *      matches the chain and every web deposit and spend is refused. It already
 *      was refused before any proof, but as "retry shortly", for ever. When the
 *      history accounts for exactly the tree's leaves and still does not fold
 *      to its root, that is not lag: `POOL_TREE_DIVERGED:`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';

const proverCalls = vi.hoisted(() => [] as string[]);
vi.mock('./starkProver', () => ({
  starkProver: {
    start: async () => {},
    generateMerkleUpdateProof: async (_o: string, newLeaf: string) => {
      proverCalls.push(newLeaf);
      return { proofHex: '00', publicInputs: ['0', newLeaf, '1', '2', '11'], proofSize: 1 };
    },
  },
}));

import {
  MERKLE_DEPTH,
  SOL_POOLS_V3,
  ZK_SHIELDED_PROGRAM_ID,
  computeNewRootFromSubtreesV3,
  computeZeroHashesV3,
  goldilocksToLeBytes32,
  prepareInsertForCommitment,
  prepareUnshieldV4,
  type PoolConfig,
  type ShieldReceipt,
} from './denominatedPool';
import { memoryPoolHistoryStore, setPoolHistoryStore } from './poolHistoryCache';

const PAYER = Keypair.generate().publicKey;
const ZK = ZK_SHIELDED_PROGRAM_ID.toBase58();
const pool = SOL_POOLS_V3[0] as PoolConfig;

function leafInsertedData(poolPda: PublicKey, leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(sha256(new TextEncoder().encode('event:LeafInserted')).subarray(0, 8), 0);
  data.set(poolPda.toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, BigInt(leafIndex), true);
  data.set(new Uint8Array(goldilocksToLeBytes32(commitment)), 48);
  return `Program data: ${Buffer.from(data).toString('base64')}`;
}

let serial = 0;
class FakeChain {
  txs: Array<{ signature: string; logs: string[] }> = [];
  treeData: Buffer | null = null;
  rpcEndpoint = `https://fake-preflight-${(serial += 1)}.rpc/`;
  requests: string[] = [];
  deposit(leafIndex: number, commitment: bigint): void {
    this.txs.unshift({
      signature: `sig_${serial}_${leafIndex}_${this.txs.length}`,
      logs: [`Program ${ZK} invoke [1]`, leafInsertedData(pool.poolPDA, leafIndex, commitment), `Program ${ZK} success`],
    });
  }
  async getSignaturesForAddress(_pk: PublicKey, opts: { before?: string; until?: string; limit?: number } = {}) {
    this.requests.push('getSignaturesForAddress');
    let list = this.txs;
    if (opts.before) {
      const i = list.findIndex((t) => t.signature === opts.before);
      list = i >= 0 ? list.slice(i + 1) : list;
    }
    if (opts.until) {
      const i = list.findIndex((t) => t.signature === opts.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, opts.limit ?? 1000).map((t) => ({ signature: t.signature, err: null }));
  }
  async getTransaction(signature: string) {
    this.requests.push('getTransaction');
    const t = this.txs.find((x) => x.signature === signature);
    return t ? { slot: 1000, meta: { err: null, logMessages: t.logs }, transaction: { message: { accountKeys: [PAYER] } } } : null;
  }
  async getAccountInfo(pk: PublicKey) {
    this.requests.push('getAccountInfo');
    if (this.treeData && pk.equals(pool.treePDA)) return { data: this.treeData };
    const d = new Uint8Array(182);
    new DataView(d.buffer).setBigUint64(121, BigInt(this.txs.length), true);
    d[120] = 15;
    d[177] = 1;
    return { data: Buffer.from(d) };
  }
  async getSlot() {
    this.requests.push('getSlot');
    return 1000;
  }
  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

/** MerkleTreeStateV3: disc | pool | root@40 | leaf_count@72 | depth@80 | vec len@81 | entries@85. */
function treeAccount(root: bigint, leafCount: number, stored: bigint[]): Buffer {
  const buf = Buffer.alloc(85 + stored.length * 32);
  buf.set(pool.poolPDA.toBytes(), 8);
  buf.set(goldilocksToLeBytes32(root), 40);
  buf.writeBigUInt64LE(BigInt(leafCount), 72);
  buf[80] = MERKLE_DEPTH;
  buf.writeUInt32LE(stored.length, 81);
  stored.forEach((v, i) => buf.set(goldilocksToLeBytes32(v), 85 + i * 32));
  return buf;
}

function replay(leaves: bigint[]): { frontier: bigint[]; root: bigint } {
  let frontier = computeZeroHashesV3().slice(0, MERKLE_DEPTH);
  let root = computeNewRootFromSubtreesV3(0n, 0, frontier).newRoot;
  leaves.forEach((l, i) => {
    const r = computeNewRootFromSubtreesV3(l, i, frontier);
    frontier = r.updatedSubtrees;
    root = r.newRoot;
  });
  return { frontier, root };
}

const leaf = (i: number): bigint => 1_000_003n * BigInt(i + 1) + 91n;

beforeEach(() => {
  setPoolHistoryStore(memoryPoolHistoryStore());
  proverCalls.length = 0;
});

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'resolved';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('F28: a non-canonical stored value refuses the deposit before any proof', () => {
  it('a non-canonical entry at a level the next insert does not read is still caught', async () => {
    // Five leaves: the next insert (index 5 = 0b101) reads levels 0 and 2 only.
    const leaves = Array.from({ length: 5 }, (_, i) => leaf(i));
    const { frontier, root } = replay(leaves);
    const chain = new FakeChain();
    leaves.forEach((c, i) => chain.deposit(i, c));
    chain.treeData = treeAccount(root, 5, [...frontier, root]);
    // The attacker's hint at level 1 (unread by the fold): a set top byte.
    chain.treeData[85 + 1 * 32 + 31] = 1;

    const msg = await refusal(() => prepareInsertForCommitment(pool, chain.asConnection(), leaf(5)));
    expect(msg, 'the pre-flight let a bricked pool through').toMatch(/^POOL_DEPOSITS_BRICKED: /);
    expect(proverCalls, 'a proof was generated for a deposit the program will refuse').toEqual([]);
  });

  it('a low limb at or above the Goldilocks modulus is non-canonical too', async () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leaf(i));
    const { frontier, root } = replay(leaves);
    const chain = new FakeChain();
    leaves.forEach((c, i) => chain.deposit(i, c));
    chain.treeData = treeAccount(root, 5, [...frontier, root]);
    chain.treeData.writeBigUInt64LE(0xffffffffffffffffn, 85 + 3 * 32);
    expect(await refusal(() => prepareInsertForCommitment(pool, chain.asConnection(), leaf(5)))).toMatch(
      /^POOL_DEPOSITS_BRICKED: /,
    );
  });

  it('the refusal names no root, no leaf position and no value', async () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leaf(i));
    const { frontier, root } = replay(leaves);
    const chain = new FakeChain();
    chain.treeData = treeAccount(root, 5, [...frontier, root]);
    chain.treeData[85 + 1 * 32 + 31] = 1;
    const msg = await refusal(() => prepareInsertForCommitment(pool, chain.asConnection(), leaf(5)));
    expect(msg).not.toMatch(/\d{3,}/);
  });

  it('control: the same honest tree without the bad byte proceeds to the proof', async () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leaf(i));
    const { frontier, root } = replay(leaves);
    const chain = new FakeChain();
    leaves.forEach((c, i) => chain.deposit(i, c));
    chain.treeData = treeAccount(root, 5, [...frontier, root]);
    await prepareInsertForCommitment(pool, chain.asConnection(), leaf(5));
    expect(proverCalls).toHaveLength(1);
  });
});

describe('F01: a tree the complete event history cannot rebuild is reported as diverged', () => {
  it('a leaf written into another slot than its event announces: POOL_TREE_DIVERGED, no proof', async () => {
    // On chain: leaves 0..2 honest, then the attacker's leaf in slot 4 while
    // leaf_count says 4 and the event says index 3.
    const honest = [leaf(0), leaf(1), leaf(2)];
    const attacker = leaf(99);
    const onChain = replayAt([...honest.map((v, i) => [i, v] as const), [4, attacker] as const]);
    const chain = new FakeChain();
    honest.forEach((c, i) => chain.deposit(i, c));
    chain.deposit(3, attacker);
    // The hints the attacker left are garbage, so neither stored layout folds.
    const stored = Array.from({ length: MERKLE_DEPTH + 1 }, (_, l) => 0xbad00000n + BigInt(l));
    chain.treeData = treeAccount(onChain, 4, stored);

    const msg = await refusal(() => prepareInsertForCommitment(pool, chain.asConnection(), leaf(4)));
    expect(msg, 'a definitive divergence was reported as a transient').toMatch(/^POOL_TREE_DIVERGED: /);
    expect(proverCalls).toEqual([]);
    expect(msg).not.toMatch(/\d{3,}/);
  });

  it('control: a history SHORTER than the tree (RPC lag) keeps the retry message, not the code', async () => {
    const leaves = Array.from({ length: 4 }, (_, i) => leaf(i));
    const { root } = replay(leaves);
    const chain = new FakeChain();
    leaves.slice(0, 3).forEach((c, i) => chain.deposit(i, c)); // the fourth is not served yet
    const stored = Array.from({ length: MERKLE_DEPTH + 1 }, (_, l) => 0xbad00000n + BigInt(l));
    chain.treeData = treeAccount(root, 4, stored);
    const msg = await refusal(() => prepareInsertForCommitment(pool, chain.asConnection(), leaf(4)));
    expect(msg).toMatch(/Shield pre-flight failed/);
    expect(msg).not.toMatch(/POOL_TREE_DIVERGED/);
  });
});

describe('F01 on the spend side: a v4 withdrawal from a diverged pool says so, before any proof', () => {
  const receipt = { leafIndex: 1, commitment: 0n, secret: 1n, nullifierPreimage: 2n, noteBlinding: 3n } as unknown as ShieldReceipt;

  it('the complete history cannot rebuild the tree root: POOL_TREE_DIVERGED, not "retry in ten seconds"', async () => {
    const honest = [leaf(0), leaf(1), leaf(2)];
    const attacker = leaf(99);
    const onChain = replayAt([...honest.map((v, i) => [i, v] as const), [4, attacker] as const]);
    const chain = new FakeChain();
    honest.forEach((c, i) => chain.deposit(i, c));
    chain.deposit(3, attacker);
    chain.treeData = treeAccount(onChain, 4, Array.from({ length: MERKLE_DEPTH + 1 }, () => 0n));
    const msg = await refusal(() =>
      prepareUnshieldV4(receipt, Keypair.generate().publicKey, pool, chain.asConnection()),
    );
    expect(msg).toMatch(/^POOL_TREE_DIVERGED: /);
    expect(msg).not.toMatch(/PRE-FLIGHT FAIL/); // no route to the C1 + C3 pair
    expect(msg).not.toMatch(/\d{3,}/);
  });

  it('control: a history shorter than the tree keeps PRE-FLIGHT FAIL (the RPC may be behind)', async () => {
    const leaves = [leaf(0), leaf(1), leaf(2), leaf(3)];
    const { root } = replay(leaves);
    const chain = new FakeChain();
    leaves.slice(0, 3).forEach((c, i) => chain.deposit(i, c));
    chain.treeData = treeAccount(root, 4, Array.from({ length: MERKLE_DEPTH + 1 }, () => 0n));
    const msg = await refusal(() =>
      prepareUnshieldV4(receipt, Keypair.generate().publicKey, pool, chain.asConnection()),
    );
    expect(msg).not.toMatch(/POOL_TREE_DIVERGED/);
  });
});

/** The root of a depth-15 tree holding `placed` (index, value) pairs, zero elsewhere. */
function replayAt(placed: ReadonlyArray<readonly [number, bigint]>): bigint {
  const zeros = computeZeroHashesV3();
  const max = Math.max(...placed.map(([i]) => i));
  let level: bigint[] = new Array(max + 1).fill(0n);
  for (const [i, v] of placed) level[i] = v;
  for (let l = 0; l < MERKLE_DEPTH; l++) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(poseidon(level[i]!, i + 1 < level.length ? level[i + 1]! : zeros[l]!));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Poseidon2 as the tree uses it, through the public fold: inserting `b` at
 * index 1 next to `a` closes the level-0 pair, and the level-1 node the fold
 * records is H(a, b).
 */
function poseidon(a: bigint, b: bigint): bigint {
  const zeros = computeZeroHashesV3();
  return computeNewRootFromSubtreesV3(b, 1, [a, ...zeros.slice(1, MERKLE_DEPTH)]).updatedSubtrees[1]!;
}
