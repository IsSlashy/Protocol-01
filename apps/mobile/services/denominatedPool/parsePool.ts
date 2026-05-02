// Borsh parser for the on-chain `DenominatedPool` account.
//
// IMPORTANT: this parser is for `DenominatedPool` (Tornado-Cash style fixed
// denomination pool), NOT the base `ShieldedPool`. The two layouts differ:
//   * DenominatedPool inserts `denomination` (u64) + `epoch_delay` (u64)
//     between `token_mint` and `merkle_root` (+16 bytes).
//   * DenominatedPool inserts `note_count` (u64) between `total_shielded`
//     and `is_active` (+8 more, +24 bytes total from `is_active` onward).
//
// Layout (programs/zk_shielded/src/state/pool.rs ::DenominatedPool):
//   0   8     discriminator
//   8   32    authority (Pubkey)
//   40  32    token_mint (Pubkey)
//   72  8     denomination (u64 LE)              [DenominatedPool only]
//   80  8     epoch_delay (u64 LE)               [DenominatedPool only]
//   88  32    merkle_root
//   120 1     tree_depth
//   121 8     next_leaf_index (u64 LE)
//   129 32    vk_hash
//   161 8     total_shielded (u64 LE)
//   169 8     note_count (u64 LE)                [DenominatedPool only]
//   177 1     is_active
//   178 4     historical_roots Vec length (u32 LE)
//   182 N*32  historical_roots data
//   182+N*32  1   max_historical_roots (u8)
//   ... more fields after (created_at i64, last_tx_at i64, bump u8,
//       mature_note_count u64, last_maturity_update_epoch u64,
//       epoch_note_counts [u64; 32], epoch_note_start u64,
//       vk_hash_transfer [u8; 32], vk_update_slot i64, root_write_index u64,
//       vk_hash_escrow [u8; 32])
//
// We only decode the fields useful for diagnostics and the historical-root
// ring lookup; the rest are skipped.

export interface ParsedPool {
  authority: Uint8Array;          // 32 bytes
  tokenMint: Uint8Array;          // 32 bytes
  denomination: bigint;
  epochDelay: bigint;
  currentRoot: Uint8Array;        // 32 bytes
  treeDepth: number;
  nextLeafIndex: bigint;
  totalShielded: bigint;
  noteCount: bigint;
  isActive: boolean;
  historicalRoots: Uint8Array[];  // up to 100 entries of 32 bytes
  maxHistoricalRoots: number;
}

const OFFSET_DISC = 0;
const OFFSET_AUTHORITY = 8;
const OFFSET_TOKEN_MINT = OFFSET_AUTHORITY + 32;        // 40
const OFFSET_DENOMINATION = OFFSET_TOKEN_MINT + 32;     // 72
const OFFSET_EPOCH_DELAY = OFFSET_DENOMINATION + 8;     // 80
const OFFSET_MERKLE_ROOT = OFFSET_EPOCH_DELAY + 8;      // 88
const OFFSET_TREE_DEPTH = OFFSET_MERKLE_ROOT + 32;      // 120
const OFFSET_NEXT_LEAF_INDEX = OFFSET_TREE_DEPTH + 1;   // 121
const OFFSET_VK_HASH = OFFSET_NEXT_LEAF_INDEX + 8;      // 129
const OFFSET_TOTAL_SHIELDED = OFFSET_VK_HASH + 32;      // 161
const OFFSET_NOTE_COUNT = OFFSET_TOTAL_SHIELDED + 8;    // 169
const OFFSET_IS_ACTIVE = OFFSET_NOTE_COUNT + 8;         // 177
const OFFSET_HIST_ROOTS_LEN = OFFSET_IS_ACTIVE + 1;     // 178
const OFFSET_HIST_ROOTS_DATA = OFFSET_HIST_ROOTS_LEN + 4; // 182

const MIN_LEN_BEFORE_VEC = OFFSET_HIST_ROOTS_DATA;

/**
 * Parse a `DenominatedPool` account. Returns null on any structural problem so
 * callers can degrade gracefully rather than throw mid-flight.
 */
export function parsePoolAccount(data: Buffer | Uint8Array): ParsedPool | null {
  const buf = data instanceof Buffer ? data : Buffer.from(data);
  if (buf.length < MIN_LEN_BEFORE_VEC) return null;

  const authority = Uint8Array.from(buf.subarray(OFFSET_AUTHORITY, OFFSET_AUTHORITY + 32));
  const tokenMint = Uint8Array.from(buf.subarray(OFFSET_TOKEN_MINT, OFFSET_TOKEN_MINT + 32));
  const denomination = buf.readBigUInt64LE(OFFSET_DENOMINATION);
  const epochDelay = buf.readBigUInt64LE(OFFSET_EPOCH_DELAY);
  const currentRoot = Uint8Array.from(buf.subarray(OFFSET_MERKLE_ROOT, OFFSET_MERKLE_ROOT + 32));
  const treeDepth = buf[OFFSET_TREE_DEPTH];
  const nextLeafIndex = buf.readBigUInt64LE(OFFSET_NEXT_LEAF_INDEX);
  const totalShielded = buf.readBigUInt64LE(OFFSET_TOTAL_SHIELDED);
  const noteCount = buf.readBigUInt64LE(OFFSET_NOTE_COUNT);
  const isActive = buf[OFFSET_IS_ACTIVE] === 1;
  const histLen = buf.readUInt32LE(OFFSET_HIST_ROOTS_LEN);

  // Sanity: 100 is the protocol-level cap (DenominatedPool::MAX_HISTORICAL_ROOTS).
  // Anything above signals layout drift (program account schema changed) and we bail.
  if (histLen > 100) return null;
  const histEnd = OFFSET_HIST_ROOTS_DATA + histLen * 32;
  if (buf.length < histEnd + 1) return null;

  const historicalRoots: Uint8Array[] = [];
  for (let i = 0; i < histLen; i++) {
    const start = OFFSET_HIST_ROOTS_DATA + i * 32;
    historicalRoots.push(Uint8Array.from(buf.subarray(start, start + 32)));
  }

  const maxHistoricalRoots = buf[histEnd];

  return {
    authority,
    tokenMint,
    denomination,
    epochDelay,
    currentRoot,
    treeDepth,
    nextLeafIndex,
    totalShielded,
    noteCount,
    isActive,
    historicalRoots,
    maxHistoricalRoots,
  };
}

/**
 * V3 — `DenominatedPoolV3` account parser.
 *
 * The V3 pool struct in `programs/zk_shielded/src/state/pool_v3.rs` has the
 * SAME byte layout as v2 (`DenominatedPool`): authority, token_mint,
 * denomination, epoch_delay, merkle_root, tree_depth, next_leaf_index,
 * vk_hash, total_shielded, note_count, is_active, historical_roots Vec,
 * max_historical_roots. The differences are:
 *   - PDA seed is `denominated_pool_v3` (not `_v2`)
 *   - The off-chain merkle tree IS a real tree (subtrees maintained on-chain
 *     via C6 STARK proofs), so the historical_roots entries are computed via
 *     Goldilocks Poseidon t=3 instead of BN254 poseidon-lite
 *   - `is_valid_root` semantics on-chain are unchanged (membership in ring)
 *
 * Because the byte layout matches, we re-export the v2 parser as the V3
 * parser. If V3 ever adds fields (e.g. `vk_hash_c6`, `vk_hash_c3`), bump this
 * to a separate function with adjusted offsets and keep v2 untouched.
 */
export const parsePoolV3Account = parsePoolAccount;
export type ParsedPoolV3 = ParsedPool;

/** Convert a 32-byte buffer to lowercase hex with 0x prefix. */
export function bytesToHex(b: Uint8Array): string {
  let s = '0x';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** Compare a Uint8Array to a hex string (with or without 0x prefix). */
export function rootInRing(root: Uint8Array, ring: Uint8Array[]): number | null {
  for (let i = 0; i < ring.length; i++) {
    let match = true;
    for (let b = 0; b < 32; b++) {
      if (ring[i][b] !== root[b]) { match = false; break; }
    }
    if (match) return i;
  }
  return null;
}

/** Convert a bigint root (Goldilocks/Poseidon field element) to 32 LE bytes. */
export function bigintToLeBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  return out;
}
