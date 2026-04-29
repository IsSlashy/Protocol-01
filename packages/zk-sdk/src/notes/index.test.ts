/**
 * Unit tests for notes module
 * Tests note creation, encryption/decryption, serialization, and spending key generation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----- Mock external dependencies -----

// Mock @noble/hashes/sha2 — match the source's import path exactly
// (`@noble/hashes` 2.2.0 only exports `./sha2.js`, not `./sha2`).
vi.mock('@noble/hashes/sha2.js', () => ({
  sha256: vi.fn((input: Uint8Array) => {
    // Deterministic fake hash: XOR-fold input into 32 bytes
    const result = new Uint8Array(32);
    for (let i = 0; i < input.length; i++) {
      result[i % 32] ^= input[i];
    }
    return result;
  }),
}));

// Mock ../circuits
const mockComputeCommitment = vi.fn();
const mockDeriveOwnerPubkey = vi.fn();
const mockRandomFieldElement = vi.fn();
const mockFieldToBytes = vi.fn();
const mockBytesToField = vi.fn();
const mockPubkeyToField = vi.fn();

const mockComputeSpendingKeyHash = vi.fn(async (key: bigint) => key + BigInt(1));

vi.mock('../circuits', () => ({
  computeCommitment: (...args: any[]) => mockComputeCommitment(...args),
  deriveOwnerPubkey: (...args: any[]) => mockDeriveOwnerPubkey(...args),
  computeSpendingKeyHash: (...args: any[]) => mockComputeSpendingKeyHash(...args),
  randomFieldElement: (...args: any[]) => mockRandomFieldElement(...args),
  fieldToBytes: (...args: any[]) => mockFieldToBytes(...args),
  bytesToField: (...args: any[]) => mockBytesToField(...args),
  pubkeyToField: (...args: any[]) => mockPubkeyToField(...args),
}));

// Mock crypto.getRandomValues
const mockGetRandomValues = vi.fn((arr: Uint8Array) => {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = (i * 7 + 13) % 256;
  }
  return arr;
});

vi.stubGlobal('crypto', { getRandomValues: mockGetRandomValues });

// ----- Imports (after mocks) -----

import nacl from 'tweetnacl';
import {
  Note,
  EncryptedNote,
  createNote,
  encryptNote,
  decryptNote,
  generateSpendingKeyPair,
} from './index';
import { ENCRYPTION } from '../constants';

// ----- Helpers -----

function makeFieldToBytes(val: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = val;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(v & BigInt(0xff));
    v >>= BigInt(8);
  }
  return bytes;
}

// ----- Tests -----

describe('Note', () => {
  const sampleNoteData = {
    amount: BigInt(1000000),
    ownerPubkey: BigInt('12345678901234567890'),
    randomness: BigInt('98765432109876543210'),
    tokenMint: BigInt('11111111111111111111'),
    commitment: BigInt('55555555555555555555'),
    leafIndex: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFieldToBytes.mockImplementation(makeFieldToBytes);
  });

  describe('constructor', () => {
    it('should set all fields from NoteData', () => {
      const note = new Note(sampleNoteData);

      expect(note.amount).toBe(sampleNoteData.amount);
      expect(note.ownerPubkey).toBe(sampleNoteData.ownerPubkey);
      expect(note.randomness).toBe(sampleNoteData.randomness);
      expect(note.tokenMint).toBe(sampleNoteData.tokenMint);
      expect(note.commitment).toBe(sampleNoteData.commitment);
      expect(note.leafIndex).toBe(3);
    });

    it('should allow leafIndex to be undefined', () => {
      const { leafIndex, ...dataWithoutLeaf } = sampleNoteData;
      const note = new Note({ ...dataWithoutLeaf, commitment: sampleNoteData.commitment });
      expect(note.leafIndex).toBeUndefined();
    });
  });

  describe('toJSON', () => {
    it('should serialize note data to a plain object', () => {
      const note = new Note(sampleNoteData);
      const json = note.toJSON();

      expect(json).toEqual(sampleNoteData);
    });

    it('should serialize note without leafIndex', () => {
      const data = { ...sampleNoteData, leafIndex: undefined };
      const note = new Note(data);
      const json = note.toJSON();

      expect(json.leafIndex).toBeUndefined();
      expect(json.amount).toBe(data.amount);
    });
  });

  describe('getCommitmentBytes', () => {
    it('should call fieldToBytes with the commitment value', () => {
      const note = new Note(sampleNoteData);
      const fakeBytes = new Uint8Array(32).fill(0xab);
      mockFieldToBytes.mockReturnValue(fakeBytes);

      const result = note.getCommitmentBytes();

      expect(mockFieldToBytes).toHaveBeenCalledWith(sampleNoteData.commitment);
      expect(result).toBe(fakeBytes);
    });
  });
});

describe('EncryptedNote', () => {
  const sampleEncryptedData = {
    ciphertext: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    ephemeralPubkey: new Uint8Array(32).fill(0xaa),
    commitment: new Uint8Array(32).fill(0xbb),
    nonce: new Uint8Array(ENCRYPTION.NONCE_SIZE).fill(0xcc),
  };

  describe('constructor', () => {
    it('should store all fields', () => {
      const enc = new EncryptedNote(sampleEncryptedData);

      expect(enc.ciphertext).toBe(sampleEncryptedData.ciphertext);
      expect(enc.ephemeralPubkey).toBe(sampleEncryptedData.ephemeralPubkey);
      expect(enc.commitment).toBe(sampleEncryptedData.commitment);
      expect(enc.nonce).toBe(sampleEncryptedData.nonce);
    });
  });

  describe('toBytes / fromBytes round-trip', () => {
    it('should serialize and deserialize back to identical data', () => {
      const original = new EncryptedNote(sampleEncryptedData);
      const serialized = original.toBytes();
      const restored = EncryptedNote.fromBytes(serialized);

      expect(restored.ciphertext).toEqual(original.ciphertext);
      expect(restored.ephemeralPubkey).toEqual(original.ephemeralPubkey);
      expect(restored.commitment).toEqual(original.commitment);
      expect(restored.nonce).toEqual(original.nonce);
    });

    it('should handle empty ciphertext', () => {
      const data = {
        ...sampleEncryptedData,
        ciphertext: new Uint8Array(0),
      };
      const enc = new EncryptedNote(data);
      const serialized = enc.toBytes();
      const restored = EncryptedNote.fromBytes(serialized);

      expect(restored.ciphertext.length).toBe(0);
      expect(restored.ephemeralPubkey).toEqual(data.ephemeralPubkey);
    });

    it('should handle large ciphertext', () => {
      const largeCiphertext = new Uint8Array(1024).fill(0xdd);
      const data = { ...sampleEncryptedData, ciphertext: largeCiphertext };
      const enc = new EncryptedNote(data);
      const serialized = enc.toBytes();
      const restored = EncryptedNote.fromBytes(serialized);

      expect(restored.ciphertext).toEqual(largeCiphertext);
    });

    it('should produce correct total byte length', () => {
      const enc = new EncryptedNote(sampleEncryptedData);
      const bytes = enc.toBytes();

      const expectedLen =
        4 + sampleEncryptedData.ciphertext.length + 32 + 32 + ENCRYPTION.NONCE_SIZE;
      expect(bytes.length).toBe(expectedLen);
    });
  });

  describe('toBytes byte layout', () => {
    it('should encode ciphertext length as first 4 bytes (little-endian)', () => {
      const enc = new EncryptedNote(sampleEncryptedData);
      const bytes = enc.toBytes();

      const view = new DataView(bytes.buffer, bytes.byteOffset);
      expect(view.getUint32(0, true)).toBe(sampleEncryptedData.ciphertext.length);
    });

    it('should place ciphertext after the length prefix', () => {
      const enc = new EncryptedNote(sampleEncryptedData);
      const bytes = enc.toBytes();

      const ct = bytes.slice(4, 4 + sampleEncryptedData.ciphertext.length);
      expect(ct).toEqual(sampleEncryptedData.ciphertext);
    });
  });
});

describe('createNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeCommitment.mockResolvedValue(BigInt(42));
    mockRandomFieldElement.mockReturnValue(BigInt(999));
    mockFieldToBytes.mockImplementation(makeFieldToBytes);
  });

  it('should create a note with provided randomness', async () => {
    const amount = BigInt(500);
    const ownerPubkey = BigInt(100);
    const tokenMint = BigInt(200);
    const randomness = BigInt(300);

    const note = await createNote(amount, ownerPubkey, tokenMint, randomness);

    expect(note).toBeInstanceOf(Note);
    expect(note.amount).toBe(amount);
    expect(note.ownerPubkey).toBe(ownerPubkey);
    expect(note.tokenMint).toBe(tokenMint);
    expect(note.randomness).toBe(randomness);
    expect(note.commitment).toBe(BigInt(42));

    expect(mockComputeCommitment).toHaveBeenCalledWith(amount, ownerPubkey, randomness, tokenMint);
    expect(mockRandomFieldElement).not.toHaveBeenCalled();
  });

  it('should generate random randomness when not provided', async () => {
    const note = await createNote(BigInt(100), BigInt(200), BigInt(300));

    expect(mockRandomFieldElement).toHaveBeenCalled();
    expect(note.randomness).toBe(BigInt(999));
    expect(mockComputeCommitment).toHaveBeenCalledWith(
      BigInt(100),
      BigInt(200),
      BigInt(999),
      BigInt(300)
    );
  });

  it('should leave leafIndex undefined on new notes', async () => {
    const note = await createNote(BigInt(1), BigInt(2), BigInt(3), BigInt(4));
    expect(note.leafIndex).toBeUndefined();
  });

  it('should use the commitment value returned by computeCommitment', async () => {
    mockComputeCommitment.mockResolvedValue(BigInt('777777777'));
    const note = await createNote(BigInt(0), BigInt(0), BigInt(0), BigInt(0));
    expect(note.commitment).toBe(BigInt('777777777'));
  });

  it('should handle zero amount', async () => {
    const note = await createNote(BigInt(0), BigInt(1), BigInt(2), BigInt(3));
    expect(note.amount).toBe(BigInt(0));
  });

  it('should handle very large amounts', async () => {
    const largeAmount = BigInt('18446744073709551615'); // u64 max
    const note = await createNote(largeAmount, BigInt(1), BigInt(2), BigInt(3));
    expect(note.amount).toBe(largeAmount);
  });
});

describe('encryptNote / decryptNote', () => {
  // The impl uses X25519 ECDH: encrypt expects the recipient's PUBLIC key,
  // decrypt expects the recipient's PRIVATE key. Generate a real keypair so
  // the round-trip can complete (a random 32-byte buffer used for both sides
  // will not satisfy the ECDH equation).
  const recipientKeyPair = nacl.box.keyPair.fromSecretKey(
    new Uint8Array(32).fill(0x42),
  );
  const recipientPub = recipientKeyPair.publicKey;
  const recipientPriv = recipientKeyPair.secretKey;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFieldToBytes.mockImplementation(makeFieldToBytes);
    mockBytesToField.mockImplementation((bytes: Uint8Array) => {
      let result = BigInt(0);
      for (let i = bytes.length - 1; i >= 0; i--) {
        result = (result << BigInt(8)) | BigInt(bytes[i]);
      }
      return result;
    });
  });

  it('should produce an EncryptedNote with correct structure', () => {
    const note = new Note({
      amount: BigInt(1000),
      ownerPubkey: BigInt(2000),
      randomness: BigInt(3000),
      tokenMint: BigInt(4000),
      commitment: BigInt(5000),
    });

    const encrypted = encryptNote(note, recipientPub);

    expect(encrypted).toBeInstanceOf(EncryptedNote);
    // serializeNoteData writes 136 bytes (8 + 32 + 32 + 32 + 32);
    // NaCl secretbox adds a 16-byte Poly1305 tag → 152.
    expect(encrypted.ciphertext.length).toBe(152);
    expect(encrypted.ephemeralPubkey.length).toBe(32);
    expect(encrypted.commitment.length).toBe(32);
    expect(encrypted.nonce.length).toBe(ENCRYPTION.NONCE_SIZE);
  });

  it('should encrypt and decrypt round-trip successfully', () => {
    const noteData = {
      amount: BigInt(1000),
      ownerPubkey: BigInt(2000),
      randomness: BigInt(3000),
      tokenMint: BigInt(4000),
      commitment: BigInt(5000),
    };
    const note = new Note(noteData);

    const encrypted = encryptNote(note, recipientPub);
    const decrypted = decryptNote(encrypted, recipientPriv);

    expect(decrypted).not.toBeNull();
    expect(decrypted).toBeInstanceOf(Note);
    expect(decrypted!.amount).toBe(noteData.amount);
    expect(decrypted!.ownerPubkey).toBe(noteData.ownerPubkey);
    expect(decrypted!.randomness).toBe(noteData.randomness);
    expect(decrypted!.tokenMint).toBe(noteData.tokenMint);
  });

  it('should return null when decrypting with wrong key', () => {
    const note = new Note({
      amount: BigInt(1000),
      ownerPubkey: BigInt(2000),
      randomness: BigInt(3000),
      tokenMint: BigInt(4000),
      commitment: BigInt(5000),
    });

    const encrypted = encryptNote(note, recipientPub);
    const wrongKey = nacl.box.keyPair.fromSecretKey(
      new Uint8Array(32).fill(0x99),
    ).secretKey;

    const decrypted = decryptNote(encrypted, wrongKey);
    expect(decrypted).toBeNull();
  });

  it('should handle ciphertext tampering gracefully', () => {
    const note = new Note({
      amount: BigInt(100),
      ownerPubkey: BigInt(200),
      randomness: BigInt(300),
      tokenMint: BigInt(400),
      commitment: BigInt(500),
    });

    const encrypted = encryptNote(note, recipientPub);

    const tamperedCiphertext = new Uint8Array(encrypted.ciphertext);
    tamperedCiphertext[0] ^= 0xff;
    tamperedCiphertext[10] ^= 0xff;

    const tampered = new EncryptedNote({
      ciphertext: tamperedCiphertext,
      ephemeralPubkey: encrypted.ephemeralPubkey,
      commitment: encrypted.commitment,
      nonce: encrypted.nonce,
    });

    const decrypted = decryptNote(tampered, recipientPriv);
    // Poly1305 authenticates the ciphertext: any tamper must fail decryption.
    expect(decrypted).toBeNull();
  });

  it('should produce a fresh nonce and ephemeral key each call', () => {
    const note = new Note({
      amount: BigInt(1),
      ownerPubkey: BigInt(2),
      randomness: BigInt(3),
      tokenMint: BigInt(4),
      commitment: BigInt(5),
    });

    const a = encryptNote(note, recipientPub);
    const b = encryptNote(note, recipientPub);

    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ephemeralPubkey).not.toEqual(b.ephemeralPubkey);
  });
});

describe('generateSpendingKeyPair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBytesToField.mockImplementation((bytes: Uint8Array) => {
      let result = BigInt(0);
      for (let i = bytes.length - 1; i >= 0; i--) {
        result = (result << BigInt(8)) | BigInt(bytes[i]);
      }
      return result;
    });
    mockDeriveOwnerPubkey.mockResolvedValue(BigInt('88888888'));
  });

  it('should derive spending key from seed', async () => {
    const seed = new Uint8Array([1, 2, 3, 4]);
    const kp = await generateSpendingKeyPair(seed);

    expect(kp.spendingKey).toBeDefined();
    expect(typeof kp.spendingKey).toBe('bigint');
  });

  it('should derive ownerPubkey using deriveOwnerPubkey', async () => {
    const seed = new Uint8Array([10, 20, 30]);
    const kp = await generateSpendingKeyPair(seed);

    expect(mockDeriveOwnerPubkey).toHaveBeenCalled();
    expect(kp.ownerPubkey).toBe(BigInt('88888888'));
  });

  it('should produce deterministic output for same seed', async () => {
    const seed = new Uint8Array([5, 6, 7, 8]);
    const kp1 = await generateSpendingKeyPair(seed);
    const kp2 = await generateSpendingKeyPair(seed);

    expect(kp1.spendingKey).toBe(kp2.spendingKey);
  });

  it('should produce different keys for different seeds', async () => {
    const seed1 = new Uint8Array([1, 0, 0, 0]);
    const seed2 = new Uint8Array([2, 0, 0, 0]);

    mockDeriveOwnerPubkey
      .mockResolvedValueOnce(BigInt(111))
      .mockResolvedValueOnce(BigInt(111))
      .mockResolvedValueOnce(BigInt(222))
      .mockResolvedValueOnce(BigInt(222));

    const kp1 = await generateSpendingKeyPair(seed1);
    const kp2 = await generateSpendingKeyPair(seed2);

    expect(kp1.spendingKey).not.toBe(kp2.spendingKey);
  });

  it('should set spendingKeyHash', async () => {
    const seed = new Uint8Array([1]);
    const kp = await generateSpendingKeyPair(seed);

    expect(kp.spendingKeyHash).toBeDefined();
    expect(typeof kp.spendingKeyHash).toBe('bigint');
  });
});
