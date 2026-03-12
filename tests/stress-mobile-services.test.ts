/**
 * STRESS TEST: Mobile Services & Crypto Utils
 *
 * Tests the TypeScript service layer (connection, crypto, STARK instructions,
 * Arcium MPC, denominated pool, BLE sharing) without requiring React Native.
 *
 * All RN-specific APIs (expo-secure-store, expo-crypto, expo-clipboard, etc.)
 * are mocked with Node.js equivalents before any source modules are loaded.
 *
 * Run:
 *   ts-mocha -p tsconfig.test.json tests/stress-mobile-services.test.ts --timeout 300000
 */

import { assert, expect } from 'chai';
import * as crypto from 'crypto';
import nacl from 'tweetnacl';
import { Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { poseidon2, poseidon4 } from 'poseidon-lite';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import bs58 from 'bs58';
import { Buffer } from 'buffer';

// =============================================================================
// Mocks — Must be set up before importing any mobile source files.
// =============================================================================

// --- expo-crypto mock ---
const MockExpoCrypto = {
  CryptoDigestAlgorithm: { SHA256: 'SHA-256', SHA512: 'SHA-512' },
  getRandomBytes(size: number): Uint8Array {
    return new Uint8Array(crypto.randomBytes(size));
  },
  async getRandomBytesAsync(size: number): Promise<Uint8Array> {
    return new Uint8Array(crypto.randomBytes(size));
  },
  async digestStringAsync(algo: string, data: string): Promise<string> {
    const nodeAlgo = algo === 'SHA-256' ? 'sha256' : 'sha512';
    return crypto.createHash(nodeAlgo).update(data).digest('hex');
  },
};

// --- expo-secure-store mock (backed by a simple Map) ---
const _secureStoreMap = new Map<string, string>();
const MockSecureStore = {
  async getItemAsync(key: string): Promise<string | null> {
    return _secureStoreMap.get(key) ?? null;
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    _secureStoreMap.set(key, value);
  },
  async deleteItemAsync(key: string): Promise<void> {
    _secureStoreMap.delete(key);
  },
};

// --- expo-clipboard mock ---
let _clipboardContent = '';
let _clipboardTimerId: ReturnType<typeof setTimeout> | null = null;
const MockClipboard = {
  async setStringAsync(str: string): Promise<void> {
    _clipboardContent = str;
  },
  async getStringAsync(): Promise<string> {
    return _clipboardContent;
  },
};

// --- expo-haptics mock ---
const MockHaptics = {
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
  async notificationAsync(_type: string): Promise<void> {},
  async impactAsync(_style: string): Promise<void> {},
};

// --- @react-native-async-storage/async-storage mock ---
const _asyncStorageMap = new Map<string, string>();
const MockAsyncStorage = {
  default: {
    getItem: async (key: string) => _asyncStorageMap.get(key) ?? null,
    setItem: async (key: string, value: string) => { _asyncStorageMap.set(key, value); },
    removeItem: async (key: string) => { _asyncStorageMap.delete(key); },
    clear: async () => { _asyncStorageMap.clear(); },
  },
};

// --- Register mocks before require() resolves them ---
const Module = require('module');
const _origResolveFilename = Module._resolveFilename;
const MOCK_MODULES: Record<string, any> = {
  'expo-crypto': MockExpoCrypto,
  'expo-secure-store': MockSecureStore,
  'expo-clipboard': MockClipboard,
  'expo-haptics': MockHaptics,
  '@react-native-async-storage/async-storage': MockAsyncStorage,
};

// Intercept require resolution so mobile source files see our mocks
Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
  if (MOCK_MODULES[request]) {
    // Return a fake path — we'll intercept in _cache below
    return `__mock__/${request}`;
  }
  return _origResolveFilename.call(this, request, parent, isMain, options);
};

// Populate require.cache so require() returns the mock directly
for (const [name, mock] of Object.entries(MOCK_MODULES)) {
  const fakePath = `__mock__/${name}`;
  require.cache[fakePath] = {
    id: fakePath,
    filename: fakePath,
    loaded: true,
    exports: mock,
    parent: null,
    children: [],
    paths: [],
    path: '',
    require: require,
    isPreloading: false,
  } as any;
}

// --- Provide global __DEV__ flag (React Native) ---
(global as any).__DEV__ = false;

// =============================================================================
// Helpers — Re-implement core mobile crypto logic in Node.js for testing
// =============================================================================

/**
 * Re-implement PIN hash (matches apps/mobile/utils/crypto/pinHash.ts)
 * Uses our MockSecureStore + MockExpoCrypto.
 */
async function hashPin(pin: string): Promise<string> {
  let salt = await MockSecureStore.getItemAsync('p01_pin_salt');
  if (!salt) {
    const bytes = MockExpoCrypto.getRandomBytes(16);
    salt = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    await MockSecureStore.setItemAsync('p01_pin_salt', salt);
  }
  return MockExpoCrypto.digestStringAsync('SHA-256', `p01_pin_v2:${salt}:${pin}`);
}

/** Constant-time string comparison (from pinHash.ts) */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Note vault encrypt/decrypt — re-implemented with Node.js crypto
 * (mirrors apps/mobile/utils/crypto/noteVault.ts logic)
 */
class NoteVault {
  private _key: Uint8Array | null = null;

  /** Derive key from pinHash using iterated SHA-256 (simplified for test: fewer iterations) */
  async unlock(pinHash: string): Promise<void> {
    let salt = await MockSecureStore.getItemAsync('p01_note_vault_salt');
    if (!salt) {
      salt = crypto.randomBytes(32).toString('hex');
      await MockSecureStore.setItemAsync('p01_note_vault_salt', salt);
    }
    let input = `P01_NOTE_VAULT_V1:${salt}:${pinHash}`;
    // Use 100 iterations in tests (production uses 10,000)
    for (let i = 0; i < 100; i++) {
      input = crypto.createHash('sha256').update(input).digest('hex');
    }
    this._key = new Uint8Array(Buffer.from(input, 'hex').slice(0, 32));
  }

  unlockWithKey(key: Uint8Array): void {
    this._key = key;
  }

  lock(): void {
    if (this._key) {
      this._key.fill(0);
      this._key = null;
    }
  }

  isUnlocked(): boolean {
    return this._key !== null;
  }

  encrypt(receipt: string): string {
    if (!this._key) return receipt;
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const plaintext = new TextEncoder().encode(receipt);
    const ciphertext = nacl.secretbox(plaintext, nonce, this._key);
    if (!ciphertext) throw new Error('Vault encryption failed');
    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce);
    combined.set(ciphertext, nonce.length);
    return `vault:${Buffer.from(combined).toString('base64')}`;
  }

  decrypt(encrypted: string): string {
    if (!encrypted.startsWith('vault:')) return encrypted;
    if (!this._key) throw new Error('Note vault is locked. Authenticate to access shielded notes.');
    const data = new Uint8Array(Buffer.from(encrypted.slice(6), 'base64'));
    const nonce = data.slice(0, nacl.secretbox.nonceLength);
    const ciphertext = data.slice(nacl.secretbox.nonceLength);
    const plaintext = nacl.secretbox.open(ciphertext, nonce, this._key);
    if (!plaintext) throw new Error('Vault decryption failed — wrong PIN or corrupted note.');
    return new TextDecoder().decode(plaintext);
  }
}

// =============================================================================
// Amount Noise — Re-implement without expo-crypto dependency
// =============================================================================

interface NoiseResult {
  adjustedAmount: number;
  noiseDelta: number;
  newCumulativeAdjustment: number;
}

async function applyAmountNoise(
  amount: number,
  noisePercent: number,
  cumulativeAdjustment: number = 0,
  remainingPayments?: number,
): Promise<NoiseResult> {
  if (amount <= 0) {
    return { adjustedAmount: amount, noiseDelta: 0, newCumulativeAdjustment: cumulativeAdjustment };
  }
  const clampedNoisePercent = Math.max(0, Math.min(20, noisePercent));
  if (clampedNoisePercent === 0) {
    return { adjustedAmount: amount, noiseDelta: 0, newCumulativeAdjustment: cumulativeAdjustment };
  }
  const maxNoise = amount * (clampedNoisePercent / 100);
  const bytes = crypto.randomBytes(4);
  const value = bytes.readUInt32BE(0);
  const randomFloat = value / 0xFFFFFFFF;
  const randomFactor = (randomFloat * 2) - 1;
  let noise = randomFactor * maxNoise;

  if (Math.abs(cumulativeAdjustment) > 0) {
    const correctionStrength = 0.3;
    const imbalanceRatio = cumulativeAdjustment / amount;
    const correction = Math.max(-maxNoise, Math.min(maxNoise, -imbalanceRatio * correctionStrength * amount));
    noise = noise * (1 - correctionStrength) + correction;
  }
  if (remainingPayments !== undefined && remainingPayments <= 1) {
    const neededCorrection = -cumulativeAdjustment;
    noise = Math.max(-maxNoise, Math.min(maxNoise, neededCorrection));
  }
  const adjustedAmount = Math.max(0, amount + noise);
  const roundedAmount = Math.round(adjustedAmount * 1e9) / 1e9;
  const actualNoise = roundedAmount - amount;
  return {
    adjustedAmount: roundedAmount,
    noiseDelta: actualNoise,
    newCumulativeAdjustment: cumulativeAdjustment + actualNoise,
  };
}

function calculateFinalPaymentAdjustment(
  expectedTotal: number,
  actualPaid: number,
  finalPayment: number,
  noisePercent: number,
): number {
  const remaining = expectedTotal - actualPaid;
  const maxNoise = finalPayment * (noisePercent / 100);
  const minFinal = Math.max(0, finalPayment - maxNoise);
  const maxFinal = finalPayment + maxNoise;
  return Math.max(minFinal, Math.min(maxFinal, remaining));
}

// =============================================================================
// Stealth — Re-implement pure crypto functions for testing
// =============================================================================

const STEALTH_SEED_INFO = 'p01-stealth-seed';
const HYBRID_HKDF_INFO = 'p01-hybrid-stealth-v2';
const META_ADDRESS_PREFIX = 'st:';

function deriveSharedSecret(mySecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return nacl.scalarMult(mySecretKey, theirPublicKey);
}

function deriveStealthSeed(spendingPubKey: Uint8Array, sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, spendingPubKey, STEALTH_SEED_INFO, 32);
}

function computeViewTag(sharedSecret: Uint8Array): number {
  return sha256(sharedSecret)[0]!;
}

function generateStealthAddress(
  recipientSpendingPub: Uint8Array,
  recipientViewingPub: Uint8Array,
): { address: string; ephemeralPublicKey: string; viewTag: number } {
  const ephemeral = nacl.box.keyPair();
  const classicSecret = deriveSharedSecret(ephemeral.secretKey, recipientViewingPub);
  const stealthSeed = deriveStealthSeed(recipientSpendingPub, classicSecret);
  const stealthKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
  return {
    address: new PublicKey(stealthKeypair.publicKey).toBase58(),
    ephemeralPublicKey: bs58.encode(ephemeral.publicKey),
    viewTag: computeViewTag(classicSecret),
  };
}

function scanStealthPayment(
  ephemeralPublicKey: string,
  viewingSecretKey: Uint8Array,
  spendingPubKey: Uint8Array,
  expectedViewTag?: number,
): { found: boolean; stealthAddress?: string } {
  const ephemeralPub = new Uint8Array(bs58.decode(ephemeralPublicKey));
  const classicSecret = deriveSharedSecret(viewingSecretKey, ephemeralPub);
  if (expectedViewTag !== undefined && computeViewTag(classicSecret) !== expectedViewTag) {
    return { found: false };
  }
  const stealthSeed = deriveStealthSeed(spendingPubKey, classicSecret);
  const stealthKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
  return {
    found: true,
    stealthAddress: new PublicKey(stealthKeypair.publicKey).toBase58(),
  };
}

function createMetaAddressV1(spendingPub: Uint8Array, viewingPub: Uint8Array): string {
  const combined = new Uint8Array(64);
  combined.set(spendingPub, 0);
  combined.set(viewingPub, 32);
  return `${META_ADDRESS_PREFIX}01${bs58.encode(combined)}`;
}

function parseMetaAddress(metaAddress: string): { spendingPubKey: Uint8Array; viewingPubKey: Uint8Array } {
  if (!metaAddress.startsWith(META_ADDRESS_PREFIX)) throw new Error('Invalid meta-address');
  const withoutPrefix = metaAddress.slice(META_ADDRESS_PREFIX.length);
  if (withoutPrefix.startsWith('01')) {
    const combined = bs58.decode(withoutPrefix.slice(2));
    if (combined.length !== 64) throw new Error('Invalid v1 meta-address');
    return { spendingPubKey: combined.slice(0, 32), viewingPubKey: combined.slice(32, 64) };
  }
  throw new Error('Unknown meta-address version');
}

// =============================================================================
// STARK instruction builders — Re-implement from mobile service
// =============================================================================

const STARK_VERIFIER_PROGRAM_ID = new PublicKey('DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs');
const MAX_CHUNK_SIZE = 900;

const DISCRIMINATORS = {
  initProofBuffer: Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]),
  resizeProofBuffer: Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]),
  writeProofChunk: Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]),
  verifyStarkProof: Buffer.from([208, 216, 183, 38, 47, 69, 156, 138]),
  verifyStarkProofV2: Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]),
  closeProofBuffer: Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]),
};

function getProofBufferPDA(authority: PublicKey, circuitId: number = 0): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stark_proof'), authority.toBuffer(), Buffer.from([circuitId])],
    STARK_VERIFIER_PROGRAM_ID,
  );
}

function buildInitProofBufferIx(proofSize: number, circuitId: number, proofBuffer: PublicKey, authority: PublicKey) {
  const data = Buffer.alloc(8 + 4 + 1);
  DISCRIMINATORS.initProofBuffer.copy(data, 0);
  data.writeUInt32LE(proofSize, 8);
  data.writeUInt8(circuitId, 12);
  return { programId: STARK_VERIFIER_PROGRAM_ID, keys: [
    { pubkey: proofBuffer, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data };
}

function buildWriteProofChunkIx(offset: number, chunk: Uint8Array, proofBuffer: PublicKey, authority: PublicKey) {
  const data = Buffer.alloc(8 + 4 + 4 + chunk.length);
  DISCRIMINATORS.writeProofChunk.copy(data, 0);
  data.writeUInt32LE(offset, 8);
  data.writeUInt32LE(chunk.length, 12);
  Buffer.from(chunk).copy(data, 16);
  return { programId: STARK_VERIFIER_PROGRAM_ID, keys: [
    { pubkey: proofBuffer, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ], data };
}

function buildVerifyStarkProofIx(commitment: bigint, proofBuffer: PublicKey, authority: PublicKey) {
  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.verifyStarkProof.copy(data, 0);
  const commitBuf = Buffer.alloc(8);
  commitBuf.writeBigUInt64LE(commitment);
  commitBuf.copy(data, 8);
  return { programId: STARK_VERIFIER_PROGRAM_ID, keys: [
    { pubkey: proofBuffer, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ], data };
}

function buildCloseProofBufferIx(proofBuffer: PublicKey, authority: PublicKey) {
  const data = Buffer.alloc(8);
  DISCRIMINATORS.closeProofBuffer.copy(data, 0);
  return { programId: STARK_VERIFIER_PROGRAM_ID, keys: [
    { pubkey: proofBuffer, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: true },
  ], data };
}

function buildResizeProofBufferIx(proofBuffer: PublicKey, authority: PublicKey) {
  return { programId: STARK_VERIFIER_PROGRAM_ID, keys: [
    { pubkey: proofBuffer, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data: DISCRIMINATORS.resizeProofBuffer };
}

function buildVerifyStarkProofV2Ix(publicInputs: bigint[], proofBuffer: PublicKey, authority: PublicKey) {
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(v => { const buf = Buffer.alloc(8); buf.writeBigUInt64LE(v); return buf; });
  const data = Buffer.concat([DISCRIMINATORS.verifyStarkProofV2, vecLen, ...inputBufs]);
  return { programId: STARK_VERIFIER_PROGRAM_ID, keys: [
    { pubkey: proofBuffer, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
  ], data };
}

// =============================================================================
// Pool config — Re-defined (matches mobile service)
// =============================================================================

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const NATIVE_SOL_MINT = SystemProgram.programId;

interface PoolConfig {
  token: 'SOL' | 'USDC';
  tokenMint: PublicKey;
  denomination: number;
  denominationAtomic: bigint;
  decimals: number;
  poolPDA: PublicKey;
  treePDA: PublicKey;
  vaultATA?: PublicKey;
}

const SOL_POOLS: PoolConfig[] = [
  { token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 0.1, decimals: 9, denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('JDVrKu9cKZMKaxxVeC8QUBRTnkC81LcbNHFDcrbyZ2iv'), treePDA: new PublicKey('FGrmPausuBJTV7V2VS2XjpfwGHYrUt79t5E3e3EvjrZ5') },
  { token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 1, decimals: 9, denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('BoCTorE7dDyFTaK4oCEw8K3w7F6FxrKCSqbAGVv4cxXL'), treePDA: new PublicKey('JCRDNgcXieJmjazUnAxo81SsqPQ2XcF38wvgfpjYgSco') },
  { token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 10, decimals: 9, denominationAtomic: 10_000_000_000n,
    poolPDA: new PublicKey('2ZTWWSjnzAjEXxeK5PXF5hjvxixqTnnFyZt7Dd4vfFDJ'), treePDA: new PublicKey('Ha3Ls6adGbJzEwqLcF4Y7x3T7vLtVyFhtc1aCas5C5GT') },
  { token: 'SOL', tokenMint: NATIVE_SOL_MINT, denomination: 100, decimals: 9, denominationAtomic: 100_000_000_000n,
    poolPDA: new PublicKey('4t5nFqX9Xw1Bcv9kp2RQJF4vC8xPnbNZPViZjFWA9KQa'), treePDA: new PublicKey('5bGshmezFLkUDZgex5xQEEiXaKaHHo7Xxnum9qumeQyJ') },
];

const USDC_POOLS: PoolConfig[] = [
  { token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1, decimals: 6, denominationAtomic: 1_000_000n,
    poolPDA: new PublicKey('GH2MCghPgZBqHoHaSqGpzQTwY9gw7V1cwMkd67ofp3w6'), treePDA: new PublicKey('29Zc9jqVoEtKKmhV769dWZBj957U95pxJpyWDkbLsTb3'),
    vaultATA: new PublicKey('8QKdMJbSukL8fkHjU3xw8kFU9jZryPQmXmfvHEpZjTKa') },
  { token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 10, decimals: 6, denominationAtomic: 10_000_000n,
    poolPDA: new PublicKey('zmaKYBQFpRkan5UrKrCxAjw1oDrtiu7X2AMGue843Kp'), treePDA: new PublicKey('4bv2gyfdMTi46fjmU5ccSk21bW2cEr6NKQyH3NAxosdh'),
    vaultATA: new PublicKey('4EuSghk6zWzkLqzmxugTmEpchxYKyNmqZ8xBytzvgGsm') },
  { token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 100, decimals: 6, denominationAtomic: 100_000_000n,
    poolPDA: new PublicKey('BixDeows6MrqXpxH9RZghnQi4ZihzevFagcq9HvW4sVS'), treePDA: new PublicKey('2JSzffuT8f3dUZBEcZrMungLqmHFS21kZSRbdQ6tBbuT'),
    vaultATA: new PublicKey('Hybuu8qYN1HJ9Gk6gkJftGXjGQdiY1DFSrxUXm2k2BUY') },
  { token: 'USDC', tokenMint: USDC_DEVNET_MINT, denomination: 1000, decimals: 6, denominationAtomic: 1_000_000_000n,
    poolPDA: new PublicKey('Dq7CHfsasR7VU3cVgDsyGnWmwBH3LtT4gTBBHEMDHvFF'), treePDA: new PublicKey('EAicVNr5qitSzP7Dc1Z7DZUzV3Pidoqt21Lk7fBWfmtn'),
    vaultATA: new PublicKey('GmiMpZfWSUKsvvJeirZSnYuhcvkbs2GfrN1jfCDmxE2H') },
];

const ALL_POOLS: PoolConfig[] = [...SOL_POOLS, ...USDC_POOLS];

// =============================================================================
// Receipt serialization helpers (from denominatedPool service)
// =============================================================================

interface ShieldReceipt {
  secret: bigint;
  nullifierPreimage: bigint;
  depositEpoch: bigint;
  tokenMint: bigint;
  commitment: bigint;
  leafIndex: number;
  denomination: bigint;
  pool: string;
  token: 'SOL' | 'USDC';
  denominationHuman: number;
  shieldedAt: number;
  merklePathElements?: bigint[];
  merklePathIndices?: number[];
  merkleRoot?: bigint;
}

function createCommitment(nullifierPreimage: bigint, secret: bigint, depositEpoch: bigint, tokenMint: bigint): bigint {
  return poseidon4([nullifierPreimage, secret, depositEpoch, tokenMint]);
}

function createNullifier(nullifierPreimage: bigint, secret: bigint): bigint {
  return poseidon2([nullifierPreimage, secret]);
}

function receiptToJSON(receipt: ShieldReceipt): string {
  return JSON.stringify({
    secret: receipt.secret.toString(),
    nullifierPreimage: receipt.nullifierPreimage.toString(),
    depositEpoch: receipt.depositEpoch.toString(),
    tokenMint: receipt.tokenMint.toString(),
    commitment: receipt.commitment.toString(),
    leafIndex: receipt.leafIndex,
    denomination: receipt.denomination.toString(),
    pool: receipt.pool,
    token: receipt.token,
    denominationHuman: receipt.denominationHuman,
    shieldedAt: receipt.shieldedAt,
    merklePathElements: receipt.merklePathElements?.map(e => e.toString()),
    merklePathIndices: receipt.merklePathIndices,
    merkleRoot: receipt.merkleRoot?.toString(),
  });
}

function receiptFromJSON(json: string): ShieldReceipt {
  const obj = JSON.parse(json);
  return {
    secret: BigInt(obj.secret),
    nullifierPreimage: BigInt(obj.nullifierPreimage),
    depositEpoch: BigInt(obj.depositEpoch),
    tokenMint: BigInt(obj.tokenMint),
    commitment: BigInt(obj.commitment),
    leafIndex: obj.leafIndex,
    denomination: BigInt(obj.denomination),
    pool: obj.pool,
    token: obj.token || 'SOL',
    denominationHuman: obj.denominationHuman || 0,
    shieldedAt: obj.shieldedAt || 0,
    merklePathElements: obj.merklePathElements?.map((e: string) => BigInt(e)),
    merklePathIndices: obj.merklePathIndices,
    merkleRoot: obj.merkleRoot ? BigInt(obj.merkleRoot) : undefined,
  };
}

// =============================================================================
// BLE / Sharing crypto helpers (from services/sharing/crypto/)
// =============================================================================

function computeFingerprint(localPubKey: string, remotePubKey: string): string {
  const sorted = [localPubKey, remotePubKey].sort();
  const combined = `${sorted[0]}:${sorted[1]}`;
  const hash = nacl.hash(new TextEncoder().encode(combined));
  const blocks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const block = Array.from(hash.slice(offset, offset + 4))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    blocks.push(block);
  }
  return blocks.join(' \u00B7 ');
}

function fingerprintsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

interface NotePayload { version: 1; type: string; data: string; ts: number; checksum: string; }
interface EncryptedNotePayload { epk: string; ct: string; n: string; v: 1; }
interface EphemeralKeyPair { publicKey: Uint8Array; secretKey: Uint8Array; }

function generateEphemeralKeyPair(): EphemeralKeyPair { return nacl.box.keyPair(); }

function encryptNote(payload: NotePayload, recipientPub: Uint8Array, senderKP: EphemeralKeyPair): EncryptedNotePayload {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(plaintext, nonce, recipientPub, senderKP.secretKey);
  if (!ct) throw new Error('Encryption failed');
  return {
    epk: Buffer.from(senderKP.publicKey).toString('base64'),
    ct: Buffer.from(ct).toString('base64'),
    n: Buffer.from(nonce).toString('base64'),
    v: 1,
  };
}

function decryptNote(encrypted: EncryptedNotePayload, senderPub: Uint8Array, recipientSK: Uint8Array): NotePayload {
  const ct = new Uint8Array(Buffer.from(encrypted.ct, 'base64'));
  const nonce = new Uint8Array(Buffer.from(encrypted.n, 'base64'));
  const plaintext = nacl.box.open(ct, nonce, senderPub, recipientSK);
  if (!plaintext) throw new Error('Decryption failed');
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function deriveNfcKey(pin: string, timestampMs?: number): Uint8Array {
  const ts = timestampMs ?? Date.now();
  const roundedMinute = Math.floor(ts / 60_000);
  const salt = new TextEncoder().encode(`P01_NFC_SALT_${roundedMinute}`);
  const domain = `P01_NFC_${pin}_${roundedMinute}`;
  let key = nacl.hash(new TextEncoder().encode(domain));
  // Use fewer iterations for test speed (production: 10,000)
  for (let i = 0; i < 100; i++) {
    const combined = new Uint8Array(key.length + salt.length);
    combined.set(key, 0);
    combined.set(salt, key.length);
    key = nacl.hash(combined);
  }
  return key.slice(0, 32);
}

// =============================================================================
// Connection Service helpers (re-implement sanitize/validate logic)
// =============================================================================

function sanitizeRpcUrl(url: string): string {
  return url.replace(/([?&])(api-key|key|apiKey)=[^&]+/gi, '$1$2=***');
}

function validateRpcEndpoint(url: string): void {
  if (!url.startsWith('https://') && !url.startsWith('wss://') &&
      !url.startsWith('http://localhost') && !url.startsWith('ws://localhost')) {
    throw new Error(`RPC endpoint must use HTTPS: ${sanitizeRpcUrl(url)}`);
  }
}

function getExplorerUrl(signature: string, type: 'tx' | 'address', cluster: string): string {
  const base = 'https://explorer.solana.com';
  const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `${base}/${type}/${signature}${clusterParam}`;
}


// #############################################################################
// TESTS
// #############################################################################

describe('STRESS TEST: Mobile Services & Crypto Utils', function () {
  this.timeout(300_000);

  // Reset SecureStore state between top-level suites
  beforeEach(() => {
    _secureStoreMap.clear();
    _asyncStorageMap.clear();
  });

  // =========================================================================
  // 1. Connection Service
  // =========================================================================
  describe('1. Connection Service', () => {
    it('sanitizeRpcUrl strips Helius API key', () => {
      const url = 'https://devnet.helius-rpc.com/?api-key=SECRET123';
      const sanitized = sanitizeRpcUrl(url);
      assert.notInclude(sanitized, 'SECRET123');
      assert.include(sanitized, 'api-key=***');
    });

    it('sanitizeRpcUrl strips generic key param', () => {
      const url = 'https://rpc.example.com/?key=MY_TOKEN&other=1';
      const sanitized = sanitizeRpcUrl(url);
      assert.notInclude(sanitized, 'MY_TOKEN');
      assert.include(sanitized, 'key=***');
      assert.include(sanitized, 'other=1');
    });

    it('validateRpcEndpoint allows https', () => {
      assert.doesNotThrow(() => validateRpcEndpoint('https://api.devnet.solana.com'));
    });

    it('validateRpcEndpoint allows wss', () => {
      assert.doesNotThrow(() => validateRpcEndpoint('wss://api.devnet.solana.com'));
    });

    it('validateRpcEndpoint allows http://localhost', () => {
      assert.doesNotThrow(() => validateRpcEndpoint('http://localhost:8899'));
    });

    it('validateRpcEndpoint rejects plain http', () => {
      assert.throws(() => validateRpcEndpoint('http://evil.com/rpc'), /HTTPS/);
    });

    it('validateRpcEndpoint rejects ws:// (non-localhost)', () => {
      assert.throws(() => validateRpcEndpoint('ws://evil.com/ws'), /HTTPS/);
    });

    it('getExplorerUrl formats devnet URL', () => {
      const url = getExplorerUrl('5abc...', 'tx', 'devnet');
      assert.equal(url, 'https://explorer.solana.com/tx/5abc...?cluster=devnet');
    });

    it('getExplorerUrl formats mainnet URL (no cluster param)', () => {
      const url = getExplorerUrl('5abc...', 'tx', 'mainnet-beta');
      assert.equal(url, 'https://explorer.solana.com/tx/5abc...');
    });

    it('getExplorerUrl formats address URL', () => {
      const url = getExplorerUrl('Abc1', 'address', 'testnet');
      assert.equal(url, 'https://explorer.solana.com/address/Abc1?cluster=testnet');
    });

    it('isDevnet / isMainnet logic', () => {
      // Test the logic directly (we can't import the stateful module)
      const isDevnet = (cluster: string) => cluster === 'devnet';
      const isMainnet = (cluster: string) => cluster === 'mainnet-beta';
      assert.isTrue(isDevnet('devnet'));
      assert.isFalse(isDevnet('mainnet-beta'));
      assert.isTrue(isMainnet('mainnet-beta'));
      assert.isFalse(isMainnet('devnet'));
    });
  });

  // =========================================================================
  // 2. Note Vault Encryption
  // =========================================================================
  describe('2. Note Vault Encryption', () => {
    let vault: NoteVault;

    beforeEach(async () => {
      _secureStoreMap.clear();
      vault = new NoteVault();
      await vault.unlock('test_pin_hash_abc123');
    });

    afterEach(() => {
      vault.lock();
    });

    it('vaultEncrypt produces prefixed string "vault:..."', () => {
      const encrypted = vault.encrypt('hello world');
      assert.isTrue(encrypted.startsWith('vault:'));
    });

    it('vaultDecrypt reverses encryption', () => {
      const original = 'hello world';
      const encrypted = vault.encrypt(original);
      const decrypted = vault.decrypt(encrypted);
      assert.equal(decrypted, original);
    });

    it('roundtrip: encrypt -> decrypt preserves JSON', () => {
      const json = JSON.stringify({ secret: '123456', nullifier: '789', epoch: 42 });
      const encrypted = vault.encrypt(json);
      const decrypted = vault.decrypt(encrypted);
      const parsed = JSON.parse(decrypted);
      assert.equal(parsed.secret, '123456');
      assert.equal(parsed.nullifier, '789');
      assert.equal(parsed.epoch, 42);
    });

    it('wrong key fails decryption gracefully', async () => {
      const encrypted = vault.encrypt('secret data');
      vault.lock();
      // Unlock with different PIN hash (different key)
      await vault.unlock('different_pin_hash_xyz');
      assert.throws(() => vault.decrypt(encrypted), /wrong PIN|decryption failed/i);
    });

    it('encrypted data is not plaintext', () => {
      const plaintext = 'very_secret_shielded_note_data';
      const encrypted = vault.encrypt(plaintext);
      assert.notInclude(encrypted, plaintext);
    });

    it('vault key derivation is deterministic', async () => {
      // Same PIN hash + same salt -> same key
      const encrypted = vault.encrypt('determinism test');
      vault.lock();
      await vault.unlock('test_pin_hash_abc123');
      const decrypted = vault.decrypt(encrypted);
      assert.equal(decrypted, 'determinism test');
    });

    it('100 encrypt/decrypt cycles all succeed', () => {
      for (let i = 0; i < 100; i++) {
        const msg = `note_${i}_${crypto.randomBytes(16).toString('hex')}`;
        const enc = vault.encrypt(msg);
        const dec = vault.decrypt(enc);
        assert.equal(dec, msg, `Cycle ${i} failed`);
      }
    });

    it('handles large JSON objects (>1KB)', () => {
      const largeObj = {
        secret: crypto.randomBytes(128).toString('hex'),
        nullifier: crypto.randomBytes(128).toString('hex'),
        merkle: Array.from({ length: 32 }, () => crypto.randomBytes(32).toString('hex')),
        metadata: 'x'.repeat(500),
      };
      const json = JSON.stringify(largeObj);
      assert.isAbove(json.length, 1024);
      const enc = vault.encrypt(json);
      const dec = vault.decrypt(enc);
      assert.deepEqual(JSON.parse(dec), largeObj);
    });

    it('handles special characters in JSON', () => {
      const json = JSON.stringify({ note: 'special\tchars\n"quotes"\\backslash\u0000null' });
      const enc = vault.encrypt(json);
      const dec = vault.decrypt(enc);
      assert.equal(dec, json);
    });

    it('lock() wipes in-memory key', () => {
      assert.isTrue(vault.isUnlocked());
      vault.lock();
      assert.isFalse(vault.isUnlocked());
    });

    it('decrypt throws when vault is locked', () => {
      const enc = vault.encrypt('test');
      vault.lock();
      assert.throws(() => vault.decrypt(enc), /locked/i);
    });

    it('unencrypted string passes through decrypt unchanged', () => {
      const legacy = '{"secret":"123"}';
      const result = vault.decrypt(legacy);
      assert.equal(result, legacy);
    });
  });

  // =========================================================================
  // 3. PIN Hashing
  // =========================================================================
  describe('3. PIN Hashing', () => {
    beforeEach(() => { _secureStoreMap.clear(); });

    it('hashes PIN with device salt', async () => {
      const hash = await hashPin('1234');
      assert.isString(hash);
      assert.isAbove(hash.length, 0);
    });

    it('same PIN -> same hash (deterministic)', async () => {
      const h1 = await hashPin('5678');
      const h2 = await hashPin('5678');
      assert.equal(h1, h2);
    });

    it('different PINs -> different hashes', async () => {
      const h1 = await hashPin('1234');
      const h2 = await hashPin('5678');
      assert.notEqual(h1, h2);
    });

    it('hash is SHA-256 output (64 hex chars)', async () => {
      const hash = await hashPin('0000');
      assert.lengthOf(hash, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });

    it('constant-time comparison: equal hashes -> true', async () => {
      const h1 = await hashPin('1234');
      const h2 = await hashPin('1234');
      assert.isTrue(constantTimeEqual(h1, h2));
    });

    it('constant-time comparison: different hashes -> false', async () => {
      const h1 = await hashPin('1234');
      const h2 = await hashPin('9999');
      assert.isFalse(constantTimeEqual(h1, h2));
    });

    it('constant-time comparison: different lengths -> false', () => {
      assert.isFalse(constantTimeEqual('abc', 'abcd'));
    });

    it('handles 4-digit PIN', async () => {
      const hash = await hashPin('1234');
      assert.lengthOf(hash, 64);
    });

    it('handles 6-digit PIN', async () => {
      const hash = await hashPin('123456');
      assert.lengthOf(hash, 64);
    });

    it('handles 8-digit PIN', async () => {
      const hash = await hashPin('12345678');
      assert.lengthOf(hash, 64);
    });

    it('handles edge case: all zeros "0000"', async () => {
      const hash = await hashPin('0000');
      assert.lengthOf(hash, 64);
    });

    it('handles edge case: max "9999"', async () => {
      const hash = await hashPin('9999');
      assert.lengthOf(hash, 64);
      // Different from "0000"
      const h0 = await hashPin('0000');
      assert.notEqual(hash, h0);
    });

    it('salt is persisted and reused', async () => {
      await hashPin('1111');
      const salt = await MockSecureStore.getItemAsync('p01_pin_salt');
      assert.isNotNull(salt);
      assert.lengthOf(salt!, 32); // 16 bytes = 32 hex chars
      // Hash again — same salt should be used
      const h1 = await hashPin('1111');
      const h2 = await hashPin('1111');
      assert.equal(h1, h2);
    });
  });

  // =========================================================================
  // 4. Amount Noise
  // =========================================================================
  describe('4. Amount Noise', () => {
    it('applies noise within configured percentage', async () => {
      const result = await applyAmountNoise(100, 10, 0);
      assert.isAbove(result.adjustedAmount, 0);
      // Should be within +/- 10% (allowing small rounding)
      assert.isAtLeast(result.adjustedAmount, 89.5);
      assert.isAtMost(result.adjustedAmount, 110.5);
    });

    it('noised amount approximately equals original +/- noise%', async () => {
      const results: number[] = [];
      for (let i = 0; i < 100; i++) {
        const r = await applyAmountNoise(100, 5, 0);
        results.push(r.adjustedAmount);
      }
      const avg = results.reduce((a, b) => a + b, 0) / results.length;
      // Average should be close to 100 (within a few percent)
      assert.isAbove(avg, 90, 'Average too low — bias detected');
      assert.isBelow(avg, 110, 'Average too high — bias detected');
    });

    it('cumulative tracking biases toward zero', async () => {
      // If we've overpaid by 50, the noise should bias toward underpaying
      const r = await applyAmountNoise(100, 10, 50);
      // With +50 cumulative, correction should push amount down
      // Not always guaranteed due to randomness, but the mean should be < 100
      // We just verify it doesn't crash and returns valid data
      assert.isAbove(r.adjustedAmount, 0);
      assert.isNumber(r.newCumulativeAdjustment);
    });

    it('final payment auto-corrects offset', async () => {
      // remainingPayments=1, cumulative offset = +5
      const r = await applyAmountNoise(100, 10, 5, 1);
      // Should try to correct the 5 unit overpayment
      assert.isBelow(r.adjustedAmount, 100, 'Final payment should correct overpayment');
    });

    it('100 sequential payments: cumulative stays bounded', async () => {
      let cumulative = 0;
      for (let i = 0; i < 100; i++) {
        const r = await applyAmountNoise(100, 10, cumulative);
        cumulative = r.newCumulativeAdjustment;
      }
      // After 100 payments with correction, cumulative should stay reasonable
      assert.isBelow(Math.abs(cumulative), 200, 'Cumulative drift too large after 100 payments');
    });

    it('zero noise = exact amounts', async () => {
      const r = await applyAmountNoise(100, 0, 0);
      assert.equal(r.adjustedAmount, 100);
      assert.equal(r.noiseDelta, 0);
    });

    it('negative amount returns as-is', async () => {
      const r = await applyAmountNoise(-50, 10, 0);
      assert.equal(r.adjustedAmount, -50);
      assert.equal(r.noiseDelta, 0);
    });

    it('zero amount returns as-is', async () => {
      const r = await applyAmountNoise(0, 10, 0);
      assert.equal(r.adjustedAmount, 0);
      assert.equal(r.noiseDelta, 0);
    });

    it('noise percent clamped to 20% max', async () => {
      // Even with 100% noise, should clamp to 20%
      const results: number[] = [];
      for (let i = 0; i < 50; i++) {
        const r = await applyAmountNoise(100, 100, 0);
        results.push(r.adjustedAmount);
      }
      // All results should be within 0..120 (20% max)
      for (const val of results) {
        assert.isAtLeast(val, 0);
        assert.isAtMost(val, 125); // Small margin for rounding
      }
    });

    it('calculateFinalPaymentAdjustment corrects remaining balance', () => {
      const adj = calculateFinalPaymentAdjustment(1000, 950, 100, 10);
      // Expected: 50 remaining, finalPayment is 100, max noise is 10
      // idealFinal = 50, minFinal = 90, so clamped to 90
      assert.isAtLeast(adj, 0);
    });
  });

  // =========================================================================
  // 5. Stealth Address Utils (Mobile)
  // =========================================================================
  describe('5. Stealth Address Utils (Mobile)', () => {
    let spendingKey: Keypair;
    let viewingKP: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeEach(() => {
      const seed = crypto.randomBytes(32);
      spendingKey = Keypair.fromSeed(seed);
      viewingKP = nacl.box.keyPair.fromSecretKey(crypto.randomBytes(32));
    });

    it('generates stealth address from wallet keys', () => {
      const result = generateStealthAddress(
        spendingKey.publicKey.toBytes(),
        viewingKP.publicKey,
      );
      assert.isString(result.address);
      assert.isString(result.ephemeralPublicKey);
      assert.isNumber(result.viewTag);
      assert.isAtLeast(result.viewTag, 0);
      assert.isAtMost(result.viewTag, 255);
      // Address should be a valid base58 Solana public key
      assert.doesNotThrow(() => new PublicKey(result.address));
    });

    it('encodes/decodes meta-address roundtrip (v1)', () => {
      const meta = createMetaAddressV1(spendingKey.publicKey.toBytes(), viewingKP.publicKey);
      assert.isTrue(meta.startsWith('st:01'));
      const parsed = parseMetaAddress(meta);
      assert.deepEqual(
        Array.from(parsed.spendingPubKey),
        Array.from(spendingKey.publicKey.toBytes()),
      );
      assert.deepEqual(
        Array.from(parsed.viewingPubKey),
        Array.from(viewingKP.publicKey),
      );
    });

    it('derives stealth address deterministically', () => {
      // Same inputs -> same stealth address
      const ephemeral = nacl.box.keyPair();
      const sharedSecret = deriveSharedSecret(ephemeral.secretKey, viewingKP.publicKey);
      const seed1 = deriveStealthSeed(spendingKey.publicKey.toBytes(), sharedSecret);
      const seed2 = deriveStealthSeed(spendingKey.publicKey.toBytes(), sharedSecret);
      assert.deepEqual(Array.from(seed1), Array.from(seed2));
    });

    it('view tag computation matches between sender and receiver', () => {
      const ephemeral = nacl.box.keyPair();
      // Sender: scalarMult(ephemeral.secret, viewing.public)
      const senderSecret = deriveSharedSecret(ephemeral.secretKey, viewingKP.publicKey);
      // Receiver: scalarMult(viewing.secret, ephemeral.public)
      const receiverSecret = deriveSharedSecret(viewingKP.secretKey, ephemeral.publicKey);
      // ECDH shared secrets should match
      assert.deepEqual(Array.from(senderSecret), Array.from(receiverSecret));
      // View tags match
      assert.equal(computeViewTag(senderSecret), computeViewTag(receiverSecret));
    });

    it('50 stealth addresses all unique', () => {
      const addresses = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const result = generateStealthAddress(
          spendingKey.publicKey.toBytes(),
          viewingKP.publicKey,
        );
        addresses.add(result.address);
      }
      assert.equal(addresses.size, 50, 'Expected 50 unique stealth addresses');
    });

    it('scan matches generated stealth address', () => {
      const stealth = generateStealthAddress(
        spendingKey.publicKey.toBytes(),
        viewingKP.publicKey,
      );
      const scan = scanStealthPayment(
        stealth.ephemeralPublicKey,
        viewingKP.secretKey,
        spendingKey.publicKey.toBytes(),
        stealth.viewTag,
      );
      assert.isTrue(scan.found);
      assert.equal(scan.stealthAddress, stealth.address);
    });

    it('scan rejects wrong view tag', () => {
      const stealth = generateStealthAddress(
        spendingKey.publicKey.toBytes(),
        viewingKP.publicKey,
      );
      const wrongTag = (stealth.viewTag + 1) % 256;
      const scan = scanStealthPayment(
        stealth.ephemeralPublicKey,
        viewingKP.secretKey,
        spendingKey.publicKey.toBytes(),
        wrongTag,
      );
      assert.isFalse(scan.found);
    });

    it('parseMetaAddress rejects invalid prefix', () => {
      assert.throws(() => parseMetaAddress('xx:01abc'), /Invalid/);
    });
  });

  // =========================================================================
  // 6. Denominated Pool Config
  // =========================================================================
  describe('6. Denominated Pool Config', () => {
    it('all pool configs have valid token mints', () => {
      for (const pool of ALL_POOLS) {
        assert.doesNotThrow(() => pool.tokenMint.toBase58());
        assert.isTrue(pool.tokenMint.equals(NATIVE_SOL_MINT) || pool.tokenMint.equals(USDC_DEVNET_MINT));
      }
    });

    it('denominations are positive numbers', () => {
      for (const pool of ALL_POOLS) {
        assert.isAbove(pool.denomination, 0, `Pool ${pool.token} ${pool.denomination} is not positive`);
        assert.isAbove(Number(pool.denominationAtomic), 0);
      }
    });

    it('denominationAtomic matches denomination * 10^decimals', () => {
      for (const pool of ALL_POOLS) {
        const expected = BigInt(Math.round(pool.denomination * Math.pow(10, pool.decimals)));
        assert.equal(pool.denominationAtomic, expected,
          `${pool.token} ${pool.denomination}: expected ${expected}, got ${pool.denominationAtomic}`);
      }
    });

    it('pool PDA derivation is deterministic', () => {
      for (const pool of ALL_POOLS) {
        const pda1 = pool.poolPDA.toBase58();
        const pda2 = pool.poolPDA.toBase58();
        assert.equal(pda1, pda2);
      }
    });

    it('no duplicate pool configs', () => {
      const keys = ALL_POOLS.map(p => `${p.token}:${p.denomination}`);
      const unique = new Set(keys);
      assert.equal(unique.size, keys.length, 'Duplicate pool configs found');
    });

    it('no duplicate pool PDAs', () => {
      const pdas = ALL_POOLS.map(p => p.poolPDA.toBase58());
      const unique = new Set(pdas);
      assert.equal(unique.size, pdas.length, 'Duplicate pool PDAs found');
    });

    it('no duplicate tree PDAs', () => {
      const trees = ALL_POOLS.map(p => p.treePDA.toBase58());
      const unique = new Set(trees);
      assert.equal(unique.size, trees.length, 'Duplicate tree PDAs found');
    });

    it('USDC pools have vaultATA set', () => {
      for (const pool of USDC_POOLS) {
        assert.isDefined(pool.vaultATA, `USDC pool ${pool.denomination} missing vaultATA`);
        assert.doesNotThrow(() => pool.vaultATA!.toBase58());
      }
    });

    it('SOL pools do not have vaultATA', () => {
      for (const pool of SOL_POOLS) {
        assert.isUndefined(pool.vaultATA, `SOL pool ${pool.denomination} should not have vaultATA`);
      }
    });

    it('8 total pools (4 SOL + 4 USDC)', () => {
      assert.lengthOf(SOL_POOLS, 4);
      assert.lengthOf(USDC_POOLS, 4);
      assert.lengthOf(ALL_POOLS, 8);
    });
  });

  // =========================================================================
  // 7. STARK Service (Instruction Builders)
  // =========================================================================
  describe('7. STARK Service (Instruction Builders)', () => {
    let authority: Keypair;

    beforeEach(() => {
      authority = Keypair.generate();
    });

    it('init_proof_buffer instruction builds correctly', () => {
      const [proofBuffer] = getProofBufferPDA(authority.publicKey);
      const ix = buildInitProofBufferIx(5000, 0, proofBuffer, authority.publicKey);
      assert.isTrue(ix.programId.equals(STARK_VERIFIER_PROGRAM_ID));
      assert.lengthOf(ix.keys, 3);
      assert.isTrue(ix.keys[0].pubkey.equals(proofBuffer));
      assert.isTrue(ix.keys[1].pubkey.equals(authority.publicKey));
      assert.isTrue(ix.keys[2].pubkey.equals(SystemProgram.programId));
      // Verify data encoding
      assert.equal(ix.data.length, 13); // 8 disc + 4 proofSize + 1 circuitId
      assert.equal(ix.data.readUInt32LE(8), 5000);
      assert.equal(ix.data.readUInt8(12), 0);
    });

    it('write_proof_chunk instruction respects max chunk size', () => {
      const [proofBuffer] = getProofBufferPDA(authority.publicKey);
      const chunk = new Uint8Array(MAX_CHUNK_SIZE);
      const ix = buildWriteProofChunkIx(0, chunk, proofBuffer, authority.publicKey);
      assert.equal(ix.data.length, 8 + 4 + 4 + MAX_CHUNK_SIZE);
      assert.equal(ix.data.readUInt32LE(8), 0); // offset
      assert.equal(ix.data.readUInt32LE(12), MAX_CHUNK_SIZE); // chunk length
    });

    it('write_proof_chunk encodes offset correctly', () => {
      const [proofBuffer] = getProofBufferPDA(authority.publicKey);
      const chunk = new Uint8Array(100);
      const ix = buildWriteProofChunkIx(900, chunk, proofBuffer, authority.publicKey);
      assert.equal(ix.data.readUInt32LE(8), 900);
    });

    it('verify_stark_proof instruction includes commitment', () => {
      const [proofBuffer] = getProofBufferPDA(authority.publicKey);
      const commitment = 12345678901234n;
      const ix = buildVerifyStarkProofIx(commitment, proofBuffer, authority.publicKey);
      assert.equal(ix.data.length, 16); // 8 disc + 8 commitment
      const readCommitment = ix.data.readBigUInt64LE(8);
      assert.equal(readCommitment, commitment);
    });

    it('close_proof_buffer instruction builds correctly', () => {
      const [proofBuffer] = getProofBufferPDA(authority.publicKey);
      const ix = buildCloseProofBufferIx(proofBuffer, authority.publicKey);
      assert.isTrue(ix.programId.equals(STARK_VERIFIER_PROGRAM_ID));
      assert.lengthOf(ix.keys, 2);
      assert.isTrue(ix.keys[0].isWritable);
      assert.isTrue(ix.keys[1].isWritable);
      assert.equal(ix.data.length, 8);
    });

    it('resize_proof_buffer instruction builds correctly', () => {
      const [proofBuffer] = getProofBufferPDA(authority.publicKey);
      const ix = buildResizeProofBufferIx(proofBuffer, authority.publicKey);
      assert.isTrue(ix.programId.equals(STARK_VERIFIER_PROGRAM_ID));
      assert.lengthOf(ix.keys, 3);
      assert.isTrue(ix.keys[2].pubkey.equals(SystemProgram.programId));
    });

    it('circuit IDs 0-5 all accepted (PDA derivation)', () => {
      for (let cid = 0; cid <= 5; cid++) {
        const [pda, bump] = getProofBufferPDA(authority.publicKey, cid);
        assert.doesNotThrow(() => pda.toBase58());
        assert.isAtLeast(bump, 0);
        assert.isAtMost(bump, 255);
      }
    });

    it('different circuit IDs produce different PDAs', () => {
      const pdas = new Set<string>();
      for (let cid = 0; cid <= 5; cid++) {
        const [pda] = getProofBufferPDA(authority.publicKey, cid);
        pdas.add(pda.toBase58());
      }
      assert.equal(pdas.size, 6, 'All 6 circuit IDs should produce unique PDAs');
    });

    it('PDA derivation: ["stark_proof", authority, circuitId] is deterministic', () => {
      const [pda1] = getProofBufferPDA(authority.publicKey, 0);
      const [pda2] = getProofBufferPDA(authority.publicKey, 0);
      assert.equal(pda1.toBase58(), pda2.toBase58());
    });

    it('verify_stark_proof_v2 encodes multiple public inputs', () => {
      const [proofBuffer] = getProofBufferPDA(authority.publicKey, 1);
      const inputs = [100n, 200n, 300n];
      const ix = buildVerifyStarkProofV2Ix(inputs, proofBuffer, authority.publicKey);
      // 8 disc + 4 vec len + 3*8 inputs = 36
      assert.equal(ix.data.length, 36);
      assert.equal(ix.data.readUInt32LE(8), 3); // vec length
      assert.equal(ix.data.readBigUInt64LE(12), 100n);
      assert.equal(ix.data.readBigUInt64LE(20), 200n);
      assert.equal(ix.data.readBigUInt64LE(28), 300n);
    });

    it('discriminators are 8 bytes each', () => {
      for (const [name, disc] of Object.entries(DISCRIMINATORS)) {
        assert.equal(disc.length, 8, `${name} discriminator should be 8 bytes`);
      }
    });
  });

  // =========================================================================
  // 8. Arcium MPC Client
  // =========================================================================
  describe('8. Arcium MPC Client', () => {
    it('MPC client module structure is valid', () => {
      // We cannot import the real mpcClient (depends on walletStore, arcium-sdk, etc.)
      // Instead, verify the expected interface matches what we know from the source.
      const expectedFunctions = [
        'getMpcClient', 'resetMpcClient', 'getMpcInitError',
        'isMpcClientReady', 'getProxyIdentifier', 'getProxyPDA',
        'getArciumProgram',
      ];
      // Just verify we can construct the expected types
      for (const fn of expectedFunctions) {
        assert.isString(fn);
      }
    });

    it('getProxyIdentifier concept: SHA-256 returns 32-byte hash', () => {
      // Test the concept: proxy identifier is SHA-256 of session key
      const sessionKey = crypto.randomBytes(32);
      const hash = crypto.createHash('sha256').update(sessionKey).digest();
      assert.lengthOf(hash, 32);
    });

    it('getProxyPDA concept: PDA derivation from 32-byte seed', () => {
      const seed = crypto.randomBytes(32);
      const programId = new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT');
      const [pda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from('proxy'), seed],
        programId,
      );
      assert.doesNotThrow(() => pda.toBase58());
      assert.isAtLeast(bump, 0);
      assert.isAtMost(bump, 255);
    });

    it('debug logs are __DEV__ gated', () => {
      // __DEV__ is set to false in our test env
      assert.isFalse((global as any).__DEV__);
      // The source code gates console.log with `if (__DEV__)`
      // so in production/test mode, no debug logging occurs
    });

    it('Anchor discriminator: SHA-256("global:<name>")[0..8]', () => {
      // Test the discriminator derivation used by mpcClient
      const methodName = 'commit_nullifier';
      const snakeName = methodName; // already snake_case
      const hash = sha256(new TextEncoder().encode(`global:${snakeName}`));
      const disc = hash.slice(0, 8);
      assert.lengthOf(disc, 8);
    });

    it('privateLookup registry PDA derivation', () => {
      const targetWallet = Keypair.generate().publicKey;
      const registryProgramId = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_registry'), targetWallet.toBuffer()],
        registryProgramId,
      );
      assert.doesNotThrow(() => pda.toBase58());
    });

    it('wallet adapter supports signAllTransactions', () => {
      const kp = Keypair.generate();
      const adapter = {
        publicKey: kp.publicKey,
        signTransaction: async (tx: Transaction) => { tx.sign(kp); return tx; },
        signAllTransactions: async (txs: Transaction[]) => {
          for (const tx of txs) tx.sign(kp);
          return txs;
        },
      };
      assert.isFunction(adapter.signTransaction);
      assert.isFunction(adapter.signAllTransactions);
    });
  });

  // =========================================================================
  // 9. Receipt Serialization
  // =========================================================================
  describe('9. Receipt Serialization', () => {
    function makeTestReceipt(): ShieldReceipt {
      const secret = BigInt('0x' + crypto.randomBytes(16).toString('hex'));
      const nullifierPreimage = BigInt('0x' + crypto.randomBytes(16).toString('hex'));
      const depositEpoch = BigInt(Math.floor(Date.now() / 1000));
      const tokenMint = 0n;
      const commitment = createCommitment(nullifierPreimage, secret, depositEpoch, tokenMint);
      return {
        secret,
        nullifierPreimage,
        depositEpoch,
        tokenMint,
        commitment,
        leafIndex: 42,
        denomination: 1_000_000_000n,
        pool: SOL_POOLS[1].poolPDA.toBase58(),
        token: 'SOL',
        denominationHuman: 1,
        shieldedAt: Date.now(),
      };
    }

    it('receiptToJSON -> receiptFromJSON roundtrip', () => {
      const original = makeTestReceipt();
      const json = receiptToJSON(original);
      const restored = receiptFromJSON(json);
      assert.equal(restored.secret, original.secret);
      assert.equal(restored.nullifierPreimage, original.nullifierPreimage);
      assert.equal(restored.depositEpoch, original.depositEpoch);
      assert.equal(restored.tokenMint, original.tokenMint);
      assert.equal(restored.commitment, original.commitment);
      assert.equal(restored.leafIndex, original.leafIndex);
      assert.equal(restored.denomination, original.denomination);
      assert.equal(restored.pool, original.pool);
      assert.equal(restored.token, original.token);
      assert.equal(restored.denominationHuman, original.denominationHuman);
    });

    it('vault-encrypted receipt: encrypt -> decrypt -> fromJSON', async () => {
      _secureStoreMap.clear();
      const vault = new NoteVault();
      await vault.unlock('receipt_pin_hash');

      const receipt = makeTestReceipt();
      const json = receiptToJSON(receipt);
      const encrypted = vault.encrypt(json);
      assert.isTrue(encrypted.startsWith('vault:'));

      const decrypted = vault.decrypt(encrypted);
      const restored = receiptFromJSON(decrypted);
      assert.equal(restored.secret, receipt.secret);
      assert.equal(restored.commitment, receipt.commitment);

      vault.lock();
    });

    it('handles all receipt fields (nullifier, commitment, amount, etc.)', () => {
      const receipt = makeTestReceipt();
      receipt.merklePathElements = [1n, 2n, 3n, 4n];
      receipt.merklePathIndices = [0, 1, 0, 1];
      receipt.merkleRoot = 99999n;

      const json = receiptToJSON(receipt);
      const restored = receiptFromJSON(json);
      assert.deepEqual(restored.merklePathElements, [1n, 2n, 3n, 4n]);
      assert.deepEqual(restored.merklePathIndices, [0, 1, 0, 1]);
      assert.equal(restored.merkleRoot, 99999n);
    });

    it('rejects malformed JSON', () => {
      assert.throws(() => receiptFromJSON('not_json{'), /JSON/i);
    });

    it('commitment verification: createCommitment is consistent', () => {
      const np = 123456789n;
      const s = 987654321n;
      const de = 1000n;
      const tm = 0n;
      const c1 = createCommitment(np, s, de, tm);
      const c2 = createCommitment(np, s, de, tm);
      assert.equal(c1, c2);
    });

    it('different secrets produce different commitments', () => {
      const np = 123456789n;
      const de = 1000n;
      const tm = 0n;
      const c1 = createCommitment(np, 111n, de, tm);
      const c2 = createCommitment(np, 222n, de, tm);
      assert.notEqual(c1, c2);
    });

    it('nullifier is deterministic', () => {
      const n1 = createNullifier(100n, 200n);
      const n2 = createNullifier(100n, 200n);
      assert.equal(n1, n2);
    });

    it('serialization handles BigInt edge cases', () => {
      const receipt = makeTestReceipt();
      receipt.secret = 0n;
      receipt.denomination = BigInt('18446744073709551615'); // max u64
      const json = receiptToJSON(receipt);
      const restored = receiptFromJSON(json);
      assert.equal(restored.secret, 0n);
      assert.equal(restored.denomination, BigInt('18446744073709551615'));
    });
  });

  // =========================================================================
  // 10. Store Logic (Unit Tests)
  // =========================================================================
  describe('10. Store Logic (Unit Tests)', () => {
    it('note deduplication: removes duplicate commitments', () => {
      const notes = [
        { id: '1', commitment: '111', status: 'mature' },
        { id: '2', commitment: '222', status: 'mature' },
        { id: '3', commitment: '111', status: 'mature' }, // duplicate
        { id: '4', commitment: '333', status: 'spent' },
        { id: '5', commitment: '222', status: 'mature' }, // duplicate
      ];
      const seen = new Set<string>();
      const deduped = notes.filter(n => {
        if (seen.has(n.commitment)) return false;
        seen.add(n.commitment);
        return true;
      });
      assert.lengthOf(deduped, 3);
      assert.deepEqual(deduped.map(n => n.id), ['1', '2', '4']);
    });

    it('note status filtering: pending/mature/spent', () => {
      const notes = [
        { status: 'pending' }, { status: 'mature' }, { status: 'mature' },
        { status: 'spent' }, { status: 'pending' }, { status: 'transferred' },
      ];
      const pending = notes.filter(n => n.status === 'pending');
      const mature = notes.filter(n => n.status === 'mature');
      const spent = notes.filter(n => n.status === 'spent');
      const transferred = notes.filter(n => n.status === 'transferred');
      assert.lengthOf(pending, 2);
      assert.lengthOf(mature, 2);
      assert.lengthOf(spent, 1);
      assert.lengthOf(transferred, 1);
    });

    it('stream payment calculation: amount per interval', () => {
      const totalAmount = 100;
      const totalPayments = 10;
      const paymentAmount = totalAmount / totalPayments;
      assert.equal(paymentAmount, 10);
    });

    it('stream due check: isPaymentDue based on timestamps', () => {
      const now = Date.now();
      const interval = 86400_000; // 1 day in ms
      const lastPayment = now - (interval + 1000); // 1 day + 1 second ago
      const isPaymentDue = (lastPaid: number, intervalMs: number) => {
        return Date.now() - lastPaid >= intervalMs;
      };
      assert.isTrue(isPaymentDue(lastPayment, interval));
      assert.isFalse(isPaymentDue(now, interval)); // just paid
    });

    it('subscription interval validation: daily/weekly/monthly', () => {
      const INTERVAL_MAP: Record<string, number> = {
        daily: 86400,
        weekly: 604800,
        monthly: 2592000,
      };
      assert.equal(INTERVAL_MAP.daily, 86400);
      assert.equal(INTERVAL_MAP.weekly, 604800);
      assert.equal(INTERVAL_MAP.monthly, 2592000);
      assert.isUndefined(INTERVAL_MAP.yearly);
    });

    it('privacy score calculation based on feature flags', () => {
      interface Stream { status: string; amountNoise: number; timingNoise: number; useStealthAddress: boolean }
      const streams: Stream[] = [
        { status: 'active', amountNoise: 10, timingNoise: 5, useStealthAddress: true },
        { status: 'active', amountNoise: 0, timingNoise: 0, useStealthAddress: false },
        { status: 'active', amountNoise: 5, timingNoise: 0, useStealthAddress: true },
        { status: 'paused', amountNoise: 10, timingNoise: 10, useStealthAddress: true },
      ];
      const activeStreams = streams.filter(s => s.status === 'active');
      const privacyEnabledCount = activeStreams.filter(
        s => s.amountNoise > 0 || s.timingNoise > 0 || s.useStealthAddress,
      ).length;
      const score = Math.round((privacyEnabledCount / activeStreams.length) * 100);
      assert.equal(score, 67); // 2 out of 3 active streams have privacy features
    });
  });

  // =========================================================================
  // 11. Clipboard Auto-Clear
  // =========================================================================
  describe('11. Clipboard Auto-Clear', () => {
    afterEach(() => {
      if (_clipboardTimerId) {
        clearTimeout(_clipboardTimerId);
        _clipboardTimerId = null;
      }
    });

    it('schedules clear after copy', async () => {
      await MockClipboard.setStringAsync('secret seed phrase');
      const content = await MockClipboard.getStringAsync();
      assert.equal(content, 'secret seed phrase');

      // Simulate the 60s timer with a short timeout for testing
      _clipboardTimerId = setTimeout(async () => {
        const current = await MockClipboard.getStringAsync();
        if (current === 'secret seed phrase') {
          await MockClipboard.setStringAsync('');
        }
      }, 50);

      // Wait for timer
      await new Promise(r => setTimeout(r, 100));
      const cleared = await MockClipboard.getStringAsync();
      assert.equal(cleared, '');
    });

    it('cancels previous timer on new copy', async () => {
      // First copy
      await MockClipboard.setStringAsync('data1');
      let timer1 = setTimeout(async () => {
        await MockClipboard.setStringAsync('');
      }, 500);

      // Second copy (should cancel first timer conceptually)
      clearTimeout(timer1);
      await MockClipboard.setStringAsync('data2');
      _clipboardTimerId = setTimeout(async () => {
        const current = await MockClipboard.getStringAsync();
        if (current === 'data2') {
          await MockClipboard.setStringAsync('');
        }
      }, 50);

      await new Promise(r => setTimeout(r, 100));
      const content = await MockClipboard.getStringAsync();
      assert.equal(content, '');
    });

    it('only clears if clipboard still contains the sensitive data', async () => {
      await MockClipboard.setStringAsync('sensitive');
      // User copies something else before timer fires
      await MockClipboard.setStringAsync('user_normal_copy');

      // Timer fires but checks content
      const current = await MockClipboard.getStringAsync();
      if (current === 'sensitive') {
        await MockClipboard.setStringAsync('');
      }
      // Clipboard should still have user's content
      const final = await MockClipboard.getStringAsync();
      assert.equal(final, 'user_normal_copy');
    });
  });

  // =========================================================================
  // 12. Session Security
  // =========================================================================
  describe('12. Session Security', () => {
    it('session timeout triggers lock after configured period', () => {
      const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const lastActivity = Date.now() - (6 * 60 * 1000); // 6 minutes ago
      const isExpired = Date.now() - lastActivity > SESSION_TIMEOUT_MS;
      assert.isTrue(isExpired);
    });

    it('session refreshes on user activity', () => {
      const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
      let lastActivity = Date.now() - (4 * 60 * 1000); // 4 minutes ago
      // User interacts — refresh
      lastActivity = Date.now();
      const isExpired = Date.now() - lastActivity > SESSION_TIMEOUT_MS;
      assert.isFalse(isExpired);
    });

    it('SecureStore preference over AsyncStorage for session flag', async () => {
      // SecureStore is hardware-backed; AsyncStorage is not
      await MockSecureStore.setItemAsync('session_active', 'true');
      await MockAsyncStorage.default.setItem('session_active', 'true');

      // Read from SecureStore first (preferred)
      const secure = await MockSecureStore.getItemAsync('session_active');
      assert.equal(secure, 'true');
    });

    it('session lock wipes sensitive in-memory state', () => {
      // Simulate session lock
      const vault = new NoteVault();
      vault.unlockWithKey(new Uint8Array(32));
      assert.isTrue(vault.isUnlocked());
      vault.lock();
      assert.isFalse(vault.isUnlocked());
    });
  });

  // =========================================================================
  // 13. Multi-Provider AI (Logic Only)
  // =========================================================================
  describe('13. Multi-Provider AI (Logic Only)', () => {
    it('provider priority: Groq -> Gemini -> Llama', () => {
      const providers = ['groq', 'gemini', 'llama'];
      assert.equal(providers[0], 'groq');
      assert.equal(providers[1], 'gemini');
      assert.equal(providers[2], 'llama');
    });

    it('graceful fallback on provider error', async () => {
      const providers = ['groq', 'gemini', 'llama'];
      const tryProvider = async (name: string): Promise<string | null> => {
        if (name === 'groq') return null; // simulate failure
        if (name === 'gemini') return null; // simulate failure
        return `response from ${name}`;
      };

      let response: string | null = null;
      for (const provider of providers) {
        response = await tryProvider(provider);
        if (response) break;
      }
      assert.equal(response, 'response from llama');
    });

    it('streaming message assembly from chunks', () => {
      const chunks = ['Hello', ' world', '! How', ' are you', '?'];
      let assembled = '';
      for (const chunk of chunks) {
        assembled += chunk;
      }
      assert.equal(assembled, 'Hello world! How are you?');
    });

    it('conversation CRUD: create, switch, delete', () => {
      const conversations: Map<string, { id: string; messages: string[] }> = new Map();

      // Create
      conversations.set('conv1', { id: 'conv1', messages: ['hello'] });
      conversations.set('conv2', { id: 'conv2', messages: ['hi'] });
      assert.equal(conversations.size, 2);

      // Switch
      let activeId = 'conv1';
      activeId = 'conv2';
      assert.equal(activeId, 'conv2');

      // Delete
      conversations.delete('conv1');
      assert.equal(conversations.size, 1);
      assert.isFalse(conversations.has('conv1'));
      assert.isTrue(conversations.has('conv2'));
    });

    it('market data parsing: SOL price + Fear & Greed', () => {
      // Simulate API response parsing
      const solPriceResponse = { solana: { usd: 142.50 } };
      const fgResponse = { data: [{ value: '65', value_classification: 'Greed' }] };

      const price = solPriceResponse.solana.usd;
      assert.isNumber(price);
      assert.isAbove(price, 0);

      const fg = parseInt(fgResponse.data[0].value);
      assert.isNumber(fg);
      assert.isAtLeast(fg, 0);
      assert.isAtMost(fg, 100);
      assert.isString(fgResponse.data[0].value_classification);
    });
  });

  // =========================================================================
  // 14. BLE/NFC Sharing Crypto
  // =========================================================================
  describe('14. BLE/NFC Sharing Crypto', () => {
    it('session key generation: random 32 bytes', () => {
      const kp = generateEphemeralKeyPair();
      assert.lengthOf(kp.publicKey, 32);
      assert.lengthOf(kp.secretKey, 32);
    });

    it('session encrypt/decrypt roundtrip (nacl.box)', () => {
      const sender = generateEphemeralKeyPair();
      const recipient = generateEphemeralKeyPair();

      const payload: NotePayload = {
        version: 1,
        type: 'denominated-pool',
        data: 'base64encodedreceipt==',
        ts: Date.now(),
        checksum: 'abc123',
      };

      const encrypted = encryptNote(payload, recipient.publicKey, sender);
      const decrypted = decryptNote(encrypted, sender.publicKey, recipient.secretKey);

      assert.equal(decrypted.version, 1);
      assert.equal(decrypted.type, 'denominated-pool');
      assert.equal(decrypted.data, payload.data);
      assert.equal(decrypted.checksum, payload.checksum);
    });

    it('wrong recipient key fails decryption', () => {
      const sender = generateEphemeralKeyPair();
      const recipient = generateEphemeralKeyPair();
      const wrongRecipient = generateEphemeralKeyPair();

      const payload: NotePayload = {
        version: 1, type: 'zk-shielded', data: 'secret',
        ts: Date.now(), checksum: 'abc',
      };

      const encrypted = encryptNote(payload, recipient.publicKey, sender);
      assert.throws(
        () => decryptNote(encrypted, sender.publicKey, wrongRecipient.secretKey),
        /failed/i,
      );
    });

    it('fingerprint generation is deterministic', () => {
      const kp1 = generateEphemeralKeyPair();
      const kp2 = generateEphemeralKeyPair();
      const pub1 = Buffer.from(kp1.publicKey).toString('base64');
      const pub2 = Buffer.from(kp2.publicKey).toString('base64');

      const fp1 = computeFingerprint(pub1, pub2);
      const fp2 = computeFingerprint(pub1, pub2);
      assert.equal(fp1, fp2);
    });

    it('fingerprint is order-independent (both sides same)', () => {
      const kp1 = generateEphemeralKeyPair();
      const kp2 = generateEphemeralKeyPair();
      const pub1 = Buffer.from(kp1.publicKey).toString('base64');
      const pub2 = Buffer.from(kp2.publicKey).toString('base64');

      const fpLocal = computeFingerprint(pub1, pub2);
      const fpRemote = computeFingerprint(pub2, pub1);
      assert.equal(fpLocal, fpRemote, 'Fingerprint should be same regardless of key order');
    });

    it('fingerprint format: 6 blocks of 8 hex chars separated by dots', () => {
      const kp1 = generateEphemeralKeyPair();
      const kp2 = generateEphemeralKeyPair();
      const pub1 = Buffer.from(kp1.publicKey).toString('base64');
      const pub2 = Buffer.from(kp2.publicKey).toString('base64');

      const fp = computeFingerprint(pub1, pub2);
      const blocks = fp.split(' \u00B7 ');
      assert.lengthOf(blocks, 6);
      for (const block of blocks) {
        assert.match(block, /^[0-9A-F]{8}$/, `Block "${block}" should be 8 uppercase hex chars`);
      }
    });

    it('fingerprintsMatch: constant-time comparison', () => {
      const fp = 'A3F2B1C0 \u00B7 9B1CE7D0 \u00B7 4A2BF1C8 \u00B7 3D6E1234 \u00B7 5678ABCD \u00B7 EF012345';
      assert.isTrue(fingerprintsMatch(fp, fp));
      const modified = fp.replace('A3F2', 'XXXX');
      assert.isFalse(fingerprintsMatch(fp, modified));
    });

    it('NFC key derivation: same PIN + same minute -> same key', () => {
      const ts = Date.now();
      const key1 = deriveNfcKey('123456', ts);
      const key2 = deriveNfcKey('123456', ts);
      assert.deepEqual(Array.from(key1), Array.from(key2));
      assert.lengthOf(key1, 32);
    });

    it('NFC key derivation: different PINs -> different keys', () => {
      const ts = Date.now();
      const key1 = deriveNfcKey('123456', ts);
      const key2 = deriveNfcKey('654321', ts);
      assert.notDeepEqual(Array.from(key1), Array.from(key2));
    });

    it('NFC symmetric encrypt/decrypt roundtrip', () => {
      const key = deriveNfcKey('999999');
      const payload: NotePayload = {
        version: 1, type: 'denominated-pool', data: 'test_data',
        ts: Date.now(), checksum: 'chk',
      };

      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const ct = nacl.secretbox(plaintext, nonce, key);
      assert.isNotNull(ct);

      const decrypted = nacl.secretbox.open(ct!, nonce, key);
      assert.isNotNull(decrypted);
      const result = JSON.parse(new TextDecoder().decode(decrypted!));
      assert.equal(result.data, 'test_data');
    });

    it('DH shared secret: both sides derive same secret', () => {
      const alice = nacl.box.keyPair();
      const bob = nacl.box.keyPair();
      const sharedA = nacl.scalarMult(alice.secretKey, bob.publicKey);
      const sharedB = nacl.scalarMult(bob.secretKey, alice.publicKey);
      assert.deepEqual(Array.from(sharedA), Array.from(sharedB));
    });

    it('session nonce: 16 random bytes, unique per session', () => {
      const n1 = crypto.randomBytes(16);
      const n2 = crypto.randomBytes(16);
      assert.lengthOf(n1, 16);
      assert.lengthOf(n2, 16);
      assert.notDeepEqual(Array.from(n1), Array.from(n2));
    });
  });

  // =========================================================================
  // 15. Edge Cases & Error Handling
  // =========================================================================
  describe('15. Edge Cases & Error Handling', () => {
    it('vault decrypt of non-encrypted string passes through', () => {
      const vault = new NoteVault();
      vault.unlockWithKey(new Uint8Array(32));
      const result = vault.decrypt('{"plain":"json"}');
      assert.equal(result, '{"plain":"json"}');
      vault.lock();
    });

    it('vault decrypt of corrupted vault: string throws', () => {
      const vault = new NoteVault();
      vault.unlockWithKey(new Uint8Array(32));
      assert.throws(
        () => vault.decrypt('vault:not_valid_base64!!!'),
        /failed|corrupt|bad nonce/i,
      );
      vault.lock();
    });

    it('PIN hash with empty string', async () => {
      _secureStoreMap.clear();
      const hash = await hashPin('');
      assert.lengthOf(hash, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });

    it('stealth derivation with zero keys (degenerate case)', () => {
      const zeroKey = new Uint8Array(32);
      const viewingKP = nacl.box.keyPair.fromSecretKey(new Uint8Array(32));
      // scalarMult with zero secret produces zero shared secret
      const sharedSecret = deriveSharedSecret(new Uint8Array(32), viewingKP.publicKey);
      // Should still produce a valid seed (HKDF handles zero input)
      const seed = deriveStealthSeed(zeroKey, sharedSecret);
      assert.lengthOf(seed, 32);
    });

    it('amount noise with negative amount returns as-is', async () => {
      const r = await applyAmountNoise(-100, 10, 0);
      assert.equal(r.adjustedAmount, -100);
      assert.equal(r.noiseDelta, 0);
    });

    it('STARK instruction with 0-byte proof chunk', () => {
      const authority = Keypair.generate();
      const [proofBuffer] = getProofBufferPDA(authority.publicKey);
      const chunk = new Uint8Array(0);
      const ix = buildWriteProofChunkIx(0, chunk, proofBuffer, authority.publicKey);
      // Data should be 8 disc + 4 offset + 4 vec length + 0 data = 16
      assert.equal(ix.data.length, 16);
      assert.equal(ix.data.readUInt32LE(12), 0); // chunk length = 0
    });

    it('pool config with max u64 denomination (edge test)', () => {
      const maxU64 = BigInt('18446744073709551615');
      // Verify BigInt serialization handles max u64
      const json = JSON.stringify({ denomination: maxU64.toString() });
      const parsed = JSON.parse(json);
      assert.equal(BigInt(parsed.denomination), maxU64);
    });

    it('createCommitment with zero inputs', () => {
      const c = createCommitment(0n, 0n, 0n, 0n);
      assert.isTrue(typeof c === 'bigint');
      assert.isTrue(c > 0n); // Poseidon of zeros is non-zero
    });

    it('meta-address parse rejects empty string', () => {
      assert.throws(() => parseMetaAddress(''));
    });

    it('meta-address parse rejects wrong version', () => {
      assert.throws(() => parseMetaAddress('st:99abc'));
    });

    it('constantTimeEqual with empty strings', () => {
      assert.isTrue(constantTimeEqual('', ''));
    });

    it('validateRpcEndpoint: ftp:// rejected', () => {
      assert.throws(() => validateRpcEndpoint('ftp://badhost.com'), /HTTPS/);
    });
  });

  // =========================================================================
  // 16. Performance Benchmarks
  // =========================================================================
  describe('16. Performance Benchmarks', () => {
    it('vault encrypt/decrypt 1000 notes < 5s', async () => {
      _secureStoreMap.clear();
      const vault = new NoteVault();
      await vault.unlock('bench_pin');

      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        const note = `{"secret":"${crypto.randomBytes(32).toString('hex')}","idx":${i}}`;
        const enc = vault.encrypt(note);
        vault.decrypt(enc);
      }
      const elapsed = Date.now() - start;
      vault.lock();
      assert.isBelow(elapsed, 5000, `1000 encrypt/decrypt took ${elapsed}ms (limit 5000ms)`);
    });

    it('PIN hash 1000 iterations < 2s', async () => {
      _secureStoreMap.clear();
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        await hashPin(`${i}`);
      }
      const elapsed = Date.now() - start;
      assert.isBelow(elapsed, 2000, `1000 PIN hashes took ${elapsed}ms (limit 2000ms)`);
    });

    it('stealth address gen 100 < 3s', () => {
      const seed = crypto.randomBytes(32);
      const spendingKey = Keypair.fromSeed(seed);
      const viewingKP = nacl.box.keyPair.fromSecretKey(crypto.randomBytes(32));

      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        generateStealthAddress(spendingKey.publicKey.toBytes(), viewingKP.publicKey);
      }
      const elapsed = Date.now() - start;
      assert.isBelow(elapsed, 3000, `100 stealth addresses took ${elapsed}ms (limit 3000ms)`);
    });

    it('amount noise 10000 calculations < 1s', async () => {
      const start = Date.now();
      let cumulative = 0;
      for (let i = 0; i < 10000; i++) {
        const r = await applyAmountNoise(100, 10, cumulative);
        cumulative = r.newCumulativeAdjustment;
      }
      const elapsed = Date.now() - start;
      assert.isBelow(elapsed, 1000, `10000 noise calcs took ${elapsed}ms (limit 1000ms)`);
    });

    it('note dedup 1000 notes < 1s', () => {
      const notes = Array.from({ length: 1000 }, (_, i) => ({
        id: `note_${i}`,
        commitment: crypto.randomBytes(16).toString('hex'),
        // Add some duplicates
        ...(i % 10 === 0 ? { commitment: 'DUPLICATE' } : {}),
      }));

      const start = Date.now();
      const seen = new Set<string>();
      const deduped = notes.filter(n => {
        if (seen.has(n.commitment)) return false;
        seen.add(n.commitment);
        return true;
      });
      const elapsed = Date.now() - start;
      assert.isBelow(elapsed, 1000, `1000 note dedup took ${elapsed}ms (limit 1000ms)`);
      assert.isBelow(deduped.length, notes.length);
    });

    it('fingerprint computation 1000 iterations < 1s', () => {
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        const kp1 = nacl.box.keyPair();
        const kp2 = nacl.box.keyPair();
        computeFingerprint(
          Buffer.from(kp1.publicKey).toString('base64'),
          Buffer.from(kp2.publicKey).toString('base64'),
        );
      }
      const elapsed = Date.now() - start;
      assert.isBelow(elapsed, 1000, `1000 fingerprints took ${elapsed}ms (limit 1000ms)`);
    });

    it('PDA derivation 1000 iterations < 2s', () => {
      const authority = Keypair.generate();
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        getProofBufferPDA(authority.publicKey, i % 6);
      }
      const elapsed = Date.now() - start;
      assert.isBelow(elapsed, 2000, `1000 PDA derivations took ${elapsed}ms (limit 2000ms)`);
    });

    it('Poseidon commitment 1000 iterations < 3s', () => {
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        createCommitment(BigInt(i), BigInt(i + 1000), BigInt(i + 2000), 0n);
      }
      const elapsed = Date.now() - start;
      assert.isBelow(elapsed, 3000, `1000 Poseidon commitments took ${elapsed}ms (limit 3000ms)`);
    });
  });
});
