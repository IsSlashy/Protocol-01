#!/usr/bin/env node
/**
 * verify-pool-max-roots.mjs
 *
 * Read-only ground-truth verification for `max_historical_roots` on the
 * Protocol-01 v2 denominated pools (devnet).
 *
 * The handoff doc docs/session-2026-04-29-handoff.md claims every devnet
 * pool was deployed with max_historical_roots = 0. The diagnostic that
 * produced that claim used apps/mobile/services/denominatedPool/parsePool.ts
 * which is hard-coded for the BASE `ShieldedPool` layout, not
 * `DenominatedPool`. Field offsets differ by +16 bytes (extra denomination
 * + epoch_delay u64s before the merkle_root). This script decodes with the
 * CORRECT layout AND prints the byte the wrong parser would read so we
 * can confirm or reject the parser-bug hypothesis.
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
 *   4    historical_roots Vec length (u32 LE)
 *   N*32 historical_roots data
 *   1    max_historical_roots
 *   8    created_at (i64 LE)
 *   8    last_tx_at (i64 LE)
 *   1    bump
 *   ... (more fields after)
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
if (heliusKey) {
  console.log(`[rpc] using Helius devnet (key from ${heliusKey.source})`);
} else {
  console.log('[rpc] WARNING: no Helius key found, falling back to public devnet RPC');
  console.log('[rpc]          rate limits may interfere with this scan');
}

// ---------------------------------------------------------------------------
// Pool list — copied verbatim from apps/mobile/services/denominatedPool/index.ts
// ---------------------------------------------------------------------------

const POOLS = [
  // SOL pools
  { token: 'SOL', denomination: 0.1,  pda: 'HkzArVjUuZTRZPzCP7jAm5Fe6R9yrRAsmWZmDArY43FN' },
  { token: 'SOL', denomination: 1,    pda: '43mLkfHhwtNYxr3YFk51aoZRQXJj75Md3VuoLaPjx2kN' },
  { token: 'SOL', denomination: 10,   pda: 'AdAWCU2aVJH8cBrypj3Dh3bidcF67J7ueyLPobj6FiT5' },
  { token: 'SOL', denomination: 100,  pda: 'EFbbkhqVqQx1J3CU4PmjC96QSWKZYwqGY7sAmZbe8VE9' },
  { token: 'SOL', denomination: 500,  pda: 'G5N3cUe8LLu2Nz6dKP65jW6DU7myeqhoJHLU5m4wJzp8' },
  { token: 'SOL', denomination: 1000, pda: '2skomH6yfy6yKDXzeCFVbfYBeK31BjjCsuAFEPbTZ78v' },
  // USDC pools
  { token: 'USDC', denomination: 1,      pda: 'AMvtg8yd4PstQn6gZv4bMqU2mtxH1qBsTWzqD5vyiAUw' },
  { token: 'USDC', denomination: 10,     pda: 'FAMYb1Zmhfk8iZ2KTmgybxfRSWYz9YLhqBA3BHPjmE6W' },
  { token: 'USDC', denomination: 100,    pda: '9vd5r2EtNdNzePWUrNjMukkPAgzUpMXU5PmX6vTFqC4c' },
  { token: 'USDC', denomination: 1000,   pda: 'Fy1AzmvXQDRtUZBPbxrDrhi81UasRf5AzXAEJqfy6afc' },
  { token: 'USDC', denomination: 10_000, pda: 'Hnmp8yGvHyjtxPwPLkpZ8LJq1sv8iQJMQ4ci7mo6B1eT' },
  { token: 'USDC', denomination: 20_000, pda: 'F1aK81X8TXTazehiWdGcTixxHJALvrsjnSqiZHEeXyer' },
  { token: 'USDC', denomination: 50_000, pda: '6jgvKWo7Fvm4XqDTRHJues55xm15RN55hoVs6ktpYihD' },
];

// ---------------------------------------------------------------------------
// Layout constants (CORRECT — DenominatedPool)
// ---------------------------------------------------------------------------

const D_OFFSET_DISC                = 0;
const D_OFFSET_AUTHORITY           = 8;
const D_OFFSET_TOKEN_MINT          = D_OFFSET_AUTHORITY + 32;            // 40
const D_OFFSET_DENOMINATION        = D_OFFSET_TOKEN_MINT + 32;           // 72
const D_OFFSET_EPOCH_DELAY         = D_OFFSET_DENOMINATION + 8;          // 80
const D_OFFSET_MERKLE_ROOT         = D_OFFSET_EPOCH_DELAY + 8;           // 88
const D_OFFSET_TREE_DEPTH          = D_OFFSET_MERKLE_ROOT + 32;          // 120
const D_OFFSET_NEXT_LEAF_INDEX     = D_OFFSET_TREE_DEPTH + 1;            // 121
const D_OFFSET_VK_HASH             = D_OFFSET_NEXT_LEAF_INDEX + 8;       // 129
const D_OFFSET_TOTAL_SHIELDED      = D_OFFSET_VK_HASH + 32;              // 161
const D_OFFSET_NOTE_COUNT          = D_OFFSET_TOTAL_SHIELDED + 8;        // 169
const D_OFFSET_IS_ACTIVE           = D_OFFSET_NOTE_COUNT + 8;            // 177
const D_OFFSET_HIST_ROOTS_LEN      = D_OFFSET_IS_ACTIVE + 1;             // 178
const D_OFFSET_HIST_ROOTS_DATA     = D_OFFSET_HIST_ROOTS_LEN + 4;        // 182
// max_historical_roots is at HIST_ROOTS_DATA + len * 32

// Layout constants used by the WRONG parser (BASE ShieldedPool layout)
// — only need the offset where it would read max_historical_roots from
const W_OFFSET_HIST_ROOTS_LEN      = 154;
const W_OFFSET_HIST_ROOTS_DATA     = 158;
// W max_historical_roots = W_OFFSET_HIST_ROOTS_DATA + W_histLen * 32

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function bytesToHex(buf, off, len) {
  let s = '0x';
  for (let i = 0; i < len; i++) s += buf[off + i].toString(16).padStart(2, '0');
  return s;
}

function decodeCorrect(buf) {
  if (buf.length < D_OFFSET_HIST_ROOTS_DATA + 1) {
    return { error: `account too short (${buf.length} bytes)` };
  }
  const denomination = buf.readBigUInt64LE(D_OFFSET_DENOMINATION);
  const epochDelay = buf.readBigUInt64LE(D_OFFSET_EPOCH_DELAY);
  const treeDepth = buf[D_OFFSET_TREE_DEPTH];
  const nextLeafIndex = buf.readBigUInt64LE(D_OFFSET_NEXT_LEAF_INDEX);
  const totalShielded = buf.readBigUInt64LE(D_OFFSET_TOTAL_SHIELDED);
  const noteCount = buf.readBigUInt64LE(D_OFFSET_NOTE_COUNT);
  const isActive = buf[D_OFFSET_IS_ACTIVE] === 1;
  const histLen = buf.readUInt32LE(D_OFFSET_HIST_ROOTS_LEN);

  if (histLen > 200) {
    return { error: `histLen=${histLen} exceeds sanity cap (200) — layout drift?` };
  }

  const histRootsEnd = D_OFFSET_HIST_ROOTS_DATA + histLen * 32;
  if (buf.length < histRootsEnd + 1) {
    return { error: `truncated: need ${histRootsEnd + 1} bytes, got ${buf.length}` };
  }

  const maxHistoricalRoots = buf[histRootsEnd];

  // Sample first 2 / last 2 historical roots
  const sample = [];
  const idxs = new Set();
  if (histLen >= 1) idxs.add(0);
  if (histLen >= 2) idxs.add(1);
  if (histLen >= 1) idxs.add(histLen - 1);
  if (histLen >= 2) idxs.add(histLen - 2);
  for (const i of [...idxs].sort((a, b) => a - b)) {
    sample.push({ idx: i, hex: bytesToHex(buf, D_OFFSET_HIST_ROOTS_DATA + i * 32, 32) });
  }

  // Bytes after max_historical_roots for sanity (created_at + last_tx_at + bump)
  const tailStart = histRootsEnd + 1;
  let createdAt = null, lastTxAt = null, bump = null;
  if (buf.length >= tailStart + 17) {
    createdAt = buf.readBigInt64LE(tailStart);
    lastTxAt = buf.readBigInt64LE(tailStart + 8);
    bump = buf[tailStart + 16];
  }

  return {
    denomination,
    epochDelay,
    merkleRoot: bytesToHex(buf, D_OFFSET_MERKLE_ROOT, 32),
    treeDepth,
    nextLeafIndex,
    totalShielded,
    noteCount,
    isActive,
    histLen,
    maxHistoricalRoots,
    sampleRoots: sample,
    histRootsEndByteOffset: histRootsEnd,
    createdAt,
    lastTxAt,
    bump,
  };
}

function decodeWrongParserMaxByte(buf) {
  // What WOULD parsePool.ts read?
  // It reads histLen at offset 154, then max_historical_roots at 158 + histLen * 32.
  if (buf.length < W_OFFSET_HIST_ROOTS_LEN + 4) {
    return { error: `account too short for wrong parser (${buf.length} bytes)` };
  }
  const wHistLen = buf.readUInt32LE(W_OFFSET_HIST_ROOTS_LEN);
  // The wrong parser bails if histLen > 200 (sanity cap).
  if (wHistLen > 200) {
    return { wHistLen, wOffsetMaxRoots: null, wMaxRootsByte: null, parserWouldBail: true };
  }
  const wOffsetMaxRoots = W_OFFSET_HIST_ROOTS_DATA + wHistLen * 32;
  if (buf.length <= wOffsetMaxRoots) {
    return { wHistLen, wOffsetMaxRoots, wMaxRootsByte: null, parserWouldBail: true };
  }
  return {
    wHistLen,
    wOffsetMaxRoots,
    wMaxRootsByte: buf[wOffsetMaxRoots],
    parserWouldBail: false,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const conn = new Connection(RPC_URL, { commitment: 'confirmed' });

console.log(`\nFetching ${POOLS.length} pool accounts via getMultipleAccountsInfo...`);
const pubkeys = POOLS.map((p) => new PublicKey(p.pda));

let infos;
try {
  infos = await conn.getMultipleAccountsInfo(pubkeys, 'confirmed');
} catch (e) {
  console.error(`\n[FATAL] RPC call failed: ${e?.message || e}`);
  console.error('Verdict: UNREACHABLE');
  process.exit(2);
}

const rows = [];
const wrongParserMaxBytes = [];
const verdicts = { zero: 0, max100: 0, other: 0, missing: 0, error: 0 };

for (let i = 0; i < POOLS.length; i++) {
  const meta = POOLS[i];
  const acc = infos[i];
  if (!acc) {
    rows.push({ ...meta, status: 'NOT_FOUND', accountSize: null });
    verdicts.missing++;
    continue;
  }
  const buf = acc.data;
  const correct = decodeCorrect(buf);
  const wrong = decodeWrongParserMaxByte(buf);

  if (correct.error) {
    rows.push({ ...meta, status: 'DECODE_ERROR', error: correct.error, accountSize: buf.length });
    verdicts.error++;
    continue;
  }

  rows.push({
    ...meta,
    status: 'OK',
    accountSize: buf.length,
    onChainDenomAtomic: correct.denomination,
    epochDelay: correct.epochDelay,
    isActive: correct.isActive,
    histLen: correct.histLen,
    maxHistoricalRoots: correct.maxHistoricalRoots,
    treeDepth: correct.treeDepth,
    nextLeafIndex: correct.nextLeafIndex,
    noteCount: correct.noteCount,
    totalShielded: correct.totalShielded,
    merkleRoot: correct.merkleRoot,
    sampleRoots: correct.sampleRoots,
    histRootsEndByteOffset: correct.histRootsEndByteOffset,
    bump: correct.bump,
    wrongParser: wrong,
  });

  if (correct.maxHistoricalRoots === 0) verdicts.zero++;
  else if (correct.maxHistoricalRoots === 100) verdicts.max100++;
  else verdicts.other++;

  wrongParserMaxBytes.push(wrong.wMaxRootsByte ?? -1);
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

console.log('\n=== Per-pool decoded values (CORRECT DenominatedPool layout) ===\n');
const fmtNum = (n) => (n === null || n === undefined ? '-' : String(n));
const fmtBig = (n) => (n === undefined || n === null ? '-' : String(n));

const HEADER = ['idx', 'token', 'denom', 'pda', 'size', 'denomAtomic', 'isActive', 'histLen', 'MAX_HIST_ROOTS', 'noteCount', 'leafIdx'];
console.log(HEADER.join(' | '));
console.log('-'.repeat(160));
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (r.status !== 'OK') {
    console.log(`${i} | ${r.token} | ${r.denomination} | ${r.pda} | ${r.accountSize ?? '-'} | ${r.status} ${r.error ?? ''}`);
    continue;
  }
  console.log(
    [
      i,
      r.token,
      r.denomination,
      r.pda,
      r.accountSize,
      fmtBig(r.onChainDenomAtomic),
      r.isActive,
      r.histLen,
      r.maxHistoricalRoots,
      fmtBig(r.noteCount),
      fmtBig(r.nextLeafIndex),
    ].join(' | ')
  );
}

console.log('\n=== Sample historical_roots (first 2 + last 2 from ring) ===\n');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (r.status !== 'OK') continue;
  if (!r.sampleRoots || r.sampleRoots.length === 0) {
    console.log(`[${i}] ${r.token} ${r.denomination}: ring is EMPTY (histLen=${r.histLen})`);
    continue;
  }
  console.log(`[${i}] ${r.token} ${r.denomination}: histLen=${r.histLen}`);
  for (const s of r.sampleRoots) {
    console.log(`     ring[${s.idx}] = ${s.hex}`);
  }
  console.log(`     current_root = ${r.merkleRoot}`);
}

console.log('\n=== WRONG-PARSER simulation (parsePool.ts BASE-layout offsets) ===\n');
console.log('idx | token | denom | wHistLen | wOffsetMaxByte | wMaxByte | bail?');
console.log('-'.repeat(80));
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (r.status !== 'OK') continue;
  const w = r.wrongParser;
  console.log(
    [
      i,
      r.token,
      r.denomination,
      w.wHistLen,
      w.wOffsetMaxRoots,
      w.wMaxRootsByte === null ? '<oob>' : w.wMaxRootsByte,
      w.parserWouldBail,
    ].join(' | ')
  );
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

console.log('\n=== Tally ===');
console.log(`  pools with max_historical_roots = 0   : ${verdicts.zero}`);
console.log(`  pools with max_historical_roots = 100 : ${verdicts.max100}`);
console.log(`  pools with other max value            : ${verdicts.other}`);
console.log(`  not-found accounts                    : ${verdicts.missing}`);
console.log(`  decode errors                         : ${verdicts.error}`);

let verdict;
if (verdicts.missing === POOLS.length) {
  verdict = 'UNREACHABLE — all pool accounts missing (RPC issue or wrong PDAs?)';
} else if (verdicts.zero === POOLS.length - verdicts.missing) {
  verdict = 'CONFIRMED max=0   (handoff was right; need on-chain Rust fix)';
} else if (verdicts.max100 === POOLS.length - verdicts.missing) {
  verdict = 'CONFIRMED max=100 (handoff was wrong; just a parser bug in parsePool.ts)';
} else if (verdicts.zero > 0 && verdicts.max100 > 0) {
  verdict = 'MIXED (some pools were init with 0, others with 100 — see table)';
} else {
  verdict = `INCONCLUSIVE — see tally (${verdicts.other} pools with other max values, ${verdicts.error} decode errors)`;
}
console.log(`\n  VERDICT: ${verdict}`);

// Wrong-parser hypothesis check
const allWrongParserReturnsZero = rows
  .filter((r) => r.status === 'OK')
  .every((r) => r.wrongParser?.wMaxRootsByte === 0);
const someWrongParserNonZero = rows
  .filter((r) => r.status === 'OK')
  .some((r) => r.wrongParser?.wMaxRootsByte !== 0 && r.wrongParser?.wMaxRootsByte !== null);

console.log('\n=== Parser-bug hypothesis ===');
if (rows.filter((r) => r.status === 'OK').length === 0) {
  console.log('  No pool accounts decoded — cannot evaluate.');
} else if (allWrongParserReturnsZero) {
  console.log('  CONSISTENT: wrong parser reads 0 from every pool. This validates the');
  console.log('              hypothesis that the [P01_DIAG] "max=0" reports come from the');
  console.log('              wrong-layout parser, NOT from the actual on-chain value.');
} else if (someWrongParserNonZero) {
  console.log('  INCONSISTENT: wrong parser reads non-zero on some pools. The "max=0"');
  console.log('                claim in the handoff cannot be a pure parser bug.');
} else {
  console.log('  MIXED. Inspect the wrong-parser table above.');
}
