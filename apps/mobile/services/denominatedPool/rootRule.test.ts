/**
 * WHICH ROOT a mobile circuit-7 withdrawal names.
 *
 * The rule under test: the root comes from the pool's state at spend time, not
 * from the note. A withdrawal that names the root created by its own deposit
 * (`LeafInserted.new_root`) hands a chain reader a one-hop join from the spend
 * back to that deposit, and the deposit's funding transaction is 1.5 s away
 * from the buyer's payment (probes/logs/05-analyze.log, 22 of 22 within 10 s).
 * Measured on devnet: 1 of 34 v4 spends named a root 4 insertions old, and in
 * v3 all 4 stale roots were the spent note's own deposit root
 * (redteam-root-probe2, probe-stale-root-2026-09-15.log).
 *
 * On this surface the rule already holds: `prepareUnshieldV4` rebuilds from the
 * leaf history and never consults `receipt.merkleRoot` / `merklePathElements`,
 * which the v3 path DOES use (`ensureMerkleProof`). So this is a REGRESSION
 * GUARD, not a fix — SPEND-1 changes the web twin, and this file is what stops
 * the same "reuse the saved path" shortcut arriving here afterwards. Its
 * positive control is an in-test wrapper that prefers the saved path: the
 * assertion below fails against it.
 *
 * No RPC, no WASM: the stub connection answers an empty signature scan, so the
 * rebuild is deterministic, and the prover is a closure.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram, type Connection } from '@solana/web3.js';

import {
  buildMerkleProofFromLeavesV3,
  goldilocksToLeBytes32,
  prepareUnshieldV4,
  type PoolConfig,
  type ShieldReceipt,
  type SpendProver,
} from './index';

const POOL = new PublicKey('11111111111111111111111111111112');
const TREE = new PublicKey('11111111111111111111111111111113');
const RECIPIENT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

const POOL_CONFIG = {
  token: 'SOL',
  tokenMint: SystemProgram.programId,
  denomination: 1,
  decimals: 9,
  denominationAtomic: 1_000_000_000n,
  poolPDA: POOL,
  treePDA: TREE,
  version: 'v3',
} as unknown as PoolConfig;

/** What the pool publishes now: the root a rebuild from today's leaves gives. */
const R_CUR = buildMerkleProofFromLeavesV3({ leavesByIndex: [], targetLeafIndex: 0 }).root;
/** The root the note carries from its own deposit — still in the ring. */
const R_OLD = 0x0123456789abcdefn;
/** A sibling value that exists only in the saved path. */
const SAVED_SIBLING = 0x7777777777777777n;

/** A PRF-blinded receipt at leaf 0, carrying a saved path at R_OLD. */
const RECEIPT: ShieldReceipt = {
  secret: 22n,
  nullifierPreimage: 11n,
  depositEpoch: 7284991002338477113n,
  tokenMint: 0n,
  commitment: 0xdeadbeefcafebaben,
  leafIndex: 0,
  denomination: 1_000_000_000n,
  pool: POOL.toBase58(),
  token: 'SOL',
  denominationHuman: 1,
  shieldedAt: 0,
  merkleRoot: R_OLD,
  merklePathElements: new Array(15).fill(SAVED_SIBLING),
  merklePathIndices: new Array(15).fill(0),
};

/**
 * A `DenominatedPool` account: current root `current`, ring holding `ring`.
 * Layout in `services/denominatedPool/parsePool.ts`.
 */
function poolAccountBytes(current: bigint, ring: bigint[]): Buffer {
  const buf = Buffer.alloc(183 + ring.length * 32);
  Buffer.from(goldilocksToLeBytes32(current)).copy(buf, 88);
  buf.writeUInt32LE(ring.length, 178);
  ring.forEach((r, i) => Buffer.from(goldilocksToLeBytes32(r)).copy(buf, 182 + i * 32));
  buf[182 + ring.length * 32] = 100;
  return buf;
}

function stubConnection(poolAccount: Buffer | null): Connection {
  return {
    getSignaturesForAddress: async () => [],
    getTransaction: async () => null,
    getAccountInfo: async () => (poolAccount ? { data: poolAccount } : null),
  } as unknown as Connection;
}

function stubProver(): { prove: SpendProver; calls: Parameters<SpendProver>[] } {
  const calls: Parameters<SpendProver>[] = [];
  const prove: SpendProver = async (...args) => {
    calls.push(args);
    const rh = args[6].map((s) => BigInt(s));
    return {
      proofHex: 'ab'.repeat(64),
      publicInputs: [0x1122334455667788n, R_CUR, ...rh].map(String),
      proofSize: 64,
    };
  };
  return { prove, calls };
}

/**
 * The shape this guard exists to refuse: use the note's saved path when its
 * root is still in the ring, and only rebuild otherwise. This is what the web
 * twin does today (SPEND-1) and what must not arrive here.
 */
async function preparePreferringSavedPath(
  receipt: ShieldReceipt,
  ring: bigint[],
  current: bigint,
): Promise<{ merkleRoot: bigint; pathElements: bigint[] }> {
  if (receipt.merkleRoot !== undefined && [current, ...ring].includes(receipt.merkleRoot)) {
    return { merkleRoot: receipt.merkleRoot, pathElements: receipt.merklePathElements ?? [] };
  }
  const rebuilt = buildMerkleProofFromLeavesV3({ leavesByIndex: [], targetLeafIndex: receipt.leafIndex });
  return { merkleRoot: rebuilt.root, pathElements: rebuilt.pathElements };
}

describe('mobile: the v4 prepare names the current root', () => {
  it('rebuilds and names the current root, though the saved one is in the ring', async () => {
    const { prove, calls } = stubProver();
    const prepared = await prepareUnshieldV4(
      RECEIPT,
      RECIPIENT,
      POOL_CONFIG,
      stubConnection(poolAccountBytes(R_CUR, [R_OLD])),
      prove,
    );

    expect(prepared.merkleRoot).toBe(R_CUR);
    expect(prepared.merkleRoot).not.toBe(R_OLD);

    // And the path handed to the circuit is the rebuilt one, not the stored one.
    expect(calls.length).toBe(1);
    expect(calls[0][4]).not.toContain(SAVED_SIBLING.toString());
  });

  it('the saved-path shortcut would name the deposit root (positive control)', async () => {
    const saved = await preparePreferringSavedPath(RECEIPT, [R_OLD], R_CUR);
    expect(saved.merkleRoot).toBe(R_OLD);
    expect(saved.merkleRoot).not.toBe(R_CUR);
    expect(saved.pathElements).toContain(SAVED_SIBLING);
  });

  it('two notes at the same pool state name the same root', async () => {
    // The property behind the rule: the root is a function of pool state, so it
    // separates nothing. Two receipts with DIFFERENT saved roots, one prepare
    // each, one answer.
    const other: ShieldReceipt = { ...RECEIPT, merkleRoot: 0x424242n, secret: 23n };
    const a = await prepareUnshieldV4(
      RECEIPT,
      RECIPIENT,
      POOL_CONFIG,
      stubConnection(poolAccountBytes(R_CUR, [R_OLD])),
      stubProver().prove,
    );
    const b = await prepareUnshieldV4(
      other,
      RECIPIENT,
      POOL_CONFIG,
      stubConnection(poolAccountBytes(R_CUR, [R_OLD, 0x424242n])),
      stubProver().prove,
    );
    expect(a.merkleRoot).toBe(b.merkleRoot);
    expect(a.merkleRoot).toBe(R_CUR);
  });

  it('the receipt fields that carry a deposit root are never read by the prepare', async () => {
    // Belt for the assertions above: a receipt whose saved path is poison. If
    // anything downstream started preferring it, the proof would be built from
    // these values.
    const poisoned: ShieldReceipt = {
      ...RECEIPT,
      merkleRoot: R_OLD,
      merklePathElements: new Array(15).fill(0xdeadn),
      merklePathIndices: new Array(15).fill(1),
    };
    const { prove, calls } = stubProver();
    const prepared = await prepareUnshieldV4(
      poisoned,
      RECIPIENT,
      POOL_CONFIG,
      stubConnection(poolAccountBytes(R_CUR, [R_OLD])),
      prove,
    );
    expect(prepared.merkleRoot).toBe(R_CUR);
    expect(calls[0][4]).not.toContain('57005'); // 0xdead
    expect(calls[0][5].every((i) => i === 0)).toBe(true);
  });
});
