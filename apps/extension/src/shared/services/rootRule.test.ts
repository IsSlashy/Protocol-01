// @vitest-environment node
//
// ⛔ NOT jsdom, which is this package's default. `PublicKey.findProgramAddressSync`
// throws "Unable to find a viable program address nonce" for EVERY input under
// jsdom here — measured 2026-09-16, `wp-logs/EXT-RPC-env-probe.log` — and this
// file derives a fee-escrow PDA through the real prepare.
/**
 * WHICH ROOT A CIRCUIT-7 WITHDRAWAL NAMES, AND WHY IT MUST BE THE CURRENT ONE.
 *
 * 🚨 THE LEAK THIS GUARDS IS PUBLISHED ON THE WIRE. `unshield_denominated_stark_v4`
 * carries `merkle_root` in the clear, and the chain accepts any root that is
 * current OR still in the pool's historical ring. So a client that named the
 * root its OWN DEPOSIT created would publish a value that dates the deposit:
 * the ring advances one step per insertion, so the named root says how many
 * leaves existed at that moment, and for a stored path it is the root of the
 * insertion that created the note. That is a one-hop link from a spend back to
 * its own deposit, and the chain would never complain — the transaction
 * succeeds. Measured on devnet: 1 v4 spend of 34 named a root 4 insertions
 * stale, and in v3 all 4 stale roots were the spending note's own deposit root
 * (`scratchpad/probe-stale-root-2026-09-15.log`, map C headline).
 *
 * ⚠️ THIS IS A REGRESSION GUARD ON BEHAVIOUR THAT IS ALREADY CORRECT HERE, not
 * a fix. `prepareUnshieldV4` in this package has no stored-path fast path: it
 * rebuilds from events every time, so it names the tree's current root. The
 * web twin DOES have one (`denominatedPool.ts:2986-3025` over there tries the
 * stored path first and keeps it while it is still in the ring), and SPEND-1
 * is the work package removing it. Porting that "optimisation" here would cost
 * nothing visible — every test would stay green and every withdrawal would
 * still confirm — while reintroducing the link. This file is what goes red
 * instead.
 *
 * The positive control matters more than usual for the same reason: the
 * assertion is on a value that is already right, so the test must show it can
 * tell the two roots apart. `an implementation that preferred the saved path
 * would name the stale root` builds that implementation in three lines and
 * measures that it names R_old — and that the ring would have accepted it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
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
  prepareUnshieldV4,
  buildMerkleProofFromLeavesV3,
  goldilocksToLeBytes32,
  recipientHashLimbs,
  findPoolV3,
  parsePoolV3Account,
  type ShieldReceipt,
  type PoolConfig,
} from './denominatedPool';
import { setPoolHistoryStore, memoryPoolHistoryStore } from './poolHistoryCache';

// ---------------------------------------------------------------------------
// The chain, as a fixture
// ---------------------------------------------------------------------------

const POOL = findPoolV3('SOL', 1) as PoolConfig;
const RECIPIENT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

/** Four leaves. The note being spent is the SECOND, so the tree grew after it. */
const LEAVES = [1111n, 2222n, 3333n, 4444n];
const TARGET_LEAF = 1;

/**
 * R_cur — the root of the tree as it stands now, which is what a rebuild from
 * every event produces. Computed with the production builder so the expected
 * value is not a constant that could drift away from the code.
 */
const R_CUR = buildMerkleProofFromLeavesV3({
  leavesByIndex: LEAVES,
  targetLeafIndex: TARGET_LEAF,
}).root;

/**
 * R_old — the root at the moment leaf 1 was inserted, i.e. the tree with only
 * its first two leaves. This is exactly what a stored path from shield time
 * carries, and what the web twin's fast path would name.
 */
const R_OLD = buildMerkleProofFromLeavesV3({
  leavesByIndex: LEAVES.slice(0, TARGET_LEAF + 1),
  targetLeafIndex: TARGET_LEAF,
}).root;

const anchorEventDisc = (name: string) => sha256(utf8ToBytes(`event:${name}`)).slice(0, 8);

/** A `LeafInserted` event, laid out as merkle_tree_v3.rs emits it. */
function leafInsertedLog(leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(anchorEventDisc('LeafInserted'), 0);
  data.set(POOL.poolPDA.toBytes(), 8);
  const idx = new Uint8Array(8);
  for (let i = 0; i < 8; i++) idx[i] = Number((BigInt(leafIndex) >> BigInt(8 * i)) & 0xffn);
  data.set(idx, 40);
  data.set(new Uint8Array(goldilocksToLeBytes32(commitment)), 48);
  return `Program data: ${Buffer.from(data).toString('base64')}`;
}

/**
 * The pool account, byte for byte as `parsePoolV3Account` reads it: current
 * root at 88, then the historical ring from 182.
 */
function poolAccount(currentRoot: bigint, historical: bigint[]): Uint8Array {
  const data = new Uint8Array(182 + historical.length * 32);
  data.set(new Uint8Array(goldilocksToLeBytes32(currentRoot)), 88);
  data[120] = 15; // tree depth
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

/** The ring holds BOTH roots, so the chain would accept either one. */
const POOL_ACCOUNT = poolAccount(R_CUR, [R_OLD, 7777n, 8888n]);

const hex = (b: Uint8Array | number[]) => Buffer.from(b).toString('hex');

function connection() {
  return {
    rpcEndpoint: 'https://devnet.helius-rpc.com/?api-key=NOT-A-REAL-KEY',
    getSignaturesForAddress: async () => LEAVES.map((_, i) => ({ signature: `SIG${i}` })),
    getTransaction: async (sig: string) => {
      const i = Number(sig.replace('SIG', ''));
      return { meta: { logMessages: [leafInsertedLog(i, LEAVES[i])] } };
    },
    getAccountInfo: async () => ({ data: POOL_ACCOUNT }),
  } as never;
}

/**
 * The note, carrying a saved path at R_old — the shape a stored-path fast path
 * would reach for.
 */
function receipt(): ShieldReceipt {
  const saved = buildMerkleProofFromLeavesV3({
    leavesByIndex: LEAVES.slice(0, TARGET_LEAF + 1),
    targetLeafIndex: TARGET_LEAF,
  });
  return {
    secret: 123456789012345678n,
    nullifierPreimage: 42n,
    depositEpoch: 7284991002338477113n, // a PRF draw, so circuit 7 accepts it
    tokenMint: 0n,
    commitment: LEAVES[TARGET_LEAF],
    leafIndex: TARGET_LEAF,
    denomination: 1_000_000_000n,
    pool: POOL.poolPDA.toBase58(),
    token: 'SOL',
    denominationHuman: 1,
    shieldedAt: 0,
    merklePathElements: saved.pathElements,
    merklePathIndices: saved.pathIndices,
    merkleRoot: saved.root,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh in-memory history per test: IndexedDB does not exist here, and a
  // shared cache would let one test's leaves answer another's question.
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

describe('the v4 prepare names the root the pool is on NOW', () => {
  it('the fixture really is discriminating: the two roots differ and the ring holds both', () => {
    // ⛔ ANTI-VACUITY, FIRST. Everything below compares merkleRoot against
    // R_CUR. If the fixture's two roots were equal — one leaf, or a builder
    // that ignored the slice — every assertion would pass no matter what the
    // prepare did, and the positive control would pass too.
    expect(R_OLD).not.toBe(R_CUR);
    expect(receipt().merkleRoot).toBe(R_OLD);

    // And the chain would have taken the stale one: it is in the ring. This is
    // why the guard cannot be left to the on-chain check. Read back from the
    // account bytes the prepare is served, through the production parser, so
    // a fixture that stopped carrying R_OLD in its ring goes red here.
    const parsed = parsePoolV3Account(POOL_ACCOUNT);
    expect(parsed).not.toBeNull();
    expect(hex(parsed!.currentRoot)).toBe(hex(goldilocksToLeBytes32(R_CUR)));
    expect(parsed!.historicalRoots.map(hex)).toContain(hex(goldilocksToLeBytes32(R_OLD)));
    expect(hex(parsed!.currentRoot)).not.toBe(hex(goldilocksToLeBytes32(R_OLD)));
  });

  it('names R_cur, not the R_old the receipt carries', async () => {
    const result = await prepareUnshieldV4(receipt(), RECIPIENT, POOL, connection());

    expect(result.merkleRoot).toBe(R_CUR);
    expect(result.merkleRoot).not.toBe(R_OLD);
  });

  it('an implementation that preferred the saved path would name the stale root (positive control)', async () => {
    // Three lines of the web twin's fast path. It is legal, it confirms on
    // chain, and it dates the deposit. Measuring it here is what proves the
    // assertion above can tell the two apart rather than agreeing with
    // whatever the code returns.
    const result = await prepareUnshieldV4(receipt(), RECIPIENT, POOL, connection());
    const preferSavedPath = (r: ShieldReceipt, fresh: bigint): bigint => r.merkleRoot ?? fresh;

    const mutant = preferSavedPath(receipt(), result.merkleRoot);

    // The chain's check would ACCEPT the mutant's root: it is one of the roots
    // the pool account the prepare was served holds (production parser)...
    const parsed = parsePoolV3Account(POOL_ACCOUNT)!;
    expect([parsed.currentRoot, ...parsed.historicalRoots].map(hex)).toContain(
      hex(goldilocksToLeBytes32(mutant)),
    );
    // ...and the assertion `names R_cur` makes is the one that refuses it.
    expect(() => expect(mutant).toBe(R_CUR)).toThrow();
    // ...and the real one does not do that.
    expect(result.merkleRoot).toBe(R_CUR);
  });

  it('rebuilds from events even when the receipt carries a complete path', async () => {
    // The mechanism, not just the value: a fast path would skip the scan. If
    // this ever stops being called, the root above stops being current.
    const conn = connection();
    const scanned = vi.spyOn(conn as unknown as { getSignaturesForAddress: () => unknown }, 'getSignaturesForAddress');

    const r = receipt();
    expect(r.merklePathElements).toHaveLength(15);
    await prepareUnshieldV4(r, RECIPIENT, POOL, conn);

    expect(scanned).toHaveBeenCalled();
  });

  it('the proof is bound to the path that reaches R_cur, not to the saved one', async () => {
    // The root is only half of it. A prepare that named R_cur but proved the
    // saved path would be refused on chain — and, worse, a prepare that named
    // R_cur and proved a path rebuilt at a DIFFERENT time would be a silent
    // mismatch. The eleven circuit levels (C7_SUBTREE_DEPTH) handed to the
    // prover must be the first eleven of the fresh path.
    const fresh = buildMerkleProofFromLeavesV3({
      leavesByIndex: LEAVES,
      targetLeafIndex: TARGET_LEAF,
    });
    await prepareUnshieldV4(receipt(), RECIPIENT, POOL, connection());

    const args = h.generateSpendProof.mock.calls[0];
    expect(args[4]).toEqual(fresh.pathElements.slice(0, 11).map(String));
    expect(args[5]).toEqual(fresh.pathIndices.slice(0, 11));
    // The saved path's first eleven levels are NOT the same, so this assertion
    // is not one the stale path could also satisfy.
    const saved = receipt();
    expect(args[4]).not.toEqual((saved.merklePathElements ?? []).slice(0, 11).map(String));
  });
});
