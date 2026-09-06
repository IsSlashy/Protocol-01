/**
 * [ERAS / DEPTH-19 2026-09-06] Which pool takes a deposit, which pool a note
 * lives in, and how a path recorded at one depth is read at another.
 *
 * Three facts this module exists to hold in one place:
 *
 *   1. A denomination is no longer ONE pool. `PoolDirectory(mint, denomination)`
 *      names the era whose pool takes deposits now; era 0 is the pool every
 *      registry hardcodes, era `n >= 1` is derived (`derivePoolEraPDA`). No
 *      directory on chain means era 0, which is every pool that exists today.
 *
 *   2. A note names its pool. `ShieldReceipt.pool` has always carried the pool
 *      PDA; spends must resolve the pool from THAT, never from
 *      `findPoolV3(token, denomination)`, which only knows era 0.
 *
 *   3. The tree depth is read, not assumed. `MERKLE_DEPTH = 15` is the depth the
 *      registry pools were born with; `migrate_tree_depth` lifts them to 19 and
 *      era pools are born at 19. A path built or stored at depth 15 is extended
 *      through the zero levels (`extendMerklePathToDepth`), which is exactly
 *      what the migration did to the roots on chain.
 *
 * Nothing here signs or sends. `openNextEraIfDue` takes a `send` callback so
 * the wallet-signing surfaces (extension, mobile) and the ephemeral-signing
 * web worker share the decision and differ only in who pays.
 */

import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

import {
  ALL_POOLS_V3,
  MERKLE_DEPTH,
  MAX_TREE_DEPTH,
  type PoolConfig,
  computeZeroHashesV3,
  parseFilledSubtrees,
  poseidonHash2,
} from './denominatedPool';
import {
  DEFAULT_MARGIN_LEAVES,
  ERA_TREE_DEPTH,
  buildOpenNextEraIx,
  deriveMerkleTreePDA,
  derivePoolDirectoryPDA,
  derivePoolEraPDA,
  eraMarginReached,
  parsePoolDirectory,
  type ParsedPoolDirectory,
} from './poolEras';

/**
 * Rent `open_next_era` charges the payer for the two accounts it creates
 * (pool 8,720 B + tree 760 B at 6,960 lamports/byte-year × 2 years + fee),
 * measured ≈ 0.068 SOL by the program's litesvm harness; rounded up so a float
 * that budgets it never comes up short by a fee.
 */
export const OPEN_NEXT_ERA_RENT_LAMPORTS = 75_000_000;

/** How many eras `findPoolByPDA` will derive when a note names a pool the registry does not list. */
export const MAX_ERA_SCAN = 512;

// ---------------------------------------------------------------------------
// Pool configs for eras
// ---------------------------------------------------------------------------

/**
 * The `PoolConfig` of era `era` of `base`'s denomination. Era 0 is `base`
 * itself. For `era >= 1` the pool and tree PDAs are derived and the SPL vault
 * is left undefined so the existing lazy `getAssociatedTokenAddress(mint, pool,
 * true)` in the send paths derives it for the new pool. Every other field
 * (token, denomination, decimals, deposits flag) is inherited.
 */
export function eraPoolConfig(base: PoolConfig, era: number, poolPDA?: PublicKey): PoolConfig {
  if (era === 0 && (!poolPDA || poolPDA.equals(base.poolPDA))) return base;
  const pool = poolPDA ?? derivePoolEraPDA(base.tokenMint, base.denominationAtomic, era)[0];
  const [tree] = deriveMerkleTreePDA(pool);
  return {
    ...base,
    poolPDA: pool,
    treePDA: tree,
    vaultATA: undefined,
    era,
  };
}

const byPdaCache = new Map<string, PoolConfig>();

/**
 * The pool a note lives in, from the PDA it recorded. The registry answers for
 * era 0; anything else is derived from the hint's denomination (a note always
 * carries `token` + `denominationHuman`), scanning eras 1..MAX_ERA_SCAN, or —
 * without a hint — every registry denomination. Results are cached; a miss
 * returns undefined rather than guessing.
 */
export function findPoolByPDA(
  poolPDA: string,
  hint?: { token?: 'SOL' | 'USDC'; denominationHuman?: number; era?: number },
): PoolConfig | undefined {
  const exact = ALL_POOLS_V3.find((p) => p.poolPDA.toBase58() === poolPDA);
  if (exact) return exact;
  const cached = byPdaCache.get(poolPDA);
  if (cached) return cached;

  const bases = ALL_POOLS_V3.filter(
    (p) =>
      (hint?.token === undefined || p.token === hint.token) &&
      (hint?.denominationHuman === undefined || p.denomination === hint.denominationHuman),
  );
  const eras = hint?.era !== undefined && hint.era >= 1 ? [hint.era] : null;
  for (const base of bases) {
    const candidates = eras ?? Array.from({ length: MAX_ERA_SCAN }, (_, i) => i + 1);
    for (const era of candidates) {
      const [pda] = derivePoolEraPDA(base.tokenMint, base.denominationAtomic, era);
      if (pda.toBase58() === poolPDA) {
        const cfg = eraPoolConfig(base, era, pda);
        byPdaCache.set(poolPDA, cfg);
        return cfg;
      }
    }
  }
  return undefined;
}

/** `findPoolByPDA` for the shape every receipt and stored note has. */
export function poolConfigForNote(note: {
  pool: string;
  token?: 'SOL' | 'USDC';
  denominationHuman?: number;
  era?: number;
}): PoolConfig | undefined {
  return findPoolByPDA(note.pool, {
    token: note.token,
    denominationHuman: note.denominationHuman,
    era: note.era,
  });
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

export interface TreeState {
  leafCount: number;
  depth: number;
  era: number;
  subtrees: bigint[];
  /** Low 8 bytes of `MerkleTreeStateV3.root`, as a Goldilocks felt. */
  root: bigint;
}

/** `MerkleTreeStateV3` as the deposit witness needs it; null when the account does not exist. */
export async function readTreeState(connection: Connection, treePDA: PublicKey): Promise<TreeState | null> {
  const info = await connection.getAccountInfo(treePDA, 'confirmed');
  if (!info) return null;
  return parseTreeState(new Uint8Array(info.data));
}

export function parseTreeState(data: Uint8Array): TreeState {
  const buf = Buffer.from(data);
  const { leafCount, subtrees, depth, era } = parseFilledSubtrees(buf);
  let root = 0n;
  for (let b = 7; b >= 0; b--) root = (root << 8n) | BigInt(buf[8 + 32 + b]);
  return { leafCount, depth, era, subtrees, root };
}

/** The state of a tree nobody has deposited into yet, at `depth`. `open_next_era` creates exactly this. */
export function emptyTreeState(depth: number, era: number): TreeState {
  const zeros = computeZeroHashesV3();
  return {
    leafCount: 0,
    depth,
    era,
    subtrees: zeros.slice(0, depth + 1),
    root: zeros[depth],
  };
}

export async function readPoolDirectory(
  connection: Connection,
  base: Pick<PoolConfig, 'tokenMint' | 'denominationAtomic'>,
): Promise<ParsedPoolDirectory | null> {
  const [pda] = derivePoolDirectoryPDA(base.tokenMint, base.denominationAtomic);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info) return null;
  return parsePoolDirectory(new Uint8Array(info.data));
}

// ---------------------------------------------------------------------------
// The deposit decision
// ---------------------------------------------------------------------------

export type DepositPlan =
  /** Deposit into the pool the directory names (or era 0 when there is none). */
  | { action: 'deposit'; pool: PoolConfig; tree: TreeState }
  /**
   * The active tree is within the margin: send `open_next_era` first, then
   * deposit into `pool` (era + 1), whose tree is `emptyTreeState` until the
   * instruction lands. `payer` funds ≈ OPEN_NEXT_ERA_RENT_LAMPORTS of rent.
   */
  | { action: 'open-then-deposit'; pool: PoolConfig; tree: TreeState; openIx: (payer: PublicKey) => TransactionInstruction }
  /** The active tree is full and no directory exists to open the next era: refuse before rent is spent. */
  | { action: 'full'; pool: PoolConfig; tree: TreeState; reason: string };

export interface ActivePoolView {
  base: PoolConfig;
  directory: ParsedPoolDirectory | null;
  active: PoolConfig;
  tree: TreeState;
  maxLeaves: bigint;
  marginLeaves: bigint;
  plan: DepositPlan;
}

/**
 * Pure: given what the chain says, decide where a deposit goes. Pinned by
 * `poolEraResolver.test.ts` in all three branches.
 */
export function planDeposit(p: {
  base: PoolConfig;
  directory: ParsedPoolDirectory | null;
  activeTree: TreeState;
}): DepositPlan {
  const { base, directory, activeTree } = p;
  const active = directory ? eraPoolConfig(base, directory.activeEra, directory.activePool) : base;
  const maxLeaves = 1n << BigInt(activeTree.depth);
  const margin = directory?.marginLeaves ?? DEFAULT_MARGIN_LEAVES;

  if (!directory) {
    if (BigInt(activeTree.leafCount) >= maxLeaves) {
      return {
        action: 'full',
        pool: active,
        tree: activeTree,
        reason:
          `The ${base.denomination} ${base.token} pool holds ${activeTree.leafCount} of ${maxLeaves} leaves and has ` +
          'no PoolDirectory yet, so no next era can be opened. Run migratePools.mts (init_pool_directory) first.',
      };
    }
    return { action: 'deposit', pool: active, tree: activeTree };
  }

  if (eraMarginReached(BigInt(activeTree.leafCount), activeTree.depth, margin)) {
    const next = eraPoolConfig(base, directory.activeEra + 1);
    const activeEra = directory.activeEra;
    return {
      action: 'open-then-deposit',
      pool: next,
      tree: emptyTreeState(ERA_TREE_DEPTH, activeEra + 1),
      openIx: (payer) =>
        buildOpenNextEraIx({
          payer,
          tokenMint: base.tokenMint,
          denominationAtomic: base.denominationAtomic,
          activeEra,
        }),
    };
  }
  return { action: 'deposit', pool: active, tree: activeTree };
}

/**
 * Read the directory and the active tree, and plan the deposit. One or two
 * RPC reads. When the directory already points at an era whose pool exists,
 * that pool's real tree state is returned (someone else opened it).
 */
export async function resolveActivePool(connection: Connection, base: PoolConfig): Promise<ActivePoolView> {
  const directory = await readPoolDirectory(connection, base);
  const active = directory ? eraPoolConfig(base, directory.activeEra, directory.activePool) : base;
  const tree = await readTreeState(connection, active.treePDA);
  if (!tree) {
    throw new Error(
      `Tree account not found for ${base.denomination} ${base.token} era ${active.era ?? 0}: ${active.treePDA.toBase58()}`,
    );
  }
  let plan = planDeposit({ base, directory, activeTree: tree });
  if (plan.action === 'open-then-deposit') {
    // If the next era's tree already exists (opened early, or by a racing
    // client), deposit into its REAL state rather than the empty one.
    const existing = await readTreeState(connection, plan.pool.treePDA);
    if (existing) plan = { action: 'deposit', pool: plan.pool, tree: existing };
  }
  return {
    base,
    directory,
    active,
    tree,
    maxLeaves: 1n << BigInt(tree.depth),
    marginLeaves: directory?.marginLeaves ?? DEFAULT_MARGIN_LEAVES,
    plan,
  };
}

/**
 * For surfaces whose wallet signs directly: open the next era when due, then
 * return the pool to deposit into. `send` submits one instruction and resolves
 * when it is confirmed; a `DirectoryMismatch` (6066) from the chain means
 * somebody opened it first, which is success for our purposes.
 */
export async function openNextEraIfDue(
  connection: Connection,
  base: PoolConfig,
  payer: PublicKey,
  send: (ix: TransactionInstruction) => Promise<string>,
  onProgress?: (step: string) => void,
): Promise<{ pool: PoolConfig; opened: boolean; txSig?: string }> {
  const view = await resolveActivePool(connection, base);
  if (view.plan.action === 'full') throw new Error(view.plan.reason);
  if (view.plan.action === 'deposit') return { pool: view.plan.pool, opened: false };

  onProgress?.(
    `The ${base.denomination} ${base.token} pool is within ${view.marginLeaves} leaves of full — opening era ${view.plan.pool.era}...`,
  );
  let txSig: string | undefined;
  try {
    txSig = await send(view.plan.openIx(payer));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/6066|DirectoryMismatch|already/i.test(msg)) throw err;
  }
  // Re-read: the directory now names the era we (or someone) opened.
  const after = await resolveActivePool(connection, base);
  if (after.plan.action === 'full') throw new Error(after.plan.reason);
  return { pool: after.plan.pool, opened: txSig !== undefined, txSig };
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

export interface MerklePathLike {
  pathElements: bigint[];
  pathIndices: number[];
  root: bigint;
}

/**
 * Lift `root` (a depth-`fromDepth` root) to depth `toDepth` by hashing it with
 * the zero subtree at each new level, as the left child. This is what
 * `migrate_tree_depth` does to every root it keeps, so a note's stored root
 * lifted this way is the root the pool's ring now holds.
 */
export function liftRootToDepth(root: bigint, fromDepth: number, toDepth: number): bigint {
  if (toDepth < fromDepth) throw new Error(`cannot lower a root from depth ${fromDepth} to ${toDepth}`);
  const zeros = computeZeroHashesV3();
  let cur = root;
  for (let level = fromDepth; level < toDepth; level++) cur = poseidonHash2(cur, zeros[level]);
  return cur;
}

/**
 * A path recorded at depth `path.pathElements.length` read at `treeDepth`:
 * the extra levels are zero siblings with direction 0 (the migrated pool is a
 * left subtree of the deeper tree) and the root is lifted accordingly. A path
 * already at or beyond `treeDepth` is returned unchanged.
 */
export function extendMerklePathToDepth<T extends MerklePathLike>(path: T, treeDepth: number): T {
  const have = path.pathElements.length;
  if (have >= treeDepth) return path;
  if (treeDepth > MAX_TREE_DEPTH) throw new Error(`treeDepth ${treeDepth} exceeds MAX_TREE_DEPTH ${MAX_TREE_DEPTH}`);
  const zeros = computeZeroHashesV3();
  const pathElements = [...path.pathElements];
  const pathIndices = [...path.pathIndices];
  for (let level = have; level < treeDepth; level++) {
    pathElements.push(zeros[level]);
    pathIndices.push(0);
  }
  return { ...path, pathElements, pathIndices, root: liftRootToDepth(path.root, have, treeDepth) };
}

/** Stored paths keep strings; same extension, string in, string out. */
export function extendStoredPathToDepth(
  path: { pathElements: string[]; pathIndices: number[]; root: string },
  treeDepth: number,
): { pathElements: string[]; pathIndices: number[]; root: string } {
  if (path.pathElements.length >= treeDepth) return path;
  const out = extendMerklePathToDepth(
    { pathElements: path.pathElements.map((e) => BigInt(e)), pathIndices: path.pathIndices, root: BigInt(path.root) },
    treeDepth,
  );
  return { pathElements: out.pathElements.map((e) => e.toString()), pathIndices: out.pathIndices, root: out.root.toString() };
}

/** `tree_depth` byte of a `DenominatedPoolV3` account, or the legacy default when the buffer is too short. */
export function treeDepthOfPoolAccount(data: Uint8Array | null | undefined): number {
  if (!data || data.length < 121) return MERKLE_DEPTH;
  const d = data[120];
  return d >= 1 && d <= MAX_TREE_DEPTH ? d : MERKLE_DEPTH;
}

/** Human line for a pool chip: "1,234 / 524,288 leaves (era 2)". */
export function describeCapacity(view: Pick<ActivePoolView, 'tree' | 'maxLeaves' | 'active'>): string {
  const era = view.active.era ?? 0;
  return `${view.tree.leafCount.toLocaleString('en-US')} / ${view.maxLeaves.toLocaleString('en-US')} leaves` + (era > 0 ? ` (era ${era})` : '');
}
