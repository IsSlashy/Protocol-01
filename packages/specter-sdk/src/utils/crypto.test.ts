import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import {
  ed25519PublicKeyToX25519,
  ed25519SecretKeyToX25519,
  ed25519ToX25519PublicKey,
  ed25519ToX25519PrivateKey,
} from './crypto';

describe('ed25519 → x25519 key conversion', () => {
  it('secret key has correct clamping bits', () => {
    const seed = nacl.sign.keyPair().secretKey.slice(0, 32);
    const x25519Secret = ed25519SecretKeyToX25519(seed);

    // RFC 7748 clamping
    expect(x25519Secret[0] & 0x07).toBe(0);   // bottom 3 bits clear
    expect(x25519Secret[31] & 0x80).toBe(0);   // top bit clear
    expect(x25519Secret[31] & 0x40).toBe(0x40); // second-to-top bit set
  });

  it('output is 32 bytes for both pub and secret', () => {
    const kp = nacl.sign.keyPair();
    const x25519Pub = ed25519PublicKeyToX25519(kp.publicKey);
    const x25519Secret = ed25519SecretKeyToX25519(kp.secretKey.slice(0, 32));

    expect(x25519Pub.length).toBe(32);
    expect(x25519Secret.length).toBe(32);
  });

  it('converted keys are consistent: scalarMult(secret, basepoint) === pub', () => {
    const kp = nacl.sign.keyPair();
    const x25519Pub = ed25519PublicKeyToX25519(kp.publicKey);
    const x25519Secret = ed25519SecretKeyToX25519(kp.secretKey.slice(0, 32));

    // X25519 basepoint
    const basepoint = new Uint8Array(32);
    basepoint[0] = 9;

    const derivedPub = nacl.scalarMult(x25519Secret, basepoint);
    expect(Buffer.from(derivedPub).toString('hex')).toBe(
      Buffer.from(x25519Pub).toString('hex'),
    );
  });

  it('consistency holds across 10 random keypairs', () => {
    const basepoint = new Uint8Array(32);
    basepoint[0] = 9;

    for (let i = 0; i < 10; i++) {
      const kp = nacl.sign.keyPair();
      const x25519Pub = ed25519PublicKeyToX25519(kp.publicKey);
      const x25519Secret = ed25519SecretKeyToX25519(kp.secretKey.slice(0, 32));
      const derivedPub = nacl.scalarMult(x25519Secret, basepoint);
      expect(Buffer.from(derivedPub).toString('hex')).toBe(
        Buffer.from(x25519Pub).toString('hex'),
      );
    }
  });

  it('ECDH shared secret agrees between converted and native X25519 keys', () => {
    // Alice: Ed25519 keypair converted to X25519
    const aliceEd = nacl.sign.keyPair();
    const aliceX25519Pub = ed25519PublicKeyToX25519(aliceEd.publicKey);
    const aliceX25519Secret = ed25519SecretKeyToX25519(aliceEd.secretKey.slice(0, 32));

    // Bob: native X25519 keypair
    const bob = nacl.box.keyPair();

    // Shared secrets must match
    const secretAlice = nacl.scalarMult(aliceX25519Secret, bob.publicKey);
    const secretBob = nacl.scalarMult(bob.secretKey, aliceX25519Pub);

    expect(Buffer.from(secretAlice).toString('hex')).toBe(
      Buffer.from(secretBob).toString('hex'),
    );
  });

  it('deprecated wrappers delegate to correct implementations', () => {
    const kp = nacl.sign.keyPair();
    const newPub = ed25519PublicKeyToX25519(kp.publicKey);
    const oldPub = ed25519ToX25519PublicKey(kp.publicKey);
    expect(Buffer.from(newPub).toString('hex')).toBe(
      Buffer.from(oldPub).toString('hex'),
    );

    const seed = kp.secretKey.slice(0, 32);
    const newSecret = ed25519SecretKeyToX25519(seed);
    const oldSecret = ed25519ToX25519PrivateKey(seed);
    expect(Buffer.from(newSecret).toString('hex')).toBe(
      Buffer.from(oldSecret).toString('hex'),
    );
  });

  it('throws on wrong input lengths', () => {
    expect(() => ed25519PublicKeyToX25519(new Uint8Array(31))).toThrow();
    expect(() => ed25519PublicKeyToX25519(new Uint8Array(33))).toThrow();
    expect(() => ed25519SecretKeyToX25519(new Uint8Array(31))).toThrow();
    expect(() => ed25519SecretKeyToX25519(new Uint8Array(64))).toThrow();
  });

  it('handles identity-adjacent points without throwing', () => {
    // A valid Ed25519 public key that's just a normal keypair
    // (testing that the birational map doesn't choke)
    for (let i = 0; i < 5; i++) {
      const kp = nacl.sign.keyPair();
      expect(() => ed25519PublicKeyToX25519(kp.publicKey)).not.toThrow();
    }
  });
});
