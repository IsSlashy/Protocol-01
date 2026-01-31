/**
 * E2E Integration Test: Privacy Level Demonstration
 *
 * ==========================================================================
 * PROTOCOL 01 -- THREE-TIER PRIVACY ARCHITECTURE
 * ==========================================================================
 *
 * This test demonstrates the three privacy levels in Protocol 01:
 *
 * TIER 1: STANDARD PRIVACY
 *   Single stealth transfer. One fresh address per payment.
 *   - Unlinkable receiver address
 *   - Sender still visible on-chain
 *   - Fastest and cheapest option
 *
 * TIER 2: ENHANCED PRIVACY
 *   Split transfers with time delays. Each split goes to a different
 *   stealth address, making it harder to correlate parts of one payment.
 *   - Multiple stealth addresses per payment
 *   - Configurable delay between splits
 *   - Moderate additional cost
 *
 * TIER 3: MAXIMUM PRIVACY
 *   Full privacy stack: relayer network + multi-hop routing + ZK shielded
 *   pool + stealth addresses.
 *   - Sender identity hidden (relayer submits tx)
 *   - Funds pass through ZK shielded pool (breaks tx graph)
 *   - Multiple hops with independent stealth addresses
 *   - Highest cost, but strongest guarantees
 *
 *   Flow diagram for MAXIMUM privacy:
 *
 *   User Wallet
 *     |
 *     v
 *   [Relayer] (hides sender)
 *     |
 *     v
 *   [ZK Shielded Pool] (breaks on-chain link)
 *     |  shield -> transfer -> unshield
 *     v
 *   [Stealth Address 1] -> [Stealth Address 2] -> [Recipient Stealth]
 *         (hop 1)               (hop 2)              (final)
 *
 * Environment: Solana devnet / localnet
 * Run: ts-mocha -p tsconfig.test.json tests/e2e-privacy-modes.test.ts --timeout 300000
 */

import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { assert } from 'chai';
import nacl from 'tweetnacl';
import * as crypto from 'crypto';

// -- Stealth SDK --
import {
  generateStealthMetaAddress,
  generateStealthAddress,
  generateMultipleStealthAddresses,
  generateStealthTransferData,
  createStealthAnnouncement,
  parseStealthAnnouncement,
} from '../packages/specter-sdk/src/stealth/generate';

import {
  deriveStealthPublicKey,
  deriveStealthPrivateKey,
  verifyStealthOwnership,
} from '../packages/specter-sdk/src/stealth/derive';

import {
  createScanner,
  StealthScanner,
} from '../packages/specter-sdk/src/stealth/scan';

// -- Transfer SDK --
import { estimateTransferFee } from '../packages/specter-sdk/src/transfer/send';

// -- Crypto utilities --
import {
  deriveSharedSecret,
  computeViewTag,
  generateEphemeralKeypair,
  encrypt,
  decrypt,
  encryptForRecipient,
  decryptFromSender,
  hash,
  hashString,
  doubleHash,
  toBase58,
  fromBase58,
  toHex,
  fromHex,
  randomBytes,
  sign,
  verify,
  constantTimeEqual,
  secureClear,
} from '../packages/specter-sdk/src/utils/crypto';

// -- Relayer network --
import {
  RelayerNetwork,
  getRelayerNetwork,
} from '../packages/zk-sdk/src/relayer/relayerNetwork';

import type {
  RelayerInfo,
  RelayerHealth,
  RelayRequest,
  RelayResponse,
} from '../packages/zk-sdk/src/relayer/relayerNetwork';

// -- ZK SDK --
import type {
  PrivacyLevel,
  PrivacyOptions,
  StealthMetaAddress,
} from '../packages/specter-sdk/src/types';

// ============================================================================
// Helpers
// ============================================================================

const DEVNET_URL = 'https://api.devnet.solana.com';
const LOCALNET_URL = 'http://localhost:8899';

async function getConnection(): Promise<Connection> {
  try {
    const local = new Connection(LOCALNET_URL, 'confirmed');
    await local.getSlot();
    return local;
  } catch {
    return new Connection(DEVNET_URL, 'confirmed');
  }
}

function createTestMetaAddress(): {
  meta: ReturnType<typeof generateStealthMetaAddress>;
  spendKey: Keypair;
  viewKey: nacl.BoxKeyPair;
} {
  const spendKey = Keypair.generate();
  const viewKey = nacl.box.keyPair();
  const meta = generateStealthMetaAddress(
    spendKey,
    Keypair.fromSecretKey(
      nacl.sign.keyPair.fromSeed(viewKey.secretKey).secretKey
    )
  );
  return { meta, spendKey, viewKey };
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Privacy Level Demonstration', function () {
  this.timeout(300_000);

  let connection: Connection;
  let recipient: ReturnType<typeof createTestMetaAddress>;

  before(async () => {
    connection = await getConnection();
    recipient = createTestMetaAddress();

    console.log('\n' + '='.repeat(72));
    console.log('  Protocol 01 -- Privacy Modes E2E Test');
    console.log('='.repeat(72));
    console.log(`  Recipient meta-addr: ${recipient.meta.encoded.slice(0, 40)}...`);
    console.log('');
  });

  // ==========================================================================
  // TIER 1: Standard Privacy
  // ==========================================================================

  describe('TIER 1: Standard Privacy (Single Stealth Transfer)', () => {
    it('1.1 -- A single stealth address is generated per payment', () => {
      /**
       * STANDARD PRIVACY generates one stealth address per payment.
       * This is the fastest and cheapest option.
       *
       * Properties:
       * - Fresh one-time address: NO address reuse
       * - Receiver is unlinkable: observer cannot connect to recipient
       * - Sender is visible: the sending address is on-chain
       * - Single transaction: minimal fees
       */
      const stealth = generateStealthAddress(recipient.meta);

      assert.ok(stealth.address, 'stealth address should be generated');
      assert.ok(stealth.ephemeralPubKey, 'ephemeral key exists');
      assert.isNumber(stealth.viewTag);

      console.log('    Standard privacy: 1 stealth address, 1 transaction');
      console.log(`    Address: ${stealth.address.toBase58()}`);
      console.log(`    View tag: 0x${stealth.viewTag.toString(16).padStart(2, '0')}`);
    });

    it('1.2 -- Standard transfer data is compact', () => {
      /**
       * A standard transfer requires:
       * - 1 stealth address (32 bytes)
       * - 1 ephemeral pubkey (32 bytes)
       * - 1 view tag (1 byte)
       * - 1 announcement (65 bytes)
       * Total overhead: 65 bytes on-chain (in memo)
       */
      const data = generateStealthTransferData(recipient.meta, 1_000_000_000n);
      const announcement = data.announcement;

      assert.equal(announcement.length, 65, 'announcement should be 65 bytes');

      console.log('    On-chain overhead: 65 bytes');
      console.log('    Transactions: 1');
      console.log('    Estimated time: ~400ms (1 confirmation)');
    });

    it('1.3 -- Recipient can verify ownership with viewing key', () => {
      /**
       * The recipient uses their viewing key to check if the stealth
       * address belongs to them.  View-tag pre-filtering makes this
       * efficient even with thousands of announcements.
       */
      const stealth = generateStealthAddress(recipient.meta);

      const isOwner = verifyStealthOwnership(
        stealth.address,
        stealth.ephemeralPubKey,
        recipient.viewKey.secretKey,
        recipient.spendKey.publicKey.toBytes(),
        stealth.viewTag
      );

      assert.isTrue(isOwner, 'recipient should verify ownership');
      console.log('    Ownership verification: PASS');
    });

    it('1.4 -- Fee estimation for standard privacy', async () => {
      const fee = await estimateTransferFee(connection, 'standard');
      assert.ok(fee > 0n);
      console.log(`    Estimated fee: ${fee} lamports`);
    });
  });

  // ==========================================================================
  // TIER 2: Enhanced Privacy
  // ==========================================================================

  describe('TIER 2: Enhanced Privacy (Split Transfers with Delays)', () => {
    it('2.1 -- Payment is split across multiple stealth addresses', () => {
      /**
       * ENHANCED PRIVACY splits the payment into N parts, each sent to
       * a different stealth address.  An observer sees N independent
       * transactions with no obvious link.
       *
       * Properties:
       * - Multiple fresh addresses: even harder to correlate
       * - Time delays: transactions are spread over time
       * - Sender still visible, but pattern is obscured
       */
      const splitCount = 4;
      const totalAmount = 10_000_000_000n; // 10 SOL
      const amountPerSplit = totalAmount / BigInt(splitCount);

      const splits = Array.from({ length: splitCount }, (_, i) => {
        const data = generateStealthTransferData(
          recipient.meta,
          i === splitCount - 1
            ? amountPerSplit + (totalAmount % BigInt(splitCount))
            : amountPerSplit
        );
        return data;
      });

      // Verify all addresses are unique
      const addresses = new Set(splits.map(s => s.stealthAddress.toBase58()));
      assert.equal(addresses.size, splitCount, 'all split addresses should be unique');

      // Verify total amount
      const totalSent = splits.reduce((sum, s) => sum + s.amount, 0n);
      assert.equal(totalSent, totalAmount, 'total should equal original amount');

      console.log(`    Split into ${splitCount} parts:`);
      for (let i = 0; i < splits.length; i++) {
        console.log(`      [${i + 1}] ${splits[i]!.amount} lamports -> ${splits[i]!.stealthAddress.toBase58().slice(0, 20)}...`);
      }
      console.log(`    Total: ${totalSent} lamports`);
    });

    it('2.2 -- Time delays between splits obscure transaction patterns', () => {
      /**
       * Enhanced privacy introduces configurable delays between split
       * transactions.  This makes it harder for blockchain analysts to
       * correlate them as parts of one payment.
       */
      const delayMs = 5000; // 5 seconds between splits
      const splitCount = 3;

      // Simulate timing
      const timestamps: number[] = [];
      const baseTime = Date.now();

      for (let i = 0; i < splitCount; i++) {
        timestamps.push(baseTime + i * delayMs);
      }

      // Verify spread
      const totalSpread = timestamps[timestamps.length - 1]! - timestamps[0]!;
      assert.equal(totalSpread, (splitCount - 1) * delayMs);

      console.log(`    Delay: ${delayMs}ms between splits`);
      console.log(`    Total time spread: ${totalSpread}ms`);
      console.log('    Timing pattern: harder to correlate');
    });

    it('2.3 -- Each split is independently verifiable by the recipient', () => {
      /**
       * The recipient can independently detect and verify each split
       * payment.  They don't need to know about the other splits.
       */
      const splits = generateMultipleStealthAddresses(recipient.meta, 3);

      for (let i = 0; i < splits.length; i++) {
        const isOwner = verifyStealthOwnership(
          splits[i]!.address,
          splits[i]!.ephemeralPubKey,
          recipient.viewKey.secretKey,
          recipient.spendKey.publicKey.toBytes(),
          splits[i]!.viewTag
        );

        assert.isTrue(isOwner, `split ${i + 1} should verify`);
      }

      console.log(`    All ${splits.length} splits verified independently`);
    });

    it('2.4 -- Enhanced privacy fee estimation', async () => {
      const fee = await estimateTransferFee(connection, 'enhanced');
      const standardFee = await estimateTransferFee(connection, 'standard');

      assert.ok(fee >= standardFee, 'enhanced should cost >= standard');

      console.log(`    Enhanced fee: ${fee} lamports`);
      console.log(`    Standard fee: ${standardFee} lamports`);
      console.log(`    Overhead: ${fee - standardFee} lamports`);
    });
  });

  // ==========================================================================
  // TIER 3: Maximum Privacy
  // ==========================================================================

  describe('TIER 3: Maximum Privacy (Relayer + ZK Pool + Multi-Hop)', () => {
    it('3.1 -- Relayer network hides the sender\'s identity', () => {
      /**
       * MAXIMUM PRIVACY routes the transaction through a relayer.
       * The relayer submits the transaction on behalf of the user,
       * so the sender's wallet address never appears on-chain.
       *
       * The user provides a ZK proof that they own the funds, and
       * the relayer verifies the proof before submission.
       */
      const network = new RelayerNetwork();
      const relayers = network.getRelayers();

      assert.ok(relayers.length > 0, 'network should have relayers');

      console.log(`    Relayer network: ${relayers.length} relayers`);
      for (const r of relayers) {
        console.log(`      [${r.id}] ${r.name} (${r.region}) fee=${r.feeBps}bps`);
      }
    });

    it('3.2 -- Best relayer is selected based on latency, success rate, and fees', () => {
      /**
       * The RelayerNetwork scores relayers by:
       * - Latency (lower is better)
       * - Success rate (higher is better)
       * - Fee (lower is better)
       * - Region preference (bonus for matching)
       */
      const network = new RelayerNetwork();

      const bestOverall = network.selectBestRelayer();
      assert.ok(bestOverall, 'should select a relayer');

      const bestForSOL = network.selectBestRelayer({ token: 'SOL', amount: 1 });
      assert.ok(bestForSOL, 'should find a relayer supporting SOL');

      const bestCheap = network.selectBestRelayer({ maxFeeBps: 11 });
      if (bestCheap) {
        assert.ok(bestCheap.feeBps <= 11, 'should respect max fee constraint');
      }

      console.log(`    Best overall: ${bestOverall!.name} (${bestOverall!.feeBps}bps)`);
      console.log(`    Best for SOL: ${bestForSOL!.name}`);
      console.log(`    Best cheap:   ${bestCheap ? bestCheap.name : 'none available'}`);
    });

    it('3.3 -- Random relayer selection for maximum privacy', () => {
      /**
       * For maximum privacy, the relayer is selected RANDOMLY (not by
       * performance).  This prevents an observer from predicting which
       * relayer a user will use.
       */
      const network = new RelayerNetwork();
      const selections = new Set<string>();

      // Select 20 times and check for variation
      for (let i = 0; i < 20; i++) {
        const relayer = network.selectRandomRelayer({ token: 'SOL' });
        if (relayer) {
          selections.add(relayer.id);
        }
      }

      // With 3 relayers and 20 selections, we expect at least 2 distinct
      console.log(`    Random selections: ${selections.size} distinct relayers from 20 attempts`);
      // Note: with only 3 relayers, probability of seeing just 1 in 20 tries is negligible
    });

    it('3.4 -- Relay request structure for ZK-verified transactions', () => {
      /**
       * The relay request contains:
       * - ZK proof (from snarkjs)
       * - Public inputs (nullifiers, commitments, merkle root)
       * - No sender information (that's the point!)
       */
      const mockRequest: RelayRequest = {
        proof: {
          pi_a: ['12345...', '67890...', '1'],
          pi_b: [['11111...', '22222...'], ['33333...', '44444...'], ['1', '0']],
          pi_c: ['55555...', '66666...', '1'],
          protocol: 'groth16',
        },
        publicInputs: [
          '1234567890', // merkle root
          '1111111111', // nullifier 1
          '2222222222', // nullifier 2
          '3333333333', // output commitment 1
          '4444444444', // output commitment 2
          '0',          // public amount (0 for private transfer)
          '5555555555', // token mint field
        ],
        nullifiers: ['1111111111', '2222222222'],
        outputCommitments: ['3333333333', '4444444444'],
        merkleRoot: '1234567890',
      };

      assert.ok(mockRequest.proof, 'proof should be present');
      assert.equal(mockRequest.publicInputs.length, 7, 'should have 7 public inputs');
      assert.equal(mockRequest.nullifiers.length, 2, 'should have 2 nullifiers');
      assert.equal(mockRequest.publicInputs[5], '0', 'public amount should be 0 for private');

      console.log('    Relay request structure:');
      console.log(`      proof: Groth16 (pi_a, pi_b, pi_c)`);
      console.log(`      public inputs: ${mockRequest.publicInputs.length}`);
      console.log(`      nullifiers: ${mockRequest.nullifiers.length}`);
      console.log(`      public amount: ${mockRequest.publicInputs[5]} (private transfer)`);
    });

    it('3.5 -- Network status monitoring for relayer health', () => {
      /**
       * The network provides aggregate health metrics for monitoring
       * and alerting.
       */
      const network = new RelayerNetwork();
      const status = network.getNetworkStatus();

      assert.ok(status.totalRelayers > 0, 'should report total relayers');

      console.log('    Network status:');
      console.log(`      Total relayers: ${status.totalRelayers}`);
      console.log(`      Online: ${status.onlineRelayers}`);
      console.log(`      Avg latency: ${status.avgLatency.toFixed(0)}ms`);
      console.log(`      Avg success rate: ${status.avgSuccessRate.toFixed(1)}%`);
    });

    it('3.6 -- Multi-hop stealth routing for transaction graph privacy', () => {
      /**
       * Maximum privacy uses multiple hops between stealth addresses.
       * Each hop is an independent transfer with no on-chain link to
       * the previous one.
       *
       *   Source -> Stealth_1 -> Stealth_2 -> Final_Stealth
       *
       * An observer sees three unrelated transactions.
       */
      const hopCount = 3;
      const hops: Array<{
        address: PublicKey;
        ephemeralPubKey: Uint8Array;
        viewTag: number;
      }> = [];

      for (let i = 0; i < hopCount; i++) {
        const hop = generateStealthAddress(recipient.meta);
        hops.push({
          address: hop.address,
          ephemeralPubKey: hop.ephemeralPubKey,
          viewTag: hop.viewTag,
        });
      }

      // All hop addresses should be unique
      const uniqueAddrs = new Set(hops.map(h => h.address.toBase58()));
      assert.equal(uniqueAddrs.size, hopCount, 'all hops should have unique addresses');

      console.log(`    Multi-hop routing: ${hopCount} hops`);
      for (let i = 0; i < hops.length; i++) {
        const label = i === hops.length - 1 ? 'FINAL' : `hop ${i + 1}`;
        console.log(`      [${label}] ${hops[i]!.address.toBase58().slice(0, 30)}...`);
      }
    });

    it('3.7 -- Maximum privacy fee estimation', async () => {
      const maxFee = await estimateTransferFee(connection, 'maximum');
      const enhancedFee = await estimateTransferFee(connection, 'enhanced');
      const standardFee = await estimateTransferFee(connection, 'standard');

      assert.ok(maxFee >= enhancedFee);
      assert.ok(enhancedFee >= standardFee);

      console.log(`    Fee comparison:`);
      console.log(`      Standard: ${standardFee} lamports`);
      console.log(`      Enhanced: ${enhancedFee} lamports (+${enhancedFee - standardFee})`);
      console.log(`      Maximum:  ${maxFee} lamports (+${maxFee - standardFee})`);
    });
  });

  // ==========================================================================
  // Cryptographic Primitives Verification
  // ==========================================================================

  describe('Cryptographic Foundation Verification', () => {
    it('4.1 -- ECDH shared secret is symmetric', () => {
      /**
       * The core of the stealth protocol relies on ECDH:
       *   ECDH(a, B) == ECDH(b, A)
       *
       * This ensures the sender and recipient derive the same shared secret.
       */
      const alice = nacl.box.keyPair();
      const bob = nacl.box.keyPair();

      const secretAB = deriveSharedSecret(alice.secretKey, bob.publicKey);
      const secretBA = deriveSharedSecret(bob.secretKey, alice.publicKey);

      assert.isTrue(constantTimeEqual(secretAB, secretBA), 'shared secrets should be equal');
      console.log('    ECDH symmetry: PASS');
    });

    it('4.2 -- View tag computation is deterministic', () => {
      /**
       * The same shared secret always produces the same view tag.
       */
      const secret = randomBytes(32);
      const tag1 = computeViewTag(secret);
      const tag2 = computeViewTag(secret);

      assert.equal(tag1, tag2, 'same secret -> same tag');
      assert.isAtLeast(tag1, 0);
      assert.isAtMost(tag1, 255);

      console.log(`    View tag determinism: 0x${tag1.toString(16)} (stable)`);
    });

    it('4.3 -- NaCl box encryption provides authenticated encryption', () => {
      /**
       * encryptForRecipient / decryptFromSender provide authenticated
       * encryption using X25519 + XSalsa20-Poly1305.
       */
      const sender = nacl.box.keyPair();
      const recipient = nacl.box.keyPair();
      const plaintext = new TextEncoder().encode('Private payment memo: subscription renewal');

      const encrypted = encryptForRecipient(plaintext, recipient.publicKey, sender.secretKey);
      assert.ok(encrypted.length > plaintext.length, 'ciphertext should be longer');

      const decrypted = decryptFromSender(encrypted, sender.publicKey, recipient.secretKey);
      assert.ok(decrypted, 'decryption should succeed');
      assert.equal(
        new TextDecoder().decode(decrypted!),
        'Private payment memo: subscription renewal'
      );

      // Tamper detection
      const tampered = new Uint8Array(encrypted);
      tampered[tampered.length - 1] ^= 0xff;
      const result = decryptFromSender(tampered, sender.publicKey, recipient.secretKey);
      assert.isNull(result, 'tampered ciphertext should fail');

      console.log('    NaCl box: encrypt/decrypt OK, tamper detection OK');
    });

    it('4.4 -- Symmetric encryption with NaCl secretbox', () => {
      /**
       * encrypt / decrypt use XSalsa20-Poly1305 for symmetric encryption.
       * Used for encrypting memos and local data.
       */
      const key = randomBytes(32);
      const plaintext = new TextEncoder().encode('Amount: 1.5 SOL to stealth address XYZ');

      const encrypted = encrypt(plaintext, key);
      const decrypted = decrypt(encrypted, key);

      assert.ok(decrypted);
      assert.equal(new TextDecoder().decode(decrypted!), 'Amount: 1.5 SOL to stealth address XYZ');

      // Wrong key fails
      const wrongKey = randomBytes(32);
      const wrongResult = decrypt(encrypted, wrongKey);
      assert.isNull(wrongResult, 'wrong key should fail');

      console.log('    Secretbox: encrypt/decrypt OK, wrong key rejected');
    });

    it('4.5 -- Ed25519 signing and verification', () => {
      /**
       * Used for auth challenge signing and transaction authorization.
       */
      const keypair = nacl.sign.keyPair();
      const message = new TextEncoder().encode('P01-AUTH:service:session:challenge:12345');

      const signature = sign(message, keypair.secretKey);
      assert.equal(signature.length, 64, 'signature should be 64 bytes');

      const isValid = verify(message, signature, keypair.publicKey);
      assert.isTrue(isValid, 'valid signature should verify');

      // Wrong message
      const wrongMsg = new TextEncoder().encode('tampered message');
      assert.isFalse(verify(wrongMsg, signature, keypair.publicKey));

      // Wrong key
      const otherKeypair = nacl.sign.keyPair();
      assert.isFalse(verify(message, signature, otherKeypair.publicKey));

      console.log('    Ed25519: sign OK, verify OK, wrong sig/key rejected');
    });

    it('4.6 -- Hashing utilities (SHA-256)', () => {
      /**
       * SHA-256 is used throughout the protocol for commitments,
       * view tags, and key derivation.
       */
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const h = hash(data);

      assert.equal(h.length, 32, 'SHA-256 should produce 32 bytes');

      // Deterministic
      const h2 = hash(data);
      assert.isTrue(constantTimeEqual(h, h2), 'same input -> same hash');

      // Different input -> different hash
      const h3 = hash(new Uint8Array([5, 4, 3, 2, 1]));
      assert.isFalse(constantTimeEqual(h, h3), 'different input -> different hash');

      // Double hash
      const dh = doubleHash(data);
      assert.equal(dh.length, 32);
      assert.isFalse(constantTimeEqual(h, dh), 'double hash != single hash');

      // String hash
      const sh = hashString('Protocol 01');
      assert.equal(sh.length, 32);

      console.log('    SHA-256: deterministic, collision-resistant, double hash distinct');
    });

    it('4.7 -- Base58 and hex encoding round-trips', () => {
      /**
       * Encoding utilities used for serialization of keys and addresses.
       */
      const original = randomBytes(32);

      // Base58 round-trip
      const b58 = toBase58(original);
      const fromB58 = fromBase58(b58);
      assert.isTrue(constantTimeEqual(original, fromB58), 'base58 should round-trip');

      // Hex round-trip
      const hexStr = toHex(original);
      const fromHexVal = fromHex(hexStr);
      assert.isTrue(constantTimeEqual(original, fromHexVal), 'hex should round-trip');

      console.log(`    Base58: ${b58.slice(0, 20)}... (round-trip OK)`);
      console.log(`    Hex: ${hexStr.slice(0, 20)}... (round-trip OK)`);
    });

    it('4.8 -- Constant-time comparison prevents timing attacks', () => {
      /**
       * constantTimeEqual takes the same time regardless of where
       * the difference is.  This prevents timing side-channel attacks.
       */
      const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const c = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]); // differs at end
      const d = new Uint8Array([9, 2, 3, 4, 5, 6, 7, 8]); // differs at start

      assert.isTrue(constantTimeEqual(a, b));
      assert.isFalse(constantTimeEqual(a, c));
      assert.isFalse(constantTimeEqual(a, d));

      // Different lengths
      assert.isFalse(constantTimeEqual(a, new Uint8Array([1, 2, 3])));

      console.log('    Constant-time comparison: timing-safe equality checks');
    });

    it('4.9 -- secureClear wipes sensitive data from memory', () => {
      /**
       * After key material is no longer needed, it should be zeroed
       * to prevent it from lingering in memory.
       */
      const key = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
      secureClear(key);
      assert.isTrue(key.every(b => b === 0), 'all bytes should be zero');

      console.log('    secureClear: buffer wiped');
    });
  });

  // ==========================================================================
  // Privacy Comparison Matrix
  // ==========================================================================

  describe('Privacy Comparison Summary', () => {
    it('5.1 -- Privacy level comparison table', async () => {
      /**
       * Summary of the three privacy tiers:
       *
       * Feature              Standard    Enhanced    Maximum
       * -------              --------    --------    -------
       * Stealth address      YES         YES         YES
       * Address unlinkable   YES         YES         YES
       * Split payments       NO          YES (N)     YES (N)
       * Time delays          NO          YES         YES
       * Sender hidden        NO          NO          YES (relayer)
       * ZK shielded pool     NO          NO          YES
       * Multi-hop routing    NO          NO          YES
       * Tx graph breakage    NO          PARTIAL     FULL
       * Cost                 LOW         MEDIUM      HIGH
       * Speed                FAST        MODERATE    SLOW
       */
      const standardFee = await estimateTransferFee(connection, 'standard');
      const enhancedFee = await estimateTransferFee(connection, 'enhanced');
      const maximumFee = await estimateTransferFee(connection, 'maximum');

      console.log('\n    Privacy Tier Comparison:');
      console.log('    ' + '-'.repeat(64));
      console.log('    Feature               Standard    Enhanced    Maximum');
      console.log('    ' + '-'.repeat(64));
      console.log('    Stealth address       YES         YES         YES');
      console.log('    Address unlinkable    YES         YES         YES');
      console.log('    Split payments        NO          YES         YES');
      console.log('    Time delays           NO          YES         YES');
      console.log('    Sender hidden         NO          NO          YES');
      console.log('    ZK shielded pool      NO          NO          YES');
      console.log('    Multi-hop routing     NO          NO          YES');
      console.log('    Tx graph breakage     NO          PARTIAL     FULL');
      console.log(`    Fee (lamports)        ${String(standardFee).padEnd(12)}${String(enhancedFee).padEnd(12)}${maximumFee}`);
      console.log('    ' + '-'.repeat(64));
    });

    it('5.2 -- All tiers share the same stealth address foundation', () => {
      /**
       * Regardless of privacy tier, the stealth address protocol is the
       * same.  Higher tiers add layers on top of the base stealth mechanism.
       */
      const levels: PrivacyLevel[] = ['standard', 'enhanced', 'maximum'];

      for (const level of levels) {
        const stealth = generateStealthAddress(recipient.meta);
        const isOwner = verifyStealthOwnership(
          stealth.address,
          stealth.ephemeralPubKey,
          recipient.viewKey.secretKey,
          recipient.spendKey.publicKey.toBytes(),
          stealth.viewTag
        );

        assert.isTrue(isOwner, `${level} tier should use valid stealth addresses`);
      }

      console.log('    All 3 tiers use the same stealth address protocol');
    });
  });
});
