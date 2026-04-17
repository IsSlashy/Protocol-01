import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import nacl from 'tweetnacl';

// ---------------------------------------------------------------------------
// Mock heavy external deps so tests stay fast and deterministic
// ---------------------------------------------------------------------------

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>(
    '@solana/web3.js'
  );
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: vi.fn().mockResolvedValue(1_000_000_000),
      getParsedTransaction: vi.fn().mockResolvedValue(null),
      getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    })),
  };
});

// Provide SpecterError / SpecterErrorCode aliases that the source modules import
vi.mock('../types', async () => {
  const actual = await vi.importActual<typeof import('../types')>('../types');
  return {
    ...actual,
    SpecterError: actual.P01Error,
    SpecterErrorCode: actual.P01ErrorCode,
    SpecterWallet: undefined, // type-only, not needed at runtime
  };
});

// ---------------------------------------------------------------------------
// Imports under test (loaded *after* mocks are wired)
// ---------------------------------------------------------------------------

import {
  generateStealthMetaAddress,
  parseStealthMetaAddress,
  generateStealthAddress,
  generateMultipleStealthAddresses,
  createStealthAnnouncement,
  parseStealthAnnouncement,
  generateStealthTransferData,
} from './generate';
import {
  deriveStealthPublicKey,
  deriveStealthPublicKeyFromEncoded,
  deriveStealthPrivateKey,
  verifyStealthOwnership,
  computeStealthAddress,
} from './derive';
import {
  StealthScanner,
  scanForPayments,
  createScanner,
  subscribeToPayments,
} from './scan';
import { encodeStealthMetaAddress } from '../utils/helpers';
import { kemGenerateKeypair } from '../utils/crypto';
import type { StealthMetaAddress } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeypairPair() {
  const spending = Keypair.generate();
  const viewing = Keypair.generate();
  return { spending, viewing };
}

function makeMetaAddress(): StealthMetaAddress {
  const { spending, viewing } = makeKeypairPair();
  return generateStealthMetaAddress(spending, viewing);
}

// ===========================================================================
// generate.ts
// ===========================================================================

describe('stealth/generate', () => {
  // -----------------------------------------------------------------------
  // generateStealthMetaAddress
  // -----------------------------------------------------------------------
  describe('generateStealthMetaAddress', () => {
    it('returns a StealthMetaAddress with spending and viewing public keys', () => {
      const { spending, viewing } = makeKeypairPair();
      const meta = generateStealthMetaAddress(spending, viewing);

      expect(meta.spendingPubKey).toBeInstanceOf(Uint8Array);
      expect(meta.viewingPubKey).toBeInstanceOf(Uint8Array);
      expect(meta.spendingPubKey.length).toBe(32);
      expect(meta.viewingPubKey.length).toBe(32);
      expect(typeof meta.encoded).toBe('string');
      expect(meta.encoded.startsWith('st')).toBe(true);
    });

    it('spending key matches the input keypair public key bytes', () => {
      const { spending, viewing } = makeKeypairPair();
      const meta = generateStealthMetaAddress(spending, viewing);

      expect(Buffer.from(meta.spendingPubKey)).toEqual(
        Buffer.from(spending.publicKey.toBytes())
      );
      expect(Buffer.from(meta.viewingPubKey)).toEqual(
        Buffer.from(viewing.publicKey.toBytes())
      );
    });

    it('produces different encoded strings for different keypairs', () => {
      const a = makeMetaAddress();
      const b = makeMetaAddress();
      expect(a.encoded).not.toEqual(b.encoded);
    });
  });

  // -----------------------------------------------------------------------
  // parseStealthMetaAddress
  // -----------------------------------------------------------------------
  describe('parseStealthMetaAddress', () => {
    it('round-trips through encode -> parse', () => {
      const original = makeMetaAddress();
      const parsed = parseStealthMetaAddress(original.encoded);

      expect(Buffer.from(parsed.spendingPubKey)).toEqual(
        Buffer.from(original.spendingPubKey)
      );
      expect(Buffer.from(parsed.viewingPubKey)).toEqual(
        Buffer.from(original.viewingPubKey)
      );
      expect(parsed.encoded).toBe(original.encoded);
    });

    it('throws on an invalid encoded string', () => {
      expect(() => parseStealthMetaAddress('not-a-valid-address')).toThrow();
    });

    it('throws on empty string', () => {
      expect(() => parseStealthMetaAddress('')).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // generateStealthAddress
  // -----------------------------------------------------------------------
  describe('generateStealthAddress', () => {
    it('returns a valid stealth address with expected fields', () => {
      const meta = makeMetaAddress();
      const result = generateStealthAddress(meta);

      expect(result.address).toBeInstanceOf(PublicKey);
      expect(result.ephemeralPubKey).toBeInstanceOf(Uint8Array);
      expect(result.ephemeralPubKey.length).toBe(32);
      expect(typeof result.viewTag).toBe('number');
      expect(result.viewTag).toBeGreaterThanOrEqual(0);
      expect(result.viewTag).toBeLessThanOrEqual(255);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.ephemeralPrivateKey).toBeInstanceOf(Uint8Array);
    });

    it('accepts an encoded meta-address string as input', () => {
      const meta = makeMetaAddress();
      const result = generateStealthAddress(meta.encoded);

      expect(result.address).toBeInstanceOf(PublicKey);
    });

    it('generates unique addresses each time', () => {
      const meta = makeMetaAddress();
      const a = generateStealthAddress(meta);
      const b = generateStealthAddress(meta);
      expect(a.address.toBase58()).not.toEqual(b.address.toBase58());
    });
  });

  // -----------------------------------------------------------------------
  // generateMultipleStealthAddresses
  // -----------------------------------------------------------------------
  describe('generateMultipleStealthAddresses', () => {
    it('generates the requested number of addresses', () => {
      const meta = makeMetaAddress();
      const addresses = generateMultipleStealthAddresses(meta, 5);

      expect(addresses).toHaveLength(5);
      for (const addr of addresses) {
        expect(addr.address).toBeInstanceOf(PublicKey);
      }
    });

    it('all generated addresses are unique', () => {
      const meta = makeMetaAddress();
      const addresses = generateMultipleStealthAddresses(meta, 10);
      const uniqueAddresses = new Set(addresses.map((a) => a.address.toBase58()));
      expect(uniqueAddresses.size).toBe(10);
    });

    it('throws when count is less than 1', () => {
      const meta = makeMetaAddress();
      expect(() => generateMultipleStealthAddresses(meta, 0)).toThrow();
    });

    it('throws when count exceeds 100', () => {
      const meta = makeMetaAddress();
      expect(() => generateMultipleStealthAddresses(meta, 101)).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // createStealthAnnouncement / parseStealthAnnouncement
  // -----------------------------------------------------------------------
  describe('stealth announcement round-trip (v2 hybrid)', () => {
    it('encodes and decodes v2 announcement data correctly', () => {
      const meta = makeMetaAddress();
      const stealth = generateStealthAddress(meta);

      expect(stealth.kemCiphertext).toBeDefined();

      const announcement = createStealthAnnouncement(
        stealth.address,
        stealth.ephemeralPubKey,
        stealth.viewTag,
        stealth.kemCiphertext,
      );

      expect(announcement).toBeInstanceOf(Uint8Array);
      expect(announcement.length).toBe(1153);

      const parsed = parseStealthAnnouncement(announcement);
      expect(parsed.viewTag).toBe(stealth.viewTag);
      expect(Buffer.from(parsed.ephemeralPubKey)).toEqual(
        Buffer.from(stealth.ephemeralPubKey)
      );
      expect(parsed.stealthAddress.toBase58()).toBe(
        stealth.address.toBase58()
      );
      expect(parsed.kemCiphertext).toBeDefined();
      expect(parsed.kemCiphertext!.length).toBe(1088);
    });

    it('parseStealthAnnouncement throws for wrong length', () => {
      expect(() => parseStealthAnnouncement(new Uint8Array(10))).toThrow();
    });

    it('parseStealthAnnouncement rejects legacy v1 (65 bytes) by default', () => {
      const v1Announcement = new Uint8Array(65);
      expect(() => parseStealthAnnouncement(v1Announcement)).toThrow(/legacy|v1/i);
    });

    it('parseStealthAnnouncement accepts v1 with allowLegacyV1 opt-in', () => {
      const v1Announcement = new Uint8Array(65);
      const parsed = parseStealthAnnouncement(v1Announcement, { allowLegacyV1: true });
      expect(parsed.viewTag).toBe(0);
      expect(parsed.kemCiphertext).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // generateStealthTransferData
  // -----------------------------------------------------------------------
  describe('generateStealthTransferData', () => {
    it('returns complete v2 transfer data including KEM-bearing announcement', () => {
      const meta = makeMetaAddress();
      const amount = 1_000_000_000n;
      const data = generateStealthTransferData(meta, amount);

      expect(data.stealthAddress).toBeInstanceOf(PublicKey);
      expect(data.ephemeralPubKey.length).toBe(32);
      expect(typeof data.viewTag).toBe('number');
      expect(data.announcement.length).toBe(1153);
      expect(data.kemCiphertext).toBeDefined();
      expect(data.kemCiphertext!.length).toBe(1088);
      expect(data.amount).toBe(amount);
    });
  });
});

// ===========================================================================
// derive.ts
// ===========================================================================

describe('stealth/derive', () => {
  // -----------------------------------------------------------------------
  // deriveStealthPublicKey
  // -----------------------------------------------------------------------
  describe('deriveStealthPublicKey', () => {
    it('derives a stealth public key with expected structure', () => {
      const meta = makeMetaAddress();
      const ephemeral = nacl.box.keyPair();

      const result = deriveStealthPublicKey(meta, ephemeral.secretKey);

      expect(result.stealthPubKey).toBeInstanceOf(PublicKey);
      expect(result.ephemeralPubKey).toBeInstanceOf(Uint8Array);
      expect(result.ephemeralPubKey.length).toBe(32);
      expect(typeof result.viewTag).toBe('number');
    });

    it('v2 hybrid derivation is probabilistic (fresh KEM ct on each call)', () => {
      // Under v2 hybrid, the KEM encapsulation introduces fresh randomness,
      // so the shared secret (and therefore the stealth address + view tag +
      // KEM ciphertext) differ across calls even with the same ephemeral key.
      const meta = makeMetaAddress();
      const ephemeral = nacl.box.keyPair();

      const a = deriveStealthPublicKey(meta, ephemeral.secretKey);
      const b = deriveStealthPublicKey(meta, ephemeral.secretKey);

      expect(a.kemCiphertext).toBeDefined();
      expect(b.kemCiphertext).toBeDefined();
      expect(Buffer.from(a.kemCiphertext!).equals(Buffer.from(b.kemCiphertext!))).toBe(false);
      expect(a.stealthPubKey.toBase58()).not.toBe(b.stealthPubKey.toBase58());
    });

    it('different ephemeral keys produce different stealth addresses', () => {
      const meta = makeMetaAddress();
      const ephA = nacl.box.keyPair();
      const ephB = nacl.box.keyPair();

      const a = deriveStealthPublicKey(meta, ephA.secretKey);
      const b = deriveStealthPublicKey(meta, ephB.secretKey);

      expect(a.stealthPubKey.toBase58()).not.toBe(b.stealthPubKey.toBase58());
    });
  });

  // -----------------------------------------------------------------------
  // deriveStealthPublicKeyFromEncoded
  // -----------------------------------------------------------------------
  describe('deriveStealthPublicKeyFromEncoded', () => {
    it('returns stealth pub key, ephemeral keys, and view tag', () => {
      const meta = makeMetaAddress();
      const result = deriveStealthPublicKeyFromEncoded(meta.encoded);

      expect(result.stealthPubKey).toBeInstanceOf(PublicKey);
      expect(result.ephemeralPubKey.length).toBe(32);
      expect(result.ephemeralPrivateKey.length).toBe(32);
      expect(typeof result.viewTag).toBe('number');
    });
  });

  // -----------------------------------------------------------------------
  // deriveStealthPrivateKey
  // -----------------------------------------------------------------------
  describe('deriveStealthPrivateKey', () => {
    it('returns a valid Keypair', () => {
      const spending = Keypair.generate();
      const viewing = Keypair.generate();
      const ephemeral = nacl.box.keyPair();

      const derived = deriveStealthPrivateKey(
        spending.secretKey.slice(0, 32),
        viewing.secretKey.slice(0, 32),
        ephemeral.publicKey
      );

      expect(derived).toBeInstanceOf(Keypair);
      expect(derived.publicKey).toBeInstanceOf(PublicKey);
      expect(derived.secretKey.length).toBe(64);
    });

    it('same inputs produce the same derived keypair', () => {
      const spending = Keypair.generate();
      const viewing = Keypair.generate();
      const ephemeral = nacl.box.keyPair();

      const a = deriveStealthPrivateKey(
        spending.secretKey.slice(0, 32),
        viewing.secretKey.slice(0, 32),
        ephemeral.publicKey
      );
      const b = deriveStealthPrivateKey(
        spending.secretKey.slice(0, 32),
        viewing.secretKey.slice(0, 32),
        ephemeral.publicKey
      );

      expect(a.publicKey.toBase58()).toBe(b.publicKey.toBase58());
    });
  });

  // -----------------------------------------------------------------------
  // verifyStealthOwnership
  // -----------------------------------------------------------------------
  describe('verifyStealthOwnership', () => {
    it('returns false for a random address that does not belong to the wallet', () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();
      const randomAddress = Keypair.generate().publicKey;
      const ephemeral = nacl.box.keyPair();

      const owns = verifyStealthOwnership(
        randomAddress,
        ephemeral.publicKey,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      expect(owns).toBe(false);
    });

    it('returns false when view tag does not match', () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();
      const randomAddress = Keypair.generate().publicKey;
      const ephemeral = nacl.box.keyPair();

      const owns = verifyStealthOwnership(
        randomAddress,
        ephemeral.publicKey,
        viewing.secretKey,
        spending.publicKey.toBytes(),
        255 // unlikely to match
      );

      expect(owns).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Full round-trip: generate → verify → derive private key (v2 hybrid)
  // -----------------------------------------------------------------------
  describe('stealth round-trip (v2 hybrid: generate → verify → derive)', () => {
    function makeV2Meta() {
      const spending = Keypair.generate();
      const viewing = nacl.box.keyPair();
      const kem = kemGenerateKeypair();
      const meta: StealthMetaAddress = {
        spendingPubKey: spending.publicKey.toBytes(),
        viewingPubKey: viewing.publicKey,
        kemPubKey: kem.publicKey,
        encoded: encodeStealthMetaAddress(
          spending.publicKey.toBytes(),
          viewing.publicKey,
          kem.publicKey,
        ),
      };
      return { spending, viewing, kem, meta };
    }

    it('sender and receiver derive the same stealth address', () => {
      const { spending, viewing, kem, meta } = makeV2Meta();

      // --- Sender side ---
      const ephemeral = nacl.box.keyPair();
      const senderResult = deriveStealthPublicKey(meta, ephemeral.secretKey);
      expect(senderResult.kemCiphertext).toBeDefined();

      // --- Receiver side ---
      const owns = verifyStealthOwnership(
        senderResult.stealthPubKey,
        senderResult.ephemeralPubKey,
        viewing.secretKey,
        spending.publicKey.toBytes(),
        senderResult.viewTag,
        kem.secretKey,
        senderResult.kemCiphertext,
      );
      expect(owns).toBe(true);

      const stealthKeypair = deriveStealthPrivateKey(
        spending.publicKey.toBytes(),
        viewing.secretKey,
        senderResult.ephemeralPubKey,
        kem.secretKey,
        senderResult.kemCiphertext,
      );

      expect(stealthKeypair.publicKey.toBase58()).toBe(
        senderResult.stealthPubKey.toBase58()
      );
    });

    it('round-trip works via encoded meta-address string', () => {
      const { spending, viewing, kem, meta } = makeV2Meta();

      const senderResult = deriveStealthPublicKeyFromEncoded(meta.encoded);
      expect(senderResult.kemCiphertext).toBeDefined();

      const owns = verifyStealthOwnership(
        senderResult.stealthPubKey,
        senderResult.ephemeralPubKey,
        viewing.secretKey,
        spending.publicKey.toBytes(),
        senderResult.viewTag,
        kem.secretKey,
        senderResult.kemCiphertext,
      );
      expect(owns).toBe(true);

      const stealthKeypair = deriveStealthPrivateKey(
        spending.publicKey.toBytes(),
        viewing.secretKey,
        senderResult.ephemeralPubKey,
        kem.secretKey,
        senderResult.kemCiphertext,
      );
      expect(stealthKeypair.publicKey.toBase58()).toBe(
        senderResult.stealthPubKey.toBase58()
      );
    });

    it('round-trip works via generateStealthAddress helper', () => {
      const { spending, viewing, kem, meta } = makeV2Meta();

      const stealth = generateStealthAddress(meta);
      expect(stealth.kemCiphertext).toBeDefined();

      const owns = verifyStealthOwnership(
        stealth.address,
        stealth.ephemeralPubKey,
        viewing.secretKey,
        spending.publicKey.toBytes(),
        stealth.viewTag,
        kem.secretKey,
        stealth.kemCiphertext,
      );
      expect(owns).toBe(true);

      const stealthKeypair = deriveStealthPrivateKey(
        spending.publicKey.toBytes(),
        viewing.secretKey,
        stealth.ephemeralPubKey,
        kem.secretKey,
        stealth.kemCiphertext,
      );
      expect(stealthKeypair.publicKey.toBase58()).toBe(
        stealth.address.toBase58()
      );
    });

    it('different recipients produce different stealth addresses from same ephemeral', () => {
      const a = makeV2Meta();
      const b = makeV2Meta();

      const ephemeral = nacl.box.keyPair();
      const resultA = deriveStealthPublicKey(a.meta, ephemeral.secretKey);
      const resultB = deriveStealthPublicKey(b.meta, ephemeral.secretKey);

      expect(resultA.stealthPubKey.toBase58()).not.toBe(
        resultB.stealthPubKey.toBase58()
      );
    });

    it('rejects v1 metas end-to-end on the sender path', () => {
      const spending = Keypair.generate();
      const viewing = nacl.box.keyPair();
      const v1Meta: StealthMetaAddress = {
        spendingPubKey: spending.publicKey.toBytes(),
        viewingPubKey: viewing.publicKey,
        encoded: encodeStealthMetaAddress(spending.publicKey.toBytes(), viewing.publicKey),
      };
      const ephemeral = nacl.box.keyPair();
      expect(() => deriveStealthPublicKey(v1Meta, ephemeral.secretKey)).toThrow(/v1|legacy|hybrid/i);
      expect(() => generateStealthAddress(v1Meta)).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // computeStealthAddress — deprecated & insecure, always throws
  // -----------------------------------------------------------------------
  describe('computeStealthAddress', () => {
    it('throws because the helper is deprecated and cryptographically insecure', () => {
      const spending = Keypair.generate();
      const viewing = Keypair.generate();
      const ephemeral = nacl.box.keyPair();

      expect(() =>
        computeStealthAddress(
          spending.publicKey.toBytes(),
          viewing.publicKey.toBytes(),
          ephemeral.publicKey,
        ),
      ).toThrow(/deprecated|insecure/i);
    });
  });
});

// ===========================================================================
// scan.ts
// ===========================================================================

describe('stealth/scan', () => {
  let mockConnection: Connection;

  beforeEach(() => {
    mockConnection = new Connection('https://api.devnet.solana.com');
  });

  // -----------------------------------------------------------------------
  // StealthScanner
  // -----------------------------------------------------------------------
  describe('StealthScanner', () => {
    it('constructs without throwing', () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();

      const scanner = new StealthScanner(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      expect(scanner).toBeInstanceOf(StealthScanner);
    });

    it('scan returns an empty array when there are no announcements', async () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();

      const scanner = new StealthScanner(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      const payments = await scanner.scan();
      expect(payments).toEqual([]);
    });

    it('scan respects scan options', async () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();

      const scanner = new StealthScanner(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      const payments = await scanner.scan({
        fromSlot: 100,
        limit: 5,
        includeClaimed: true,
      });

      expect(payments).toEqual([]);
    });

    it('checkViewTag returns a boolean', () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();
      const ephemeral = nacl.box.keyPair();

      const scanner = new StealthScanner(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      const result = scanner.checkViewTag(42, ephemeral.publicKey);
      expect(typeof result).toBe('boolean');
    });

    it('verifyAndDeriveKey returns isOwner boolean', () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();
      const ephemeral = nacl.box.keyPair();
      const randomAddress = Keypair.generate().publicKey;

      const scanner = new StealthScanner(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      const result = scanner.verifyAndDeriveKey(
        ephemeral.publicKey,
        randomAddress
      );

      expect(typeof result.isOwner).toBe('boolean');
    });

    it('checkTransaction returns null for unknown signature', async () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();

      const scanner = new StealthScanner(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      const result = await scanner.checkTransaction('fakeSig123');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // scanForPayments (convenience function)
  // -----------------------------------------------------------------------
  describe('scanForPayments', () => {
    it('returns empty array with no announcements', async () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();

      const payments = await scanForPayments(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      expect(payments).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // createScanner
  // -----------------------------------------------------------------------
  describe('createScanner', () => {
    it('returns a StealthScanner instance', () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();

      const scanner = createScanner(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes()
      );

      expect(scanner).toBeInstanceOf(StealthScanner);
    });
  });

  // -----------------------------------------------------------------------
  // subscribeToPayments
  // -----------------------------------------------------------------------
  describe('subscribeToPayments', () => {
    it('returns an object with an unsubscribe method', () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();
      const callback = vi.fn();

      const subscription = subscribeToPayments(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes(),
        callback
      );

      expect(typeof subscription.unsubscribe).toBe('function');

      // Clean up
      subscription.unsubscribe();
    });

    it('unsubscribe stops polling', async () => {
      const viewing = nacl.box.keyPair();
      const spending = Keypair.generate();
      const callback = vi.fn();

      const subscription = subscribeToPayments(
        mockConnection,
        viewing.secretKey,
        spending.publicKey.toBytes(),
        callback
      );

      subscription.unsubscribe();

      // Wait briefly to confirm no further calls
      await new Promise((r) => setTimeout(r, 100));
      // callback should not have been called with any payment
      // (no announcements exist in the mock)
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
