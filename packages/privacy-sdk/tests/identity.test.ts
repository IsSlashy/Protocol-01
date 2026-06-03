import { describe, it, expect, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import {
  deriveP01Identity,
  deriveP01IdentityFromSeed,
  clearP01Identity,
  clearAllP01Identities,
} from '../src/identity/deriveIdentity';
import { classifySigner, toUnifiedSigner } from '../src/identity/signer';
import {
  IDENTITY_DOMAIN,
  HKDF_SALT,
  SPEND_INFO,
  VIEW_INFO,
} from '../src/identity/constants';
import type { WalletAdapter } from '../src/types';

afterEach(() => clearAllP01Identities());

function expectedFromIkm(ikm: Uint8Array) {
  return {
    spend: new Uint8Array(hkdf(sha256, ikm, HKDF_SALT, SPEND_INFO, 32)),
    view: new Uint8Array(hkdf(sha256, ikm, HKDF_SALT, VIEW_INFO, 32)),
  };
}

describe('deriveP01IdentityFromSeed', () => {
  it('is deterministic and yields two distinct 32-byte keys', () => {
    const seed = new Uint8Array(32).fill(7);
    const a = deriveP01IdentityFromSeed(seed);
    const b = deriveP01IdentityFromSeed(seed);
    expect(a.spendingKey).toEqual(b.spendingKey);
    expect(a.viewingKey).toEqual(b.viewingKey);
    expect(a.spendingKey.length).toBe(32);
    expect(a.viewingKey.length).toBe(32);
    expect(a.spendingKey).not.toEqual(a.viewingKey);
  });

  it('matches a manual HKDF over the seed', () => {
    const seed = new Uint8Array(32).map((_, i) => (i * 13 + 1) & 0xff);
    const { spend, view } = expectedFromIkm(seed);
    const id = deriveP01IdentityFromSeed(seed);
    expect(new Uint8Array(id.spendingKey)).toEqual(spend);
    expect(new Uint8Array(id.viewingKey)).toEqual(view);
  });

  it('rejects non-32-byte seeds', () => {
    expect(() => deriveP01IdentityFromSeed(new Uint8Array(31))).toThrow();
  });
});

describe('deriveP01Identity — seed/local (gold path)', () => {
  it('classifies a Keypair as "seed" and derives from secretKey[0..32)', async () => {
    const kp = Keypair.generate();
    expect(classifySigner(kp)).toBe('seed');
    const id = await deriveP01Identity(kp);
    const { spend, view } = expectedFromIkm(kp.secretKey.slice(0, 32));
    expect(new Uint8Array(id.spendingKey)).toEqual(spend);
    expect(new Uint8Array(id.viewingKey)).toEqual(view);
  });

  it('caches by pubkey and returns the same reference', async () => {
    const kp = Keypair.generate();
    const a = await deriveP01Identity(kp);
    const b = await deriveP01Identity(kp);
    expect(a).toBe(b);
    const c = await deriveP01Identity(kp, { forceRefresh: true });
    expect(c).not.toBe(a);
    expect(new Uint8Array(c.spendingKey)).toEqual(new Uint8Array(a.spendingKey));
  });
});

describe('deriveP01Identity — software (signMessage)', () => {
  function softwareAdapter(sig: Uint8Array): WalletAdapter {
    return {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (t: any) => t,
      signMessage: async () => sig.slice(),
    };
  }

  it('classifies as "software" and derives HKDF over the signature', async () => {
    const sig = new Uint8Array(64).map((_, i) => (i * 5 + 3) & 0xff);
    const adapter = softwareAdapter(sig);
    expect(classifySigner(adapter)).toBe('software');
    const id = await deriveP01Identity(adapter);
    const { spend, view } = expectedFromIkm(sig);
    expect(new Uint8Array(id.spendingKey)).toEqual(spend);
    expect(new Uint8Array(id.viewingKey)).toEqual(view);
  });

  it('signs the IDENTITY_DOMAIN message', async () => {
    let seen: Uint8Array | null = null;
    const adapter: WalletAdapter = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (t: any) => t,
      signMessage: async (m: Uint8Array) => {
        seen = m;
        return new Uint8Array(64).fill(1);
      },
    };
    await deriveP01Identity(adapter);
    expect(seen).toEqual(utf8ToBytes(IDENTITY_DOMAIN));
  });

  it('rejects a non-deterministic signer (twice-sign gate)', async () => {
    let n = 0;
    const adapter: WalletAdapter = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (t: any) => t,
      signMessage: async () => new Uint8Array(64).fill(n++),
    };
    await expect(deriveP01Identity(adapter)).rejects.toThrow(/non-deterministic/i);
  });
});

describe('deriveP01Identity — hardware (no signMessage)', () => {
  it('classifies as "hardware" and refuses signature derivation', async () => {
    const adapter: WalletAdapter = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async (t: any) => t,
    };
    expect(classifySigner(adapter)).toBe('hardware');
    await expect(deriveP01Identity(adapter)).rejects.toThrow(/hardware tier|app-managed/i);
  });
});

describe('no-at-rest: clearP01Identity zeroizes', () => {
  it('zeroizes the cached buffers and drops the entry', async () => {
    const kp = Keypair.generate();
    const id = await deriveP01Identity(kp);
    expect(Array.from(id.spendingKey).some((b) => b !== 0)).toBe(true);
    clearP01Identity(kp.publicKey.toBase58());
    expect(Array.from(id.spendingKey).every((b) => b === 0)).toBe(true);
    expect(Array.from(id.viewingKey).every((b) => b === 0)).toBe(true);
    const id2 = await deriveP01Identity(kp);
    expect(id2).not.toBe(id);
    expect(Array.from(id2.spendingKey).some((b) => b !== 0)).toBe(true);
  });
});

describe('toUnifiedSigner', () => {
  it('wraps a Keypair with kind "seed" and a synthesized signMessage', async () => {
    const kp = Keypair.generate();
    const u = toUnifiedSigner(kp);
    expect(u.kind).toBe('seed');
    expect(u.publicKey).toBeInstanceOf(PublicKey);
    expect(typeof u.signMessage).toBe('function');
    const sig = await u.signMessage!(utf8ToBytes('hello'));
    expect(sig.length).toBe(64);
  });
});
