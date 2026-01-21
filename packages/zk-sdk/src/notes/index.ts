/**
 * Note management for shielded transactions
 * Handles creation, encryption, and decryption of notes
 */

import { sha256 } from '@noble/hashes/sha256';
import {
  computeCommitment,
  deriveOwnerPubkey,
  randomFieldElement,
  fieldToBytes,
  bytesToField,
  pubkeyToField,
} from '../circuits';
import type { NoteData, EncryptedNoteData, SpendingKeyPair } from '../types';
import { ENCRYPTION } from '../constants';

/**
 * Note class representing a shielded UTXO
 */
export class Note {
  readonly amount: bigint;
  readonly ownerPubkey: bigint;
  readonly randomness: bigint;
  readonly tokenMint: bigint;
  readonly commitment: bigint;
  leafIndex?: number;

  constructor(data: NoteData) {
    this.amount = data.amount;
    this.ownerPubkey = data.ownerPubkey;
    this.randomness = data.randomness;
    this.tokenMint = data.tokenMint;
    this.commitment = data.commitment;
    this.leafIndex = data.leafIndex;
  }

  /**
   * Serialize note data
   */
  toJSON(): NoteData {
    return {
      amount: this.amount,
      ownerPubkey: this.ownerPubkey,
      randomness: this.randomness,
      tokenMint: this.tokenMint,
      commitment: this.commitment,
      leafIndex: this.leafIndex,
    };
  }

  /**
   * Get commitment as bytes
   */
  getCommitmentBytes(): Uint8Array {
    return fieldToBytes(this.commitment);
  }
}

/**
 * Encrypted note for storage/transmission
 */
export class EncryptedNote {
  readonly ciphertext: Uint8Array;
  readonly ephemeralPubkey: Uint8Array;
  readonly commitment: Uint8Array;
  readonly nonce: Uint8Array;

  constructor(data: EncryptedNoteData) {
    this.ciphertext = data.ciphertext;
    this.ephemeralPubkey = data.ephemeralPubkey;
    this.commitment = data.commitment;
    this.nonce = data.nonce;
  }

  /**
   * Serialize to bytes
   */
  toBytes(): Uint8Array {
    const totalLen = 4 + this.ciphertext.length + 32 + 32 + ENCRYPTION.NONCE_SIZE;
    const result = new Uint8Array(totalLen);
    let offset = 0;

    // Ciphertext length (4 bytes)
    new DataView(result.buffer).setUint32(offset, this.ciphertext.length, true);
    offset += 4;

    // Ciphertext
    result.set(this.ciphertext, offset);
    offset += this.ciphertext.length;

    // Ephemeral pubkey (32 bytes)
    result.set(this.ephemeralPubkey, offset);
    offset += 32;

    // Commitment (32 bytes)
    result.set(this.commitment, offset);
    offset += 32;

    // Nonce
    result.set(this.nonce, offset);

    return result;
  }

  /**
   * Deserialize from bytes
   */
  static fromBytes(bytes: Uint8Array): EncryptedNote {
    let offset = 0;

    // Ciphertext length
    const ciphertextLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
    offset += 4;

    // Ciphertext
    const ciphertext = bytes.slice(offset, offset + ciphertextLen);
    offset += ciphertextLen;

    // Ephemeral pubkey
    const ephemeralPubkey = bytes.slice(offset, offset + 32);
    offset += 32;

    // Commitment
    const commitment = bytes.slice(offset, offset + 32);
    offset += 32;

    // Nonce
    const nonce = bytes.slice(offset, offset + ENCRYPTION.NONCE_SIZE);

    return new EncryptedNote({ ciphertext, ephemeralPubkey, commitment, nonce });
  }
}

/**
 * Create a new note
 */
export async function createNote(
  amount: bigint,
  ownerPubkey: bigint,
  tokenMint: bigint,
  randomness?: bigint
): Promise<Note> {
  const rand = randomness ?? randomFieldElement();
  const commitment = await computeCommitment(amount, ownerPubkey, rand, tokenMint);

  return new Note({
    amount,
    ownerPubkey,
    randomness: rand,
    tokenMint,
    commitment,
  });
}

/**
 * Create a note for a specific recipient
 */
export async function createNoteForRecipient(
  amount: bigint,
  recipientPubkey: bigint,
  tokenMint: Uint8Array
): Promise<Note> {
  const tokenMintField = pubkeyToField(tokenMint);
  return createNote(amount, recipientPubkey, tokenMintField);
}

/**
 * Encrypt a note for storage
 * Uses a simple XOR-based encryption with HKDF-derived key
 * In production, use proper AEAD (XChaCha20-Poly1305)
 */
export function encryptNote(note: Note, viewingKey: Uint8Array): EncryptedNote {
  // Generate ephemeral keypair
  const ephemeralPrivate = new Uint8Array(32);
  crypto.getRandomValues(ephemeralPrivate);
  // For simplicity, use the private key as the "public" key
  // In production, derive proper EC public key
  const ephemeralPubkey = sha256(ephemeralPrivate);

  // Derive shared secret
  const sharedInput = new Uint8Array(64);
  sharedInput.set(ephemeralPrivate, 0);
  sharedInput.set(viewingKey, 32);
  const sharedSecret = sha256(sharedInput);

  // Serialize note data
  const noteData = serializeNoteData(note);

  // Generate nonce
  const nonce = new Uint8Array(ENCRYPTION.NONCE_SIZE);
  crypto.getRandomValues(nonce);

  // Simple XOR encryption (replace with XChaCha20-Poly1305 in production)
  const keyStream = expandKey(sharedSecret, nonce, noteData.length);
  const ciphertext = new Uint8Array(noteData.length);
  for (let i = 0; i < noteData.length; i++) {
    ciphertext[i] = noteData[i] ^ keyStream[i];
  }

  return new EncryptedNote({
    ciphertext,
    ephemeralPubkey,
    commitment: fieldToBytes(note.commitment),
    nonce,
  });
}

/**
 * Decrypt a note
 */
export function decryptNote(
  encrypted: EncryptedNote,
  viewingKey: Uint8Array
): Note | null {
  try {
    // Derive shared secret
    const sharedInput = new Uint8Array(64);
    sharedInput.set(encrypted.ephemeralPubkey, 0);
    sharedInput.set(viewingKey, 32);
    const sharedSecret = sha256(sharedInput);

    // Decrypt
    const keyStream = expandKey(sharedSecret, encrypted.nonce, encrypted.ciphertext.length);
    const noteData = new Uint8Array(encrypted.ciphertext.length);
    for (let i = 0; i < encrypted.ciphertext.length; i++) {
      noteData[i] = encrypted.ciphertext[i] ^ keyStream[i];
    }

    // Deserialize
    return deserializeNoteData(noteData);
  } catch {
    return null;
  }
}

/**
 * Serialize note data to bytes
 */
function serializeNoteData(note: Note): Uint8Array {
  const buffer = new Uint8Array(128);
  let offset = 0;

  // Amount (8 bytes)
  const amountBytes = fieldToBytes(note.amount);
  buffer.set(amountBytes.slice(0, 8), offset);
  offset += 8;

  // Owner pubkey (32 bytes)
  buffer.set(fieldToBytes(note.ownerPubkey), offset);
  offset += 32;

  // Randomness (32 bytes)
  buffer.set(fieldToBytes(note.randomness), offset);
  offset += 32;

  // Token mint (32 bytes)
  buffer.set(fieldToBytes(note.tokenMint), offset);
  offset += 32;

  // Commitment (32 bytes) - for verification
  buffer.set(fieldToBytes(note.commitment), offset);

  return buffer;
}

/**
 * Deserialize note data from bytes
 */
function deserializeNoteData(data: Uint8Array): Note {
  let offset = 0;

  // Amount
  const amountBytes = new Uint8Array(32);
  amountBytes.set(data.slice(offset, offset + 8));
  const amount = bytesToField(amountBytes);
  offset += 8;

  // Owner pubkey
  const ownerPubkey = bytesToField(data.slice(offset, offset + 32));
  offset += 32;

  // Randomness
  const randomness = bytesToField(data.slice(offset, offset + 32));
  offset += 32;

  // Token mint
  const tokenMint = bytesToField(data.slice(offset, offset + 32));
  offset += 32;

  // Commitment
  const commitment = bytesToField(data.slice(offset, offset + 32));

  return new Note({
    amount,
    ownerPubkey,
    randomness,
    tokenMint,
    commitment,
  });
}

/**
 * Expand key using SHA256 (simplified KDF)
 */
function expandKey(key: Uint8Array, nonce: Uint8Array, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  let counter = 0;

  while (offset < length) {
    const input = new Uint8Array(key.length + nonce.length + 4);
    input.set(key, 0);
    input.set(nonce, key.length);
    new DataView(input.buffer).setUint32(key.length + nonce.length, counter++, true);

    const block = sha256(input);
    const toCopy = Math.min(block.length, length - offset);
    result.set(block.slice(0, toCopy), offset);
    offset += toCopy;
  }

  return result;
}

/**
 * Generate spending key pair from seed
 */
export async function generateSpendingKeyPair(seed: Uint8Array): Promise<SpendingKeyPair> {
  const spendingKey = bytesToField(sha256(seed));
  const ownerPubkey = await deriveOwnerPubkey(spendingKey);
  const spendingKeyHash = await deriveOwnerPubkey(spendingKey); // Same as pubkey derivation

  return {
    spendingKey,
    ownerPubkey,
    spendingKeyHash,
  };
}

// Re-export types
export type { NoteData } from '../types';
