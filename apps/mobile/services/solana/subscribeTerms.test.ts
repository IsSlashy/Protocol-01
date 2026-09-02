/**
 * The subscribe screen's parameter resolution.
 *
 * Discover pushes `{ service: <registry PDA> }` and nothing else. From commit
 * cfdc0732 until this resolver existed the screen never read `service`, so a
 * customer arriving from Discover got retailer = null, price = 0 and no vault
 * path, and no mobile key was ever minted for a registered service. A merchant
 * checks a key with `verifyMerchantLicense`, which demands the vault's rate
 * and interval equal the registry entry EXACTLY, so the resolution has to copy
 * the entry's bigints verbatim and tag the key with the entry's slug.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  DEFAULT_INTERVAL_SLOTS,
  resolveSubscribeTerms,
  termsFromRouteParams,
} from './subscribeTerms';
import type { ServiceEntry } from './serviceRegistry';
import { licenseServiceTag } from '../license/derive';

const RETAILER = new PublicKey('retailer-for-subscribe-terms');
const PDA = new PublicKey('service-pda-for-subscribe-terms');

function entry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    pda: PDA,
    owner: new PublicKey('owner-for-subscribe-terms'),
    retailer: RETAILER,
    tokenMint: new PublicKey('11111111111111111111111111111111'),
    // 2.01 SOL and an odd interval: values a float round trip would not keep.
    priceAtomic: 2_010_000_000n,
    intervalSlots: 7_201n,
    subscriberCount: 3n,
    supportsOneshot: true,
    supportsVault: true,
    verified: true,
    active: true,
    bump: 0,
    createdAt: 0,
    updatedAt: 0,
    slug: 'disney-plus',
    name: 'Disney+',
    iconKey: 'disney',
    category: 'streaming',
    metadataUri: '',
    ...overrides,
  };
}

describe('resolveSubscribeTerms: a `service` PDA becomes the registry entry', () => {
  it('copies rate, interval, retailer and slug verbatim from the entry', () => {
    const t = resolveSubscribeTerms({ service: PDA.toBase58() }, entry());

    expect(t.source).toBe('registry');
    expect(t.awaitingRegistry).toBe(false);
    expect(t.serviceId).toBe('disney-plus');
    expect(t.serviceName).toBe('Disney+');
    expect(t.servicePda).toBe(PDA.toBase58());
    expect(t.retailer).toBe(RETAILER.toBase58());
    expect(t.priceLamports).toBe(2_010_000_000n);
    expect(t.intervalSlots).toBe(7_201n);
    expect(t.supportsVault).toBe(true);
    expect(t.supportsOneshot).toBe(true);
    expect(t.verified).toBe(true);
    expect(t.iconKey).toBe('disney');
    expect(t.category).toBe('streaming');
  });

  it('tags the key with the slug, the same rule LicenseKeyCard applies', () => {
    const t = resolveSubscribeTerms({ service: PDA.toBase58() }, entry());
    expect(t.licenseTag).toBe('disney-plus');
    expect(t.licenseTag).toBe(licenseServiceTag('disney-plus', RETAILER.toBase58()));
  });

  it('is a bigint copy, not a float round trip (2.01 SOL floors one lamport short)', () => {
    const t = resolveSubscribeTerms({ service: PDA.toBase58() }, entry());
    const throughFloat = BigInt(Math.floor((Number(t.priceLamports) / 1e9) * 1e9));
    expect(throughFloat).not.toBe(2_010_000_000n);
    expect(t.priceLamports).toBe(2_010_000_000n);
  });

  it('lets the entry win over spelled-out params that disagree', () => {
    const t = resolveSubscribeTerms(
      {
        service: PDA.toBase58(),
        retailer: new PublicKey('someone-else').toBase58(),
        priceLamports: '1',
        intervalSlots: '1',
        supportsVault: '0',
        serviceId: 'wrong-slug',
      },
      entry(),
    );
    expect(t.retailer).toBe(RETAILER.toBase58());
    expect(t.priceLamports).toBe(2_010_000_000n);
    expect(t.intervalSlots).toBe(7_201n);
    expect(t.supportsVault).toBe(true);
    expect(t.serviceId).toBe('disney-plus');
  });

  it('falls back to the slug as the display name when the entry has no name', () => {
    const t = resolveSubscribeTerms({ service: PDA.toBase58() }, entry({ name: '', iconKey: '' }));
    expect(t.serviceName).toBe('disney-plus');
    expect(t.iconKey).toBe('disney-plus');
  });

  it('with the entry not yet supplied, flags awaitingRegistry and buys nothing', () => {
    const t = resolveSubscribeTerms({ service: PDA.toBase58() }, null);
    expect(t.source).toBe('params');
    expect(t.awaitingRegistry).toBe(true);
    expect(t.retailer).toBeNull();
    expect(t.priceLamports).toBe(0n);
    expect(t.supportsVault).toBe(false);
    expect(t.licenseTag).toBeNull();
  });
});

describe('resolveSubscribeTerms: the spelled-out params keep working', () => {
  it('reads the on-chain fields older callers pass', () => {
    const t = resolveSubscribeTerms(
      {
        serviceId: 'spotify',
        serviceName: 'Spotify',
        servicePda: PDA.toBase58(),
        retailer: RETAILER.toBase58(),
        priceLamports: '500000000',
        intervalSlots: '6480000',
        supportsOneshot: '1',
        supportsVault: '1',
        verified: '1',
        iconKey: 'spotify',
        category: 'music',
      },
      null,
    );
    expect(t.source).toBe('params');
    expect(t.awaitingRegistry).toBe(false);
    expect(t.serviceId).toBe('spotify');
    expect(t.serviceName).toBe('Spotify');
    expect(t.servicePda).toBe(PDA.toBase58());
    expect(t.retailer).toBe(RETAILER.toBase58());
    expect(t.priceLamports).toBe(500_000_000n);
    expect(t.intervalSlots).toBe(6_480_000n);
    expect(t.supportsVault).toBe(true);
    expect(t.verified).toBe(true);
    expect(t.category).toBe('music');
    expect(t.licenseTag).toBe('spotify');
  });

  it('still understands the legacy price/frequency strings', () => {
    const t = termsFromRouteParams({ price: '0.5', frequency: 'monthly', retailer: RETAILER.toBase58() });
    expect(t.serviceName).toBe('Service');
    expect(t.priceLamports).toBe(500_000_000n);
    expect(t.intervalSlots).toBe(DEFAULT_INTERVAL_SLOTS);
    expect(t.frequency).toBe('monthly');
    expect(t.supportsOneshot).toBe(true);
    expect(t.supportsVault).toBe(false);
  });

  it('tags a recipient without a slug with its retailer address', () => {
    const t = termsFromRouteParams({ retailer: RETAILER.toBase58() });
    expect(t.serviceId).toBe('');
    expect(t.licenseTag).toBe(RETAILER.toBase58());
    expect(t.licenseTag).toBe(licenseServiceTag('', RETAILER.toBase58()));
  });

  it('does not throw on unparseable numbers; it falls back', () => {
    const t = termsFromRouteParams({ priceLamports: 'abc', intervalSlots: '-5', price: 'x' });
    expect(t.priceLamports).toBe(0n);
    expect(t.intervalSlots).toBe(DEFAULT_INTERVAL_SLOTS);
  });
});
