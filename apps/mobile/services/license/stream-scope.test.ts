/**
 * The license service tag as it survives PERSISTENCE, not just as a function.
 *
 * `service-tag.test.ts` proves `licenseServiceTag` and
 * `licenseKeyForSubscription` agree. That is a property of two pure functions.
 * It says nothing about the value the display path is actually HANDED, and the
 * whole recorded defect lived in that hand-off.
 *
 * The wiring on mobile is:
 *
 *   subscribe.tsx:406            posts licenseServiceTag(serviceId, retailer)
 *   subscriptionVaultStore:521   ALSO calls upsertStreamFromVault(vaultInfo)
 *                                → a second Stream row for the SAME vault
 *   streams.ts:474               that row gets recipientAddress = vault.retailer
 *                                and NO serviceId
 *   [id].tsx:562                 LicenseKeyCard gets the row's serviceId +
 *                                recipientAddress and re-derives from them
 *
 * For a registry-slug subscription the chain holds a commitment on the slug and
 * that row can only ever produce the retailer-fallback key. These tests run the
 * REAL `upsertStreamFromVault` and derive from the row it writes, so the
 * hand-off is executed rather than assumed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '../../test/__mocks__/async-storage';

vi.mock('../solana/connection', () => ({
  getConnection: vi.fn(() => ({ getSlot: vi.fn().mockResolvedValue(1_000) })),
  getExplorerUrl: vi.fn(() => 'https://solscan.io/tx/mock'),
  isMainnet: vi.fn(() => false),
}));

import { upsertStreamFromVault, type Stream } from '../solana/streams';
import {
  decodeLicenseKey,
  licenseCommitment,
  licenseCommitmentForSubscription,
  licenseKeyForSubscription,
  licenseScopeForStream,
} from './derive';

const RETAILER = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
const NOTE_SECRET = '9182736455647382910';
const SLUG = 'disney-plus';

const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

/** blake3(decode(key)) === on-chain commitment — what the merchant SDK does. */
function merchantAccepts(key: string, onChain: Uint8Array): boolean {
  return bytesToHex(licenseCommitment(decodeLicenseKey(key))) === bytesToHex(onChain);
}

function vaultInfo(overrides: Record<string, unknown> = {}) {
  return {
    address: 'VaU1t11111111111111111111111111111111111111',
    subscriberPubkey: null,
    subscriberCommitment: 1n,
    retailer: RETAILER,
    tokenMint: 'So11111111111111111111111111111111111111112',
    totalDeposited: 5_000_000n,
    rate: 1_000_000n,
    intervalSlots: 6_480_000n,
    startSlot: 900n,
    claimedPeriods: 0n,
    isActive: true,
    isPaused: false,
    pauseSlot: null,
    totalPausedSlots: 0n,
    sourcePool: null,
    isNormalMode: false,
    isPrivateMode: true,
    clientStealthMeta: null,
    ...overrides,
  } as unknown as Parameters<typeof upsertStreamFromVault>[0];
}

/** Exactly what LicenseKeyCard renders, given a persisted Stream row. */
function keyShownFor(stream: Stream): string {
  return licenseKeyForSubscription(NOTE_SECRET, licenseScopeForStream(stream));
}

describe('license scope survives the Stream record', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('a vault row synthesised for a REGISTERED service still yields the key the merchant accepts', async () => {
    // subscribe.tsx committed on the registry slug.
    const onChain = licenseCommitmentForSubscription(NOTE_SECRET, {
      serviceId: SLUG,
      retailerAddress: RETAILER,
    });

    // subscriptionVaultStore then synthesises the vault-backed row. It knows
    // the tag it just hashed and must not throw it away.
    const row = await upsertStreamFromVault(vaultInfo(), { licenseServiceTag: SLUG });
    expect(row).not.toBeNull();

    expect(merchantAccepts(keyShownFor(row!), onChain)).toBe(true);
  });

  it('a free-form recipient (no slug) still resolves to the retailer address', async () => {
    const onChain = licenseCommitmentForSubscription(NOTE_SECRET, {
      serviceId: '',
      retailerAddress: RETAILER,
    });
    const row = await upsertStreamFromVault(vaultInfo(), { licenseServiceTag: RETAILER });
    expect(row).not.toBeNull();
    expect(merchantAccepts(keyShownFor(row!), onChain)).toBe(true);
  });

  it('a genuinely recovered vault — no tag recorded anywhere — falls back to the retailer', async () => {
    // Cross-device recovery has no slug available: the SubscriptionVault
    // account does not carry one. The retailer fallback is the ONLY thing left,
    // and it is right exactly when the subscription had no slug. This asserts
    // the fallback, and the next test asserts the case it cannot serve.
    const onChain = licenseCommitmentForSubscription(NOTE_SECRET, {
      serviceId: undefined,
      retailerAddress: RETAILER,
    });
    const row = await upsertStreamFromVault(vaultInfo());
    expect(row).not.toBeNull();
    expect(row!.licenseServiceTag).toBeUndefined();
    expect(merchantAccepts(keyShownFor(row!), onChain)).toBe(true);
  });

  it('cross-device recovery of a REGISTRY subscription cannot produce the key — recorded, not hidden', async () => {
    // OPEN: the on-chain vault carries no service slug, so a device that only
    // scanned the chain has no way to reproduce a slug-scoped tag. This is a
    // real remaining gap, kept executable so it cannot be quietly assumed
    // fixed. Closing it needs a decision about where the slug is published.
    const onChain = licenseCommitmentForSubscription(NOTE_SECRET, {
      serviceId: SLUG,
      retailerAddress: RETAILER,
    });
    const row = await upsertStreamFromVault(vaultInfo());
    expect(merchantAccepts(keyShownFor(row!), onChain)).toBe(false);
  });

  it('the recorded tag wins over a stale serviceId on the same row', async () => {
    // Defence in depth: if a row ever carries both, the value that was hashed
    // at subscribe time is authoritative.
    const onChain = licenseCommitmentForSubscription(NOTE_SECRET, {
      serviceId: SLUG,
      retailerAddress: RETAILER,
    });
    const row = await upsertStreamFromVault(vaultInfo(), { licenseServiceTag: SLUG });
    const stale: Stream = { ...row!, serviceId: 'netflix' };
    expect(merchantAccepts(keyShownFor(stale), onChain)).toBe(true);
  });
});

describe('licenseScopeForStream', () => {
  const base = { recipientAddress: RETAILER } as Stream;

  it('prefers the recorded tag', () => {
    expect(licenseScopeForStream({ ...base, licenseServiceTag: SLUG, serviceId: 'netflix' })).toEqual({
      serviceId: SLUG,
      retailerAddress: RETAILER,
    });
  });

  it('falls back to serviceId, then to the retailer address', () => {
    expect(licenseScopeForStream({ ...base, serviceId: SLUG })).toEqual({
      serviceId: SLUG,
      retailerAddress: RETAILER,
    });
    expect(licenseScopeForStream(base)).toEqual({ serviceId: undefined, retailerAddress: RETAILER });
  });

  it('never falls back to the local stream id', () => {
    const scope = licenseScopeForStream({ ...base, id: 'stream_1754000000000_abc123def' } as Stream);
    expect(scope.retailerAddress).toBe(RETAILER);
    expect(JSON.stringify(scope)).not.toContain('stream_');
  });
});
