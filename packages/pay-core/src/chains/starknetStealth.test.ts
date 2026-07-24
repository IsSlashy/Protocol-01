import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { ec } from 'starknet';
import {
  encodeStealthMetaAddress,
  kemGenerateKeypair,
} from '@protocol-01/specter-sdk/core';
import {
  generateStarknetStealth,
  deriveStarknetStealthKey,
} from './starknetStealth';

function makeRecipient() {
  const spending = nacl.sign.keyPair();
  const viewing = nacl.box.keyPair();
  const kemSeed = new Uint8Array(64).fill(7);
  const kem = kemGenerateKeypair(kemSeed);
  const meta = encodeStealthMetaAddress(spending.publicKey, viewing.publicKey, kem.publicKey);
  return { spending, viewing, kem, meta };
}

describe('Starknet stealth account derivation (sender/recipient parity)', () => {
  it('sender and recipient derive the SAME counterfactual account address', () => {
    const r = makeRecipient();

    const target = generateStarknetStealth(r.meta);
    expect(target.address).toMatch(/^0x[0-9a-f]+$/);
    expect(target.kemCiphertext.length).toBe(1088);
    expect(target.ephemeralPubKey.length).toBe(32);

    const key = deriveStarknetStealthKey({
      spendingPubKey: r.spending.publicKey,
      viewingPrivateKey: r.viewing.secretKey,
      kemSecretKey: r.kem.secretKey,
      ephemeralPubKey: target.ephemeralPubKey,
      kemCiphertext: target.kemCiphertext,
      viewTag: target.viewTag,
    });

    expect(key).not.toBeNull();
    expect(key!.address).toBe(target.address);
    expect(key!.starkPubKey).toBe(target.starkPubKey);
    // The recovered private key really controls the account's stark pubkey.
    expect(ec.starkCurve.getStarkKey(key!.starkPrivKey)).toBe(target.starkPubKey);
  });

  it('a different recipient CANNOT derive the key (view tag rejects)', () => {
    const alice = makeRecipient();
    const target = generateStarknetStealth(alice.meta);

    const mallory = nacl.box.keyPair();
    const malloryKemSeed = new Uint8Array(64).fill(9);
    const malloryKem = kemGenerateKeypair(malloryKemSeed);

    const attempt = deriveStarknetStealthKey({
      spendingPubKey: alice.spending.publicKey,
      viewingPrivateKey: mallory.secretKey,
      kemSecretKey: malloryKem.secretKey,
      ephemeralPubKey: target.ephemeralPubKey,
      kemCiphertext: target.kemCiphertext,
      viewTag: target.viewTag,
    });
    // Wrong secrets → wrong shared secret → view tag mismatch (1/256 false
    // positive is possible in principle; the address check below is the real
    // gate, exercised by skipping the tag).
    const forced = deriveStarknetStealthKey({
      spendingPubKey: alice.spending.publicKey,
      viewingPrivateKey: mallory.secretKey,
      kemSecretKey: malloryKem.secretKey,
      ephemeralPubKey: target.ephemeralPubKey,
      kemCiphertext: target.kemCiphertext,
      viewTag: -1,
    });
    expect(forced!.address).not.toBe(target.address);
    if (attempt) expect(attempt.address).not.toBe(target.address);
  });

  it('two sends to the same meta produce different one-time addresses', () => {
    const r = makeRecipient();
    const a = generateStarknetStealth(r.meta);
    const b = generateStarknetStealth(r.meta);
    expect(a.address).not.toBe(b.address);
  });
});
