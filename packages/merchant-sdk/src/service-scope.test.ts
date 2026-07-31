import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { serviceScopeFromRegistry, vaultMatchesService, type ServiceScope } from './service-scope';

const RETAILER = new PublicKey('11111111111111111111111111111112');
const OTHER_RETAILER = new PublicKey('11111111111111111111111111111113');
const USDC = new PublicKey('11111111111111111111111111111114');

/** "Basic" tier: 0.05 SOL per ~30 min of slots. */
const basic: ServiceScope = {
  retailer: RETAILER,
  tokenMint: SystemProgram.programId,
  priceAtomic: 50_000_000n,
  intervalSlots: 216_000n,
};

/** Same merchant, same payout key, dearer tier. */
const premium: ServiceScope = { ...basic, priceAtomic: 150_000_000n };

function vaultFor(scope: ServiceScope) {
  return {
    retailer: scope.retailer,
    tokenMint: scope.tokenMint,
    rate: scope.priceAtomic,
    intervalSlots: scope.intervalSlots,
  };
}

describe('vaultMatchesService — the scoping `void serviceId` threw away', () => {
  it('accepts a vault created for the service', () => {
    expect(vaultMatchesService(vaultFor(basic), basic)).toEqual({ matches: true });
  });

  it('rejects a basic-tier key presented for the premium tier', () => {
    // This is the escalation the old code allowed: one merchant, one retailer
    // key, one vault per subscriber, one commitment — and serviceId ignored, so
    // the cheap key opened the dear service.
    const m = vaultMatchesService(vaultFor(basic), premium);
    expect(m.matches).toBe(false);
    expect(m.reason).toMatch(/rate 50000000 does not match the service price 150000000/);
  });

  it('rejects a vault paying a different retailer', () => {
    const m = vaultMatchesService(vaultFor({ ...basic, retailer: OTHER_RETAILER }), basic);
    expect(m.matches).toBe(false);
    expect(m.reason).toMatch(/different retailer/);
  });

  it('rejects a vault in a different token', () => {
    const m = vaultMatchesService(vaultFor({ ...basic, tokenMint: USDC }), basic);
    expect(m.matches).toBe(false);
    expect(m.reason).toMatch(/different token/);
  });

  it('rejects a vault on a different billing period', () => {
    const m = vaultMatchesService(vaultFor({ ...basic, intervalSlots: 6_480_000n }), basic);
    expect(m.matches).toBe(false);
    expect(m.reason).toMatch(/interval 6480000 does not match/);
  });

  it('reports ambiguity instead of hiding it when two services are identical on chain', () => {
    // Same retailer, mint, price and interval. Nothing on chain separates them,
    // and a merchant relying on them being distinct needs to be told.
    const twin: ServiceScope = { ...basic };
    const m = vaultMatchesService(vaultFor(basic), basic, { otherServices: [twin] });
    expect(m).toEqual({ matches: true, ambiguous: true });
  });

  it('does not report ambiguity when the other service differs in any field', () => {
    expect(vaultMatchesService(vaultFor(basic), basic, { otherServices: [premium] })).toEqual({
      matches: true,
    });
    expect(
      vaultMatchesService(vaultFor(basic), basic, {
        otherServices: [{ ...basic, retailer: OTHER_RETAILER }],
      }),
    ).toEqual({ matches: true });
  });
});

describe('serviceScopeFromRegistry', () => {
  it('keeps exactly the four fields a vault can be checked against', () => {
    const scope = serviceScopeFromRegistry({
      retailer: RETAILER,
      tokenMint: SystemProgram.programId,
      priceAtomic: 50_000_000n,
      intervalSlots: 216_000n,
      // extra registry fields must not leak into the scope
      ...({ slug: 'basic', name: 'Basic', verified: true } as object),
    } as never);
    expect(Object.keys(scope).sort()).toEqual(['intervalSlots', 'priceAtomic', 'retailer', 'tokenMint']);
  });
});
