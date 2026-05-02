#!/usr/bin/env node
/**
 * parser-side-by-side.mjs
 *
 * Hard, empirical, side-by-side comparison of:
 *   BROKEN parser  -> apps/mobile/services/denominatedPool/parsePool.ts (ShieldedPool offsets)
 *   FIXED  parser  -> shifted offsets matching DenominatedPool layout
 *
 * Same on-chain account bytes are passed through both, on the SOL 0.1 and
 * SOL 1 pools. The fixed parser is also cross-checked against fetchPoolInfo()
 * logic (replicated inline) on overlapping fields.
 *
 * Pool layout (DenominatedPool, programs/zk_shielded/src/state/pool.rs):
 *   8    discriminator
 *   32   authority (Pubkey)
 *   32   token_mint (Pubkey)
 *   8    denomination (u64 LE)
 *   8    epoch_delay (u64 LE)
 *   32   merkle_root
 *   1    tree_depth
 *   8    next_leaf_index (u64 LE)
 *   32   vk_hash
 *   8    total_shielded (u64 LE)
 *   8    note_count (u64 LE)
 *   1    is_active
 *   4+N  historical_roots Vec<[u8; 32]>
 *   1    max_historical_roots
 *   8    created_at, 8 last_tx_at, 1 bump, ... (tail)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// RPC endpoint
// ---------------------------------------------------------------------------

function loadHeliusKey() {
  const candidates = [
    path.resolve(__dirname, '../apps/mobile/.env.local'),
    path.resolve(__dirname, '../apps/mobile/.env'),
    path.resolve(__dirname, '../.env'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/^EXPO_PUBLIC_HELIUS_API_KEY=(.+)$/m);
    if (m && m[1].trim()) return { key: m[1].trim(), source: p };
  }
  return null;
}

const heliusKey = loadHeliusKey();
const RPC_URL = heliusKey
  ? `https://devnet.helius-rpc.com/?api-key=${heliusKey.key}`
  : 'https://api.devnet.solana.com';
console.log(
  heliusKey
    ? `[rpc] using Helius devnet (key from ${heliusKey.source})`
    : '[rpc] WARNING: no Helius key found, falling back to public devnet RPC'
);

// ---------------------------------------------------------------------------
// Pools under test
// ---------------------------------------------------------------------------

const POOLS = [
  { token: 'SOL', denomination: 0.1, pda: 'HkzArVjUuZTRZPzCP7jAm5Fe6R9yrRAsmWZmDArY43FN' },
  { token: 'SOL', denomination: 1,   pda: '43mLkfHhwtNYxr3YFk51aoZRQXJj75Md3VuoLaPjx2kN' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(buf, off, len) {
  let s = '0x';
  for (let i = 0; i < len; i++) s += buf[off + i].toString(16).padStart(2, '0');
  return s;
}

function fmtBig(n) { return n === undefined || n === null ? '-' : String(n); }
function shortHex(h, n = 12) {
  if (!h || h === 'N/A' || h.startsWith('<')) return h;
  return h.length <= 2 + n * 2 + 4 ? h : `${h.slice(0, 2 + n)}…${h.slice(-n)}`;
}

// ---------------------------------------------------------------------------
// BROKEN parser: ShieldedPool offsets (current parsePool.ts)
// ---------------------------------------------------------------------------
const B_OFFSET_AUTHORITY        = 8;
const B_OFFSET_TOKEN_MINT       = 40;
const B_OFFSET_MERKLE_ROOT      = 72;
const B_OFFSET_TREE_DEPTH       = 104;
const B_OFFSET_NEXT_LEAF_INDEX  = 105;
const B_OFFSET_VK_HASH          = 113;
const B_OFFSET_TOTAL_SHIELDED   = 145;
const B_OFFSET_IS_ACTIVE        = 153;
const B_OFFSET_HIST_ROOTS_LEN   = 154;
const B_OFFSET_HIST_ROOTS_DATA  = 158;

function parsePoolBROKEN(buf) {
  if (buf.length < B_OFFSET_HIST_ROOTS_DATA) return { error: 'too short' };
  const treeDepth     = buf[B_OFFSET_TREE_DEPTH];
  const nextLeafIndex = buf.readBigUInt64LE(B_OFFSET_NEXT_LEAF_INDEX);
  const totalShielded = buf.readBigUInt64LE(B_OFFSET_TOTAL_SHIELDED);
  const isActive      = buf[B_OFFSET_IS_ACTIVE] === 1;
  const histLen       = buf.readUInt32LE(B_OFFSET_HIST_ROOTS_LEN);

  // Same sanity bail as parsePool.ts (>200 returns null)
  if (histLen > 200) {
    return {
      bailed: true,
      currentRoot: bytesToHex(buf, B_OFFSET_MERKLE_ROOT, 32),
      treeDepth,
      nextLeafIndex,
      totalShielded,
      isActive,
      histLen,
      maxHistoricalRoots: null,
      ringFirst: 'N/A',
      ringLast: 'N/A',
      ringCount: 0,
    };
  }

  const histEnd = B_OFFSET_HIST_ROOTS_DATA + histLen * 32;
  if (buf.length < histEnd + 1) {
    return {
      bailed: true,
      currentRoot: bytesToHex(buf, B_OFFSET_MERKLE_ROOT, 32),
      treeDepth,
      nextLeafIndex,
      totalShielded,
      isActive,
      histLen,
      maxHistoricalRoots: null,
      ringFirst: 'N/A',
      ringLast: 'N/A',
      ringCount: 0,
    };
  }

  const ring = [];
  for (let i = 0; i < histLen; i++) {
    ring.push(bytesToHex(buf, B_OFFSET_HIST_ROOTS_DATA + i * 32, 32));
  }
  const maxHistoricalRoots = buf[histEnd];

  return {
    bailed: false,
    currentRoot: bytesToHex(buf, B_OFFSET_MERKLE_ROOT, 32),
    treeDepth,
    nextLeafIndex,
    totalShielded,
    isActive,
    histLen,
    maxHistoricalRoots,
    ringFirst: ring.length ? ring[0] : 'N/A',
    ringLast: ring.length ? ring[ring.length - 1] : 'N/A',
    ringCount: ring.length,
  };
}

// ---------------------------------------------------------------------------
// FIXED parser: DenominatedPool offsets (proposed fix, +16 byte shift)
// ---------------------------------------------------------------------------
const F_OFFSET_DENOMINATION     = 72;
const F_OFFSET_EPOCH_DELAY      = 80;
const F_OFFSET_MERKLE_ROOT      = 88;
const F_OFFSET_TREE_DEPTH       = 120;
const F_OFFSET_NEXT_LEAF_INDEX  = 121;
const F_OFFSET_VK_HASH          = 129;
const F_OFFSET_TOTAL_SHIELDED   = 161;
const F_OFFSET_NOTE_COUNT       = 169;
const F_OFFSET_IS_ACTIVE        = 177;
const F_OFFSET_HIST_ROOTS_LEN   = 178;
const F_OFFSET_HIST_ROOTS_DATA  = 182;

function parsePoolFIXED(buf) {
  if (buf.length < F_OFFSET_HIST_ROOTS_DATA) return { error: 'too short' };
  const denomination  = buf.readBigUInt64LE(F_OFFSET_DENOMINATION);
  const epochDelay    = buf.readBigUInt64LE(F_OFFSET_EPOCH_DELAY);
  const treeDepth     = buf[F_OFFSET_TREE_DEPTH];
  const nextLeafIndex = buf.readBigUInt64LE(F_OFFSET_NEXT_LEAF_INDEX);
  const totalShielded = buf.readBigUInt64LE(F_OFFSET_TOTAL_SHIELDED);
  const noteCount     = buf.readBigUInt64LE(F_OFFSET_NOTE_COUNT);
  const isActive      = buf[F_OFFSET_IS_ACTIVE] === 1;
  const histLen       = buf.readUInt32LE(F_OFFSET_HIST_ROOTS_LEN);

  if (histLen > 200) return { error: `histLen=${histLen} exceeds sanity cap` };
  const histEnd = F_OFFSET_HIST_ROOTS_DATA + histLen * 32;
  if (buf.length < histEnd + 1) return { error: 'truncated' };

  const ring = [];
  for (let i = 0; i < histLen; i++) {
    ring.push(bytesToHex(buf, F_OFFSET_HIST_ROOTS_DATA + i * 32, 32));
  }
  const maxHistoricalRoots = buf[histEnd];

  return {
    denomination,
    epochDelay,
    currentRoot: bytesToHex(buf, F_OFFSET_MERKLE_ROOT, 32),
    treeDepth,
    nextLeafIndex,
    totalShielded,
    noteCount,
    isActive,
    histLen,
    maxHistoricalRoots,
    ringFirst: ring.length ? ring[0] : 'N/A',
    ringLast: ring.length ? ring[ring.length - 1] : 'N/A',
    ringCount: ring.length,
  };
}

// ---------------------------------------------------------------------------
// Replica of fetchPoolInfo() parsing (ground-truth cross-check)
// ---------------------------------------------------------------------------
function parseFetchPoolInfoReplica(data) {
  let offset = 8 + 32 + 32; // disc + authority + token_mint = 72
  offset += 8;  // denomination
  const epochDelay = data.readBigUInt64LE(offset); offset += 8;
  const currentRoot = data.slice(offset, offset + 32); offset += 32;
  offset += 1;  // tree_depth
  const nextLeafIndex = Number(data.readBigUInt64LE(offset)); offset += 8;
  offset += 32; // vk_hash
  const totalShielded = data.readBigUInt64LE(offset); offset += 8;
  const noteCount = Number(data.readBigUInt64LE(offset)); offset += 8;
  const isActive = data[offset] === 1; offset += 1;
  const histRootsLen = data.readUInt32LE(offset);

  let crHex = '0x';
  for (let i = 0; i < 32; i++) crHex += currentRoot[i].toString(16).padStart(2, '0');

  return {
    isActive,
    noteCount,
    nextLeafIndex,
    totalShielded,
    epochDelay,
    currentRoot: crHex,
    histLen: histRootsLen,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const conn = new Connection(RPC_URL, { commitment: 'confirmed' });
console.log(`\nFetching ${POOLS.length} pool accounts...`);
const pubkeys = POOLS.map((p) => new PublicKey(p.pda));
const infos = await conn.getMultipleAccountsInfo(pubkeys, 'confirmed');

for (let i = 0; i < POOLS.length; i++) {
  const meta = POOLS[i];
  const acc = infos[i];

  console.log('\n' + '='.repeat(78));
  console.log(`POOL ${i}: ${meta.token} ${meta.denomination}`);
  console.log(`PDA:  ${meta.pda}`);
  console.log('='.repeat(78));

  if (!acc) {
    console.log('  NOT FOUND on-chain.');
    continue;
  }
  const buf = acc.data;
  console.log(`Account size: ${buf.length} bytes\n`);

  const broken = parsePoolBROKEN(buf);
  const fixed  = parsePoolFIXED(buf);
  const ref    = parseFetchPoolInfoReplica(buf);

  // Side-by-side table
  const FIELD_W = 18;
  const COL_W   = 38;
  const pad = (s, w) => String(s).padEnd(w);

  console.log(pad('Field', FIELD_W) + ' | ' + pad('BROKEN parser', COL_W) + ' | FIXED parser');
  console.log('-'.repeat(FIELD_W) + '-+-' + '-'.repeat(COL_W) + '-+-' + '-'.repeat(COL_W));

  const rows = [
    ['currentRoot',     shortHex(broken.currentRoot),                  shortHex(fixed.currentRoot)],
    ['treeDepth',       fmtBig(broken.treeDepth),                      fmtBig(fixed.treeDepth)],
    ['nextLeafIndex',   fmtBig(broken.nextLeafIndex),                  fmtBig(fixed.nextLeafIndex)],
    ['totalShielded',   fmtBig(broken.totalShielded),                  fmtBig(fixed.totalShielded)],
    ['noteCount',       'N/A (offset is in vk_hash)',                  fmtBig(fixed.noteCount)],
    ['isActive',        fmtBig(broken.isActive),                       fmtBig(fixed.isActive)],
    ['histLen',         broken.bailed ? `${broken.histLen} (BAILED)`   : fmtBig(broken.histLen),
                                                                        fmtBig(fixed.histLen)],
    ['maxHistRoots',    broken.maxHistoricalRoots === null ? 'null (BAILED)' : fmtBig(broken.maxHistoricalRoots),
                                                                        fmtBig(fixed.maxHistoricalRoots)],
    ['ring entries',    broken.bailed ? '0 (parser returned null)'     : fmtBig(broken.ringCount),
                                                                        fmtBig(fixed.ringCount)],
    ['ring[0]',         shortHex(broken.ringFirst),                    shortHex(fixed.ringFirst)],
    ['ring[last]',      shortHex(broken.ringLast),                     shortHex(fixed.ringLast)],
  ];
  for (const [field, b, f] of rows) {
    console.log(pad(field, FIELD_W) + ' | ' + pad(b, COL_W) + ' | ' + f);
  }

  // Raw bytes at the contested offsets
  console.log('\nRaw bytes (where each parser thinks histLen lives):');
  console.log(`  offset 154 (BROKEN reads u32 here, but it is INSIDE vk_hash):`);
  console.log(`    bytes = ${bytesToHex(buf, 154, 4)}  -> u32 LE = ${buf.readUInt32LE(154)}`);
  console.log(`  offset 178 (FIXED reads u32 here, real histLen field):`);
  console.log(`    bytes = ${bytesToHex(buf, 178, 4)}  -> u32 LE = ${buf.readUInt32LE(178)}`);

  // Cross-check vs fetchPoolInfo() logic
  console.log('\nfetchPoolInfo() cross-check (overlapping fields):');
  const sameRoot = ref.currentRoot === fixed.currentRoot;
  const sameLeaf = BigInt(ref.nextLeafIndex) === fixed.nextLeafIndex;
  const sameNote = BigInt(ref.noteCount) === fixed.noteCount;
  const sameTot  = ref.totalShielded === fixed.totalShielded;
  const sameAct  = ref.isActive === fixed.isActive;
  const sameLen  = BigInt(ref.histLen) === BigInt(fixed.histLen);
  console.log(`  currentRoot   match: ${sameRoot}`);
  console.log(`  nextLeafIndex match: ${sameLeaf}  (ref=${ref.nextLeafIndex}, fixed=${fixed.nextLeafIndex})`);
  console.log(`  noteCount     match: ${sameNote}  (ref=${ref.noteCount}, fixed=${fixed.noteCount})`);
  console.log(`  totalShielded match: ${sameTot}`);
  console.log(`  isActive      match: ${sameAct}`);
  console.log(`  histLen       match: ${sameLen}  (ref=${ref.histLen}, fixed=${fixed.histLen})`);
  const allMatch = sameRoot && sameLeaf && sameNote && sameTot && sameAct && sameLen;
  console.log(`  ALL OVERLAPPING FIELDS AGREE: ${allMatch}`);
}

console.log('\n' + '='.repeat(78));
console.log('Done.');
