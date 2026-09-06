/**
 * [ERAS / DEPTH-19 / RING-255 2026-09-06] Builders for the five pool
 * instructions that make a pool never fill, plus the `PoolDirectory` reader.
 *
 * Program side: `programs/zk_shielded/src/instructions/{migrate_tree_depth,
 * migrate_pool_capacity, init_pool_directory, init_pool_era, open_next_era}.rs`
 * and `state/pool_directory.rs`. Account orders and argument layouts below are
 * pinned against that Rust by `poolEras.test.ts`; do not retype them from
 * memory. Byte-for-byte twin of `apps/web/lib/privacy/pool/poolEras.ts`
 * (only the import path differs); change them together.
 *
 * What a deposit client does with this (wired in a later lot, not here):
 *   1. `derivePoolDirectoryPDA(mint, denomination)` → `getAccountInfo` →
 *      `parsePoolDirectory`. No account = era 0 = the pool the registry names.
 *   2. Deposit into `activePool`. Read its tree's `depth` for the C6 witness
 *      and `tree_depth - 11` siblings on every spend.
 *   3. If the tree is within `marginLeaves` of `2^depth`, send
 *      `buildOpenNextEraIx` first (anyone may; the payer covers ~0.07 SOL of
 *      rent) and deposit into the era it opens.
 *
 * ⛔ Era 0 keeps the THREE-seed address every registry hardcodes today. Era
 * `n >= 1` appends `n` as a little-endian u16 fourth seed. Nothing else about
 * the pool layout changed: `parsePoolV3Account` still reads it, except that its
 * `histLen > 100` guard must become `> 255` once the ring is migrated.
 */

import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { ZK_SHIELDED_PROGRAM_ID } from './denominatedPool';

/** `DenominatedPoolV3::SEED_PREFIX`. Same literal the registry pools were derived with. */
export const POOL_SEED_PREFIX = 'denominated_pool_v4';
/** `MerkleTreeStateV3::SEED_PREFIX`. */
export const MERKLE_TREE_SEED_PREFIX = 'merkle_tree_v4';
/** `PoolDirectory::SEED_PREFIX`. */
export const POOL_DIRECTORY_SEED_PREFIX = 'pool_directory';

/** `MerkleTreeStateV3::MAX_DEPTH` = `INSERT_SUBTREE_DEPTH (11) + MAX_TOP_LEVELS (8)`. */
export const MAX_TREE_DEPTH = 19;
/** `DenominatedPoolV3::ERA_TREE_DEPTH`: era pools are born at the ceiling. */
export const ERA_TREE_DEPTH = 19;
/** `DenominatedPoolV3::MAX_HISTORICAL_ROOTS` after the migration; legacy pools carry 100 until migrated. */
export const MAX_HISTORICAL_ROOTS = 255;
/** `PoolDirectory::DEFAULT_MARGIN_LEAVES`. */
export const DEFAULT_MARGIN_LEAVES = 1_024n;
/** `PoolDirectory::LEN`. */
export const POOL_DIRECTORY_LEN = 123;
/** The circuit depth both C6 and C7 prove; siblings on the wire = `treeDepth - SPEND_SUBTREE_DEPTH`. */
export const SPEND_SUBTREE_DEPTH = 11;
/** Newest ring roots lifted by `migrate_tree_depth` when the caller does not say: 7 x ~138k CU + the current root < 1.4M. */
export const DEFAULT_KEEP_ROOTS_ON_MIGRATE = 7;

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}
function u16le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}
function readU64LE(d: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
}

/** Anchor instruction discriminator: `sha256("global:<name>")[0..8]`. */
export function instructionDiscriminator(name: string): Uint8Array {
  return sha256(utf8ToBytes(`global:${name}`)).slice(0, 8);
}
/** Anchor account discriminator: `sha256("account:<Name>")[0..8]`. */
export function accountDiscriminator(name: string): Uint8Array {
  return sha256(utf8ToBytes(`account:${name}`)).slice(0, 8);
}

/**
 * The pool PDA of `(tokenMint, denomination, era)`. Era 0 is the legacy
 * three-seed address; era `n >= 1` adds `n` as a u16 LE fourth seed.
 * Mirrors `DenominatedPoolV3::pool_pda`.
 */
export function derivePoolEraPDA(
  tokenMint: PublicKey,
  denominationAtomic: bigint,
  era: number,
  programId: PublicKey = ZK_SHIELDED_PROGRAM_ID,
): [PublicKey, number] {
  if (!Number.isInteger(era) || era < 0 || era > 0xffff) {
    throw new Error(`era must be a u16, got ${era}`);
  }
  const seeds: Uint8Array[] = [
    utf8ToBytes(POOL_SEED_PREFIX),
    tokenMint.toBytes(),
    u64le(denominationAtomic),
  ];
  if (era > 0) seeds.push(u16le(era));
  return PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), programId);
}

/** `[b"merkle_tree_v4", pool]`. */
export function deriveMerkleTreePDA(
  pool: PublicKey,
  programId: PublicKey = ZK_SHIELDED_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(utf8ToBytes(MERKLE_TREE_SEED_PREFIX)), pool.toBuffer()],
    programId,
  );
}

/** `[b"pool_directory", tokenMint, denomination_le]`. Mirrors `PoolDirectory::pda`. */
export function derivePoolDirectoryPDA(
  tokenMint: PublicKey,
  denominationAtomic: bigint,
  programId: PublicKey = ZK_SHIELDED_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(utf8ToBytes(POOL_DIRECTORY_SEED_PREFIX)),
      tokenMint.toBuffer(),
      Buffer.from(u64le(denominationAtomic)),
    ],
    programId,
  );
}

export interface ParsedPoolDirectory {
  authority: PublicKey;
  tokenMint: PublicKey;
  denomination: bigint;
  activeEra: number;
  activePool: PublicKey;
  marginLeaves: bigint;
  bump: number;
}

/**
 * Layout of `PoolDirectory` (Borsh, after the 8-byte discriminator):
 *   8:40 authority | 40:72 token_mint | 72:80 denomination | 80:82 active_era
 *   82:114 active_pool | 114:122 margin_leaves | 122 bump
 * Returns null on a wrong discriminator or a short buffer.
 */
export function parsePoolDirectory(data: Uint8Array): ParsedPoolDirectory | null {
  if (data.length < POOL_DIRECTORY_LEN) return null;
  const disc = accountDiscriminator('PoolDirectory');
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return null;
  return {
    authority: new PublicKey(data.slice(8, 40)),
    tokenMint: new PublicKey(data.slice(40, 72)),
    denomination: readU64LE(data, 72),
    activeEra: data[80] | (data[81] << 8),
    activePool: new PublicKey(data.slice(82, 114)),
    marginLeaves: readU64LE(data, 114),
    bump: data[122],
  };
}

/**
 * Whether `open_next_era` would succeed now: `leafCount + marginLeaves >= 2^depth`.
 * The same arithmetic the handler runs, so a client can decide without a
 * simulation.
 */
export function eraMarginReached(leafCount: bigint, treeDepth: number, marginLeaves: bigint): boolean {
  return leafCount + marginLeaves >= 1n << BigInt(treeDepth);
}

/**
 * `open_next_era`. Permissionless; `payer` covers the rent of the new pool
 * and tree when they do not exist yet. Account order = `OpenNextEra<'info>`.
 */
export function buildOpenNextEraIx(p: {
  payer: PublicKey;
  tokenMint: PublicKey;
  denominationAtomic: bigint;
  activeEra: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? ZK_SHIELDED_PROGRAM_ID;
  const [directory] = derivePoolDirectoryPDA(p.tokenMint, p.denominationAtomic, programId);
  const [activePool] = derivePoolEraPDA(p.tokenMint, p.denominationAtomic, p.activeEra, programId);
  const [activeTree] = deriveMerkleTreePDA(activePool, programId);
  const [nextPool] = derivePoolEraPDA(p.tokenMint, p.denominationAtomic, p.activeEra + 1, programId);
  const [nextTree] = deriveMerkleTreePDA(nextPool, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: directory, isSigner: false, isWritable: true },
      { pubkey: activePool, isSigner: false, isWritable: false },
      { pubkey: activeTree, isSigner: false, isWritable: false },
      { pubkey: nextPool, isSigner: false, isWritable: true },
      { pubkey: nextTree, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(instructionDiscriminator('open_next_era')),
  });
}

/**
 * `migrate_tree_depth(new_depth: u8, keep_roots: u8)`. Authority-only.
 * Account order = `MigrateTreeDepth<'info>`.
 *
 * `keepRoots` is how many of the NEWEST historical roots are lifted to the new
 * depth (the rest are dropped): each costs `(newDepth - oldDepth)` Poseidon
 * hashes at ~34,469 CU, so 15 -> 19 is ~138,000 CU per root and the default
 * of 7 plus the current root stays under the 1.4M transaction cap. Send a
 * `setComputeUnitLimit(1_400_000)` ahead of it.
 */
export function buildMigrateTreeDepthIx(p: {
  authority: PublicKey;
  pool: PublicKey;
  newDepth: number;
  keepRoots?: number;
  programId?: PublicKey;
}): TransactionInstruction {
  if (!Number.isInteger(p.newDepth) || p.newDepth <= SPEND_SUBTREE_DEPTH || p.newDepth > MAX_TREE_DEPTH) {
    throw new Error(`newDepth must be in (${SPEND_SUBTREE_DEPTH}, ${MAX_TREE_DEPTH}], got ${p.newDepth}`);
  }
  const keepRoots = p.keepRoots ?? DEFAULT_KEEP_ROOTS_ON_MIGRATE;
  if (!Number.isInteger(keepRoots) || keepRoots < 0 || keepRoots > 255) {
    throw new Error(`keepRoots must be a u8, got ${keepRoots}`);
  }
  const programId = p.programId ?? ZK_SHIELDED_PROGRAM_ID;
  const [tree] = deriveMerkleTreePDA(p.pool, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: false },
      { pubkey: p.pool, isSigner: false, isWritable: true },
      { pubkey: tree, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      Buffer.from(instructionDiscriminator('migrate_tree_depth')),
      Buffer.from([p.newDepth, keepRoots]),
    ]),
  });
}

/** `migrate_pool_capacity()`. Authority-only, idempotent. Account order = `MigratePoolCapacity<'info>`. */
export function buildMigratePoolCapacityIx(p: {
  authority: PublicKey;
  pool: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? ZK_SHIELDED_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: true },
      { pubkey: p.pool, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(instructionDiscriminator('migrate_pool_capacity')),
  });
}

/**
 * `init_pool_directory(margin_leaves: u64)` for an existing era-0 pool.
 * `marginLeaves` of 0n selects the program default. Account order =
 * `InitPoolDirectory<'info>`.
 */
export function buildInitPoolDirectoryIx(p: {
  authority: PublicKey;
  tokenMint: PublicKey;
  denominationAtomic: bigint;
  marginLeaves?: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? ZK_SHIELDED_PROGRAM_ID;
  const [pool] = derivePoolEraPDA(p.tokenMint, p.denominationAtomic, 0, programId);
  const [tree] = deriveMerkleTreePDA(pool, programId);
  const [directory] = derivePoolDirectoryPDA(p.tokenMint, p.denominationAtomic, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: tree, isSigner: false, isWritable: false },
      { pubkey: directory, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(instructionDiscriminator('init_pool_directory')),
      Buffer.from(u64le(p.marginLeaves ?? 0n)),
    ]),
  });
}

/**
 * `init_pool_era(vk_hash, token_mint, denomination, epoch_delay, era: u16)`,
 * the manual path (directory authority). Account order = `InitPoolEra<'info>`.
 */
export function buildInitPoolEraIx(p: {
  authority: PublicKey;
  tokenMint: PublicKey;
  denominationAtomic: bigint;
  epochDelay: bigint;
  era: number;
  vkHash?: Uint8Array;
  programId?: PublicKey;
}): TransactionInstruction {
  if (p.era < 1) throw new Error('init_pool_era is for era >= 1; era 0 is init_denominated_pool_v3');
  const programId = p.programId ?? ZK_SHIELDED_PROGRAM_ID;
  const [directory] = derivePoolDirectoryPDA(p.tokenMint, p.denominationAtomic, programId);
  const [pool] = derivePoolEraPDA(p.tokenMint, p.denominationAtomic, p.era, programId);
  const [tree] = deriveMerkleTreePDA(pool, programId);
  const vk = p.vkHash ?? new Uint8Array(32);
  if (vk.length !== 32) throw new Error('vkHash must be 32 bytes');
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: true },
      { pubkey: directory, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: tree, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(instructionDiscriminator('init_pool_era')),
      Buffer.from(vk),
      p.tokenMint.toBuffer(),
      Buffer.from(u64le(p.denominationAtomic)),
      Buffer.from(u64le(p.epochDelay)),
      Buffer.from(u16le(p.era)),
    ]),
  });
}

// The rent sysvar is what `init_denominated_pool_v3` takes; none of the five
// instructions above do. Re-exported so a caller building both does not import
// two modules for one constant.
export { SYSVAR_RENT_PUBKEY };
