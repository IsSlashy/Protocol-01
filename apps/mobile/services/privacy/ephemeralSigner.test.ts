/**
 * Guards for the ephemeral-signer derivation.
 *
 * The property under test is NOT "the function returns a keypair" — the old,
 * broken code did that too. It is:
 *
 *   the private key must NOT be a function of public inputs only.
 *
 * So the central assertion is a MODELLED ATTACK: reproduce the old derivation
 * from nothing but a wallet address and a label (both public), and require that
 * it no longer matches what the app signs with.
 */
import { describe, it, expect } from 'vitest';
import { Keypair as SolKeypair } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

import {
  deriveEphemeralFromSecretSeed,
  deriveLegacyEphemeral,
  SWEEP_FEE_RESERVE,
} from './ephemeralSigner';

const SECRET_SEED = new Uint8Array(32).fill(7);
const OTHER_SEED = new Uint8Array(32).fill(9);
const WALLET_ADDR = '4vGBhCsonwAxMUHKFPGSz9x8R9R4NxJxMwHnyDz92ajo';
const LABEL = 'stealth_unshield_v3_8901821612542787864';

/**
 * What an attacker could run, offline, in 2026-08. Nothing here is secret:
 * the wallet address is on every explorer and the label is built from a note id
 * that is the prefix of a commitment published in cleartext by the shield ix.
 */
function attackerDerivation(walletAddr: string, label: string): SolKeypair {
  return SolKeypair.fromSeed(
    hmac(sha256, new TextEncoder().encode(walletAddr), new TextEncoder().encode(label)),
  );
}

describe('ephemeral signer derivation', () => {
  it('is NOT reproducible from the wallet address and label alone', () => {
    const attacker = attackerDerivation(WALLET_ADDR, LABEL);
    const real = deriveEphemeralFromSecretSeed(SECRET_SEED, LABEL);
    expect(real.publicKey.toBase58()).not.toBe(attacker.publicKey.toBase58());
    expect(Buffer.from(real.secretKey)).not.toEqual(Buffer.from(attacker.secretKey));
  });

  it('is deterministic in (secret seed, label) — crash resumability', () => {
    const a = deriveEphemeralFromSecretSeed(SECRET_SEED, LABEL);
    const b = deriveEphemeralFromSecretSeed(SECRET_SEED, LABEL);
    expect(a.publicKey.toBase58()).toBe(b.publicKey.toBase58());
  });

  it('separates wallets: a different secret seed gives a different signer', () => {
    const a = deriveEphemeralFromSecretSeed(SECRET_SEED, LABEL);
    const b = deriveEphemeralFromSecretSeed(OTHER_SEED, LABEL);
    expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
  });

  it('separates operations: a different label gives a different signer', () => {
    const a = deriveEphemeralFromSecretSeed(SECRET_SEED, 'stealth_unshield_v3_aaaa');
    const b = deriveEphemeralFromSecretSeed(SECRET_SEED, 'stealth_unshield_v3_bbbb');
    expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
  });

  it('refuses a seed that is too short instead of deriving from a stub', () => {
    expect(() => deriveEphemeralFromSecretSeed(new Uint8Array(16), LABEL)).toThrow(/too short/);
  });

  it('reproduces the OLD address exactly, so pre-fix funds stay reachable', () => {
    // If this ever diverges, every lamport parked at a pre-fix address becomes
    // unrecoverable by this app. It must match the attacker model bit for bit.
    const legacy = deriveLegacyEphemeral(WALLET_ADDR, LABEL);
    const attacker = attackerDerivation(WALLET_ADDR, LABEL);
    expect(legacy.publicKey.toBase58()).toBe(attacker.publicKey.toBase58());
  });

  it('leaves exactly one transaction fee behind when sweeping', () => {
    expect(SWEEP_FEE_RESERVE).toBe(5_000);
  });
});
