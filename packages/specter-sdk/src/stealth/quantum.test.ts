/**
 * P4.3 tests — post-quantum WOTS+ wrapping for stealth spending keys.
 */
import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  deriveStealthWotsKeypair,
  deriveStealthWotsFromRecipient,
  buildClaimProofPQ,
  verifyClaimProofPQ,
} from './quantum';
import { generateStealthAddress } from './generate';
import { deriveStealthPrivateKey } from './derive';
import {
  deriveSharedSecret,
  deriveHybridSharedSecret,
  deriveStealthSeed,
  kemDecapsulate,
  kemGenerateKeypair,
} from '../utils/crypto';
import { encodeStealthMetaAddress } from '../utils/helpers';

function setup() {
  const spendKp = nacl.box.keyPair();
  const viewKp = nacl.box.keyPair();
  const kem = kemGenerateKeypair();

  const encoded = encodeStealthMetaAddress(
    spendKp.publicKey,
    viewKp.publicKey,
    kem.publicKey,
  );
  const meta = {
    spendingPubKey: spendKp.publicKey,
    viewingPubKey: viewKp.publicKey,
    kemPubKey: kem.publicKey,
    encoded,
  };
  const stealth = generateStealthAddress(meta);
  return { spendKp, viewKp, kem, meta, stealth };
}

describe('P4.3 — stealth WOTS+ wrapping', () => {
  describe('deriveStealthWotsKeypair', () => {
    it('is deterministic: same seed → same keypair', () => {
      const seed = sha256(new TextEncoder().encode('test-seed-1'));
      const a = deriveStealthWotsKeypair(seed);
      const b = deriveStealthWotsKeypair(seed);
      expect(Buffer.from(a.secretKey)).to.deep.equal(Buffer.from(b.secretKey));
      expect(Buffer.from(a.publicKey)).to.deep.equal(Buffer.from(b.publicKey));
      expect(Buffer.from(a.publicKeyHash)).to.deep.equal(
        Buffer.from(b.publicKeyHash),
      );
    });

    it('different seeds produce independent keypairs', () => {
      const a = deriveStealthWotsKeypair(sha256(new Uint8Array([1])));
      const b = deriveStealthWotsKeypair(sha256(new Uint8Array([2])));
      expect(Buffer.from(a.publicKeyHash)).to.not.deep.equal(
        Buffer.from(b.publicKeyHash),
      );
    });

    it('WOTS+ keypair is independent from the Ed25519 stealth keypair', () => {
      // The two keypairs share a seed via HKDF with different info labels.
      // The Ed25519 seed is `stealthSeed` itself (nacl.sign.keyPair.fromSeed),
      // while WOTS+ uses HKDF(stealthSeed, info="p01:stealth:wots-pq-v1").
      // The 32-byte secret bytes must therefore differ.
      const stealthSeed = sha256(new TextEncoder().encode('shared-seed'));
      const edKp = nacl.sign.keyPair.fromSeed(stealthSeed);
      const wotsKp = deriveStealthWotsKeypair(stealthSeed);
      // First 32 bytes of WOTS+ secret (chain 0) must not coincide with the
      // Ed25519 seed — they pass through distinct HKDF expansions.
      const wotsChain0 = wotsKp.secretKey.slice(0, 32);
      expect(Buffer.from(wotsChain0)).to.not.deep.equal(Buffer.from(stealthSeed));
      expect(Buffer.from(wotsChain0)).to.not.deep.equal(
        Buffer.from(edKp.secretKey.slice(0, 32)),
      );
    });

    it('rejects non-32-byte seeds', () => {
      expect(() => deriveStealthWotsKeypair(new Uint8Array(16))).toThrow(
        /32 bytes/,
      );
      expect(() => deriveStealthWotsKeypair(new Uint8Array(64))).toThrow(
        /32 bytes/,
      );
    });
  });

  describe('deriveStealthWotsFromRecipient', () => {
    it('sender-derived and recipient-derived WOTS+ keypairs match (v2 hybrid)', () => {
      const { spendKp, viewKp, kem, stealth } = setup();

      // Recipient reconstructs the WOTS+ keypair from the announcement data
      const recipientWots = deriveStealthWotsFromRecipient(
        spendKp.publicKey,
        viewKp.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext!,
      );

      // Compute the expected keypair directly from the shared secret path
      const classic = deriveSharedSecret(
        viewKp.secretKey,
        stealth.ephemeralPubKey,
      );
      const kemShared = kemDecapsulate(stealth.kemCiphertext!, kem.secretKey);
      const hybrid = deriveHybridSharedSecret(classic, kemShared, {
        ephemeralPubKey: stealth.ephemeralPubKey,
        kemCiphertext: stealth.kemCiphertext!,
      });
      const seed = deriveStealthSeed(spendKp.publicKey, hybrid);
      const expected = deriveStealthWotsKeypair(seed);

      expect(Buffer.from(recipientWots.publicKeyHash)).to.deep.equal(
        Buffer.from(expected.publicKeyHash),
      );
    });

    it('classic-only (no KEM args) still derives consistently', () => {
      const spendKp = nacl.box.keyPair();
      const viewKp = nacl.box.keyPair();
      const ephemeral = nacl.box.keyPair();

      // Recipient path: no KEM
      const recipientWots = deriveStealthWotsFromRecipient(
        spendKp.publicKey,
        viewKp.secretKey,
        ephemeral.publicKey,
      );

      // Matches the direct seed path
      const classic = deriveSharedSecret(viewKp.secretKey, ephemeral.publicKey);
      const seed = deriveStealthSeed(spendKp.publicKey, classic);
      const expected = deriveStealthWotsKeypair(seed);

      expect(Buffer.from(recipientWots.publicKeyHash)).to.deep.equal(
        Buffer.from(expected.publicKeyHash),
      );
    });
  });

  describe('buildClaimProofPQ / verifyClaimProofPQ', () => {
    it('round-trips an honest claim proof', () => {
      const { spendKp, viewKp, kem, stealth } = setup();
      const wots = deriveStealthWotsFromRecipient(
        spendKp.publicKey,
        viewKp.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext!,
      );
      const destination = Keypair.generate().publicKey;

      const proof = buildClaimProofPQ(wots, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: destination,
      });

      expect(proof.signature.length).to.equal(67 * 32); // WOTS_SIG_SIZE
      expect(proof.publicKey.length).to.equal(67 * 32);
      expect(proof.publicKeyHash.length).to.equal(32);
      expect(proof.challenge.length).to.equal(32);

      const ok = verifyClaimProofPQ(proof, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: destination,
      });
      expect(ok).to.be.true;
    });

    it('rejects a proof when destination is swapped (replay prevention)', () => {
      const { spendKp, viewKp, kem, stealth } = setup();
      const wots = deriveStealthWotsFromRecipient(
        spendKp.publicKey,
        viewKp.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext!,
      );
      const honestDest = Keypair.generate().publicKey;
      const attackerDest = Keypair.generate().publicKey;

      const proof = buildClaimProofPQ(wots, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: honestDest,
      });

      // Attacker forwards the signed proof but claims to a different destination
      const ok = verifyClaimProofPQ(proof, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: attackerDest,
      });
      expect(ok).to.be.false;
    });

    it('rejects a proof with a tampered signature', () => {
      const { spendKp, viewKp, kem, stealth } = setup();
      const wots = deriveStealthWotsFromRecipient(
        spendKp.publicKey,
        viewKp.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext!,
      );
      const destination = Keypair.generate().publicKey;

      const proof = buildClaimProofPQ(wots, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: destination,
      });

      // Flip a byte in the signature
      const tampered = new Uint8Array(proof.signature);
      tampered[0] = tampered[0]! ^ 0xff;
      const bad = { ...proof, signature: tampered };

      const ok = verifyClaimProofPQ(bad, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: destination,
      });
      expect(ok).to.be.false;
    });

    it('rejects a proof whose publicKey does not match its publicKeyHash', () => {
      const { spendKp, viewKp, kem, stealth } = setup();
      const wots = deriveStealthWotsFromRecipient(
        spendKp.publicKey,
        viewKp.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext!,
      );
      const destination = Keypair.generate().publicKey;

      const proof = buildClaimProofPQ(wots, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: destination,
      });

      // Attacker swaps in a foreign publicKey whose signature could still be valid
      // for *some* message/context, but whose hash won't match the stored commitment
      const forged = new Uint8Array(proof.publicKey);
      forged[0] = forged[0]! ^ 0xff;
      const bad = { ...proof, publicKey: forged };

      const ok = verifyClaimProofPQ(bad, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: destination,
      });
      expect(ok).to.be.false;
    });

    it('binds to stealthAddress, ephemeralPubKey, and spendingPubKey', () => {
      const { spendKp, viewKp, kem, stealth } = setup();
      const wots = deriveStealthWotsFromRecipient(
        spendKp.publicKey,
        viewKp.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext!,
      );
      const destination = Keypair.generate().publicKey;

      const proof = buildClaimProofPQ(wots, {
        stealthAddress: stealth.address,
        ephemeralPubKey: stealth.ephemeralPubKey,
        spendingPubKey: spendKp.publicKey,
        destinationPubKey: destination,
      });

      const otherAddr = Keypair.generate().publicKey;
      const otherEph = nacl.box.keyPair().publicKey;
      const otherSpend = nacl.box.keyPair().publicKey;

      const combos = [
        { stealthAddress: otherAddr },
        { ephemeralPubKey: otherEph },
        { spendingPubKey: otherSpend },
      ];
      for (const override of combos) {
        const ok = verifyClaimProofPQ(proof, {
          stealthAddress: stealth.address,
          ephemeralPubKey: stealth.ephemeralPubKey,
          spendingPubKey: spendKp.publicKey,
          destinationPubKey: destination,
          ...override,
        });
        expect(ok).to.be.false;
      }
    });

    it('PQ claim works alongside (but is independent from) an Ed25519 claim', () => {
      // Sanity check: deriving BOTH the Ed25519 stealth keypair and the WOTS+
      // wrapper from the same recipient inputs must succeed. An on-chain
      // verifier that requires "both sigs valid" can therefore enforce the
      // post-quantum fallback without extra ceremony.
      const { spendKp, viewKp, kem, stealth } = setup();

      // Ed25519 half
      const edKp = deriveStealthPrivateKey(
        spendKp.publicKey,
        viewKp.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext!,
      );
      expect(edKp.publicKey.toBase58()).to.equal(stealth.address.toBase58());

      // WOTS+ half
      const wotsKp = deriveStealthWotsFromRecipient(
        spendKp.publicKey,
        viewKp.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext!,
      );
      expect(wotsKp.publicKeyHash.length).to.equal(32);
    });
  });

  describe('context validation', () => {
    it('rejects non-32-byte ephemeralPubKey', () => {
      const wots = deriveStealthWotsKeypair(
        sha256(new TextEncoder().encode('seed')),
      );
      expect(() =>
        buildClaimProofPQ(wots, {
          stealthAddress: Keypair.generate().publicKey,
          ephemeralPubKey: new Uint8Array(16),
          spendingPubKey: new Uint8Array(32),
          destinationPubKey: Keypair.generate().publicKey,
        }),
      ).toThrow(/32 bytes/);
    });

    it('rejects non-32-byte spendingPubKey', () => {
      const wots = deriveStealthWotsKeypair(
        sha256(new TextEncoder().encode('seed')),
      );
      expect(() =>
        buildClaimProofPQ(wots, {
          stealthAddress: Keypair.generate().publicKey,
          ephemeralPubKey: new Uint8Array(32),
          spendingPubKey: new Uint8Array(24),
          destinationPubKey: Keypair.generate().publicKey,
        }),
      ).toThrow(/32 bytes/);
    });

    it('accepts both PublicKey and raw Uint8Array for address fields', () => {
      const wots = deriveStealthWotsKeypair(
        sha256(new TextEncoder().encode('seed')),
      );
      const dest = Keypair.generate();
      const stealthAddrBytes = Keypair.generate().publicKey.toBytes();

      const proof = buildClaimProofPQ(wots, {
        stealthAddress: stealthAddrBytes, // raw bytes
        ephemeralPubKey: new Uint8Array(32),
        spendingPubKey: new Uint8Array(32),
        destinationPubKey: dest.publicKey, // PublicKey
      });

      // Verify with PublicKey-typed stealthAddress + raw-bytes destination
      const ok = verifyClaimProofPQ(proof, {
        stealthAddress: new PublicKey(stealthAddrBytes),
        ephemeralPubKey: new Uint8Array(32),
        spendingPubKey: new Uint8Array(32),
        destinationPubKey: dest.publicKey.toBytes(),
      });
      expect(ok).to.be.true;
    });
  });
});
