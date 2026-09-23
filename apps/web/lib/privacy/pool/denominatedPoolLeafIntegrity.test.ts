/**
 * [AUDIT v1 round 2, fix lane 1] The pool's leaf history and the deposit
 * pre-flight must not take on trust what the chain does not bind.
 *
 * Four findings, each pinned by a case below that failed on the code it names
 * (red log: scratchpad `audit-v1-opus/r2-fix1/red.log`):
 *
 *   F1. `prepareShieldInsert` rebuilt the pool root only from the tree
 *       account's `filled_subtrees`. Levels 1..10 of that array are written
 *       from the depositor's `new_subtrees` argument and nothing binds them
 *       (merkle_tree_v3.rs:223-232, shield_denominated_v3.rs:184-187). One
 *       deposit carrying an honest proof and garbage hints made every later
 *       web deposit throw "neither layout matched". The web client also SENT
 *       its hints one level off (level i at index i; the program stores index
 *       i at level i+1 and drops level 10), so an honest web-only history
 *       stopped matching at index 1,025.
 *   F2. `fetchPoolCommitments` filed leaves by commitment, so a commitment
 *       inserted twice (the program has no uniqueness check) collapsed into
 *       one entry: a hole in every rebuilt tree, and the owner's note moved to
 *       the later index where recovery no longer finds it.
 *   F3. The leaf-event decoder read any `Program data:` line with a known
 *       discriminator, whichever program logged it and whichever pool it
 *       named.
 *   F4. `shareableNoteToReceipt` copied the token and denomination labels from
 *       the sender's JSON, and accepted a note minted for another token.
 *
 * The chain here is a fake with real event bytes and real account layouts;
 * leaves are synthetic. Nothing touches a cluster.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';

vi.mock('./starkProver', () => ({
  starkProver: {
    start: async () => {},
    generateMerkleUpdateProof: async (oldLeaf: string, newLeaf: string, pathElements: string[]) => {
      proverCalls.push({ oldLeaf, newLeaf, pathElements });
      return { proofHex: '00', publicInputs: ['0', newLeaf, '1', '2', '11'], proofSize: 1 };
    },
  },
}));
const proverCalls: Array<{ oldLeaf: string; newLeaf: string; pathElements: string[] }> = [];

import {
  ALL_POOLS_V3,
  MERKLE_DEPTH,
  SOL_POOLS_V3,
  USDC_POOLS_V3,
  ZK_SHIELDED_PROGRAM_ID,
  buildMerkleProofFromLeavesV3,
  computeNewRootFromSubtreesV3,
  computeZeroHashesV3,
  createCommitmentV3,
  fetchPoolCommitments,
  fetchPoolLeavesByIndex,
  goldilocksToLeBytes32,
  prepareInsertForCommitment,
  pubkeyToField,
  shareableNoteToReceipt,
  type PoolConfig,
  type ShareableNote,
} from './denominatedPool';
import { memoryPoolHistoryStore, setPoolHistoryStore } from './poolHistoryCache';

const PAYER = Keypair.generate().publicKey;
const ZK = ZK_SHIELDED_PROGRAM_ID.toBase58();
const OTHER_PROGRAM = Keypair.generate().publicKey.toBase58();
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

/** `LeafInserted` as merkle_tree_v3.rs emits it: disc | pool@8 | idx@40 | leaf@48. */
function leafInsertedData(pool: PublicKey, leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(sha256(new TextEncoder().encode('event:LeafInserted')).subarray(0, 8), 0);
  data.set(pool.toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, BigInt(leafIndex), true);
  data.set(new Uint8Array(goldilocksToLeBytes32(commitment)), 48);
  return `Program data: ${Buffer.from(data).toString('base64')}`;
}

/** The log a real deposit carries: the event sits inside zk_shielded's own frame. */
function depositLogs(pool: PublicKey, leafIndex: number, commitment: bigint): string[] {
  return [
    `Program ${COMPUTE_BUDGET} invoke [1]`,
    `Program ${COMPUTE_BUDGET} success`,
    `Program ${ZK} invoke [1]`,
    'Program log: Instruction: ShieldDenominatedV3',
    leafInsertedData(pool, leafIndex, commitment),
    `Program ${ZK} consumed 100 of 200 compute units`,
    `Program ${ZK} success`,
  ];
}

interface FakeTx {
  signature: string;
  logs: string[];
}

let serial = 0;
const uniq = (): string => `${Date.now().toString(36)}_${(serial += 1)}_${Math.random().toString(36).slice(2)}`;

/** Newest-first history plus the pool and tree accounts. */
class FakeChain {
  txs: FakeTx[] = [];
  nextLeafIndex = 0;
  treeData: Buffer | null = null;
  signatureCalls = 0;
  rpcEndpoint = `https://fake-${uniq()}.rpc/`;
  constructor(readonly pool: PoolConfig | { poolPDA: PublicKey; treePDA: PublicKey }) {}

  deposit(leafIndex: number, commitment: bigint): void {
    this.txs.unshift({ signature: `sig_${uniq()}`, logs: depositLogs(this.pool.poolPDA, leafIndex, commitment) });
    this.nextLeafIndex = Math.max(this.nextLeafIndex, leafIndex + 1);
  }

  raw(logs: string[]): void {
    this.txs.unshift({ signature: `sig_${uniq()}`, logs });
  }

  async getSignaturesForAddress(_pk: PublicKey, opts: { before?: string; until?: string; limit?: number } = {}) {
    this.signatureCalls += 1;
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
    const t = this.txs.find((x) => x.signature === signature);
    if (!t) return null;
    return { slot: 1000, meta: { err: null, logMessages: t.logs }, transaction: { message: { accountKeys: [PAYER] } } };
  }

  async getAccountInfo(pk: PublicKey) {
    if (this.treeData && pk.equals(this.pool.treePDA)) return { data: this.treeData };
    // The pool account as `parsePoolV3Account` reads it: depth at 120,
    // next_leaf_index at 121, active at 177, an empty ring.
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
 * MerkleTreeStateV3 bytes as `prepareShieldInsert` parses them:
 * disc(8) | pool(32) | root@40 | leaf_count@72 | depth@80 | vec len@81 | entries.
 */
function treeAccount(pool: PublicKey, root: bigint, leafCount: number, stored: bigint[]): Buffer {
  const buf = Buffer.alloc(8 + 32 + 32 + 8 + 1 + 4 + stored.length * 32);
  buf.set(pool.toBytes(), 8);
  buf.set(goldilocksToLeBytes32(root), 40);
  buf.writeBigUInt64LE(BigInt(leafCount), 72);
  buf[80] = MERKLE_DEPTH;
  buf.writeUInt32LE(stored.length, 81);
  stored.forEach((v, i) => buf.set(goldilocksToLeBytes32(v), 85 + i * 32));
  return buf;
}

/** Honest incremental replay: the true frontier (level l at index l) and root. */
function honestReplay(leaves: bigint[]): { frontier: bigint[]; root: bigint } {
  let frontier = computeZeroHashesV3().slice(0, MERKLE_DEPTH);
  let root = computeNewRootFromSubtreesV3(0n, 0, frontier).newRoot;
  leaves.forEach((leaf, i) => {
    const r = computeNewRootFromSubtreesV3(leaf, i, frontier);
    frontier = r.updatedSubtrees;
    root = r.newRoot;
  });
  return { frontier, root };
}

/** Levels >= 11 of `filled_subtrees`, as the program derives them (shield_denominated_v3.rs:474-479). */
const INSERT_SUBTREE_DEPTH = 11;

function leaf(i: number): bigint {
  return 1_000_003n * BigInt(i + 1) + 77n;
}

beforeEach(() => {
  setPoolHistoryStore(memoryPoolHistoryStore());
  proverCalls.length = 0;
});

// ---------------------------------------------------------------------------
// F1 — the deposit pre-flight
// ---------------------------------------------------------------------------

describe('[R2-F1] the deposit pre-flight does not depend on the unbound hint levels', () => {
  const pool = SOL_POOLS_V3[0];

  it('garbage at filled_subtrees[1..10] (honest root) no longer refuses the next deposit: the frontier is rebuilt from the leaves', async () => {
    const leaves = Array.from({ length: 6 }, (_, i) => leaf(i));
    const { frontier, root } = honestReplay(leaves);
    // What the program stores after an honest C6 proof carrying garbage hints:
    // [0] = the leaf, [1..10] = the caller's words, [11..] = derived, root honest.
    const stored = [leaves[5]!];
    for (let l = 1; l < INSERT_SUBTREE_DEPTH; l++) stored.push(0xbad00000n + BigInt(l));
    for (let l = INSERT_SUBTREE_DEPTH; l < MERKLE_DEPTH; l++) stored.push(frontier[l]!);
    stored.push(root);

    const chain = new FakeChain(pool);
    leaves.forEach((c, i) => chain.deposit(i, c));
    chain.treeData = treeAccount(pool.poolPDA, root, leaves.length, stored);

    const commitment = leaf(6);
    const prepared = await prepareInsertForCommitment(pool, chain.asConnection(), commitment);

    const truth = buildMerkleProofFromLeavesV3({ leavesByIndex: [...leaves, commitment], targetLeafIndex: 6 });
    expect(prepared.insertParams.leafIndex).toBe(6);
    expect(prepared.merklePath.root).toBe(truth.root);
    expect(prepared.merklePath.pathElements).toEqual(truth.pathElements);
    expect(proverCalls).toHaveLength(1);
  });

  it('a history that does not reproduce the on-chain root is still refused, before any proof', async () => {
    const leaves = Array.from({ length: 6 }, (_, i) => leaf(i));
    const { frontier, root } = honestReplay(leaves);
    const stored = [leaves[5]!];
    for (let l = 1; l < INSERT_SUBTREE_DEPTH; l++) stored.push(0xbad00000n + BigInt(l));
    for (let l = INSERT_SUBTREE_DEPTH; l < MERKLE_DEPTH; l++) stored.push(frontier[l]!);
    stored.push(root);

    const chain = new FakeChain(pool);
    // The history the RPC serves is WRONG at leaf 3.
    leaves.forEach((c, i) => chain.deposit(i, i === 3 ? c + 1n : c));
    chain.treeData = treeAccount(pool.poolPDA, root, leaves.length, stored);

    await expect(prepareInsertForCommitment(pool, chain.asConnection(), leaf(6))).rejects.toThrow(
      /Shield pre-flight failed/,
    );
    expect(proverCalls).toHaveLength(0);
  });

  it('what the web client sends lands at the level the program stores it: 1,100 web-only deposits never need the history walk', async () => {
    const chain = new FakeChain(pool);
    const zeros = computeZeroHashesV3();
    // The on-chain array: depth + 1 entries.
    const stored: bigint[] = Array.from({ length: MERKLE_DEPTH + 1 }, (_, l) => zeros[l]!);
    let trueFrontier = zeros.slice(0, MERKLE_DEPTH);
    let root = computeNewRootFromSubtreesV3(0n, 0, trueFrontier).newRoot;

    const N = 1_100;
    for (let i = 0; i < N; i++) {
      chain.treeData = treeAccount(pool.poolPDA, root, i, stored);
      const commitment = leaf(i);
      let prepared;
      try {
        prepared = await prepareInsertForCommitment(pool, chain.asConnection(), commitment);
      } catch (e) {
        throw new Error(`web deposit at index ${i} refused: ${(e as Error).message}`);
      }
      const sent = prepared.insertParams.newSubtrees;
      expect(sent).toHaveLength(MERKLE_DEPTH);

      // The program's write rule (merkle_tree_v3.rs:223-232, then the
      // derived top levels, shield_denominated_v3.rs:474-479).
      const honest = computeNewRootFromSubtreesV3(commitment, i, trueFrontier);
      stored[0] = commitment;
      sent.forEach((v, k) => {
        if (k + 1 < INSERT_SUBTREE_DEPTH) stored[k + 1] = v;
      });
      for (let l = INSERT_SUBTREE_DEPTH; l < MERKLE_DEPTH; l++) stored[l] = honest.updatedSubtrees[l]!;
      trueFrontier = honest.updatedSubtrees;
      root = honest.newRoot;
      expect(prepared.merklePath.root).toBe(root);
      chain.deposit(i, commitment);
    }
    // Every one of them matched on the account alone.
    expect(chain.signatureCalls).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// F2 — a commitment inserted twice
// ---------------------------------------------------------------------------

describe('[R2-F2] a repeated commitment keeps both leaves, and the first one is the one a lookup finds', () => {
  it('leaves 111, 222, 222, 333 rebuild with no hole', async () => {
    const pool = { poolPDA: Keypair.generate().publicKey, treePDA: Keypair.generate().publicKey };
    const chain = new FakeChain(pool);
    [111n, 222n, 222n, 333n].forEach((c, i) => chain.deposit(i, c));
    const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(chain.asConnection(), pool.poolPDA);
    expect(leavesByIndex.map(String)).toEqual(['111', '222', '222', '333']);
    expect(missing).toEqual([]);
  });

  it('a repeat decoded on a WARM walk does not move the owner’s note to the later leaf', async () => {
    const pool = { poolPDA: Keypair.generate().publicKey, treePDA: Keypair.generate().publicKey };
    const chain = new FakeChain(pool);
    chain.deposit(0, 4242n);
    chain.deposit(1, 5151n);
    const first = await fetchPoolCommitments(chain.asConnection(), pool.poolPDA);
    expect(first.get('4242')?.leafIndex).toBe(0);

    chain.deposit(2, 4242n); // anybody can re-insert a public commitment
    const warm = await fetchPoolCommitments(chain.asConnection(), pool.poolPDA);
    expect(warm.get('4242')?.leafIndex).toBe(0);
    // ...and the later leaf is still a leaf of the tree for whoever iterates.
    const indices = [...warm.values()].map((e) => e.leafIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// F3 — whose event is it
// ---------------------------------------------------------------------------

describe('[R2-F3] only zk_shielded’s own LeafInserted for THIS pool is a leaf of this pool', () => {
  it('an event naming another pool is not filed', async () => {
    const pool = { poolPDA: Keypair.generate().publicKey, treePDA: Keypair.generate().publicKey };
    const other = Keypair.generate().publicKey;
    const chain = new FakeChain(pool);
    chain.deposit(0, 111n);
    chain.raw(depositLogs(other, 1, 999n));
    const map = await fetchPoolCommitments(chain.asConnection(), pool.poolPDA);
    expect([...map.values()].map((e) => [e.leafIndex, e.commitment.toString()])).toEqual([[0, '111']]);
  });

  it('an event logged inside ANOTHER program’s frame is not filed, even naming this pool', async () => {
    const pool = { poolPDA: Keypair.generate().publicKey, treePDA: Keypair.generate().publicKey };
    const chain = new FakeChain(pool);
    chain.deposit(0, 111n);
    chain.raw([
      `Program ${OTHER_PROGRAM} invoke [1]`,
      leafInsertedData(pool.poolPDA, 1, 4243n),
      `Program ${OTHER_PROGRAM} success`,
    ]);
    // ...nor one logged by another program AFTER zk_shielded's frame closed.
    chain.raw([
      `Program ${ZK} invoke [1]`,
      `Program ${ZK} success`,
      `Program ${OTHER_PROGRAM} invoke [1]`,
      leafInsertedData(pool.poolPDA, 30_000, 4244n),
      `Program ${OTHER_PROGRAM} success`,
    ]);
    // ...nor from a program zk_shielded is not: a nested frame of another id.
    chain.raw([
      `Program ${ZK} invoke [1]`,
      `Program ${OTHER_PROGRAM} invoke [2]`,
      leafInsertedData(pool.poolPDA, 2, 4245n),
      `Program ${OTHER_PROGRAM} success`,
      `Program ${ZK} success`,
    ]);
    const map = await fetchPoolCommitments(chain.asConnection(), pool.poolPDA);
    expect([...map.values()].map((e) => [e.leafIndex, e.commitment.toString()])).toEqual([[0, '111']]);
  });

  it('control: zk_shielded’s event reached through a CPI is still a leaf', async () => {
    const pool = { poolPDA: Keypair.generate().publicKey, treePDA: Keypair.generate().publicKey };
    const chain = new FakeChain(pool);
    chain.deposit(0, 111n);
    chain.raw([
      `Program ${OTHER_PROGRAM} invoke [1]`,
      `Program ${ZK} invoke [2]`,
      leafInsertedData(pool.poolPDA, 1, 222n),
      `Program ${ZK} success`,
      `Program ${OTHER_PROGRAM} success`,
    ]);
    const map = await fetchPoolCommitments(chain.asConnection(), pool.poolPDA);
    const got = [...map.values()].map((e) => [e.leafIndex, e.commitment.toString()]).sort();
    expect(got).toEqual([[0, '111'], [1, '222']]);
  });
});

// ---------------------------------------------------------------------------
// F4 — an imported note's labels
// ---------------------------------------------------------------------------

describe('[R2-F4] an imported note is labelled by the pool it names, never by the sender', () => {
  const pool = SOL_POOLS_V3[0];
  const secret = 1_234_567n;
  const nullifierPreimage = 7_654_321n;
  const noteBlinding = 99n;
  const mintField = pubkeyToField(pool.tokenMint);

  function note(overrides: Partial<ShareableNote> = {}, mint = mintField): ShareableNote {
    return {
      version: 1,
      pool: pool.poolPDA.toBase58(),
      secret: secret.toString(),
      nullifier_preimage: nullifierPreimage.toString(),
      deposit_epoch: noteBlinding.toString(),
      token_mint: mint.toString(),
      commitment: createCommitmentV3(nullifierPreimage, secret, noteBlinding, mint).toString(),
      leafIndex: 3,
      token: pool.token,
      denominationHuman: pool.denomination,
      ...overrides,
    };
  }

  it('a 0.1 SOL note labelled "10 USDC" comes out as 0.1 SOL', () => {
    const receipt = shareableNoteToReceipt(note({ token: 'USDC', denominationHuman: 10 }));
    expect(receipt.token).toBe(pool.token);
    expect(receipt.denominationHuman).toBe(pool.denomination);
    expect(receipt.denomination).toBe(pool.denominationAtomic);
  });

  it('a note whose commitment binds another token’s mint is refused for this pool', () => {
    const usdcMint = pubkeyToField(USDC_POOLS_V3[0]!.tokenMint);
    expect(usdcMint).not.toBe(mintField);
    expect(() => shareableNoteToReceipt(note({}, usdcMint))).toThrow(/mint/i);
  });

  it('control: every configured pool accepts its own well-formed note', () => {
    for (const p of ALL_POOLS_V3) {
      const m = pubkeyToField(p.tokenMint);
      const r = shareableNoteToReceipt({
        ...note({}, m),
        pool: p.poolPDA.toBase58(),
        token: p.token,
        denominationHuman: p.denomination,
      });
      expect(r.token).toBe(p.token);
      expect(r.denominationHuman).toBe(p.denomination);
    }
  });
});
