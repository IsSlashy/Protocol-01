import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  issueAccessToken,
  issueSubscriptionAccessToken,
  verifyAccessToken,
  type AccessTokenVault,
} from './access-token';

const merchant = Keypair.fromSeed(new Uint8Array(32).fill(0x42));
const VAULT_A = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const VAULT_B = new PublicKey('7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU');

/** 5 funded periods of 100 slots starting at slot 1000 → ends at slot 1500. */
function vault(over: Partial<AccessTokenVault> = {}): AccessTokenVault {
  return {
    pda: VAULT_A,
    isActive: true,
    isPaused: false,
    startSlot: 1_000n,
    totalPausedSlots: 0n,
    intervalSlots: 100n,
    totalDeposited: 500_000n,
    rate: 100_000n,
    ...over,
  };
}

const NOW = 1_800_000_000;

describe('issueAccessToken — the notAfterUnix ceiling', () => {
  it('still honours a plain TTL when no ceiling is given', () => {
    const t = issueAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 3600,
      nowUnix: NOW,
    });
    const r = verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW });
    expect(r.valid).toBe(true);
    expect(r.claims!.exp).toBe(NOW + 3600);
  });

  it('clamps exp down to the ceiling when the TTL would overshoot it', () => {
    const t = issueAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 30 * 86_400,
      notAfterUnix: NOW + 120,
      nowUnix: NOW,
    });
    expect(verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW }).claims!.exp).toBe(NOW + 120);
  });

  it('leaves exp alone when the TTL is already shorter than the ceiling', () => {
    const t = issueAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 60,
      notAfterUnix: NOW + 10_000,
      nowUnix: NOW,
    });
    expect(verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW }).claims!.exp).toBe(NOW + 60);
  });

  it('refuses to mint a token whose ceiling has already passed', () => {
    expect(() =>
      issueAccessToken({
        merchantKeypair: merchant,
        subscriberId: 'sub-1',
        serviceSlug: 'svc',
        ttlSeconds: 3600,
        notAfterUnix: NOW - 1,
        nowUnix: NOW,
      }),
    ).toThrow(/already expired/i);
  });
});

describe('issueSubscriptionAccessToken — a token cannot outlive its subscription', () => {
  it('THE BUG: a 30-day session token off a subscription with 400 slots left', () => {
    const t = issueSubscriptionAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 30 * 86_400,
      vault: vault(),
      currentSlot: 1_100n,
      nowUnix: NOW,
    });
    const r = verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW });
    expect(r.valid).toBe(true);
    // 400 slots × 400 ms = 160 s. Not 30 days.
    expect(r.claims!.exp).toBe(NOW + 160);
  });

  it('binds the token to the vault PDA and the subscription generation', () => {
    const t = issueSubscriptionAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 60,
      vault: vault(),
      currentSlot: 1_100n,
      nowUnix: NOW,
    });
    const r = verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW });
    expect(r.claims!.vault).toBe(VAULT_A.toBase58());
    expect(r.claims!.vaultStartSlot).toBe('1000');
  });

  it('refuses when the subscription has run past its funded periods', () => {
    expect(() =>
      issueSubscriptionAccessToken({
        merchantKeypair: merchant,
        subscriberId: 'sub-1',
        serviceSlug: 'svc',
        ttlSeconds: 60,
        vault: vault(),
        currentSlot: 1_500n,
        nowUnix: NOW,
      }),
    ).toThrow(/not current/i);
  });

  it('refuses for a vault that is exhausted but still reports isActive true', () => {
    // The devnet shape measured on 2026-08-01: every period claimed, balance
    // spent, `is_active` still true because the program never writes it false.
    const exhausted = vault({ startSlot: 0n });
    expect(exhausted.isActive).toBe(true);
    expect(() =>
      issueSubscriptionAccessToken({
        merchantKeypair: merchant,
        subscriberId: 'sub-1',
        serviceSlug: 'svc',
        ttlSeconds: 60,
        vault: exhausted,
        currentSlot: 10_000n,
        nowUnix: NOW,
      }),
    ).toThrow(/not current/i);
  });

  it('refuses while the subscription is paused', () => {
    expect(() =>
      issueSubscriptionAccessToken({
        merchantKeypair: merchant,
        subscriberId: 'sub-1',
        serviceSlug: 'svc',
        ttlSeconds: 60,
        vault: vault({ isPaused: true }),
        currentSlot: 1_100n,
        nowUnix: NOW,
      }),
    ).toThrow(/not current/i);
  });

  it('refuses when under a second of the funded window is left', () => {
    expect(() =>
      issueSubscriptionAccessToken({
        merchantKeypair: merchant,
        subscriberId: 'sub-1',
        serviceSlug: 'svc',
        ttlSeconds: 60,
        vault: vault(),
        currentSlot: 1_499n,
        nowUnix: NOW,
      }),
    ).toThrow(/no subscription time left/i);
  });

  it('a measured slot time lengthens the deadline, the nominal one shortens it', () => {
    const args = {
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 30 * 86_400,
      vault: vault(),
      currentSlot: 1_100n,
      nowUnix: NOW,
    };
    const nominal = verifyAccessToken(
      issueSubscriptionAccessToken(args),
      merchant.publicKey,
      { nowUnix: NOW },
    ).claims!.exp;
    const measured = verifyAccessToken(
      issueSubscriptionAccessToken({ ...args, slotMs: 600n }),
      merchant.publicKey,
      { nowUnix: NOW },
    ).claims!.exp;
    expect(measured).toBeGreaterThan(nominal);
  });
});

describe('verifyAccessToken — service scope', () => {
  const token = issueAccessToken({
    merchantKeypair: merchant,
    subscriberId: 'sub-1',
    serviceSlug: 'cheap-tier',
    ttlSeconds: 3600,
    nowUnix: NOW,
  });

  it('THE BUG: without expectedService a cheap-tier token passes for any service', () => {
    const r = verifyAccessToken(token, merchant.publicKey, { nowUnix: NOW });
    expect(r.valid).toBe(true);
    // and the result says so out loud
    expect(r.serviceChecked).toBe(false);
  });

  it('rejects the cheap-tier token when the expensive service is named', () => {
    const r = verifyAccessToken(token, merchant.publicKey, {
      expectedService: 'expensive-tier',
      nowUnix: NOW,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/scoped to service "cheap-tier"/);
    expect(r.serviceChecked).toBe(true);
  });

  it('accepts it for its own service', () => {
    const r = verifyAccessToken(token, merchant.publicKey, {
      expectedService: 'cheap-tier',
      nowUnix: NOW,
    });
    expect(r.valid).toBe(true);
    expect(r.serviceChecked).toBe(true);
  });
});

describe('verifyAccessToken — vault binding and re-check', () => {
  function boundToken(over: Partial<AccessTokenVault> = {}, slot = 1_100n) {
    return issueSubscriptionAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 30 * 86_400,
      vault: vault(over),
      currentSlot: slot,
      nowUnix: NOW,
    });
  }

  it('rejects a token that names a different vault', () => {
    const r = verifyAccessToken(boundToken(), merchant.publicKey, {
      expectedVault: VAULT_B,
      nowUnix: NOW,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/names vault/);
  });

  it('rejects an unbound token when a vault is demanded', () => {
    const plain = issueAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 60,
      nowUnix: NOW,
    });
    const r = verifyAccessToken(plain, merchant.publicKey, {
      expectedVault: VAULT_A,
      nowUnix: NOW,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not bound to a vault/);
  });

  it('THE MEASURED BUG, one layer up: a live token whose subscription has ended', () => {
    const t = boundToken();
    // The token itself is nowhere near expiry at NOW+10.
    expect(verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW + 10 }).valid).toBe(true);
    // Re-checking against the chain at a slot past the funded window denies it.
    const r = verifyAccessToken(t, merchant.publicKey, {
      subscription: { vault: vault(), currentSlot: 1_500n },
      nowUnix: NOW + 10,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/run past the periods it was funded for/);
    expect(r.subscriptionChecked).toBe(true);
  });

  it('denies a token whose subscription got paused after issuance', () => {
    const t = boundToken();
    const r = verifyAccessToken(t, merchant.publicKey, {
      subscription: { vault: vault({ isPaused: true }), currentSlot: 1_100n },
      nowUnix: NOW,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/paused/);
  });

  it('THE STABLE-SUB BUG: a token survives close + re-subscribe without the generation pin', () => {
    const t = boundToken();
    // claim_period closes an exhausted vault (cancellation no longer exists);
    // re-subscribing writes the SAME PDA (the seeds are retailer +
    // subscriber_id + mint) with a NEW start_slot.
    const reborn = vault({ startSlot: 9_000n });
    const r = verifyAccessToken(t, merchant.publicKey, {
      subscription: { vault: reborn, currentSlot: 9_100n },
      nowUnix: NOW,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/different subscription on this vault/);
    // Same PDA, same `sub` — only start_slot tells the two apart.
    expect(r.claims!.vault).toBe(reborn.pda.toBase58());
  });

  it('accepts a token re-checked against the subscription it was minted for', () => {
    const r = verifyAccessToken(boundToken(), merchant.publicKey, {
      expectedService: 'svc',
      expectedVault: VAULT_A,
      subscription: { vault: vault(), currentSlot: 1_200n },
      nowUnix: NOW,
    });
    expect(r.valid).toBe(true);
    expect(r.serviceChecked).toBe(true);
    expect(r.subscriptionChecked).toBe(true);
  });

  it('reports both checks as skipped on the bare two-argument call', () => {
    const r = verifyAccessToken(boundToken(), merchant.publicKey);
    expect(r.valid).toBe(true);
    expect(r.serviceChecked).toBe(false);
    expect(r.subscriptionChecked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extraClaims must not be able to define the token
// ---------------------------------------------------------------------------

/** Decode the signed payload without going through verifyAccessToken. */
function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(bs58.decode(token.split('.')[0]!)).toString('utf-8'));
}

describe('extraClaims decorates a token, it does not define it', () => {
  it('THE BYPASS: extraClaims.exp used to overwrite the clamp just computed', () => {
    // The subscription has 100 slots left — 40 seconds at the nominal slot
    // time — so the honest ceiling is NOW + 40.
    const honest = issueSubscriptionAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 30 * 86_400,
      vault: vault(),
      currentSlot: 1_400n,
      nowUnix: NOW,
    });
    expect(payloadOf(honest).exp).toBe(NOW + 40);

    // The same call plus the `tier` field the README's own example attaches —
    // and a year of expiry smuggled in beside it. MEASURED before the fix:
    // exp came out at NOW + 31,536,000 and the token verified 200 days later,
    // which is precisely the defect issueSubscriptionAccessToken exists to
    // close, reachable through its own documented parameter.
    const smuggled = issueSubscriptionAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 30 * 86_400,
      vault: vault(),
      currentSlot: 1_400n,
      nowUnix: NOW,
      extraClaims: { tier: 'pro', exp: NOW + 365 * 86_400 },
    });
    expect(payloadOf(smuggled).exp).toBe(NOW + 40);
    expect(payloadOf(smuggled).tier).toBe('pro');

    const r = verifyAccessToken(smuggled, merchant.publicKey, {
      expectedService: 'svc',
      nowUnix: NOW + 200 * 86_400,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });

  it('cannot re-point iss, sub or svc either', () => {
    const other = Keypair.fromSeed(new Uint8Array(32).fill(0x11));
    const t = issueAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'cheap-tier',
      ttlSeconds: 3600,
      nowUnix: NOW,
      extraClaims: {
        iss: other.publicKey.toBase58(),
        sub: 'somebody-else',
        svc: 'expensive-tier',
      },
    });
    const p = payloadOf(t);
    expect(p.iss).toBe(merchant.publicKey.toBase58());
    expect(p.sub).toBe('sub-1');
    expect(p.svc).toBe('cheap-tier');
    // The service escalation the svc check exists to stop stays stopped.
    const r = verifyAccessToken(t, merchant.publicKey, {
      expectedService: 'expensive-tier',
      nowUnix: NOW,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/scoped to service "cheap-tier"/);
  });

  it('still carries the fields a merchant legitimately attaches', () => {
    const t = issueAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 3600,
      nowUnix: NOW,
      extraClaims: { tier: 'pro', seats: 5 },
    });
    const r = verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW });
    expect(r.valid).toBe(true);
    expect(r.claims!.tier).toBe('pro');
    expect(r.claims!.seats).toBe(5);
  });

  it('the vault binding cannot be stripped through extraClaims', () => {
    const t = issueSubscriptionAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 3600,
      vault: vault(),
      currentSlot: 1_200n,
      nowUnix: NOW,
      extraClaims: { vault: VAULT_B.toBase58(), vaultStartSlot: '9000' },
    });
    const p = payloadOf(t);
    expect(p.vault).toBe(VAULT_A.toBase58());
    expect(p.vaultStartSlot).toBe('1000');
  });
});

// ---------------------------------------------------------------------------
// exp is the only bound a bearer token has
// ---------------------------------------------------------------------------

describe('a token with no legible exp is not a token', () => {
  /** Sign an arbitrary payload with the merchant key, exactly as the SDK does. */
  function forgeSigned(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims), 'utf-8');
    const sig = ed25519.sign(sha256(payload), merchant.secretKey.subarray(0, 32));
    return `${bs58.encode(payload)}.${bs58.encode(sig)}`;
  }

  it('THE UNBOUNDED TOKEN: a non-numeric exp used to skip the expiry check', () => {
    // MEASURED before the fix: this verified as valid one hundred years on,
    // because the guard read `typeof claims.exp === 'number' && exp < now`.
    const t = forgeSigned({
      iss: merchant.publicKey.toBase58(),
      sub: 'sub-1',
      svc: 'svc',
      exp: 'never',
      iat: NOW,
    });
    const r = verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW + 100 * 365 * 86_400 });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/no numeric exp/);
  });

  it('rejects a token with no exp claim at all', () => {
    const t = forgeSigned({
      iss: merchant.publicKey.toBase58(),
      sub: 'sub-1',
      svc: 'svc',
      iat: NOW,
    });
    const r = verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/no numeric exp/);
  });

  it('rejects Infinity and NaN, which are numbers but not deadlines', () => {
    // JSON.stringify writes all three as `null`, which is not a number either.
    for (const exp of [Infinity, -Infinity, NaN]) {
      const t = forgeSigned({
        iss: merchant.publicKey.toBase58(),
        sub: 'sub-1',
        svc: 'svc',
        exp,
        iat: NOW,
      });
      const r = verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW });
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/no numeric exp/);
    }
  });

  it('a normally issued token is unaffected', () => {
    const t = issueAccessToken({
      merchantKeypair: merchant,
      subscriberId: 'sub-1',
      serviceSlug: 'svc',
      ttlSeconds: 3600,
      nowUnix: NOW,
    });
    expect(verifyAccessToken(t, merchant.publicKey, { nowUnix: NOW }).valid).toBe(true);
  });
});
