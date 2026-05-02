/**
 * Tests for the DenominatedPool account parser (parsePool.ts).
 *
 * Why these exist: parsePool.ts was historically coded against the BASE
 * `ShieldedPool` layout but is exclusively used to decode `DenominatedPool`
 * accounts. The two layouts differ by +24 bytes from `is_active` onward
 * (denomination + epoch_delay + note_count). The old parser silently read
 * vk_hash territory in place of the historical-roots vec, returning
 * histLen=0 + max=0 for every pool — making `historicalRoots` always look
 * empty and tripping the rebuild path on every spend.
 *
 * On-chain ground truth (verified against devnet 2026-04-29): all 13 v2
 * pools have max_historical_roots = 100 with rings up to 11 entries.
 *
 * Cases covered:
 *   a. Synthetic round-trip — build a hand-crafted buffer with known values,
 *      parse it, assert every field round-trips correctly.
 *   b. Real-data fixture — first 600 bytes of devnet SOL 0.1 pool
 *      HkzArVjUuZTRZPzCP7jAm5Fe6R9yrRAsmWZmDArY43FN, asserts max=100,
 *      hist_len in [0,100], every ring entry is 32 bytes and not zero.
 *   c. Truncated buffer — short buffer returns null.
 *   d. Garbage histLen — forged histLen=999 returns null.
 *   e. Regression — old ShieldedPool offsets read max=0 from the same
 *      real-data fixture, locking in the bug as a regression.
 */

import { describe, it, expect } from 'vitest';
import { parsePoolAccount, bytesToHex, rootInRing, bigintToLeBytes } from './parsePool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic DenominatedPool account buffer matching the on-chain
 * layout. Pads the post-vec tail with zeros so the parser can read
 * max_historical_roots without overrunning.
 */
function buildSyntheticPool(opts: {
  authority: Uint8Array;
  tokenMint: Uint8Array;
  denomination: bigint;
  epochDelay: bigint;
  merkleRoot: Uint8Array;
  treeDepth: number;
  nextLeafIndex: bigint;
  vkHash: Uint8Array;
  totalShielded: bigint;
  noteCount: bigint;
  isActive: boolean;
  historicalRoots: Uint8Array[];
  maxHistoricalRoots: number;
}): Buffer {
  // Layout: 182 + N*32 + 1 (max) + tail padding
  const TAIL_PAD = 32; // a few extra bytes for safety
  const len = 182 + opts.historicalRoots.length * 32 + 1 + TAIL_PAD;
  const buf = Buffer.alloc(len);

  // Discriminator (any 8 bytes — parser doesn't validate)
  buf.writeBigUInt64LE(0xdeadbeefcafebaben, 0);
  buf.set(opts.authority, 8);
  buf.set(opts.tokenMint, 40);
  buf.writeBigUInt64LE(opts.denomination, 72);
  buf.writeBigUInt64LE(opts.epochDelay, 80);
  buf.set(opts.merkleRoot, 88);
  buf.writeUInt8(opts.treeDepth, 120);
  buf.writeBigUInt64LE(opts.nextLeafIndex, 121);
  buf.set(opts.vkHash, 129);
  buf.writeBigUInt64LE(opts.totalShielded, 161);
  buf.writeBigUInt64LE(opts.noteCount, 169);
  buf.writeUInt8(opts.isActive ? 1 : 0, 177);
  buf.writeUInt32LE(opts.historicalRoots.length, 178);
  for (let i = 0; i < opts.historicalRoots.length; i++) {
    buf.set(opts.historicalRoots[i], 182 + i * 32);
  }
  buf.writeUInt8(opts.maxHistoricalRoots, 182 + opts.historicalRoots.length * 32);
  return buf;
}

function rep32(byte: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(byte);
  return out;
}

// First 600 bytes of devnet pool HkzArVjUuZTRZPzCP7jAm5Fe6R9yrRAsmWZmDArY43FN
// (SOL 0.1 v2). Captured 2026-04-29 via scripts/dump-pool-bytes.mjs.
//
// Expected on-chain values (pre-validated by scripts/verify-pool-max-roots.mjs):
//   denomination = 100_000_000 (0.1 SOL in lamports)
//   epoch_delay = 1
//   tree_depth = 15
//   next_leaf_index = 11
//   total_shielded = 600_000_000 (= 6 * 0.1 SOL in lamports)
//   note_count = 6
//   is_active = true
//   hist_len = 11
//   max_historical_roots = 100
const DEVNET_SOL_0P1_HEX =
  '1015c623b15c448c63457fc3eba40e69139ceaa0aa1996a49de9ae3537163e16' +
  'b0b842dad8dd62d7000000000000000000000000000000000000000000000000' +
  '000000000000000000e1f50500000000010000000000000034a53ba3f40840ff' +
  'c08f14997a84571152c974c0c792c869e4eacdb49bc79f250f0b000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '000046c323000000000600000000000000010b000000caab75a5ceea6f79c2ce' +
  '66dac8a57bad63ee311cc3035743151bead000b4c6207433eda2fd855c8401ab' +
  'c5c39e2fee1548a89a0071e6a3a58c2cf92b1d44fb12de95e2ca18b5274e64b7' +
  'a124051243578f3b03a266654930c7f4fae0a89d5209f38dd9ee14d6761f063c' +
  '7113adb1a3f76df6413cd32fa041135b88af0de8071833eb75fc26ec26006672' +
  '718c67291cbd563b8bed4700b2285381d217deec3100b3a3d89af9aa3ba4a9db' +
  '052a5e2c51b7eed7b1c2058026a3ad463b27b5517f2a29bc7962eba3950db12f' +
  'def4caf880082aaa2f18a0b8af78c20681568b9796198552bb217d942cd60604' +
  '554cc0fb57c5a0fdccc48e8713beb4b0c89391f07428a0c2903f97111ee40cd4' +
  '88f8849c8af7990260c04bc67e0d396d02ac42732b18ea591236833a17df6678' +
  '922199cb24fff47821bb87905b3e484fdf7e36a35c29dcff2656201f8787d36d' +
  'd6de21d8c899fb2cac209bc9d46e6e210144bd70822a646b08ea6900000000e4' +
  '2af26900000000fd0400000000000000fbf80000000000000200000000000000' +
  '000000000000000000000000000000000000000000000000';

/**
 * Re-implementation of the OLD (broken) parser using the BASE ShieldedPool
 * offsets, kept here only for the regression test. Pinning the bug in test
 * form so we get a loud failure if anyone tries to "merge" the layouts.
 */
function oldShieldedPoolParseMax(buf: Buffer): { histLen: number; maxByte: number | null } {
  const OLD_OFFSET_HIST_ROOTS_LEN = 154;
  const OLD_OFFSET_HIST_ROOTS_DATA = 158;
  if (buf.length < OLD_OFFSET_HIST_ROOTS_LEN + 4) return { histLen: -1, maxByte: null };
  const histLen = buf.readUInt32LE(OLD_OFFSET_HIST_ROOTS_LEN);
  if (histLen > 200) return { histLen, maxByte: null };
  const off = OLD_OFFSET_HIST_ROOTS_DATA + histLen * 32;
  if (buf.length <= off) return { histLen, maxByte: null };
  return { histLen, maxByte: buf[off] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parsePoolAccount — synthetic round-trip', () => {
  it('decodes every field correctly and recovers both ring entries', () => {
    const authority = rep32(0xa1);
    const tokenMint = rep32(0xa2);
    const merkleRoot = rep32(0xc1);
    const vkHash = rep32(0xb1);
    const root0 = rep32(0xd1);
    const root1 = rep32(0xd2);

    const buf = buildSyntheticPool({
      authority,
      tokenMint,
      denomination: 100_000_000n,
      epochDelay: 1n,
      merkleRoot,
      treeDepth: 15,
      nextLeafIndex: 11n,
      vkHash,
      totalShielded: 600_000_000n,
      noteCount: 6n,
      isActive: true,
      historicalRoots: [root0, root1],
      maxHistoricalRoots: 100,
    });

    const parsed = parsePoolAccount(buf);
    expect(parsed).not.toBeNull();
    if (!parsed) return; // type narrowing

    expect(Array.from(parsed.authority)).toEqual(Array.from(authority));
    expect(Array.from(parsed.tokenMint)).toEqual(Array.from(tokenMint));
    expect(parsed.denomination).toBe(100_000_000n);
    expect(parsed.epochDelay).toBe(1n);
    expect(Array.from(parsed.currentRoot)).toEqual(Array.from(merkleRoot));
    expect(parsed.treeDepth).toBe(15);
    expect(parsed.nextLeafIndex).toBe(11n);
    expect(parsed.totalShielded).toBe(600_000_000n);
    expect(parsed.noteCount).toBe(6n);
    expect(parsed.isActive).toBe(true);
    expect(parsed.historicalRoots).toHaveLength(2);
    expect(Array.from(parsed.historicalRoots[0])).toEqual(Array.from(root0));
    expect(Array.from(parsed.historicalRoots[1])).toEqual(Array.from(root1));
    expect(parsed.maxHistoricalRoots).toBe(100);
  });

  it('handles an empty historical_roots ring (hist_len=0)', () => {
    const buf = buildSyntheticPool({
      authority: rep32(0xa1),
      tokenMint: rep32(0xa2),
      denomination: 1_000_000_000n,
      epochDelay: 0n,
      merkleRoot: rep32(0xc1),
      treeDepth: 15,
      nextLeafIndex: 0n,
      vkHash: rep32(0xb1),
      totalShielded: 0n,
      noteCount: 0n,
      isActive: false,
      historicalRoots: [],
      maxHistoricalRoots: 100,
    });

    const parsed = parsePoolAccount(buf);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.historicalRoots).toHaveLength(0);
    expect(parsed.maxHistoricalRoots).toBe(100);
    expect(parsed.isActive).toBe(false);
  });
});

describe('parsePoolAccount — real-data fixture (devnet SOL 0.1 v2)', () => {
  const fixture = Buffer.from(DEVNET_SOL_0P1_HEX, 'hex');

  it('matches expected ground-truth values', () => {
    const parsed = parsePoolAccount(fixture);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(parsed.denomination).toBe(100_000_000n); // 0.1 SOL
    expect(parsed.epochDelay).toBe(1n);
    expect(parsed.treeDepth).toBe(15);
    expect(parsed.nextLeafIndex).toBe(11n);
    expect(parsed.totalShielded).toBe(600_000_000n); // 6 * 0.1 SOL
    expect(parsed.noteCount).toBe(6n);
    expect(parsed.isActive).toBe(true);
    expect(parsed.maxHistoricalRoots).toBe(100);
    expect(parsed.historicalRoots.length).toBe(11);
  });

  it('historicalRoots length is in [0, 100] and every entry is 32 bytes & non-zero', () => {
    const parsed = parsePoolAccount(fixture);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(parsed.historicalRoots.length).toBeGreaterThanOrEqual(0);
    expect(parsed.historicalRoots.length).toBeLessThanOrEqual(100);

    for (let i = 0; i < parsed.historicalRoots.length; i++) {
      const r = parsed.historicalRoots[i];
      expect(r.length).toBe(32);
      // None of the rings should be all zeros (would mean we're reading dead space).
      const allZero = r.every((b) => b === 0);
      expect(allZero, `ring[${i}] is all zeros`).toBe(false);
    }
  });

  it('first ring entry matches the known devnet root', () => {
    const parsed = parsePoolAccount(fixture);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    // Verified via scripts/verify-pool-max-roots.mjs
    expect(bytesToHex(parsed.historicalRoots[0])).toBe(
      '0xcaab75a5ceea6f79c2ce66dac8a57bad63ee311cc3035743151bead000b4c620'
    );
  });

  it('current_root matches the known devnet value', () => {
    const parsed = parsePoolAccount(fixture);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(bytesToHex(parsed.currentRoot)).toBe(
      '0x34a53ba3f40840ffc08f14997a84571152c974c0c792c869e4eacdb49bc79f25'
    );
  });
});

describe('parsePoolAccount — failure modes', () => {
  it('returns null on a buffer too short to contain even the fixed prefix', () => {
    const buf = Buffer.alloc(50); // way less than MIN_LEN_BEFORE_VEC = 182
    expect(parsePoolAccount(buf)).toBeNull();
  });

  it('returns null when histLen claims more entries than the buffer holds', () => {
    // Build a buffer that LOOKS valid up to the histLen field, but claims
    // hist_len = 50 while the buffer is only ~200 bytes long (50*32=1600 > rest).
    const buf = Buffer.alloc(200);
    buf.writeUInt32LE(50, 178);
    expect(parsePoolAccount(buf)).toBeNull();
  });

  it('returns null on garbage histLen=999 (above the protocol cap of 100)', () => {
    const buf = Buffer.alloc(4096);
    buf.writeUInt32LE(999, 178);
    expect(parsePoolAccount(buf)).toBeNull();
  });

  it('returns null on garbage histLen=101 (just over MAX_HISTORICAL_ROOTS)', () => {
    const buf = Buffer.alloc(4096);
    buf.writeUInt32LE(101, 178);
    expect(parsePoolAccount(buf)).toBeNull();
  });
});

describe('OLD parser regression — locks in the bug', () => {
  it('OLD ShieldedPool offsets read max=0 from real DenominatedPool data', () => {
    // The OLD parser (BASE ShieldedPool layout) read histLen at 154 and
    // max_historical_roots at 158. On a DenominatedPool account those offsets
    // land in vk_hash territory and trail-zero space respectively. We confirm
    // the regression: OLD reads histLen=0 and max=0 even though the on-chain
    // truth is histLen=11 and max=100.
    const fixture = Buffer.from(DEVNET_SOL_0P1_HEX, 'hex');
    const old = oldShieldedPoolParseMax(fixture);
    expect(old.histLen).toBe(0);
    expect(old.maxByte).toBe(0);

    // And the new parser disagrees — proving the fix.
    const fresh = parsePoolAccount(fixture);
    expect(fresh).not.toBeNull();
    if (!fresh) return;
    expect(fresh.maxHistoricalRoots).toBe(100);
    expect(fresh.historicalRoots.length).toBe(11);
  });
});

describe('helpers', () => {
  it('bytesToHex prefixes 0x and zero-pads each byte', () => {
    // 4 input bytes → 8 hex chars + "0x" prefix = 10 chars total.
    // Each byte is rendered as exactly 2 hex digits (zero-padded).
    expect(bytesToHex(new Uint8Array([0, 1, 0xff, 0x10]))).toBe('0x0001ff10');
    expect(bytesToHex(new Uint8Array([0x00, 0x0a, 0xb0]))).toBe('0x000ab0');
  });

  it('bigintToLeBytes is little-endian and 32-byte-padded', () => {
    const out = bigintToLeBytes(0x0102030405n);
    expect(out.length).toBe(32);
    expect(out[0]).toBe(0x05);
    expect(out[1]).toBe(0x04);
    expect(out[2]).toBe(0x03);
    expect(out[3]).toBe(0x02);
    expect(out[4]).toBe(0x01);
    for (let i = 5; i < 32; i++) expect(out[i]).toBe(0);
  });

  it('rootInRing returns the index of a present root and null when absent', () => {
    const r0 = rep32(0x11);
    const r1 = rep32(0x22);
    const r2 = rep32(0x33);
    expect(rootInRing(r1, [r0, r1, r2])).toBe(1);
    expect(rootInRing(rep32(0xaa), [r0, r1, r2])).toBeNull();
  });
});
