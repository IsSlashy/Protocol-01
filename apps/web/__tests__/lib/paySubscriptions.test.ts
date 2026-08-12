/**
 * `lib/pay/subscriptions.ts`: the decode + summary + record layer behind the
 * Subscriptions tab.
 *
 * The decoder fixture is a REAL account: the 361-byte devnet vault
 * 7WaBm7Kq5WDYa5ykFgaUes1ZCXHXqkyfquJEkmBxzyqw (owner
 * GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c), fetched 2026-08-05. Every
 * expectation on it is a literal written from the raw bytes by hand, so the
 * test pins the decoder to the chain, not to itself. The 263- and 328-byte
 * generations no longer have an easy live specimen, so those are synthesized
 * with an independent writer below; what matters for them is the soft tail
 * (zero padding decodes as None, never as garbage).
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex as nobleHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { createNoteEncryptionAddress, decryptNote } from '@/lib/privacy/pool/noteCrypto';

// The record store is sealed since L5b and the worker opens it. The worker is
// faked here with the real noteCrypto primitives, one deterministic seed per
// meta — the same pattern as __tests__/lib/knownSpentNoteKeys.test.ts. The
// real handler's envelope whitelist is pinned in
// lib/privacy/pool/storeEncryption.test.ts; this file is about the store
// semantics (replace, forget, fallback) and the decoder, which the mock never
// touches.
function seedFor(meta: string): Uint8Array {
  return sha256(utf8ToBytes(`test-seed:${meta}`));
}

vi.mock('@/lib/privacy/workerClient', () => ({
  poolRequest: vi.fn(async (req: { kind: string; meta: string; blobs?: string[] }) => {
    if (req.meta === 'meta-no-session') throw new Error('No pool keys for this identity.');
    const seed = seedFor(req.meta);
    if (req.kind === 'poolStoreLabel') {
      return {
        kind: 'poolStoreLabel',
        label: nobleHex(sha256(seed)).slice(0, 32),
        legacyAddress: createNoteEncryptionAddress(seed),
      };
    }
    if (req.kind === 'poolNoteAddress') {
      return { kind: 'poolNoteAddress', address: createNoteEncryptionAddress(seed) };
    }
    if (req.kind === 'poolOpenRecords') {
      const subscriptions: unknown[] = [];
      for (const blob of req.blobs ?? []) {
        try {
          const rec = JSON.parse(new TextDecoder().decode(decryptNote(seed, blob)));
          if (rec.p01store === 1 && rec.kind === 'subscription') subscriptions.push(rec);
        } catch {
          // not this identity's blob
        }
      }
      return {
        kind: 'poolOpenRecords',
        payouts: [],
        spentKeys: [],
        handoffs: [],
        subscriptions,
        skipped: 0,
      };
    }
    throw new Error(`unexpected pool request: ${req.kind}`);
  }),
}));

import {
  NATIVE_SOL_MINT_BASE58,
  NotASubscriptionVaultError,
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  base58Decode,
  base58Encode,
  bytesToHex,
  decimalsForVaultMint,
  decodeSubscriptionVault,
  forgetSubscription,
  formatApproxDuration,
  formatAtomic,
  isBase58Address,
  loadSubscriptions,
  recordSubscription,
  summarizeSubscription,
  symbolForVaultMint,
  toPeriodState,
  type StoredSubscription,
  type VaultPeriodState,
} from '@/lib/pay/subscriptions';

// ---------------------------------------------------------------------------
// The real devnet vault, byte for byte
// ---------------------------------------------------------------------------

const DEVNET_VAULT_HEX =
  '605af7ca9d1056be00018da14f2b2000127200000000000000000000000000000000000000000000' +
  '00000c5443225caa0f33a5be0e6780e34ba1b46e4b357ce12ef7292752ae73b21635000000000000' +
  '000000000000000000000000000000000000000000000000000000ca9a3b0000000080f0fa020000' +
  '0000dc050000000000003e22af1c0000000000000000000000000100000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000014fcaa629d8f20041a2f9' +
  'a3765c47b3e810a5f8e4d15d4488bdb759c1cf323461ff0001b301dbbf29305e8c442e4b2764afda' +
  '20c8ac9bdd616fc29e44957d172e7796260000000000000000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '00';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Independent writer for synthetic vault generations
// ---------------------------------------------------------------------------

interface SyntheticVault {
  subscriberPubkey?: Uint8Array;
  subscriberCommitment?: Uint8Array;
  retailer: Uint8Array;
  tokenMint: Uint8Array;
  totalDeposited: bigint;
  rate: bigint;
  intervalSlots: bigint;
  startSlot: bigint;
  claimedPeriods: bigint;
  isActive: boolean;
  isPaused: boolean;
  pauseSlot?: bigint;
  totalPausedSlots: bigint;
  sourcePool?: Uint8Array;
  bump: number;
  clientStealthMeta?: Uint8Array;
  licenseCommitment?: Uint8Array;
}

/** Borsh-writes a vault, then zero-pads to `accountLen`, like Anchor does. */
function writeVault(v: SyntheticVault, accountLen: number): Uint8Array {
  const parts: number[] = [...SUBSCRIPTION_VAULT_DISCRIMINATOR];
  const opt = (bytes?: Uint8Array) => {
    if (bytes) {
      parts.push(1, ...bytes);
    } else {
      parts.push(0);
    }
  };
  const u64 = (x: bigint) => {
    let val = BigInt.asUintN(64, x);
    for (let i = 0; i < 8; i++) {
      parts.push(Number(val & 0xffn));
      val >>= 8n;
    }
  };
  opt(v.subscriberPubkey);
  opt(v.subscriberCommitment);
  parts.push(...v.retailer, ...v.tokenMint);
  u64(v.totalDeposited);
  u64(v.rate);
  u64(v.intervalSlots);
  u64(v.startSlot);
  u64(v.claimedPeriods);
  parts.push(v.isActive ? 1 : 0, v.isPaused ? 1 : 0);
  if (v.pauseSlot !== undefined) {
    parts.push(1);
    u64(v.pauseSlot);
  } else {
    parts.push(0);
  }
  u64(v.totalPausedSlots);
  parts.push(...new Uint8Array(32)); // vk_hash_subscriber
  opt(v.sourcePool);
  parts.push(v.bump);
  opt(v.clientStealthMeta);
  opt(v.licenseCommitment);
  if (parts.length > accountLen) {
    throw new Error(`synthetic vault serialized to ${parts.length} > ${accountLen}`);
  }
  const out = new Uint8Array(accountLen);
  out.set(parts);
  return out;
}

const RETAILER = new Uint8Array(32).fill(7);
const SOL_MINT = new Uint8Array(32); // system program, all zeros

function privateVault(over: Partial<SyntheticVault> = {}): SyntheticVault {
  return {
    subscriberCommitment: new Uint8Array(32).fill(9),
    retailer: RETAILER,
    tokenMint: SOL_MINT,
    totalDeposited: 500_000n,
    rate: 100_000n,
    intervalSlots: 100n,
    startSlot: 1_000n,
    claimedPeriods: 0n,
    isActive: true,
    isPaused: false,
    totalPausedSlots: 0n,
    sourcePool: new Uint8Array(32).fill(3),
    bump: 254,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('discriminator', () => {
  it('is sha256("account:SubscriptionVault")[..8], recomputed independently', () => {
    const expected = sha256(new TextEncoder().encode('account:SubscriptionVault')).slice(0, 8);
    expect(bytesToHex(SUBSCRIPTION_VAULT_DISCRIMINATOR)).toBe(bytesToHex(expected));
    expect(bytesToHex(SUBSCRIPTION_VAULT_DISCRIMINATOR)).toBe('605af7ca9d1056be');
  });
});

describe('base58', () => {
  it('round-trips 32-byte keys', () => {
    const bytes = new Uint8Array(32).map((_, i) => (i * 37 + 5) % 256);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it('encodes the system program as 32 ones', () => {
    expect(base58Encode(new Uint8Array(32))).toBe(NATIVE_SOL_MINT_BASE58);
    expect(NATIVE_SOL_MINT_BASE58).toBe('1'.repeat(32));
  });

  it('matches web3.js on a known key', () => {
    // Pinned against `new PublicKey(...).toBase58()` on the retailer bytes of
    // the devnet fixture, computed with the real @solana/web3.js.
    expect(
      base58Encode(
        hexToBytes('0c5443225caa0f33a5be0e6780e34ba1b46e4b357ce12ef7292752ae73b21635'),
      ),
    ).toBe('q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr');
  });

  it('isBase58Address accepts 32-byte addresses and rejects everything else', () => {
    expect(isBase58Address('7WaBm7Kq5WDYa5ykFgaUes1ZCXHXqkyfquJEkmBxzyqw')).toBe(true);
    expect(isBase58Address(NATIVE_SOL_MINT_BASE58)).toBe(true);
    expect(isBase58Address('')).toBe(false);
    expect(isBase58Address('not-an-address')).toBe(false); // 0 and - are not base58
    expect(isBase58Address('abc')).toBe(false); // decodes short
  });
});

describe('decodeSubscriptionVault, real 361-byte devnet vault', () => {
  const decoded = decodeSubscriptionVault(hexToBytes(DEVNET_VAULT_HEX));

  it('reads every field the chain holds', () => {
    expect(decoded.accountLen).toBe(361);
    expect(decoded.subscriberPubkey).toBeNull();
    expect(bytesToHex(decoded.subscriberCommitment!)).toBe(
      '8da14f2b20001272000000000000000000000000000000000000000000000000',
    );
    expect(decoded.retailer).toBe('q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr');
    expect(decoded.tokenMint).toBe(NATIVE_SOL_MINT_BASE58);
    expect(decoded.totalDeposited).toBe(1_000_000_000n); // 1 SOL
    expect(decoded.rate).toBe(50_000_000n); // 0.05 SOL per period
    expect(decoded.intervalSlots).toBe(1_500n);
    expect(decoded.startSlot).toBe(481_239_614n);
    expect(decoded.claimedPeriods).toBe(0n);
    expect(decoded.isActive).toBe(true);
    expect(decoded.isPaused).toBe(false);
    expect(decoded.pauseSlot).toBeNull();
    expect(decoded.totalPausedSlots).toBe(0n);
    expect(decoded.sourcePool).toBe('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS');
    expect(bytesToHex(decoded.licenseCommitment!)).toBe(
      'b301dbbf29305e8c442e4b2764afda20c8ac9bdd616fc29e44957d172e779626',
    );
  });

  it('funds 20 periods of 0.05 SOL', () => {
    const s = toPeriodState(decoded);
    expect(s.totalDeposited / s.rate).toBe(20n);
  });
});

describe('decodeSubscriptionVault, older generations and padding', () => {
  it('263-byte generation: ends after bump, soft tail decodes as None', () => {
    const decoded = decodeSubscriptionVault(writeVault(privateVault(), 263));
    expect(decoded.accountLen).toBe(263);
    expect(decoded.retailer).toBe(base58Encode(RETAILER));
    expect(decoded.sourcePool).toBe(base58Encode(new Uint8Array(32).fill(3)));
    expect(decoded.licenseCommitment).toBeNull();
  });

  it('328-byte generation: stealth meta present, license commitment padding-None', () => {
    const decoded = decodeSubscriptionVault(
      writeVault(privateVault({ clientStealthMeta: new Uint8Array(64).fill(5) }), 328),
    );
    expect(decoded.accountLen).toBe(328);
    expect(decoded.licenseCommitment).toBeNull();
    // The fields BEFORE the stealth meta must not shift because of it.
    expect(decoded.rate).toBe(100_000n);
  });

  it('361 bytes with all optionals: license commitment survives a Some stealth meta', () => {
    const lc = new Uint8Array(32).fill(11);
    const decoded = decodeSubscriptionVault(
      writeVault(
        privateVault({
          clientStealthMeta: new Uint8Array(64).fill(5),
          licenseCommitment: lc,
          pauseSlot: 2_000n,
          subscriberPubkey: new Uint8Array(32).fill(1),
        }),
        361,
      ),
    );
    expect(bytesToHex(decoded.licenseCommitment!)).toBe(bytesToHex(lc));
    expect(decoded.pauseSlot).toBe(2_000n);
    expect(decoded.subscriberPubkey).toBe(base58Encode(new Uint8Array(32).fill(1)));
  });

  it('legacy normal-mode vault: subscriber pubkey Some, commitment None', () => {
    const decoded = decodeSubscriptionVault(
      writeVault(
        privateVault({
          subscriberPubkey: new Uint8Array(32).fill(2),
          subscriberCommitment: undefined,
        }),
        263,
      ),
    );
    expect(decoded.subscriberPubkey).toBe(base58Encode(new Uint8Array(32).fill(2)));
    expect(decoded.subscriberCommitment).toBeNull();
  });

  it('rejects a wrong discriminator', () => {
    const bytes = writeVault(privateVault(), 263);
    bytes[0] ^= 0xff;
    expect(() => decodeSubscriptionVault(bytes)).toThrow(NotASubscriptionVaultError);
  });

  it('rejects an account truncated inside the mandatory fields', () => {
    const bytes = writeVault(privateVault(), 263).slice(0, 100);
    expect(() => decodeSubscriptionVault(bytes)).toThrow(NotASubscriptionVaultError);
  });
});

// ---------------------------------------------------------------------------
// Summary math
// ---------------------------------------------------------------------------

function state(over: Partial<VaultPeriodState> = {}): VaultPeriodState {
  return {
    isActive: true,
    isPaused: false,
    startSlot: 1_000n,
    totalPausedSlots: 0n,
    intervalSlots: 100n,
    claimedPeriods: 0n,
    totalDeposited: 500_000n, // 5 periods at rate
    rate: 100_000n,
    ...over,
  };
}

describe('summarizeSubscription', () => {
  it('mid-subscription: remaining periods count down on the clock', () => {
    // 250 slots elapsed of a 5 x 100-slot subscription: in period 2 (0-based),
    // 2 full periods used, 3 remaining, 250 slots (100 seconds nominal) left.
    const s = summarizeSubscription(state(), 1_250n);
    expect(s.status).toBe('current');
    expect(s.totalPeriods).toBe(5n);
    expect(s.periodsUsed).toBe(2n);
    expect(s.periodsRemaining).toBe(3n);
    expect(s.secondsRemaining).toBe(100);
  });

  it('remaining periods do not depend on the merchant claiming', () => {
    // Merchant swept 2 periods; the subscriber still has 3 periods of TIME.
    const s = summarizeSubscription(state({ claimedPeriods: 2n }), 1_250n);
    expect(s.periodsRemaining).toBe(3n);
    expect(s.claimedPeriods).toBe(2n);
    expect(s.merchantClaimableNow).toBe(0n); // elapsed 2, already claimed 2
    expect(s.merchantPeriodsUncollected).toBe(3n);
  });

  it('a slow merchant leaves claimable periods behind, remaining still shrinks', () => {
    const s = summarizeSubscription(state(), 1_450n); // elapsed 4, claimed 0
    expect(s.periodsUsed).toBe(4n);
    expect(s.periodsRemaining).toBe(1n);
    expect(s.merchantClaimableNow).toBe(4n);
  });

  it('ended: everything used, zero seconds left', () => {
    const s = summarizeSubscription(state(), 1_500n); // exactly the end slot
    expect(s.status).toBe('ended');
    expect(s.periodsUsed).toBe(5n);
    expect(s.periodsRemaining).toBe(0n);
    expect(s.secondsRemaining).toBe(0);
  });

  it('unknown clock: no usage claim and no time estimate', () => {
    const s = summarizeSubscription(state(), 0n);
    expect(s.status).toBe('unknown');
    expect(s.periodsUsed).toBe(0n);
    expect(s.secondsRemaining).toBeNull();
  });

  it('paused: counts stand, no time estimate', () => {
    const s = summarizeSubscription(state({ isPaused: true }), 1_250n);
    expect(s.status).toBe('paused');
    expect(s.periodsRemaining).toBe(3n);
    expect(s.secondsRemaining).toBeNull();
  });

  it('the real devnet vault reads as 20 periods of 10 nominal minutes', () => {
    const v = toPeriodState(decodeSubscriptionVault(hexToBytes(DEVNET_VAULT_HEX)));
    // One interval past start: period 1 of 20 in use, 19 remaining.
    const s = summarizeSubscription(v, v.startSlot + 1_500n);
    expect(s.totalPeriods).toBe(20n);
    expect(s.periodsUsed).toBe(1n);
    expect(s.periodsRemaining).toBe(19n);
    // 19 x 1500 slots x 400 ms = 11400 s.
    expect(s.secondsRemaining).toBe(11_400);
  });
});

describe('formatApproxDuration', () => {
  it.each([
    [0, 'less than a minute'],
    [59, 'less than a minute'],
    [60, 'about a minute'],
    [90, 'about 2 minutes'],
    [1_800, 'about 30 minutes'],
    [3_600, 'about an hour'],
    [11_400, 'about 3 hours'],
    [86_400, 'about 24 hours'],
    [172_800, 'about 2 days'],
    [260_000, 'about 3 days'],
  ])('%d seconds reads "%s"', (seconds, expected) => {
    expect(formatApproxDuration(seconds)).toBe(expected);
  });

  it('never claims a negative or NaN duration', () => {
    expect(formatApproxDuration(-5)).toBe('unknown');
    expect(formatApproxDuration(Number.NaN)).toBe('unknown');
  });
});

describe('formatAtomic', () => {
  it.each([
    [1_000_000_000n, 9, '1'],
    [50_000_000n, 9, '0.05'],
    [1_003_403_440n, 9, '1.00340344'],
    [0n, 9, '0'],
    [1_500_000n, 6, '1.5'],
  ])('%s at %d decimals reads "%s"', (amount, decimals, expected) => {
    expect(formatAtomic(amount, decimals)).toBe(expected);
  });
});

describe('mint helpers', () => {
  it('maps the zero mint to SOL and anything else to USDC decimals', () => {
    expect(decimalsForVaultMint(NATIVE_SOL_MINT_BASE58)).toBe(9);
    expect(symbolForVaultMint(NATIVE_SOL_MINT_BASE58)).toBe('SOL');
    expect(decimalsForVaultMint('q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr')).toBe(6);
    expect(symbolForVaultMint('q8R2oNtnCH1Y3Pgjm8okR1Vz6wuxwMwPyoCxm5emLdr')).toBe('USDC');
  });
});

// ---------------------------------------------------------------------------
// Local records
// ---------------------------------------------------------------------------

function rec(over: Partial<StoredSubscription> = {}): StoredSubscription {
  return {
    vaultPDA: 'vault1',
    retailer: 'retailer1',
    serviceTag: 'bitwarden-test',
    serviceName: 'Bitwarden Test',
    token: 'SOL',
    denomination: 1,
    rate: '50000000',
    intervalSlots: '1500',
    openTxSig: 'sig1',
    openedAt: 1_000,
    ...over,
  };
}

describe('subscription records', () => {
  const META = 'meta-w1';

  beforeEach(() => {
    localStorage.clear();
  });

  it('records and loads, newest first — and only ciphertext is persisted', async () => {
    await recordSubscription(META, 'w1', rec({ vaultPDA: 'a', openedAt: 1 }));
    await recordSubscription(META, 'w1', rec({ vaultPDA: 'b', openedAt: 2 }));
    expect((await loadSubscriptions(META, 'w1')).records.map((r) => r.vaultPDA)).toEqual([
      'b',
      'a',
    ]);
    // A genuinely empty identity: an ordinary empty read, and no stale-worker
    // flag — the worker was never even asked (no blobs to open).
    expect(await loadSubscriptions('meta-w2', 'w2')).toEqual({ records: [], staleWorker: false });

    // The store never saw the cleartext: v1 untouched, v2 sealed blobs only.
    expect(localStorage.getItem('p01_pay_subscriptions_v1')).toBeNull();
    const v2 = JSON.parse(localStorage.getItem('p01_pay_subscriptions_v2')!) as Record<
      string,
      string[]
    >;
    for (const blob of Object.values(v2).flat()) {
      expect(blob.startsWith('p01enc1:')).toBe(true);
    }
    expect(Object.keys(v2)).not.toContain('w1');
  });

  it('re-recording the same vault replaces the record instead of duplicating', async () => {
    await recordSubscription(META, 'w1', rec({ serviceName: 'Old' }));
    await recordSubscription(META, 'w1', rec({ serviceName: 'New', openedAt: 2_000 }));
    const list = (await loadSubscriptions(META, 'w1')).records;
    expect(list).toHaveLength(1);
    expect(list[0]!.serviceName).toBe('New');
  });

  it('NEVER persists fields outside the public contract, licenseKey included', async () => {
    await recordSubscription(META, 'w1', {
      ...rec(),
      licenseKey: 'P01-SHOULD-NEVER-BE-WRITTEN',
    } as unknown as StoredSubscription);
    // Neither store carries it — v1 must not exist at all, and the sealed
    // record comes back without the field because it was never sealed in.
    expect(localStorage.getItem('p01_pay_subscriptions_v1')).toBeNull();
    const list = (await loadSubscriptions(META, 'w1')).records;
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('licenseKey');
    expect(JSON.stringify(list)).not.toContain('P01-SHOULD-NEVER-BE-WRITTEN');
  });

  it('forgets one vault and leaves the rest', async () => {
    await recordSubscription(META, 'w1', rec({ vaultPDA: 'a' }));
    await recordSubscription(META, 'w1', rec({ vaultPDA: 'b' }));
    await forgetSubscription(META, 'w1', 'a');
    expect((await loadSubscriptions(META, 'w1')).records.map((r) => r.vaultPDA)).toEqual(['b']);
  });

  it('with NO session, the record falls back to v1 rather than being dropped', async () => {
    // This store is the only pointer to a vault nothing can re-discover, so a
    // failed sealed write must land SOMEWHERE readable. The v1 shape is the
    // last resort, and both the session-less and the sessioned read serve it.
    await recordSubscription('meta-no-session', 'w1', rec({ vaultPDA: 'a' }));
    const v1 = JSON.parse(localStorage.getItem('p01_pay_subscriptions_v1')!) as Record<
      string,
      StoredSubscription[]
    >;
    expect(v1.w1![0]!.vaultPDA).toBe('a');
    expect((await loadSubscriptions(null, 'w1')).records.map((r) => r.vaultPDA)).toEqual(['a']);
    expect((await loadSubscriptions(META, 'w1')).records.map((r) => r.vaultPDA)).toEqual(['a']);
  });

  it('migrates a v1 cleartext store on first sessioned touch, losing nothing', async () => {
    localStorage.setItem(
      'p01_pay_subscriptions_v1',
      JSON.stringify({ w1: [rec({ vaultPDA: 'legacy-vault' })] }),
    );
    const list = (await loadSubscriptions(META, 'w1')).records;
    expect(list.map((r) => r.vaultPDA)).toEqual(['legacy-vault']);
    // v1 gone, record re-served from ciphertext alone.
    expect(localStorage.getItem('p01_pay_subscriptions_v1')).toBeNull();
    expect((await loadSubscriptions(META, 'w1')).records.map((r) => r.vaultPDA)).toEqual([
      'legacy-vault',
    ]);
  });
});
