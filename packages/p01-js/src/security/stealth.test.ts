/**
 * The one-time key the SDK hands back must control the one-time address
 * (audit v1, round 4, claims finding "p01-js stealth addresses").
 *
 * Run: cd packages/p01-js && npx vitest run --config vitest.unit.config.ts src/security/stealth.test.ts
 *
 * THE FLAW. `generateStealthKeyPair` makes the spend key an RFC 8032 key pair:
 * spendPublicKey = ed25519.getPublicKey(seed), which is a·G with
 * a = clamp(sha512(seed)[0..32]). The sender pays P = spendPublicKey + h(S)·G.
 * `deriveStealthPrivateKey` returned (seed + h(S)) mod L — the RAW SEED read as
 * an integer, not a — so the "one-time private key" controlled neither P nor
 * any key related to it, and `scanAndDeriveStealthPayment` then reported an
 * `address` that was not the one paid. Funds sent to P (a PrivateStream tick
 * with `useStealthAddress`) could not be spent through the SDK.
 *
 * WHAT IS PINNED: the derived scalar times G is P; the address the scan
 * reports is P; a Solana transaction whose fee payer is P, signed with the
 * derived key through the SDK, verifies. Negative controls: another
 * recipient's keys do not reach P, and a signature does not verify under a
 * different key.
 */

import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import * as stealth from './stealth';
import {
  createMetaAddressFromKeyPair,
  deriveStealthPrivateKey,
  generateStealthAddress,
  generateStealthKeyPair,
  scanAndDeriveStealthPayment,
} from './stealth';

const L = BigInt('7237005577332262213973186563042994240857116359379907606001950938285454250989');

function leToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

type Signer = (message: Uint8Array, oneTimePrivateKey: Uint8Array) => Uint8Array;
/** Looked up at call time, so a missing export fails its own test and not the file. */
const signWithStealthKey = (message: Uint8Array, key: Uint8Array): Uint8Array =>
  (stealth as unknown as { signWithStealthKey: Signer }).signWithStealthKey(message, key);

function payment() {
  const keys = generateStealthKeyPair();
  const meta = createMetaAddressFromKeyPair(keys);
  const paid = generateStealthAddress(meta);
  return { keys, paid, P: new PublicKey(paid.address).toBytes() };
}

describe('the derived one-time key controls the address that was paid', () => {
  it('derived scalar · G is the one-time address (20 random recipients)', () => {
    for (let i = 0; i < 20; i++) {
      const { keys, paid, P } = payment();
      const k = deriveStealthPrivateKey(paid.ephemeralPublicKey, keys.scanPrivateKey, keys.spendPrivateKey);
      expect(k).toHaveLength(32);
      const kG = ed25519.Point.BASE.multiply(leToBigInt(k) % L).toBytes();
      expect(Buffer.from(kG).toString('hex'), `recipient ${i}`).toBe(Buffer.from(P).toString('hex'));
    }
  });

  it('scanAndDeriveStealthPayment reports the address that was actually paid', () => {
    for (let i = 0; i < 20; i++) {
      const { keys, paid } = payment();
      const r = scanAndDeriveStealthPayment(
        paid.ephemeralPublicKey,
        paid.viewTag,
        keys.scanPrivateKey,
        keys.spendPrivateKey,
        keys.spendPublicKey,
      );
      expect(r.isOurs).toBe(true);
      expect(r.address, `recipient ${i}`).toBe(paid.address);
    }
  });

  it('a Solana transfer out of the one-time address, signed with the derived key, verifies', () => {
    const { keys, paid } = payment();
    const k = deriveStealthPrivateKey(paid.ephemeralPublicKey, keys.scanPrivateKey, keys.spendPrivateKey);
    const from = new PublicKey(paid.address);
    const tx = new Transaction({
      feePayer: from,
      recentBlockhash: SystemProgram.programId.toBase58(),
    }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    const sig = signWithStealthKey(tx.serializeMessage(), k);
    tx.addSignature(from, Buffer.from(sig));
    expect(tx.verifySignatures()).toBe(true);
  });

  it('the signature is a standard ed25519 signature under the one-time address, and only under it', () => {
    const { keys, paid, P } = payment();
    const k = deriveStealthPrivateKey(paid.ephemeralPublicKey, keys.scanPrivateKey, keys.spendPrivateKey);
    const msg = new TextEncoder().encode('stealth spend');
    const sig = signWithStealthKey(msg, k);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, msg, P)).toBe(true);
    // Deterministic: the nonce is derived, never drawn.
    expect(Buffer.from(signWithStealthKey(msg, k)).equals(Buffer.from(sig))).toBe(true);
    // Negative controls: another key, another message.
    const other = payment();
    expect(ed25519.verify(sig, msg, other.P)).toBe(false);
    expect(ed25519.verify(sig, new TextEncoder().encode('stealth spenD'), P)).toBe(false);
  });

  it('another recipient’s keys do not derive a key for this address', () => {
    const { paid, P } = payment();
    const stranger = generateStealthKeyPair();
    const k = deriveStealthPrivateKey(paid.ephemeralPublicKey, stranger.scanPrivateKey, stranger.spendPrivateKey);
    const kG = ed25519.Point.BASE.multiply(leToBigInt(k) % L).toBytes();
    expect(Buffer.from(kG).equals(Buffer.from(P))).toBe(false);
  });
});
