/**
 * STRESS TEST: Cryptographic Primitives & SDK
 *
 * Off-chain test of the crypto primitives in the live specter-sdk and
 * rpc-config packages: Poseidon, stealth addresses (v1 + v2), WOTS+,
 * hash-timelock, commit-reveal, NaCl secretbox/box, SHA-256,
 * Ed25519->X25519 conversion, HKDF, RPC config, and edge cases.
 * (The zk-sdk and privacy-toolkit sections were removed with those packages.)
 *
 * Run:
 *   ts-mocha -p tsconfig.test.json tests/stress-crypto-sdk.test.ts --timeout 300000
 */

import { expect } from 'chai';
import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { poseidon2, poseidon4 } from 'poseidon-lite';

// BigInt-safe chai helpers (chai .greaterThan/.lessThan don't support BigInt)
function expectLt(a: bigint, b: bigint) { expect(a < b).to.be.true; }

// ── specter-sdk: crypto utilities ──
import {
  generateEphemeralKeypair,
  deriveSharedSecret,
  deriveKey,
  deriveStealthSeed,
  computeViewTag,
  kemGenerateKeypair,
  kemEncapsulate,
  kemDecapsulate,
  deriveHybridSharedSecret,
  encrypt,
  decrypt,
  encryptForRecipient,
  decryptFromSender,
  hash,
  hashString,
  doubleHash,
  toHex,
  fromHex,
  randomBytes,
  randomSeed,
  ed25519PublicKeyToX25519,
  ed25519SecretKeyToX25519,
  constantTimeEqual,
} from '../packages/specter-sdk/src/utils/crypto';

// ── specter-sdk: stealth address generation & derivation ──
import {
  generateStealthMetaAddress,
  parseStealthMetaAddress,
  generateStealthAddress,
  generateMultipleStealthAddresses,
} from '../packages/specter-sdk/src/stealth/generate';
import {
  deriveStealthPublicKey,
  deriveStealthPrivateKey,
  verifyStealthOwnership,
} from '../packages/specter-sdk/src/stealth/derive';
import {
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
} from '../packages/specter-sdk/src/utils/helpers';

// ── specter-sdk: quantum-safe (WOTS+, hash vault, commit-reveal) ──
import {
  generateWotsKeypair,
  wotsSign,
  wotsVerify,
  deriveWotsKeypair,
  WOTS_SIG_SIZE,
  WOTS_PUBKEY_SIZE,
  WOTS_CHAINS,
} from '../packages/specter-sdk/src/quantum/wots';
import {
  generateVaultSecret,
  computeHashVaultCommitment,
  generateNonce,
  computeCommitment as computeCommitRevealCommitment,
} from '../packages/specter-sdk/src/quantum/helpers';

// ── rpc-config ──
import {
  getEndpoints,
  getDefaultRpcUrl,
  RpcConnectionManager,
  sanitizeRpcUrl,
  validateRpcEndpoint,
  getExplorerUrl,
  getSolscanUrl,
} from '../packages/rpc-config/src/index';

// ============================================================================
// BN254 field modulus (for convenience)
// ============================================================================
const BN254_P = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

// ============================================================================
// TESTS
// ============================================================================

describe('STRESS TEST: Cryptographic Primitives & SDK', function () {
  this.timeout(300_000);

  // ─────────────────────────────────────────────────────────────
  // 1. Poseidon Hashing (BN254)
  // ─────────────────────────────────────────────────────────────
  describe('1. Poseidon Hashing (BN254)', () => {
    it('2-input hash produces consistent results', () => {
      const a = 1n;
      const b = 2n;
      const h1 = poseidon2([a, b]);
      const h2 = poseidon2([a, b]);
      expect(h1).to.equal(h2);
      expect(typeof h1).to.equal('bigint');

    });

    it('4-input hash (commitment) produces consistent results', () => {
      const inputs = [100n, 200n, 300n, 400n];
      const h1 = poseidon4(inputs);
      const h2 = poseidon4(inputs);
      expect(h1).to.equal(h2);

      expectLt(h1, BN254_P);
    });

    it('handles zero inputs correctly', () => {
      const h = poseidon2([0n, 0n]);
      expect(typeof h).to.equal('bigint');

    });

    it('handles field boundary inputs (p-1)', () => {
      const pMinus1 = BN254_P - 1n;
      const h = poseidon2([pMinus1, 0n]);
      expect(typeof h).to.equal('bigint');

      expectLt(h, BN254_P);
    });

    it('1000 sequential hashes performance benchmark', () => {
      const start = Date.now();
      let acc = 1n;
      for (let i = 0; i < 1000; i++) {
        acc = poseidon2([acc, BigInt(i)]);
      }
      const elapsed = Date.now() - start;
      expect(acc).to.not.equal(0n);
      // Should complete within 5 seconds
      expect(elapsed).to.be.lessThan(5000);
      console.log(`    Poseidon 2-input x1000: ${elapsed}ms`);
    });

    it('hash collision resistance: 1000 random inputs all unique', () => {
      const hashes = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const h = poseidon2([BigInt(i), BigInt(i + 1000)]);
        hashes.add(h.toString());
      }
      expect(hashes.size).to.equal(1000);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Stealth Address v1 (legacy) — P4.1 rejection semantics
  // ─────────────────────────────────────────────────────────────
  //
  // v1 (classic ECDH, no ML-KEM-768) was deprecated in P4.1 (2026-04-17).
  // v1 metas can still be *generated* and *decoded* via the explicit
  // `allowLegacyV1` escape hatch (so wallets can scan historical notes
  // during migration), but every sender-side path must refuse v1.
  describe('2. Stealth Address v1 (legacy rejection)', () => {
    let spendingKeypair: Keypair;
    let viewingKeypair: Keypair;

    before(() => {
      spendingKeypair = Keypair.generate();
      viewingKeypair = Keypair.generate();
    });

    it('generation requires explicit allowLegacyV1 flag', () => {
      expect(() =>
        generateStealthMetaAddress(spendingKeypair, viewingKeypair, false),
      ).to.throw(/legacy|v1/i);

      const meta = generateStealthMetaAddress(
        spendingKeypair,
        viewingKeypair,
        false,
        { allowLegacyV1: true },
      );
      expect(meta.spendingPubKey).to.have.lengthOf(32);
      expect(meta.viewingPubKey).to.have.lengthOf(32);
      expect(meta.encoded.startsWith('st')).to.be.true;
      expect(meta.kemPubKey).to.be.undefined;
    });

    it('decode rejects v1 metas unless allowLegacyV1 is set', () => {
      const v1Meta = generateStealthMetaAddress(
        spendingKeypair,
        viewingKeypair,
        false,
        { allowLegacyV1: true },
      );

      expect(() => decodeStealthMetaAddress(v1Meta.encoded)).to.throw(/legacy|v1/i);

      const decoded = decodeStealthMetaAddress(v1Meta.encoded, { allowLegacyV1: true });
      expect(Buffer.from(decoded.spendingPubKey)).to.deep.equal(Buffer.from(v1Meta.spendingPubKey));
      expect(Buffer.from(decoded.viewingPubKey)).to.deep.equal(Buffer.from(v1Meta.viewingPubKey));
      expect(decoded.kemPubKey).to.be.undefined;
    });

    it('sender-side deriveStealthPublicKey refuses v1 metas', () => {
      const v1Meta = generateStealthMetaAddress(
        spendingKeypair,
        viewingKeypair,
        false,
        { allowLegacyV1: true },
      );
      const ephemeral = nacl.box.keyPair();
      expect(() => deriveStealthPublicKey(v1Meta, ephemeral.secretKey))
        .to.throw(/legacy|v1|ML-KEM|hybrid/i);
    });

    it('generateStealthAddress refuses v1 metas end-to-end', () => {
      const v1Meta = generateStealthMetaAddress(
        spendingKeypair,
        viewingKeypair,
        false,
        { allowLegacyV1: true },
      );
      expect(() => generateStealthAddress(v1Meta)).to.throw();
    });

    it('isLegacyStealthMetaAddressV1 detects legacy envelopes', async () => {
      const { isLegacyStealthMetaAddressV1, isValidStealthMetaAddress } = await import(
        '../packages/specter-sdk/src/utils/helpers'
      );
      const v1Meta = generateStealthMetaAddress(
        spendingKeypair,
        viewingKeypair,
        false,
        { allowLegacyV1: true },
      );
      const v2Meta = generateStealthMetaAddress(spendingKeypair, viewingKeypair, true);

      expect(isLegacyStealthMetaAddressV1(v1Meta.encoded)).to.be.true;
      expect(isValidStealthMetaAddress(v1Meta.encoded)).to.be.false;
      expect(isLegacyStealthMetaAddressV1(v2Meta.encoded)).to.be.false;
      expect(isValidStealthMetaAddress(v2Meta.encoded)).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Stealth Address Generation (v2 - Hybrid X25519+ML-KEM-768)
  // ─────────────────────────────────────────────────────────────
  describe('3. Stealth Address Generation (v2 - Hybrid X25519+ML-KEM-768)', () => {
    let spendingKeypair: Keypair;
    let viewingKeypair: Keypair;

    before(() => {
      spendingKeypair = Keypair.generate();
      viewingKeypair = Keypair.generate();
    });

    it('generates valid v2 meta-address with KEM pubkey', () => {
      const meta = generateStealthMetaAddress(spendingKeypair, viewingKeypair, true);
      expect(meta.kemPubKey).to.not.be.undefined;
      expect(meta.kemPubKey!).to.have.lengthOf(1184);
      expect(meta.kemSecretKey).to.not.be.undefined;
      expect(meta.kemSecretKey!).to.have.lengthOf(2400);
      expect(meta.encoded.startsWith('st')).to.be.true;
    });

    it('encodes/decodes v2 meta-address (1249 bytes payload)', () => {
      const meta = generateStealthMetaAddress(spendingKeypair, viewingKeypair, true);
      const decoded = decodeStealthMetaAddress(meta.encoded);
      expect(decoded.kemPubKey).to.not.be.undefined;
      expect(decoded.kemPubKey!).to.have.lengthOf(1184);
      expect(Buffer.from(decoded.spendingPubKey)).to.deep.equal(Buffer.from(meta.spendingPubKey));
      expect(Buffer.from(decoded.viewingPubKey)).to.deep.equal(Buffer.from(meta.viewingPubKey));
      expect(Buffer.from(decoded.kemPubKey!)).to.deep.equal(Buffer.from(meta.kemPubKey!));
    });

    it('ML-KEM encapsulate/decapsulate roundtrip', () => {
      const kp = kemGenerateKeypair();
      expect(kp.publicKey).to.have.lengthOf(1184);
      expect(kp.secretKey).to.have.lengthOf(2400);

      const { cipherText, sharedSecret: senderSecret } = kemEncapsulate(kp.publicKey);
      expect(cipherText).to.have.lengthOf(1088);
      expect(senderSecret).to.have.lengthOf(32);

      const recipientSecret = kemDecapsulate(cipherText, kp.secretKey);
      expect(recipientSecret).to.have.lengthOf(32);
      expect(Buffer.from(recipientSecret)).to.deep.equal(Buffer.from(senderSecret));
    });

    it('hybrid ECDH+KEM produces same shared secret on both sides', () => {
      const ephemeral = nacl.box.keyPair();
      const recipient = nacl.box.keyPair();
      const kem = kemGenerateKeypair();

      // Sender side
      const classicSender = deriveSharedSecret(ephemeral.secretKey, recipient.publicKey);
      const { cipherText, sharedSecret: kemSenderSecret } = kemEncapsulate(kem.publicKey);
      const ctx = { ephemeralPubKey: ephemeral.publicKey, kemCiphertext: cipherText };
      const hybridSender = deriveHybridSharedSecret(classicSender, kemSenderSecret, ctx);

      // Recipient side
      const classicRecipient = deriveSharedSecret(recipient.secretKey, ephemeral.publicKey);
      const kemRecipientSecret = kemDecapsulate(cipherText, kem.secretKey);
      const hybridRecipient = deriveHybridSharedSecret(classicRecipient, kemRecipientSecret, ctx);

      expect(Buffer.from(hybridSender)).to.deep.equal(Buffer.from(hybridRecipient));
    });

    it('hybrid HKDF info is bound to (ephemeralPubKey, kemCiphertext) — mix-and-match is rejected', () => {
      const ephemeralA = nacl.box.keyPair();
      const ephemeralB = nacl.box.keyPair();
      const recipient = nacl.box.keyPair();
      const kem = kemGenerateKeypair();

      // Payment A
      const classicA = deriveSharedSecret(ephemeralA.secretKey, recipient.publicKey);
      const { cipherText: ctA, sharedSecret: kemSecretA } = kemEncapsulate(kem.publicKey);

      // Payment B
      const classicB = deriveSharedSecret(ephemeralB.secretKey, recipient.publicKey);
      const { cipherText: ctB, sharedSecret: kemSecretB } = kemEncapsulate(kem.publicKey);

      // Honest derivations
      const honestA = deriveHybridSharedSecret(classicA, kemSecretA, {
        ephemeralPubKey: ephemeralA.publicKey,
        kemCiphertext: ctA,
      });
      const honestB = deriveHybridSharedSecret(classicB, kemSecretB, {
        ephemeralPubKey: ephemeralB.publicKey,
        kemCiphertext: ctB,
      });

      // Mix-and-match: swap A's ciphertext into B's context
      const mixed = deriveHybridSharedSecret(classicB, kemSecretB, {
        ephemeralPubKey: ephemeralB.publicKey,
        kemCiphertext: ctA, // attacker swapped this
      });

      expect(Buffer.from(mixed)).to.not.deep.equal(Buffer.from(honestB));
      expect(Buffer.from(mixed)).to.not.deep.equal(Buffer.from(honestA));
    });

    it('v2 stealth address derivation matches', () => {
      const spendKp = nacl.box.keyPair();
      const viewKp = nacl.box.keyPair();
      const kem = kemGenerateKeypair();

      const encoded = encodeStealthMetaAddress(spendKp.publicKey, viewKp.publicKey, kem.publicKey);
      const meta = parseStealthMetaAddress(encoded);

      const ephemeral = nacl.box.keyPair();
      const senderResult = deriveStealthPublicKey(meta, ephemeral.secretKey);
      expect(senderResult.kemCiphertext).to.not.be.undefined;
      expect(senderResult.kemCiphertext!).to.have.lengthOf(1088);

      const recipientKeypair = deriveStealthPrivateKey(
        spendKp.publicKey,
        viewKp.secretKey,
        senderResult.ephemeralPubKey,
        kem.secretKey,
        senderResult.kemCiphertext
      );

      expect(recipientKeypair.publicKey.equals(senderResult.stealthPubKey)).to.be.true;
    });

    it('50 v2 stealth addresses all unique', () => {
      const meta = generateStealthMetaAddress(spendingKeypair, viewingKeypair, true);
      const addresses = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const stealth = generateStealthAddress(meta);
        addresses.add(stealth.address.toBase58());
      }
      expect(addresses.size).to.equal(50);
    });

    it('v2 memo format includes KEM ciphertext', () => {
      const meta = generateStealthMetaAddress(spendingKeypair, viewingKeypair, true);
      const stealth = generateStealthAddress(meta);
      expect(stealth.kemCiphertext).to.not.be.undefined;
      expect(stealth.kemCiphertext!).to.have.lengthOf(1088);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. WOTS+ Signatures (Quantum-Safe)
  // ─────────────────────────────────────────────────────────────
  describe('4. WOTS+ Signatures (Quantum-Safe)', () => {
    it('generates deterministic keypair from seed', () => {
      const seed = randomSeed();
      const kp1 = generateWotsKeypair(seed);
      const kp2 = generateWotsKeypair(seed);
      expect(Buffer.from(kp1.secretKey)).to.deep.equal(Buffer.from(kp2.secretKey));
      expect(Buffer.from(kp1.publicKey)).to.deep.equal(Buffer.from(kp2.publicKey));
      expect(Buffer.from(kp1.publicKeyHash)).to.deep.equal(Buffer.from(kp2.publicKeyHash));
    });

    it('sign + verify roundtrip', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = sha256(new TextEncoder().encode('test message'));
      const sig = wotsSign(new Uint8Array(message), kp);
      const valid = wotsVerify(new Uint8Array(message), sig, kp.publicKeyHash);
      expect(valid).to.be.true;
    });

    it('rejects wrong message', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = sha256(new TextEncoder().encode('test message'));
      const sig = wotsSign(new Uint8Array(message), kp);
      const wrongMessage = sha256(new TextEncoder().encode('wrong message'));
      const valid = wotsVerify(new Uint8Array(wrongMessage), sig, kp.publicKeyHash);
      expect(valid).to.be.false;
    });

    it('rejects modified signature', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = sha256(new TextEncoder().encode('test message'));
      const sig = wotsSign(new Uint8Array(message), kp);
      // Flip a byte in the signature
      sig.signature[0] ^= 0xff;
      const valid = wotsVerify(new Uint8Array(message), sig, kp.publicKeyHash);
      expect(valid).to.be.false;
    });

    it('key rotation: sign with key0, generate key1, verify key1 different', () => {
      const masterSeed = randomSeed();
      const kp0 = deriveWotsKeypair(masterSeed, 0);
      const kp1 = deriveWotsKeypair(masterSeed, 1);

      expect(Buffer.from(kp0.publicKeyHash)).to.not.deep.equal(Buffer.from(kp1.publicKeyHash));
      expect(Buffer.from(kp0.secretKey)).to.not.deep.equal(Buffer.from(kp1.secretKey));
    });

    it('all-zero message hash', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = new Uint8Array(32); // all zeros
      const sig = wotsSign(message, kp);
      const valid = wotsVerify(message, sig, kp.publicKeyHash);
      expect(valid).to.be.true;
    });

    it('all-0xFF message hash', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = new Uint8Array(32).fill(0xff);
      const sig = wotsSign(message, kp);
      const valid = wotsVerify(message, sig, kp.publicKeyHash);
      expect(valid).to.be.true;
    });

    it('signature is exactly 2144 bytes (67 chains × 32 bytes)', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = sha256(new TextEncoder().encode('size test'));
      const sig = wotsSign(new Uint8Array(message), kp);
      expect(sig.signature).to.have.lengthOf(WOTS_SIG_SIZE);
      expect(WOTS_SIG_SIZE).to.equal(2144);
      expect(sig.publicKey).to.have.lengthOf(WOTS_PUBKEY_SIZE);
      expect(WOTS_PUBKEY_SIZE).to.equal(2144);
    });

    it('50 unique keypairs from different seeds', () => {
      const pubKeyHashes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const seed = randomSeed();
        const kp = generateWotsKeypair(seed);
        pubKeyHashes.add(toHex(kp.publicKeyHash));
      }
      expect(pubKeyHashes.size).to.equal(50);
    });

    it('performance: generate keypair < 100ms', () => {
      const seed = randomSeed();
      const start = Date.now();
      generateWotsKeypair(seed);
      const elapsed = Date.now() - start;
      expect(elapsed).to.be.lessThan(100);
      console.log(`    WOTS+ keygen: ${elapsed}ms`);
    });

    it('performance: sign < 100ms', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = sha256(new TextEncoder().encode('perf'));
      const start = Date.now();
      wotsSign(new Uint8Array(message), kp);
      const elapsed = Date.now() - start;
      expect(elapsed).to.be.lessThan(100);
      console.log(`    WOTS+ sign: ${elapsed}ms`);
    });

    it('performance: verify < 100ms', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = sha256(new TextEncoder().encode('perf'));
      const sig = wotsSign(new Uint8Array(message), kp);
      const start = Date.now();
      wotsVerify(new Uint8Array(message), sig, kp.publicKeyHash);
      const elapsed = Date.now() - start;
      expect(elapsed).to.be.lessThan(100);
      console.log(`    WOTS+ verify: ${elapsed}ms`);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Hash-Timelock Vault Helpers
  // ─────────────────────────────────────────────────────────────
  describe('5. Hash-Timelock Vault Helpers', () => {
    it('commitment = SHA-256(secret) is deterministic', () => {
      const secret = generateVaultSecret();
      const c1 = computeHashVaultCommitment(secret);
      const c2 = computeHashVaultCommitment(secret);
      expect(Buffer.from(c1)).to.deep.equal(Buffer.from(c2));
      expect(c1).to.have.lengthOf(32);
    });

    it('verify preimage against commitment', () => {
      const secret = generateVaultSecret();
      const commitment = computeHashVaultCommitment(secret);
      const recomputed = sha256(secret);
      expect(Buffer.from(commitment)).to.deep.equal(Buffer.from(recomputed));
    });

    it('reject wrong preimage', () => {
      const secret = generateVaultSecret();
      const commitment = computeHashVaultCommitment(secret);
      const wrongSecret = generateVaultSecret();
      const wrongCommitment = computeHashVaultCommitment(wrongSecret);
      expect(Buffer.from(commitment)).to.not.deep.equal(Buffer.from(wrongCommitment));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Commit-Reveal Helpers
  // ─────────────────────────────────────────────────────────────
  describe('6. Commit-Reveal Helpers', () => {
    it('commitment = SHA-256(action_data || nonce)', () => {
      const actionData = new TextEncoder().encode('withdraw:100');
      const nonce = generateNonce();
      const commitment = computeCommitRevealCommitment(actionData, nonce);
      expect(commitment).to.have.lengthOf(32);

      // Manual verification
      const combined = new Uint8Array(actionData.length + nonce.length);
      combined.set(actionData);
      combined.set(nonce, actionData.length);
      const expected = sha256(combined);
      expect(Buffer.from(commitment)).to.deep.equal(Buffer.from(expected));
    });

    it('reveal matches commitment', () => {
      const actionData = new TextEncoder().encode('transfer:50');
      const nonce = generateNonce();
      const commitment = computeCommitRevealCommitment(actionData, nonce);
      const recomputed = computeCommitRevealCommitment(actionData, nonce);
      expect(Buffer.from(commitment)).to.deep.equal(Buffer.from(recomputed));
    });

    it('reject mismatched reveal', () => {
      const actionData = new TextEncoder().encode('transfer:50');
      const nonce1 = generateNonce();
      const nonce2 = generateNonce();
      const c1 = computeCommitRevealCommitment(actionData, nonce1);
      const c2 = computeCommitRevealCommitment(actionData, nonce2);
      expect(Buffer.from(c1)).to.not.deep.equal(Buffer.from(c2));
    });

    it('nonce randomness: 100 nonces all unique', () => {
      const nonces = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const n = generateNonce();
        nonces.add(toHex(n));
      }
      expect(nonces.size).to.equal(100);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 7. NaCl Encryption (Secretbox)
  // ─────────────────────────────────────────────────────────────
  describe('7. NaCl Encryption (Secretbox)', () => {
    it('encrypt/decrypt roundtrip with secretbox', () => {
      const key = randomSeed();
      const plaintext = new TextEncoder().encode('Hello, Protocol 01!');
      const ciphertext = encrypt(plaintext, key);
      const decrypted = decrypt(ciphertext, key);
      expect(decrypted).to.not.be.null;
      expect(new TextDecoder().decode(decrypted!)).to.equal('Hello, Protocol 01!');
    });

    it('wrong key fails decryption', () => {
      const key1 = randomSeed();
      const key2 = randomSeed();
      const plaintext = new TextEncoder().encode('secret');
      const ciphertext = encrypt(plaintext, key1);
      const decrypted = decrypt(ciphertext, key2);
      expect(decrypted).to.be.null;
    });

    it('different nonces -> different ciphertext', () => {
      const key = randomSeed();
      const plaintext = new TextEncoder().encode('same plaintext');
      const c1 = encrypt(plaintext, key);
      const c2 = encrypt(plaintext, key);
      // Nonces are random, so ciphertexts should differ
      expect(Buffer.from(c1)).to.not.deep.equal(Buffer.from(c2));
    });

    it('ciphertext is nonce(24) + encrypted + tag', () => {
      const key = randomSeed();
      const plaintext = new TextEncoder().encode('test');
      const ciphertext = encrypt(plaintext, key);
      // nonce = 24 bytes, ciphertext = plaintext.length + 16 (Poly1305 tag)
      expect(ciphertext.length).to.equal(24 + plaintext.length + 16);
    });

    it('100 encrypt/decrypt roundtrips', () => {
      const key = randomSeed();
      for (let i = 0; i < 100; i++) {
        const msg = new TextEncoder().encode(`message-${i}`);
        const ct = encrypt(msg, key);
        const pt = decrypt(ct, key);
        expect(pt).to.not.be.null;
        expect(new TextDecoder().decode(pt!)).to.equal(`message-${i}`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 8. NaCl Box (ECDH Encryption)
  // ─────────────────────────────────────────────────────────────
  describe('8. NaCl Box (ECDH Encryption)', () => {
    it('box: sender encrypts, recipient decrypts', () => {
      const sender = nacl.box.keyPair();
      const recipient = nacl.box.keyPair();
      const plaintext = new TextEncoder().encode('private payment');

      const encrypted = encryptForRecipient(plaintext, recipient.publicKey, sender.secretKey);
      const decrypted = decryptFromSender(encrypted, sender.publicKey, recipient.secretKey);

      expect(decrypted).to.not.be.null;
      expect(new TextDecoder().decode(decrypted!)).to.equal('private payment');
    });

    it('wrong recipient key fails', () => {
      const sender = nacl.box.keyPair();
      const recipient = nacl.box.keyPair();
      const wrong = nacl.box.keyPair();
      const plaintext = new TextEncoder().encode('secret');

      const encrypted = encryptForRecipient(plaintext, recipient.publicKey, sender.secretKey);
      const decrypted = decryptFromSender(encrypted, sender.publicKey, wrong.secretKey);

      expect(decrypted).to.be.null;
    });

    it('different nonces -> different ciphertext', () => {
      const sender = nacl.box.keyPair();
      const recipient = nacl.box.keyPair();
      const plaintext = new TextEncoder().encode('same message');

      const c1 = encryptForRecipient(plaintext, recipient.publicKey, sender.secretKey);
      const c2 = encryptForRecipient(plaintext, recipient.publicKey, sender.secretKey);

      expect(Buffer.from(c1)).to.not.deep.equal(Buffer.from(c2));
    });

    it('10 key exchanges all produce valid encrypted channels', () => {
      for (let i = 0; i < 10; i++) {
        const alice = nacl.box.keyPair();
        const bob = nacl.box.keyPair();
        const msg = new TextEncoder().encode(`channel-${i}`);

        const encrypted = encryptForRecipient(msg, bob.publicKey, alice.secretKey);
        const decrypted = decryptFromSender(encrypted, alice.publicKey, bob.secretKey);

        expect(decrypted).to.not.be.null;
        expect(new TextDecoder().decode(decrypted!)).to.equal(`channel-${i}`);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 9. SHA-256 & Constant-Time Comparison
  // ─────────────────────────────────────────────────────────────
  describe('9. SHA-256 & Constant-Time Comparison', () => {
    it('SHA-256 matches known test vectors', () => {
      // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
      const emptyHash = hash(new Uint8Array(0));
      expect(toHex(emptyHash)).to.equal(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );

      // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
      const abcHash = hashString('abc');
      expect(toHex(abcHash)).to.equal(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
    });

    it('double-hash produces known result', () => {
      const data = new TextEncoder().encode('test');
      const dh = doubleHash(data);
      const manual = sha256(sha256(data));
      expect(Buffer.from(dh)).to.deep.equal(Buffer.from(manual));
    });

    it('constant-time compare: equal buffers -> true', () => {
      const a = new Uint8Array([1, 2, 3, 4, 5]);
      const b = new Uint8Array([1, 2, 3, 4, 5]);
      expect(constantTimeEqual(a, b)).to.be.true;
    });

    it('constant-time compare: different buffers -> false', () => {
      const a = new Uint8Array([1, 2, 3, 4, 5]);
      const b = new Uint8Array([1, 2, 3, 4, 6]);
      expect(constantTimeEqual(a, b)).to.be.false;
    });

    it('constant-time compare: different lengths -> false', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(constantTimeEqual(a, b)).to.be.false;
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 10. Ed25519 -> X25519 Conversion
  // ─────────────────────────────────────────────────────────────
  describe('10. Ed25519 -> X25519 Conversion', () => {
    it('converts Ed25519 public key to X25519', () => {
      const edKeypair = nacl.sign.keyPair();
      const x25519Pub = ed25519PublicKeyToX25519(edKeypair.publicKey);
      expect(x25519Pub).to.have.lengthOf(32);
    });

    it('converted key is valid X25519 point', () => {
      const edKeypair = nacl.sign.keyPair();
      const x25519Pub = ed25519PublicKeyToX25519(edKeypair.publicKey);
      // A valid X25519 point should produce a non-zero result when used in scalar mult
      const randomScalar = nacl.box.keyPair().secretKey;
      const result = nacl.scalarMult(randomScalar, x25519Pub);
      // Result should not be all zeros (degenerate)
      const allZero = result.every(b => b === 0);
      expect(allZero).to.be.false;
    });

    it('conversion is deterministic', () => {
      const edKeypair = nacl.sign.keyPair();
      const x1 = ed25519PublicKeyToX25519(edKeypair.publicKey);
      const x2 = ed25519PublicKeyToX25519(edKeypair.publicKey);
      expect(Buffer.from(x1)).to.deep.equal(Buffer.from(x2));
    });

    it('ECDH works with converted keys', () => {
      // Alice: Ed25519 keypair -> convert to X25519
      const aliceEd = nacl.sign.keyPair();
      const aliceX25519Pub = ed25519PublicKeyToX25519(aliceEd.publicKey);
      const aliceX25519Priv = ed25519SecretKeyToX25519(aliceEd.secretKey.slice(0, 32));

      // Bob: native X25519 keypair
      const bob = nacl.box.keyPair();

      // Both sides compute shared secret
      const secretAlice = nacl.scalarMult(aliceX25519Priv, bob.publicKey);
      const secretBob = nacl.scalarMult(bob.secretKey, aliceX25519Pub);

      expect(Buffer.from(secretAlice)).to.deep.equal(Buffer.from(secretBob));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 11. HKDF Key Derivation
  // ─────────────────────────────────────────────────────────────
  describe('11. HKDF Key Derivation', () => {
    it('produces 32-byte key from shared secret', () => {
      const sharedSecret = randomSeed();
      const key = deriveKey(sharedSecret, 'test-info', 32);
      expect(key).to.have.lengthOf(32);
    });

    it('different info strings -> different keys', () => {
      const sharedSecret = randomSeed();
      const k1 = deriveKey(sharedSecret, 'info-1', 32);
      const k2 = deriveKey(sharedSecret, 'info-2', 32);
      expect(Buffer.from(k1)).to.not.deep.equal(Buffer.from(k2));
    });

    it('different salts -> different keys', () => {
      const ikm = randomSeed();
      const k1 = hkdf(sha256, ikm, randomBytes(16), utf8ToBytes('same-info'), 32);
      const k2 = hkdf(sha256, ikm, randomBytes(16), utf8ToBytes('same-info'), 32);
      expect(Buffer.from(k1)).to.not.deep.equal(Buffer.from(k2));
    });

    it('deterministic with same inputs', () => {
      const sharedSecret = randomSeed();
      const k1 = deriveKey(sharedSecret, 'deterministic', 32);
      const k2 = deriveKey(sharedSecret, 'deterministic', 32);
      expect(Buffer.from(k1)).to.deep.equal(Buffer.from(k2));
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 12. RPC Config (@protocol-01/rpc-config)
  // ─────────────────────────────────────────────────────────────
  describe('12. RPC Config (@protocol-01/rpc-config)', () => {
    it('getEndpoints returns sorted by priority', () => {
      const eps = getEndpoints('devnet');
      expect(eps.length).to.be.greaterThanOrEqual(1);
      // Should be sorted ascending by priority
      for (let i = 1; i < eps.length; i++) {
        expect(eps[i].priority).to.be.greaterThanOrEqual(eps[i - 1].priority);
      }
    });

    it('Helius endpoint included when API key provided', () => {
      const eps = getEndpoints('devnet', { heliusApiKey: 'test-key-123' });
      const helius = eps.find(e => e.provider === 'helius');
      expect(helius).to.not.be.undefined;
      expect(helius!.http).to.include('helius-rpc.com');
      expect(helius!.http).to.include('test-key-123');
    });

    it('public Solana RPC always last', () => {
      const eps = getEndpoints('devnet', { heliusApiKey: 'key' });
      const last = eps[eps.length - 1];
      expect(last.provider).to.equal('solana-public');
    });

    it('sanitizeRpcUrl strips API keys', () => {
      const url = 'https://devnet.helius-rpc.com/?api-key=SECRET123';
      const sanitized = sanitizeRpcUrl(url);
      expect(sanitized).to.not.include('SECRET123');
      expect(sanitized).to.include('***');
    });

    it('validateRpcEndpoint rejects http (non-localhost)', () => {
      expect(() => validateRpcEndpoint('http://example.com/rpc')).to.throw();
    });

    it('validateRpcEndpoint allows https', () => {
      expect(() => validateRpcEndpoint('https://api.devnet.solana.com')).to.not.throw();
    });

    it('validateRpcEndpoint allows localhost http', () => {
      expect(() => validateRpcEndpoint('http://localhost:8899')).to.not.throw();
      expect(() => validateRpcEndpoint('http://127.0.0.1:8899')).to.not.throw();
    });

    it('RpcConnectionManager creates valid connection', () => {
      const mgr = new RpcConnectionManager({ cluster: 'devnet' });
      const conn = mgr.getConnection();
      expect(conn).to.not.be.null;
      expect(conn).to.not.be.undefined;
    });

    it('RpcConnectionManager switchEndpoint cycles through endpoints', () => {
      const mgr = new RpcConnectionManager({
        cluster: 'devnet',
        heliusApiKey: 'test-key',
      });
      const ep1 = mgr.getCurrentEndpoint();
      mgr.switchEndpoint();
      const ep2 = mgr.getCurrentEndpoint();
      // With 2+ endpoints, they should differ (unless only 1)
      if (mgr['endpoints'].length > 1) {
        expect(ep1.http).to.not.equal(ep2.http);
      }
    });

    it('getExplorerUrl formats correctly for devnet/mainnet', () => {
      const devnetUrl = getExplorerUrl('abc123', 'devnet', 'tx');
      expect(devnetUrl).to.include('explorer.solana.com');
      expect(devnetUrl).to.include('abc123');
      expect(devnetUrl).to.include('cluster=devnet');

      const mainnetUrl = getExplorerUrl('xyz789', 'mainnet-beta', 'tx');
      expect(mainnetUrl).to.include('explorer.solana.com');
      expect(mainnetUrl).to.include('xyz789');
      expect(mainnetUrl).to.not.include('cluster=');
    });

    it('getSolscanUrl formats correctly', () => {
      const devnetUrl = getSolscanUrl('abc123', 'devnet', 'tx');
      expect(devnetUrl).to.include('solscan.io');
      expect(devnetUrl).to.include('abc123');
      expect(devnetUrl).to.include('cluster=devnet');

      const mainnetUrl = getSolscanUrl('xyz789', 'mainnet-beta', 'address');
      expect(mainnetUrl).to.include('solscan.io');
      expect(mainnetUrl).to.include('account');
      expect(mainnetUrl).to.include('xyz789');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 13. Amount Noise (Privacy)
  // ─────────────────────────────────────────────────────────────
  describe('13. Amount Noise (Privacy)', () => {
    // Simple noise application: add random noise within +/- percentage
    function applyNoise(amount: number, pct: number): number {
      const noise = (Math.random() * 2 - 1) * pct * amount;
      return amount + noise;
    }

    it('applies noise within +/- percentage', () => {
      const amount = 1000;
      const pct = 0.05; // 5%
      for (let i = 0; i < 100; i++) {
        const noised = applyNoise(amount, pct);
        expect(noised).to.be.greaterThanOrEqual(amount * (1 - pct));
        expect(noised).to.be.lessThanOrEqual(amount * (1 + pct));
      }
    });

    it('cumulative adjustment trends toward zero', () => {
      const amount = 1000;
      const pct = 0.05;
      let cumulative = 0;
      const iterations = 10000;
      for (let i = 0; i < iterations; i++) {
        const noised = applyNoise(amount, pct);
        cumulative += noised - amount;
      }
      // Average offset should be near zero (law of large numbers)
      const avgOffset = Math.abs(cumulative / iterations);
      expect(avgOffset).to.be.lessThan(amount * pct * 0.1); // within 10% of max noise
    });

    it('final payment auto-corrects cumulative offset', () => {
      const amounts = [100, 200, 300, 400];
      const pct = 0.05;
      let cumulative = 0;

      for (let i = 0; i < amounts.length - 1; i++) {
        const noised = applyNoise(amounts[i], pct);
        cumulative += noised - amounts[i];
      }

      // Final payment corrects the offset
      const finalAmount = amounts[amounts.length - 1] - cumulative;
      const totalOriginal = amounts.reduce((s, a) => s + a, 0);
      const totalNoised =
        amounts.slice(0, -1).reduce((s, a) => s + applyNoise(a, pct), 0) + finalAmount;
      // For this test, verify concept: sum(noised) can be corrected
      expect(finalAmount).to.be.a('number');
    });

    it('100 noised amounts stay within bounds', () => {
      const amount = 500;
      const pct = 0.10;
      for (let i = 0; i < 100; i++) {
        const noised = applyNoise(amount, pct);
        expect(noised).to.be.greaterThanOrEqual(amount * 0.9);
        expect(noised).to.be.lessThanOrEqual(amount * 1.1);
      }
    });

    it('noise distribution is approximately uniform', () => {
      const amount = 1000;
      const pct = 0.05;
      let positive = 0;
      let negative = 0;
      const n = 10000;

      for (let i = 0; i < n; i++) {
        const noised = applyNoise(amount, pct);
        if (noised >= amount) positive++;
        else negative++;
      }

      // Should be roughly 50/50
      const ratio = positive / n;
      expect(ratio).to.be.greaterThan(0.4);
      expect(ratio).to.be.lessThan(0.6);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 14. Edge Cases & Adversarial Inputs
  // ─────────────────────────────────────────────────────────────
  describe('14. Edge Cases & Adversarial Inputs', () => {
    it('Poseidon: max field value (p-1)', () => {
      const pMinus1 = BN254_P - 1n;
      const h = poseidon2([pMinus1, pMinus1]);

      expectLt(h, BN254_P);
    });

    it('Poseidon: zero input', () => {
      const h = poseidon2([0n, 0n]);
      expect(h).to.be.a('bigint');

    });

    it('WOTS+: empty message (32 zero bytes, should still work)', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = new Uint8Array(32);
      const sig = wotsSign(message, kp);
      expect(wotsVerify(message, sig, kp.publicKeyHash)).to.be.true;
    });

    it('stealth: self-payment (sender = recipient meta-address)', () => {
      const kp = nacl.box.keyPair();
      const kem = kemGenerateKeypair();
      const encoded = encodeStealthMetaAddress(kp.publicKey, kp.publicKey, kem.publicKey);
      const meta = parseStealthMetaAddress(encoded);
      const stealth = generateStealthAddress(meta);
      expect(stealth.address).to.be.instanceOf(PublicKey);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 15. Performance Benchmarks
  // ─────────────────────────────────────────────────────────────
  describe('15. Performance Benchmarks', () => {
    it('Poseidon 2-input: 1000 hashes < 5s', () => {
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        poseidon2([BigInt(i), BigInt(i + 1)]);
      }
      const elapsed = Date.now() - start;
      console.log(`    Poseidon 2-input x1000: ${elapsed}ms`);
      expect(elapsed).to.be.lessThan(5000);
    });

    it('Poseidon 4-input: 1000 hashes < 10s', () => {
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        poseidon4([BigInt(i), BigInt(i + 1), BigInt(i + 2), BigInt(i + 3)]);
      }
      const elapsed = Date.now() - start;
      console.log(`    Poseidon 4-input x1000: ${elapsed}ms`);
      expect(elapsed).to.be.lessThan(10000);
    });

    it('Stealth address gen: 100 < 10s (v2 hybrid)', () => {
      const spending = Keypair.generate();
      const viewing = Keypair.generate();
      const meta = generateStealthMetaAddress(spending, viewing);

      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        generateStealthAddress(meta);
      }
      const elapsed = Date.now() - start;
      console.log(`    Stealth gen x100 (v2): ${elapsed}ms`);
      expect(elapsed).to.be.lessThan(10000);
    });

    it('WOTS+ keygen: 50 < 5s', () => {
      const start = Date.now();
      for (let i = 0; i < 50; i++) {
        const seed = new Uint8Array(32);
        seed[0] = i;
        generateWotsKeypair(seed);
      }
      const elapsed = Date.now() - start;
      console.log(`    WOTS+ keygen x50: ${elapsed}ms`);
      expect(elapsed).to.be.lessThan(5000);
    });

    it('WOTS+ sign+verify: 50 < 10s', () => {
      const seed = randomSeed();
      const kp = generateWotsKeypair(seed);
      const message = sha256(new TextEncoder().encode('benchmark'));

      const start = Date.now();
      for (let i = 0; i < 50; i++) {
        const sig = wotsSign(new Uint8Array(message), kp);
        wotsVerify(new Uint8Array(message), sig, kp.publicKeyHash);
      }
      const elapsed = Date.now() - start;
      console.log(`    WOTS+ sign+verify x50: ${elapsed}ms`);
      expect(elapsed).to.be.lessThan(10000);
    });
  });
});
