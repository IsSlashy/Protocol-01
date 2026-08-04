/**
 * serviceRegistry — layout, failure-vs-empty, and cache behaviour.
 *
 * ## How to run this file
 *
 * ⚠ NEITHER shipped vitest config picks this file up:
 *   - `vitest.config.ts`      include: `__tests__/ ** / *.test.ts(x)`
 *   - `vitest.pool.config.mts` include: `lib/privacy/pool/ ** / *.test.ts`
 *
 * This file is `lib/privacy/serviceRegistry.test.ts`, which matches neither, so
 * `pnpm test` does NOT run it. Until one of those configs is widened (the pool
 * config's glob only needs `lib/privacy/**`), run it explicitly:
 *
 *   npx vitest run --config <a config whose include covers lib/privacy>
 *
 * A test nobody runs is the hollow-guard pattern this repo keeps getting bitten
 * by. This notice exists so the gap is a known fact rather than a silent one.
 *
 * ## What is actually guarded
 *
 * 1. The discriminator is RECOMPUTED from `sha256("account:ServiceRegistry")`,
 *    not copied — so a wrong constant fails here.
 * 2. The byte layout is exercised by encoding an account at the offsets the
 *    program writes and decoding it back through the module. Every assertion is
 *    paired with a MUTATION of the same bytes, so a decoder that ignored the
 *    field would fail the second half.
 * 3. A failed read never becomes an empty roster, and never enters the cache.
 */

import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REGISTRY_PROGRAM_ID,
  SERVICE_REGISTRY_DISCRIMINATOR,
  ServiceRegistryError,
  clearServiceRegistryCache,
  decimalsForMint,
  discriminatorFilter,
  fetchServiceRegistry,
  formatInterval,
  formatPriceAtomic,
  formatServicePrice,
  loadServiceRegistry,
  peekServiceRegistry,
} from './serviceRegistry';

// ---------------------------------------------------------------------------
// Fixture builder — writes the layout the Rust program writes.
//
// Offsets are stated here ONCE and independently of the decoder under test.
// If the two ever disagree the round-trip below produces garbage.
// ---------------------------------------------------------------------------

const OFF = {
  discriminator: 0,
  owner: 8,
  retailer: 40,
  tokenMint: 72,
  priceAtomic: 104,
  intervalSlots: 112,
  subscriberCount: 120,
  supportsOneshot: 128,
  supportsVault: 129,
  verified: 130,
  active: 131,
  bump: 132,
  createdAt: 133,
  updatedAt: 141,
  strings: 149,
} as const;

interface Fixture {
  owner: PublicKey;
  retailer: PublicKey;
  tokenMint: PublicKey;
  priceAtomic: bigint;
  intervalSlots: bigint;
  subscriberCount: bigint;
  supportsOneshot: boolean;
  supportsVault: boolean;
  verified: boolean;
  active: boolean;
  bump: number;
  createdAt: number;
  updatedAt: number;
  slug: string;
  name: string;
  iconKey: string;
  category: string;
  metadataUri: string;
}

const NATIVE = new PublicKey('11111111111111111111111111111111');

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    owner: new PublicKey('7gWpzSZAtCxHqRLLxxHhczpMUpwHgHRTFCwZWXvmqNup'),
    retailer: new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB'),
    tokenMint: NATIVE,
    priceAtomic: 50_000_000n,
    intervalSlots: 6_480_000n, // 30 days at 0.4 s/slot
    subscriberCount: 3n,
    supportsOneshot: true,
    supportsVault: true,
    verified: true,
    active: true,
    bump: 254,
    createdAt: 1_750_000_000,
    updatedAt: 1_760_000_000,
    // Deliberately different lengths: a decoder that assumed fixed-width or
    // padded strings would read the next field from the wrong place.
    slug: 'mullvad',
    name: 'Mullvad VPN',
    iconKey: 'vpn',
    category: 'privacy',
    metadataUri: '',
    ...over,
  };
}

function encodeString(s: string): Uint8Array {
  const body = utf8ToBytes(s);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

function encodeAccount(f: Fixture): Uint8Array {
  const tail = [f.slug, f.name, f.iconKey, f.category, f.metadataUri].map(encodeString);
  const tailLen = tail.reduce((n, b) => n + b.length, 0);
  const bytes = new Uint8Array(OFF.strings + tailLen);
  const view = new DataView(bytes.buffer);

  bytes.set(SERVICE_REGISTRY_DISCRIMINATOR, OFF.discriminator);
  bytes.set(f.owner.toBytes(), OFF.owner);
  bytes.set(f.retailer.toBytes(), OFF.retailer);
  bytes.set(f.tokenMint.toBytes(), OFF.tokenMint);
  view.setBigUint64(OFF.priceAtomic, f.priceAtomic, true);
  view.setBigUint64(OFF.intervalSlots, f.intervalSlots, true);
  view.setBigUint64(OFF.subscriberCount, f.subscriberCount, true);
  bytes[OFF.supportsOneshot] = f.supportsOneshot ? 1 : 0;
  bytes[OFF.supportsVault] = f.supportsVault ? 1 : 0;
  bytes[OFF.verified] = f.verified ? 1 : 0;
  bytes[OFF.active] = f.active ? 1 : 0;
  bytes[OFF.bump] = f.bump;
  view.setBigInt64(OFF.createdAt, BigInt(f.createdAt), true);
  view.setBigInt64(OFF.updatedAt, BigInt(f.updatedAt), true);

  let o = OFF.strings;
  for (const t of tail) {
    bytes.set(t, o);
    o += t.length;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// A Connection stand-in. Only the two members the module touches.
// ---------------------------------------------------------------------------

type Account = { pubkey: PublicKey; account: { data: Uint8Array } };

interface FakeConnection {
  rpcEndpoint: string;
  getProgramAccounts: ReturnType<typeof vi.fn>;
}

function fakeConnection(
  impl: () => Promise<Account[]>,
  rpcEndpoint = 'https://devnet.example/1',
): FakeConnection {
  return { rpcEndpoint, getProgramAccounts: vi.fn(impl) };
}

/** The module only needs `rpcEndpoint` + `getProgramAccounts`; cast at the seam. */
function asConnection(c: FakeConnection) {
  return c as unknown as Parameters<typeof fetchServiceRegistry>[0];
}

let pdaCounter = 0;
function nextPda(): PublicKey {
  pdaCounter += 1;
  const b = new Uint8Array(32);
  b[0] = pdaCounter;
  return new PublicKey(b);
}

function account(f: Fixture): Account {
  return { pubkey: nextPda(), account: { data: encodeAccount(f) } };
}

beforeEach(() => {
  clearServiceRegistryCache();
  pdaCounter = 0;
});

// ---------------------------------------------------------------------------

describe('the account discriminator', () => {
  it('is sha256("account:ServiceRegistry")[..8], recomputed here', () => {
    const expected = sha256(utf8ToBytes('account:ServiceRegistry')).slice(0, 8);
    expect(Array.from(SERVICE_REGISTRY_DISCRIMINATOR)).toEqual(Array.from(expected));
  });

  it('is the memcmp the RPC query filters on, base64 at offset 0', async () => {
    const conn = fakeConnection(async () => []);
    await fetchServiceRegistry(asConnection(conn));

    const [programId, config] = conn.getProgramAccounts.mock.calls[0] as [
      PublicKey,
      { filters: Array<{ memcmp: { offset: number; bytes: string; encoding: string } }> },
    ];
    expect(programId.toBase58()).toBe(REGISTRY_PROGRAM_ID.toBase58());
    expect(config.filters).toHaveLength(1);
    expect(config.filters[0]).toEqual(discriminatorFilter());
    expect(config.filters[0]!.memcmp.offset).toBe(0);
    expect(config.filters[0]!.memcmp.encoding).toBe('base64');

    // Decode the filter back to bytes: it must BE the discriminator, not a
    // lookalike string. A base58-encoded value would fail this.
    const raw = Uint8Array.from(atob(config.filters[0]!.memcmp.bytes), (ch) => ch.charCodeAt(0));
    expect(Array.from(raw)).toEqual(Array.from(SERVICE_REGISTRY_DISCRIMINATOR));
  });
});

describe('the on-chain layout', () => {
  it('decodes every field of a ServiceEntry', async () => {
    const f = fixture();
    const acc = account(f);
    const conn = fakeConnection(async () => [acc]);

    const snap = await fetchServiceRegistry(asConnection(conn));
    expect(snap.services).toHaveLength(1);
    const s = snap.services[0]!;

    expect(s.slug).toBe('mullvad');
    expect(s.name).toBe('Mullvad VPN');
    expect(s.iconKey).toBe('vpn');
    expect(s.category).toBe('privacy');
    expect(s.retailer.toBase58()).toBe(f.retailer.toBase58());
    expect(s.priceAtomic).toBe(50_000_000n);
    expect(s.intervalSlots).toBe(6_480_000n);
    expect(s.verified).toBe(true);
    expect(s.active).toBe(true);
    expect(s.owner.toBase58()).toBe(f.owner.toBase58());
    expect(s.tokenMint.toBase58()).toBe(NATIVE.toBase58());
    expect(s.pda.toBase58()).toBe(acc.pubkey.toBase58());
  });

  // MUTATION HALF. Each case flips exactly one field's bytes in the encoded
  // account and asserts the decoded value follows. A decoder reading the wrong
  // offset — or a test asserting a constant it also supplied — cannot pass both
  // halves.
  it('flipping byte 130 flips `verified`', async () => {
    const acc = account(fixture({ verified: true }));
    expect(acc.account.data[OFF.verified]).toBe(1);
    acc.account.data[OFF.verified] = 0;
    const conn = fakeConnection(async () => [acc]);
    const snap = await fetchServiceRegistry(asConnection(conn));
    expect(snap.services[0]!.verified).toBe(false);
  });

  it('flipping byte 131 flips `active`', async () => {
    const acc = account(fixture({ active: true }));
    expect(acc.account.data[OFF.active]).toBe(1);
    acc.account.data[OFF.active] = 0;
    // `activeOnly` defaults to true and would hide the flipped entry entirely.
    const conn = fakeConnection(async () => [acc]);
    const snap = await fetchServiceRegistry(asConnection(conn), { activeOnly: false });
    expect(snap.services[0]!.active).toBe(false);
  });

  it('flipping the retailer bytes changes the retailer, not a neighbour', async () => {
    const f = fixture();
    const acc = account(f);
    acc.account.data[OFF.retailer] ^= 0xff;
    const conn = fakeConnection(async () => [acc]);
    const snap = await fetchServiceRegistry(asConnection(conn));
    expect(snap.services[0]!.retailer.toBase58()).not.toBe(f.retailer.toBase58());
    expect(snap.services[0]!.owner.toBase58()).toBe(f.owner.toBase58());
    expect(snap.services[0]!.tokenMint.toBase58()).toBe(f.tokenMint.toBase58());
  });

  it('reads priceAtomic and intervalSlots from their own little-endian slots', async () => {
    const acc = account(fixture());
    const view = new DataView(
      acc.account.data.buffer,
      acc.account.data.byteOffset,
      acc.account.data.byteLength,
    );
    view.setBigUint64(OFF.priceAtomic, 1_234_567n, true);
    view.setBigUint64(OFF.intervalSlots, 216_000n, true);

    const conn = fakeConnection(async () => [acc]);
    const snap = await fetchServiceRegistry(asConnection(conn));
    expect(snap.services[0]!.priceAtomic).toBe(1_234_567n);
    expect(snap.services[0]!.intervalSlots).toBe(216_000n);
  });

  it('reads the five trailing strings sequentially, not at fixed widths', async () => {
    // Lengths chosen so any padded/fixed-width assumption lands mid-field.
    const f = fixture({
      slug: 'a',
      name: 'a much longer display name than the slug',
      iconKey: '',
      category: 'privacy',
      metadataUri: 'https://example.test/meta.json',
    });
    const conn = fakeConnection(async () => [account(f)]);
    const s = (await fetchServiceRegistry(asConnection(conn))).services[0]!;
    expect(s.slug).toBe('a');
    expect(s.name).toBe('a much longer display name than the slug');
    expect(s.iconKey).toBe('');
    expect(s.category).toBe('privacy');
  });
});

describe('a failed read is a failure, not an empty roster', () => {
  it('throws when the RPC throws', async () => {
    const conn = fakeConnection(async () => {
      throw new Error('429 Too Many Requests');
    });
    await expect(fetchServiceRegistry(asConnection(conn))).rejects.toBeInstanceOf(
      ServiceRegistryError,
    );
    await expect(fetchServiceRegistry(asConnection(conn))).rejects.toThrow('429');
  });

  it('throws when accounts matched but none of them decode', async () => {
    // Right discriminator, truncated body — what a dataSlice or a layout change
    // looks like from here. Silently returning [] is the defect.
    const stub: Account = {
      pubkey: nextPda(),
      account: { data: SERVICE_REGISTRY_DISCRIMINATOR.slice() },
    };
    const conn = fakeConnection(async () => [stub, stub]);
    await expect(fetchServiceRegistry(asConnection(conn))).rejects.toThrow(
      /none of them could be decoded/i,
    );
  });

  it('reports a partial decode failure instead of hiding it', async () => {
    const good = account(fixture());
    const bad: Account = {
      pubkey: nextPda(),
      account: { data: SERVICE_REGISTRY_DISCRIMINATOR.slice() },
    };
    const conn = fakeConnection(async () => [good, bad]);
    const snap = await fetchServiceRegistry(asConnection(conn));
    expect(snap.services).toHaveLength(1);
    expect(snap.matchedAccounts).toBe(2);
    expect(snap.decodeFailures).toBe(1);
  });

  it('distinguishes a genuinely empty program from a failure', async () => {
    const conn = fakeConnection(async () => []);
    const snap = await fetchServiceRegistry(asConnection(conn));
    expect(snap.services).toEqual([]);
    expect(snap.matchedAccounts).toBe(0);
    expect(snap.decodeFailures).toBe(0);
  });

  it('never caches a failure, and retries on the next call', async () => {
    let calls = 0;
    const conn = fakeConnection(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return [account(fixture())];
    });

    await expect(loadServiceRegistry(asConnection(conn))).rejects.toThrow('transient');
    expect(peekServiceRegistry(asConnection(conn))).toBeNull();

    const snap = await loadServiceRegistry(asConnection(conn));
    expect(snap.services).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe('filtering', () => {
  it('hides paused listings by default and keeps unverified ones', async () => {
    const conn = fakeConnection(async () => [
      account(fixture({ slug: 'live', name: 'Live', verified: false, active: true })),
      account(fixture({ slug: 'paused', name: 'Paused', verified: true, active: false })),
    ]);
    const snap = await fetchServiceRegistry(asConnection(conn));
    expect(snap.services.map((s) => s.slug)).toEqual(['live']);
    expect(snap.services[0]!.verified).toBe(false);
    expect(snap.filteredOut).toBe(1);
  });

  it('sorts verified first, then by name', async () => {
    const conn = fakeConnection(async () => [
      account(fixture({ slug: 'z', name: 'Zeta', verified: true })),
      account(fixture({ slug: 'a', name: 'Alpha', verified: false })),
      account(fixture({ slug: 'b', name: 'Beta', verified: true })),
    ]);
    const snap = await fetchServiceRegistry(asConnection(conn));
    expect(snap.services.map((s) => s.name)).toEqual(['Beta', 'Zeta', 'Alpha']);
  });
});

describe('the cache', () => {
  it('serves a second read without another RPC call', async () => {
    const conn = fakeConnection(async () => [account(fixture())]);
    await loadServiceRegistry(asConnection(conn));
    await loadServiceRegistry(asConnection(conn));
    expect(conn.getProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it('re-reads when forced', async () => {
    const conn = fakeConnection(async () => [account(fixture())]);
    await loadServiceRegistry(asConnection(conn));
    await loadServiceRegistry(asConnection(conn), { force: true });
    expect(conn.getProgramAccounts).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent reads into one RPC call', async () => {
    const conn = fakeConnection(async () => [account(fixture())]);
    const [a, b] = await Promise.all([
      loadServiceRegistry(asConnection(conn)),
      loadServiceRegistry(asConnection(conn)),
    ]);
    expect(conn.getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('does not serve one endpoint’s roster to another', async () => {
    const a = fakeConnection(async () => [account(fixture({ slug: 'a', name: 'A' }))], 'https://rpc-a');
    const b = fakeConnection(async () => [account(fixture({ slug: 'b', name: 'B' }))], 'https://rpc-b');
    expect((await loadServiceRegistry(asConnection(a))).services[0]!.slug).toBe('a');
    expect((await loadServiceRegistry(asConnection(b))).services[0]!.slug).toBe('b');
    expect(b.getProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it('expires a stale snapshot', async () => {
    const conn = fakeConnection(async () => [account(fixture())]);
    await loadServiceRegistry(asConnection(conn));
    expect(peekServiceRegistry(asConnection(conn), { maxAgeMs: 0 })).toBeNull();
    await loadServiceRegistry(asConnection(conn), { maxAgeMs: 0 });
    expect(conn.getProgramAccounts).toHaveBeenCalledTimes(2);
  });
});

describe('display helpers', () => {
  it('names the standard billing periods', () => {
    expect(formatInterval(6_480_000n)).toBe('monthly'); // 30 d
    expect(formatInterval(1_512_000n)).toBe('weekly'); // 7 d
    expect(formatInterval(3_024_000n)).toBe('biweekly'); // 14 d
    expect(formatInterval(78_840_000n)).toBe('yearly'); // 365 d
    expect(formatInterval(216_000n)).toBe('daily'); // 1 d
    expect(formatInterval(1_080_000n)).toBe('every 5 days');
    expect(formatInterval(9_000n)).toBe('every 1 h');
  });

  it('scales priceAtomic by the mint’s decimals', () => {
    expect(decimalsForMint(NATIVE)).toBe(9);
    expect(decimalsForMint(new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'))).toBe(6);
    expect(formatPriceAtomic(50_000_000n, 9)).toBe('0.05');
    expect(formatPriceAtomic(1_500_000_000n, 9)).toBe('1.5');
    expect(formatPriceAtomic(5_000_000n, 6)).toBe('5');
    expect(formatPriceAtomic(0n, 9)).toBe('0');
  });

  it('renders a price with the right symbol', async () => {
    const conn = fakeConnection(async () => [account(fixture())]);
    const s = (await fetchServiceRegistry(asConnection(conn))).services[0]!;
    expect(formatServicePrice(s)).toBe('0.05 SOL');
  });
});
