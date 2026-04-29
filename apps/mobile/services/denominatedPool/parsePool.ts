// Borsh parser for the on-chain `ShieldedPool` account.
//
// Layout (programs/zk_shielded/src/state/pool.rs ::ShieldedPool):
//   8   discriminator
//   32  authority (Pubkey)
//   32  token_mint (Pubkey)
//   32  merkle_root
//   1   tree_depth
//   8   next_leaf_index (u64 LE)
//   32  vk_hash
//   8   total_shielded (u64 LE)
//   1   is_active
//   4   historical_roots Vec length (u32 LE)
//   N*32 historical_roots data
//   1   max_historical_roots
//   8   created_at (i64 LE)
//   8   last_tx_at (i64 LE)
//   2   relayer_fee_bps (u16 LE)
//   32  relayer
//   1   bump
//   8   vk_update_slot (i64 LE)
//   1+32 pending_authority Option<Pubkey>
//
// We only need the fields useful for diagnostics; the rest are skipped.

export interface ParsedPool {
  authority: Uint8Array;          // 32 bytes
  tokenMint: Uint8Array;          // 32 bytes
  currentRoot: Uint8Array;        // 32 bytes
  treeDepth: number;
  nextLeafIndex: bigint;
  totalShielded: bigint;
  isActive: boolean;
  historicalRoots: Uint8Array[];  // up to 100 entries of 32 bytes
  maxHistoricalRoots: number;
}

const OFFSET_DISC = 0;
const OFFSET_AUTHORITY = 8;
const OFFSET_TOKEN_MINT = OFFSET_AUTHORITY + 32; // 40
const OFFSET_MERKLE_ROOT = OFFSET_TOKEN_MINT + 32; // 72
const OFFSET_TREE_DEPTH = OFFSET_MERKLE_ROOT + 32; // 104
const OFFSET_NEXT_LEAF_INDEX = OFFSET_TREE_DEPTH + 1; // 105
const OFFSET_VK_HASH = OFFSET_NEXT_LEAF_INDEX + 8; // 113
const OFFSET_TOTAL_SHIELDED = OFFSET_VK_HASH + 32; // 145
const OFFSET_IS_ACTIVE = OFFSET_TOTAL_SHIELDED + 8; // 153
const OFFSET_HIST_ROOTS_LEN = OFFSET_IS_ACTIVE + 1; // 154
const OFFSET_HIST_ROOTS_DATA = OFFSET_HIST_ROOTS_LEN + 4; // 158

const MIN_LEN_BEFORE_VEC = OFFSET_HIST_ROOTS_DATA;

/**
 * Parse a `ShieldedPool` account. Returns null on any structural problem so
 * callers can degrade gracefully rather than throw mid-flight.
 */
export function parsePoolAccount(data: Buffer | Uint8Array): ParsedPool | null {
  const buf = data instanceof Buffer ? data : Buffer.from(data);
  if (buf.length < MIN_LEN_BEFORE_VEC) return null;

  const authority = Uint8Array.from(buf.subarray(OFFSET_AUTHORITY, OFFSET_AUTHORITY + 32));
  const tokenMint = Uint8Array.from(buf.subarray(OFFSET_TOKEN_MINT, OFFSET_TOKEN_MINT + 32));
  const currentRoot = Uint8Array.from(buf.subarray(OFFSET_MERKLE_ROOT, OFFSET_MERKLE_ROOT + 32));
  const treeDepth = buf[OFFSET_TREE_DEPTH];
  const nextLeafIndex = buf.readBigUInt64LE(OFFSET_NEXT_LEAF_INDEX);
  const totalShielded = buf.readBigUInt64LE(OFFSET_TOTAL_SHIELDED);
  const isActive = buf[OFFSET_IS_ACTIVE] === 1;
  const histLen = buf.readUInt32LE(OFFSET_HIST_ROOTS_LEN);

  // Sanity: 100 is the protocol-level cap. Anything wildly higher signals a
  // layout drift (program account schema changed) and we bail.
  if (histLen > 200) return null;
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
    currentRoot,
    treeDepth,
    nextLeafIndex,
    totalShielded,
    isActive,
    historicalRoots,
    maxHistoricalRoots,
  };
}

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
