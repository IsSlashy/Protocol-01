/**
 * ZK Service for Mobile
 * Bridges the P-01 ZK SDK to React Native
 *
 * Proof generation runs client-side in a hidden WebView (snarkjs + WASM).
 * Spending keys NEVER leave the device. See WebViewProver + ZkProverProvider.
 */

import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { generateStealthAddress, scanStealthPayment, type StealthAddress } from '../../utils/crypto/stealth';

// Constants from zk-sdk
const ZK_SHIELDED_PROGRAM_ID = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';
const MERKLE_TREE_DEPTH = 20;

// PDA seeds
const PDA_SEEDS = {
  SHIELDED_POOL: Buffer.from('shielded_pool'),
  MERKLE_TREE: Buffer.from('merkle_tree'),
  NULLIFIER_SET: Buffer.from('nullifier_set'),
};

// NOTE: Proof generation requires circuit files to be bundled with the app
// Shield operations work without proofs, transfer/unshield require proofs

/**
 * Note structure (matches zk-sdk)
 */
export interface Note {
  amount: bigint;
  ownerPubkey: bigint;
  randomness: bigint;
  tokenMint: bigint;
  commitment: bigint;
  leafIndex?: number;
  // Merkle path stored at shield time (for historical root proofs)
  merklePathElements?: bigint[];
  merklePathIndices?: number[];
  merkleRoot?: bigint;
  // Whether this note has been verified on-chain
  isOnChain?: boolean;
}

/**
 * ZK Address for receiving shielded payments
 */
export interface ZkAddress {
  receivingPubkey: bigint;
  viewingKey: Uint8Array;
  encoded: string;
}

/**
 * Groth16 proof
 */
export interface Groth16Proof {
  pi_a: Uint8Array;
  pi_b: Uint8Array;
  pi_c: Uint8Array;
}

/**
 * Result of a stealth unshield operation
 * Contains everything the recipient needs to find and spend their funds
 */
export interface StealthUnshieldResult {
  signature: string;
  stealthAddress: string;
  ephemeralPublicKey: string;
  viewTag: number;
  amount: bigint;
}

// Import poseidon-lite for circom-compatible Poseidon hash
import { poseidon1, poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';

/**
 * Poseidon hash (BN254 field compatible)
 * Uses poseidon-lite for exact compatibility with circom circuits
 */
function poseidonHash(...inputs: bigint[]): bigint {
  try {
    switch (inputs.length) {
      case 1:
        return poseidon1(inputs);
      case 2:
        return poseidon2(inputs);
      case 3:
        return poseidon3(inputs);
      case 4:
        return poseidon4(inputs);
      default:
        throw new Error(`Poseidon: unsupported input count ${inputs.length}`);
    }
  } catch (error) {
    console.error('[Poseidon] Error:', error);
    throw error;
  }
}

/**
 * Convert bigint to 32-byte LE buffer
 */
function bigintToLeBytes(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(temp & BigInt(0xff));
    temp = temp >> BigInt(8);
  }
  return bytes;
}

/**
 * Convert bigint to 32-byte BE buffer (for ZK public inputs)
 * The alt_bn128 precompile expects big-endian encoding
 */
function bigintToBeBytes(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = n;
  // Fill from the end (index 31) to the start (index 0)
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(temp & BigInt(0xff));
    temp = temp >> BigInt(8);
  }
  return bytes;
}

/**
 * Convert 32-byte LE buffer to bigint
 */
function leBytesToBigint(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) + BigInt(bytes[i]);
  }
  return result;
}

/**
 * Generate cryptographically secure random field element
 */
async function randomFieldElement(): Promise<bigint> {
  const crypto = require('expo-crypto');
  const fieldOrder = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

  const randomBytes = await crypto.getRandomBytesAsync(32);
  return leBytesToBigint(new Uint8Array(randomBytes)) % fieldOrder;
}

/**
 * Generate a random BigInt synchronously (for dummy notes)
 * Uses timestamp + Math.random() for uniqueness - sufficient for dummy notes
 * where we only need to avoid nullifier collision, not cryptographic security
 */
function generateRandomBigInt(): bigint {
  const fieldOrder = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
  // Combine timestamp with multiple random values for uniqueness
  const timestamp = BigInt(Date.now());
  const rand1 = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const rand2 = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  const rand3 = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  // Mix them together to create a unique value
  const combined = (timestamp * rand1 + rand2 * BigInt(1000000007) + rand3) % fieldOrder;
  return combined;
}

/**
 * Derive spending key pair from seed phrase
 */
async function deriveSpendingKey(seedPhrase: string): Promise<{
  spendingKey: bigint;
  spendingKeyHash: bigint;
  ownerPubkey: bigint;
}> {
  const crypto = require('expo-crypto');
  const seed = new TextEncoder().encode(seedPhrase + ':spending_key');

  const hashResult = await crypto.digestStringAsync(
    crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(seed).toString('hex')
  );

  const fieldOrder = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
  const spendingKey = BigInt('0x' + hashResult) % fieldOrder;
  // owner_pubkey = Poseidon(spending_key) - matches circuit SpendingKeyDerivation
  const ownerPubkey = poseidonHash(spendingKey);
  // spending_key_hash = Poseidon(spending_key) - same as owner_pubkey in this design
  const spendingKeyHash = ownerPubkey;

  return { spendingKey, spendingKeyHash, ownerPubkey };
}

/**
 * Create a new note
 */
async function createNote(
  amount: bigint,
  ownerPubkey: bigint,
  tokenMint: bigint
): Promise<Note> {
  const randomness = await randomFieldElement();

  try {
    const commitment = poseidonHash(amount, ownerPubkey, randomness, tokenMint);

    return {
      amount,
      ownerPubkey,
      randomness,
      tokenMint,
      commitment,
    };
  } catch (error) {
    console.error('[ZK createNote] Poseidon error:', error);
    throw error;
  }
}

/**
 * Compute nullifier for a note
 */
function computeNullifier(commitment: bigint, spendingKeyHash: bigint): bigint {
  return poseidonHash(commitment, spendingKeyHash);
}

/**
 * Client-side Merkle tree (matches on-chain structure)
 */
class MerkleTree {
  private depth: number;
  private leaves: bigint[] = [];
  private nodes: Map<string, bigint> = new Map();
  private _root: bigint | null = null;
  private _zeroValues: bigint[] | null = null;

  constructor(depth: number = MERKLE_TREE_DEPTH) {
    this.depth = depth;
    // Root is computed lazily when needed (after Poseidon init)
  }

  get root(): bigint {
    if (this._root === null) {
      this._root = this.getZeroValue(this.depth);
    }
    return this._root;
  }

  get leafCount(): number {
    return this.leaves.length;
  }

  private getZeroValue(level: number): bigint {
    // Cache zero values for efficiency
    // IMPORTANT: Base zero value must match circuit and on-chain!
    // On-chain uses keccak256("specter") mod p = 0x6caf9948ed859624e241e7760f341b82b45da1ebb6353a34f3abacd3604ce52f
    if (!this._zeroValues) {
      // On-chain zero value bytes (stored as [u8; 32] in Rust, little-endian)
      const ZERO_VALUE_BYTES = [
        0x6c, 0xaf, 0x99, 0x48, 0xed, 0x85, 0x96, 0x24,
        0xe2, 0x41, 0xe7, 0x76, 0x0f, 0x34, 0x1b, 0x82,
        0xb4, 0x5d, 0xa1, 0xeb, 0xb6, 0x35, 0x3a, 0x34,
        0xf3, 0xab, 0xac, 0xd3, 0x60, 0x4c, 0xe5, 0x2f,
      ];
      // Convert to bigint (LITTLE-ENDIAN - matches Solana's on-chain byte order)
      // Last byte becomes MSB when constructing the bigint
      let baseZero = BigInt(0);
      for (let i = ZERO_VALUE_BYTES.length - 1; i >= 0; i--) {
        baseZero = (baseZero << BigInt(8)) | BigInt(ZERO_VALUE_BYTES[i]);
      }

      this._zeroValues = [baseZero];
      for (let i = 1; i <= this.depth; i++) {
        const prev = this._zeroValues[i - 1];
        this._zeroValues.push(poseidonHash(prev, prev));
      }
    }
    return this._zeroValues[level];
  }

  insert(leaf: bigint): bigint {
    const index = this.leaves.length;
    this.leaves.push(leaf);

    // Update tree
    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = this.getNode(level, siblingIndex);

      this.setNode(level, currentIndex, currentHash);

      currentHash = isRight
        ? poseidonHash(sibling, currentHash)
        : poseidonHash(currentHash, sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }

    this._root = currentHash;
    return this._root;
  }

  /**
   * Get a leaf by index
   */
  getLeaf(index: number): bigint | undefined {
    return this.leaves[index];
  }

  /**
   * Get the precomputed zero value for a given tree level
   */
  getZeroValueForLevel(level: number): bigint {
    return this.getZeroValue(level);
  }

  /**
   * Compute what the root would be after inserting a new leaf, WITHOUT modifying the tree.
   * Used by optimistic shield to get the correct root before sending the transaction.
   * After tx success, call insert() to actually add the leaf.
   */
  computeRootAfterInsert(leaf: bigint): bigint {
    const index = this.leaves.length;
    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = this.getNode(level, siblingIndex);

      currentHash = isRight
        ? poseidonHash(sibling, currentHash)
        : poseidonHash(currentHash, sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return currentHash;
  }

  /**
   * Extract the correct filledSubtrees from the current tree state.
   * Replays all inserts tracking the subtrees (same algorithm as on-chain insert).
   * Used to bootstrap correct subtrees after a full tree rebuild.
   */
  getFilledSubtrees(): bigint[] {
    const subtrees: bigint[] = [];
    for (let i = 0; i < this.depth; i++) {
      subtrees.push(this.getZeroValue(i));
    }

    for (let i = 0; i < this.leaves.length; i++) {
      let currentHash = this.leaves[i];
      let currentIndex = i;

      for (let level = 0; level < this.depth; level++) {
        if (currentIndex % 2 === 0) {
          subtrees[level] = currentHash;
          currentHash = poseidonHash(currentHash, this.getZeroValue(level));
        } else {
          currentHash = poseidonHash(subtrees[level], currentHash);
        }
        currentIndex = Math.floor(currentIndex / 2);
      }
    }

    return subtrees;
  }

  private getNode(level: number, index: number): bigint {
    const key = `${level}-${index}`;
    return this.nodes.get(key) ?? this.getZeroValue(level);
  }

  private setNode(level: number, index: number, value: bigint): void {
    const key = `${level}-${index}`;
    this.nodes.set(key, value);
  }

  generateProof(leafIndex: number): {
    pathElements: bigint[];
    pathIndices: number[];
  } {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentIndex = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;

      pathElements.push(this.getNode(level, siblingIndex));
      pathIndices.push(isRight ? 1 : 0);

      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
  }
}

/**
 * Main ZK Service class for mobile
 */
export class ZkService {
  private connection: Connection;
  private programId: PublicKey;
  private merkleTree: MerkleTree;
  private notes: Note[] = [];
  private spendingKey: bigint | null = null;
  private spendingKeyHash: bigint | null = null;
  private ownerPubkey: bigint | null = null;
  private viewingKey: Uint8Array | null = null;
  private tokenMint: PublicKey;
  private isInitialized: boolean = false;
  // When on-chain root differs from local (due to extension using different impl), store it here
  private _onChainRoot: bigint | null = null;
  // Cached local subtrees for proof reconstruction (loaded lazily)
  private _cachedSubtrees: bigint[] | null = null;

  constructor() {
    this.connection = getConnection();
    this.programId = new PublicKey(ZK_SHIELDED_PROGRAM_ID);
    this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
    this.tokenMint = SystemProgram.programId; // SOL
  }

  /**
   * Initialize with user's seed phrase
   */
  async initialize(seedPhrase: string): Promise<void> {
    const keys = await deriveSpendingKey(seedPhrase);
    this.spendingKey = keys.spendingKey;
    this.spendingKeyHash = keys.spendingKeyHash;
    this.ownerPubkey = keys.ownerPubkey;
    this.viewingKey = bigintToLeBytes(keys.ownerPubkey);


    // Load persisted notes
    await this.loadNotes();

    this.isInitialized = true;
  }

  /**
   * Get ZK address for receiving payments
   */
  getZkAddress(): ZkAddress {
    if (!this.ownerPubkey || !this.viewingKey) {
      throw new Error('ZK Service not initialized');
    }

    const pubkeyBytes = bigintToLeBytes(this.ownerPubkey);
    const combined = new Uint8Array(64);
    combined.set(pubkeyBytes, 0);
    combined.set(this.viewingKey, 32);

    // Using base64 for React Native compatibility
    const encoded = `zk:${Buffer.from(combined).toString('base64')}`;

    return {
      receivingPubkey: this.ownerPubkey,
      viewingKey: this.viewingKey,
      encoded,
    };
  }
  /**
   * Parse a stealth address from encoded format
   */
  static parseStealthAddress(encoded: string): { spendingPublicKey: string; viewingPublicKey: string } | null {
    if (!encoded.startsWith('stealth:')) {
      return null;
    }
    const parts = encoded.slice(8).split(':');
    if (parts.length !== 2) {
      return null;
    }
    return {
      spendingPublicKey: parts[0],
      viewingPublicKey: parts[1],
    };
  }

  /**
   * Check if a nullifier is potentially spent on-chain
   * Uses bloom filter for fast probabilistic check
   * False positives possible, false negatives impossible
   */
  private async checkNullifierOnChain(nullifierBytes: Uint8Array): Promise<boolean> {
    try {
      // Get nullifier set PDA
      const [poolPDA] = PublicKey.findProgramAddressSync(
        [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
        this.programId
      );
      const [nullifierSetPDA] = PublicKey.findProgramAddressSync(
        [PDA_SEEDS.NULLIFIER_SET, poolPDA.toBytes()],
        this.programId
      );

      // Fetch account data
      const accountInfo = await this.connection.getAccountInfo(nullifierSetPDA);
      if (!accountInfo) {
        return false;
      }

      // Parse nullifier set data
      // Layout: discriminator(8) + pool(32) + count(8) + num_hash_functions(1) + bump(1) + padding(6) + bloom_filter(256*8)
      const data = accountInfo.data;
      const numHashFunctions = data[8 + 32 + 8]; // At offset 48
      const bloomFilterOffset = 8 + 32 + 8 + 1 + 1 + 6; // = 56

      // Bloom filter size: 256 * 64 bits = 16,384 bits
      const BLOOM_SIZE_BITS = 16384;

      // Double hashing technique: h(i) = h1 + i*h2
      const h1Bytes = keccak_256(nullifierBytes);
      const h1View = new DataView(h1Bytes.buffer, h1Bytes.byteOffset, 8);
      const h1 = h1View.getBigUint64(0, true); // little-endian

      const h2Input = new Uint8Array(nullifierBytes.length + 1);
      h2Input.set(nullifierBytes);
      h2Input[nullifierBytes.length] = 0x01;
      const h2Bytes = keccak_256(h2Input);
      const h2View = new DataView(h2Bytes.buffer, h2Bytes.byteOffset, 8);
      const h2 = h2View.getBigUint64(0, true); // little-endian

      // Check each hash function
      for (let i = 0; i < numHashFunctions; i++) {
        // combined = h1 + i * h2 (wrapping)
        const combined = (h1 + BigInt(i) * h2) % (BigInt(1) << BigInt(64));
        const bitIndex = Number(combined % BigInt(BLOOM_SIZE_BITS));
        const wordIndex = Math.floor(bitIndex / 64);
        const bitOffset = bitIndex % 64;

        // Read the u64 word from bloom filter
        const wordOffset = bloomFilterOffset + wordIndex * 8;
        const wordView = new DataView(data.buffer, data.byteOffset + wordOffset, 8);
        const word = wordView.getBigUint64(0, true); // little-endian

        // Check if bit is set
        if ((word & (BigInt(1) << BigInt(bitOffset))) === BigInt(0)) {
          return false; // Definitely not in set
        }
      }

      return true; // Possibly in set (might be false positive)
    } catch (error) {
      console.error('[ZK] Error checking nullifier on-chain:', error);
      return false; // Assume not spent on error
    }
  }

  /**
   * Validate notes are not already spent on-chain
   * Removes any zombie notes that have already been spent
   */
  private async validateNotesNotSpent(notesToCheck: Note[]): Promise<Note[]> {
    const validNotes: Note[] = [];
    let removedCount = 0;

    for (const note of notesToCheck) {
      // Compute nullifier for this note
      const nullifier = computeNullifier(note.commitment, this.spendingKeyHash!);
      const nullifierBytes = bigintToLeBytes(nullifier);

      // Check if already spent on-chain
      const mightBeSpent = await this.checkNullifierOnChain(nullifierBytes);

      if (mightBeSpent) {
        console.warn(`[ZK] Note at index ${note.leafIndex} appears to be already spent (nullifier in bloom filter)`);
        // Remove from local storage
        this.notes = this.notes.filter(n => n.commitment !== note.commitment);
        removedCount++;
      } else {
        validNotes.push(note);
      }
    }

    if (removedCount > 0) {
      await this.saveNotes();
    }

    return validNotes;
  }

  /**
   * Get shielded balance
   */
  getShieldedBalance(): bigint {
    return this.notes.reduce((sum, note) => sum + note.amount, BigInt(0));
  }

  /**
   * Get all notes
   */
  getNotes(): Note[] {
    return [...this.notes];
  }

  /**
   * Shield tokens (deposit from transparent to shielded)
   */
  async shield(
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {

    if (!this.ownerPubkey) {
      throw new Error('ZK Service not initialized');
    }

    // OPTIMISTIC SHIELD: Fast path using filledSubtrees (1 RPC + 20 hashes).
    // Prefer locally-stored corrected subtrees over on-chain stale ones.
    // On-chain subtrees are stale (insert_with_root only updates level 0),
    // but local subtrees are properly updated after each shield.
    console.log('[ZK Shield] Reading on-chain state (optimistic path)...');
    const onChainState = await this.readOnChainFilledSubtrees();

    // Use locally-stored correct subtrees if available (validated against on-chain leaf count).
    // Fall back to computing from local tree, then on-chain subtrees as last resort.
    const localSubtrees = await this.loadLocalSubtrees(onChainState.leafCount);
    let useSubtrees: bigint[];
    if (localSubtrees) {
      useSubtrees = localSubtrees;
    } else if (this.merkleTree.leafCount === onChainState.leafCount && onChainState.leafCount > 0) {
      // Tree is synced with on-chain — compute correct subtrees from it
      console.log('[ZK Shield] Computing subtrees from synced tree');
      useSubtrees = this.merkleTree.getFilledSubtrees();
      await this.saveLocalSubtrees(useSubtrees, onChainState.leafCount);
    } else {
      // Last resort: on-chain subtrees (stale for levels > 0, but may work for first shield)
      console.warn('[ZK Shield] Using on-chain subtrees (may be stale for levels > 0)');
      useSubtrees = onChainState.filledSubtrees;
    }

    const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));

    // Create note for self
    const note = await createNote(amount, this.ownerPubkey, tokenMintField);

    // Compute new root using subtrees (fast: only 20 Poseidon hashes)
    // Also computes Merkle proof for the new leaf — this proof is self-consistent
    // with the root and both are sent/stored on-chain, so unshield can use them
    // directly without needing to rebuild the full tree.
    const leafIndexBeforeInsert = onChainState.leafCount;
    const { newRoot, updatedSubtrees, pathElements, pathIndices } = this.computeNewRootFromSubtrees(
      useSubtrees,
      onChainState.leafCount,
      note.commitment,
      onChainState.depth
    );
    const newRootBytes = bigintToLeBytes(newRoot);

    const subtreeSource = localSubtrees ? 'correct subtrees' : (this.merkleTree.leafCount === onChainState.leafCount && onChainState.leafCount > 0) ? 'tree-computed subtrees' : 'on-chain subtrees';
    console.log('[ZK Shield] Root computed, leafIndex:', leafIndexBeforeInsert, `(${subtreeSource})`);

    // Set note metadata with proof from filledSubtrees (guaranteed to match on-chain root)
    note.leafIndex = leafIndexBeforeInsert;
    note.merkleRoot = newRoot;
    note.merklePathElements = pathElements;
    note.merklePathIndices = pathIndices;
    note.isOnChain = true;

    // Get PDAs
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );

    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    // Build shield instruction - Anchor discriminator: sha256("global:shield")[0..8]
    const discriminator = Buffer.from([0xdc, 0xc6, 0xfd, 0xf6, 0xe7, 0x54, 0x93, 0x62]);
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(amount, 0);
    const commitmentBytes = bigintToLeBytes(note.commitment);

    const data = Buffer.concat([discriminator, amountBuffer, commitmentBytes, newRootBytes]);

    // Token program ID for optional accounts (placeholder for native SOL)
    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        // Optional accounts for SPL tokens (required by Anchor even if not used)
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        // Use program ID as placeholder for optional token accounts (won't be accessed for SOL)
        { pubkey: this.programId, isSigner: false, isWritable: false }, // user_token_account placeholder
        { pubkey: this.programId, isSigner: false, isWritable: false }, // pool_vault placeholder
      ],
      data,
    });

    // Pre-check wallet balance (shield needs SOL for amount + fees)
    const walletBalance = await this.connection.getBalance(walletPublicKey);
    const shieldAmount = Number(amount);
    const estimatedFees = 15_000;
    if (walletBalance < shieldAmount + estimatedFees) {
      const have = (walletBalance / 1e9).toFixed(4);
      const need = ((shieldAmount + estimatedFees) / 1e9).toFixed(4);
      throw new Error(`Insufficient SOL. Need ${need} SOL (${(shieldAmount / 1e9).toFixed(4)} to shield + fees), wallet has ${have} SOL.`);
    }

    // Build and sign transaction with retry on dropped tx
    const MAX_RETRIES = 3;
    let signature: string = '';
    let confirmed = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const tx = new Transaction().add(ix);
      tx.feePayer = walletPublicKey;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const signedTx = await signTransaction(tx);
      console.log(`[ZK Shield] Sending tx (attempt ${attempt}/${MAX_RETRIES})...`);
      signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'processed',
        maxRetries: 3,
      });
      console.log(`[ZK Shield] Tx sent: ${signature}`);

      try {
        const confirmation = await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'processed'
        );
        if (confirmation.value.err) {
          console.error('[ZK Shield] Transaction failed on-chain:', JSON.stringify(confirmation.value.err));
          throw new Error(`Shield transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        confirmed = true;
        console.log(`[ZK Shield] Confirmed on attempt ${attempt}`);
        break;
      } catch (e: any) {
        const msg = e?.message || e?.toString() || '';
        if (msg.includes('insufficient lamports')) {
          const match = msg.match(/insufficient lamports (\d+), need (\d+)/);
          if (match) {
            const have = (Number(match[1]) / 1e9).toFixed(4);
            const need = (Number(match[2]) / 1e9).toFixed(4);
            throw new Error(`Insufficient SOL for transaction. Wallet has ${have} SOL but needs ${need} SOL.`);
          }
          throw new Error('Insufficient SOL for transaction fees. Please fund your wallet first.');
        }
        if (msg.includes('timeout') || msg.includes('expired') || msg.includes('block height exceeded')) {
          console.warn(`[ZK Shield] Attempt ${attempt} expired, tx dropped by network`);
          if (attempt < MAX_RETRIES) {
            console.log('[ZK Shield] Retrying with fresh blockhash...');
            continue;
          }
          // Last attempt — check status one more time
          const status = await this.connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
            confirmed = true;
            break;
          }
          throw new Error(`Shield transaction dropped after ${MAX_RETRIES} attempts. Devnet may be congested — try again.`);
        }
        throw e;
      }
    }

    // After tx confirmation, verify on-chain leaf index and update local tree
    try {
      const merkleTreeAccount = await this.connection.getAccountInfo(merkleTreePDA);
      if (merkleTreeAccount) {
        const onChainLeafCount = merkleTreeAccount.data.readBigUInt64LE(8 + 32 + 32);
        const onChainLeafIndex = Number(onChainLeafCount) - 1;
        if (onChainLeafIndex !== note.leafIndex) {
          console.warn('[ZK Shield] On-chain leaf index mismatch:', note.leafIndex, '!=', onChainLeafIndex);
          note.leafIndex = onChainLeafIndex;
        }
      }
    } catch (e) {
      console.warn('[ZK Shield] Could not verify on-chain leaf index');
    }

    // Save corrected subtrees for next shield (fast, ~1ms).
    // Use on-chain leaf count + 1 (not local tree count, which may be inflated).
    await this.saveLocalSubtrees(updatedSubtrees, onChainState.leafCount + 1);

    // Note: Merkle proof was already computed from filledSubtrees above (pathElements/pathIndices).
    // No need to sync/update local tree — the proof from filledSubtrees is self-consistent
    // with the on-chain root and will be used directly by unshield.

    // Store note locally (with validation)
    this.addNote(note);
    await this.saveNotes();

    // Update local commitments cache
    try {
      const cached = await SecureStore.getItemAsync('zk_all_commitments');
      const allCommitments: string[] = cached ? JSON.parse(cached) : [];
      while (allCommitments.length < note.leafIndex!) {
        allCommitments.push('0'); // Placeholder for unknown commitments
      }
      if (allCommitments.length === note.leafIndex) {
        allCommitments.push(note.commitment.toString());
        await SecureStore.setItemAsync('zk_all_commitments', JSON.stringify(allCommitments));
      }
    } catch (e) {
      console.warn('[ZK Shield] Could not update commitment cache');
    }

    console.log('[ZK Shield] Optimistic shield complete in ~3s instead of ~3min');
    return signature;
  }

  /**
   * Transfer shielded tokens (client-side proof via WebView)
   */
  async transfer(
    recipient: ZkAddress,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    if (!this.spendingKeyHash || !this.ownerPubkey) {
      throw new Error('ZK Service not initialized');
    }

    // Sync Merkle tree with on-chain state before generating proofs
    await this.syncMerkleTree();

    // Select notes to spend
    const { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));

    // Create output notes
    const recipientNote = await createNote(amount, recipient.receivingPubkey, tokenMintField);
    const changeAmount = totalValue - amount;
    const changeNote = await createNote(changeAmount, this.ownerPubkey, tokenMintField);

    // Compute nullifiers
    const nullifier1 = computeNullifier(notesToSpend[0].commitment, this.spendingKeyHash);
    let nullifier2: bigint;
    let dummyInputNote: Note | undefined;

    if (notesToSpend[1]) {
      nullifier2 = computeNullifier(notesToSpend[1].commitment, this.spendingKeyHash);
    } else {
      // IMPORTANT: For dummy input note, we must use UNIQUE randomness each time!
      // Using constant (0,0,0,tokenMint) causes nullifier collision - once spent in bloom filter,
      // all future single-note operations fail.
      const dummyRandomness = generateRandomBigInt();
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), dummyRandomness, tokenMintField);
      nullifier2 = computeNullifier(dummyCommitment, this.spendingKeyHash);

      dummyInputNote = {
        amount: BigInt(0),
        ownerPubkey: BigInt(0),
        randomness: dummyRandomness,
        tokenMint: tokenMintField,
        commitment: dummyCommitment,
      };
    }

    // Generate Merkle proofs
    const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
    const proof2 = notesToSpend[1]
      ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
      : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

    // If we have only 1 real note, include the dummy input note with unique randomness
    const inputNotesForCircuit = notesToSpend[1]
      ? notesToSpend
      : [notesToSpend[0], dummyInputNote!];

    // Save the current merkle root BEFORE inserting new commitments
    // This is the root that will be used in the proof and validated on-chain
    // IMPORTANT: We must use the LOCAL tree root because the proof siblings come from the local tree.
    // Using a different root (like _onChainRoot) would cause proof verification to fail since
    // the siblings wouldn't hash up to that root.
    const merkleRoot = this.merkleTree.root;
    if (this._onChainRoot && this._onChainRoot !== merkleRoot) {
      console.warn('[ZK Transfer] WARNING: Local root differs from on-chain. This may cause transaction to fail.');
      console.warn('[ZK Transfer] Local root:', merkleRoot.toString().slice(0, 20) + '...');
      console.warn('[ZK Transfer] On-chain root:', this._onChainRoot.toString().slice(0, 20) + '...');
      console.warn('[ZK Transfer] The sync may have failed. Try refreshing the wallet or resetting ZK state.');
    }

    // Generate proof locally
    const zkProof = await this.generateProofClientSide({
      merkleRoot: merkleRoot,
      nullifier1,
      nullifier2,
      outputCommitment1: recipientNote.commitment,
      outputCommitment2: changeNote.commitment,
      // Private inputs
      inputNotes: inputNotesForCircuit,
      outputNotes: [recipientNote, changeNote],
      proofs: [proof1, proof2],
      spendingKey: this.spendingKey!,
    });

    // Update local Merkle tree (after proof generation) and save the new root
    this.merkleTree.insert(recipientNote.commitment);
    this.merkleTree.insert(changeNote.commitment);
    const newRoot = this.merkleTree.root;

    // Get PDAs
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );

    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    const [nullifierSetPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.NULLIFIER_SET, poolPDA.toBytes()],
      this.programId
    );

    const [vkDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vk_data'), poolPDA.toBytes()],
      this.programId
    );

    // Build transfer instruction - Anchor discriminator: sha256("global:transfer")[0..8]
    // merkle_root = old root used in the ZK proof (for validation)
    // new_root = root after inserting both commitments (for merkle tree update)
    const discriminator = Buffer.from([0xa3, 0x34, 0xc8, 0xe7, 0x8c, 0x03, 0x45, 0xba]);
    const data = Buffer.concat([
      discriminator,
      zkProof.pi_a,
      zkProof.pi_b,
      zkProof.pi_c,
      bigintToLeBytes(nullifier1),
      bigintToLeBytes(nullifier2),
      bigintToLeBytes(recipientNote.commitment),
      bigintToLeBytes(changeNote.commitment),
      bigintToLeBytes(merkleRoot),  // Old merkle root for proof validation
      bigintToLeBytes(newRoot),     // New merkle root for tree update
    ]);


    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },
        { pubkey: vkDataPDA, isSigner: false, isWritable: false },
      ],
      data,
    });

    // Add compute budget instruction for Groth16 verification
    // Transfer requires more compute than Shield because it verifies a more complex circuit
    const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');

    // SetComputeUnitLimit instruction (discriminator = 2)
    const computeLimitData = Buffer.alloc(5);
    computeLimitData.writeUInt8(2, 0);
    computeLimitData.writeUInt32LE(1_800_000, 1); // 1.8M compute units for Transfer

    // SetComputeUnitPrice instruction (discriminator = 3) - priority fee
    const computePriceData = Buffer.alloc(9);
    computePriceData.writeUInt8(3, 0);
    computePriceData.writeBigUInt64LE(BigInt(1000), 1); // 1000 microlamports per CU

    const computeLimitIx = new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: computeLimitData,
    });

    const computePriceIx = new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: computePriceData,
    });

    // Pre-check wallet balance for tx fees
    const walletBalance = await this.connection.getBalance(walletPublicKey);
    const requiredLamports = 100_000; // ~0.0001 SOL for fees + rent
    if (walletBalance < requiredLamports) {
      const have = (walletBalance / 1e9).toFixed(4);
      throw new Error(`Insufficient SOL for transaction fees. Wallet has ${have} SOL. Please fund your wallet first.`);
    }

    let signature: string = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const tx = new Transaction().add(computeLimitIx).add(computePriceIx).add(ix);
      tx.feePayer = walletPublicKey;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const signedTx = await signTransaction(tx);
      console.log(`[ZK Transfer] Sending tx (attempt ${attempt}/3)...`);
      signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'processed',
        maxRetries: 3,
      });

      try {
        const confirmation = await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'processed'
        );
        if (confirmation.value.err) {
          console.error('[ZK Transfer] Transaction FAILED:', signature);
          throw new Error(`Transfer transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        break;
      } catch (e: any) {
        const msg = e?.message || e?.toString() || '';
        if (msg.includes('insufficient lamports')) {
          const match = msg.match(/insufficient lamports (\d+), need (\d+)/);
          if (match) {
            const have = (Number(match[1]) / 1e9).toFixed(4);
            const need = (Number(match[2]) / 1e9).toFixed(4);
            throw new Error(`Insufficient SOL for transaction fees. Wallet has ${have} SOL but needs ${need} SOL.`);
          }
          throw new Error('Insufficient SOL for transaction fees. Please fund your wallet first.');
        }
        if ((msg.includes('timeout') || msg.includes('expired') || msg.includes('block height exceeded')) && attempt < 3) {
          console.warn(`[ZK Transfer] Attempt ${attempt} expired, retrying...`);
          continue;
        }
        if (msg.includes('timeout') || msg.includes('expired') || msg.includes('block height exceeded')) {
          const status = await this.connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') break;
          throw new Error('Transfer transaction dropped after 3 attempts. Network may be congested.');
        }
        throw e;
      }
    }

    // Update local notes
    this.removeSpentNotes(notesToSpend);
    if (changeAmount > BigInt(0)) {
      changeNote.leafIndex = this.merkleTree.leafCount - 1;
      this.addNote(changeNote);
    }
    await this.saveNotes();

    // Store the sent note for sharing with recipient
    // The recipient's note is at leafIndex = merkleTree.leafCount - 2 (if change exists) or - 1
    const recipientLeafIndex = changeAmount > BigInt(0)
      ? this.merkleTree.leafCount - 2
      : this.merkleTree.leafCount - 1;
    recipientNote.leafIndex = recipientLeafIndex;

    this._lastSentNote = {
      noteString: this.exportNote(recipientNote),
      amount: amount,
      leafIndex: recipientLeafIndex,
    };


    return signature;
  }

  /**
   * Unshield tokens (withdraw from shielded to transparent)
   */
  async unshield(
    recipient: PublicKey,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    if (!this.spendingKeyHash || !this.ownerPubkey) {
      throw new Error('ZK Service not initialized');
    }

    const unshieldStart = Date.now();
    console.log('[ZK Unshield] Starting unshield of', Number(amount) / 1e9, 'SOL...');

    // Select notes to spend
    let { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    // Validate selected notes are not already spent on-chain (detect zombie notes)
    const validNotes = await this.validateNotesNotSpent(notesToSpend);

    // If any notes were removed as zombies, re-select
    if (validNotes.length < notesToSpend.length) {
      const reselection = this.selectNotes(amount);
      notesToSpend = reselection.notesToSpend;
      totalValue = reselection.totalValue;

      if (totalValue < amount) {
        throw new Error(`Insufficient shielded balance after removing zombie notes: ${totalValue} < ${amount}`);
      }

      // Validate again
      const finalValidNotes = await this.validateNotesNotSpent(notesToSpend);
      if (finalValidNotes.length < notesToSpend.length) {
        throw new Error('All available notes appear to be already spent on-chain');
      }
      notesToSpend = finalValidNotes;
    } else {
      notesToSpend = validNotes;
    }

    const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));

    // Create change note (or dummy note if no change)
    const changeAmount = totalValue - amount;
    let changeNote: Note;
    if (changeAmount > BigInt(0)) {
      changeNote = await createNote(changeAmount, this.ownerPubkey, tokenMintField);
    } else {
      // Create dummy note with amount=0 for the circuit
      // The circuit will compute Poseidon(0, 0, 0, tokenMint) so we need to match that
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);
      changeNote = {
        amount: BigInt(0),
        ownerPubkey: BigInt(0),
        randomness: BigInt(0),
        tokenMint: tokenMintField,
        commitment: dummyCommitment,
      };
    }

    // Compute nullifiers
    const nullifier1 = computeNullifier(notesToSpend[0].commitment, this.spendingKeyHash);
    let nullifier2: bigint;
    let dummyInputNote: Note | undefined;

    if (notesToSpend[1]) {
      nullifier2 = computeNullifier(notesToSpend[1].commitment, this.spendingKeyHash);
    } else {
      const dummyRandomness = generateRandomBigInt();
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), dummyRandomness, tokenMintField);
      nullifier2 = computeNullifier(dummyCommitment, this.spendingKeyHash);
      dummyInputNote = {
        amount: BigInt(0),
        ownerPubkey: BigInt(0),
        randomness: dummyRandomness,
        tokenMint: tokenMintField,
        commitment: dummyCommitment,
      };
    }

    // Use saved Merkle proof from shield time. The merkleRoot is guaranteed to be
    // on-chain (current or historical). No tree sync needed.
    const note1 = notesToSpend[0];
    if (!note1.merkleRoot) {
      throw new Error('Note missing Merkle root — was it shielded with an older version?');
    }

    // Verify saved proof matches saved root. If not (e.g. old code saved wrong proof),
    // reconstruct from leafIndex + saved subtrees.
    let proof1: { pathElements: bigint[]; pathIndices: number[] };
    const merkleRoot = note1.merkleRoot;

    if (note1.merklePathElements && note1.merklePathIndices) {
      // Verify saved proof locally
      let verifyRoot = note1.commitment;
      for (let i = 0; i < MERKLE_TREE_DEPTH; i++) {
        const sibling = note1.merklePathElements[i];
        const isRight = note1.merklePathIndices[i] === 1;
        verifyRoot = isRight
          ? poseidonHash(sibling, verifyRoot)
          : poseidonHash(verifyRoot, sibling);
      }
      if (verifyRoot === merkleRoot) {
        proof1 = { pathElements: note1.merklePathElements, pathIndices: note1.merklePathIndices };
        console.log('[ZK Unshield] Saved proof verified OK, root:', merkleRoot.toString().slice(0, 20) + '...');
      } else {
        console.warn('[ZK Unshield] Saved proof does NOT match root — reconstructing from subtrees');
        proof1 = await this.reconstructProofFromSubtrees(note1);
      }
    } else {
      console.warn('[ZK Unshield] No saved proof — reconstructing from subtrees');
      proof1 = await this.reconstructProofFromSubtrees(note1);
    }

    const proof2 = notesToSpend[1]?.merklePathElements
      ? { pathElements: notesToSpend[1].merklePathElements, pathIndices: notesToSpend[1].merklePathIndices! }
      : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

    // Create dummy second output note (amount=0)
    const dummyOutput2Commitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);
    const dummyOutput2: Note = {
      amount: BigInt(0),
      ownerPubkey: BigInt(0),
      randomness: BigInt(0),
      tokenMint: tokenMintField,
      commitment: dummyOutput2Commitment,
    };

    // Generate proof locally
    const inputNotesForCircuit = notesToSpend[1]
      ? notesToSpend
      : [notesToSpend[0], dummyInputNote!];

    const zkProof = await this.generateProofClientSide({
      merkleRoot,
      nullifier1,
      nullifier2,
      outputCommitment1: changeNote.commitment,
      outputCommitment2: dummyOutput2Commitment,
      publicAmount: -amount, // Negative for unshield
      inputNotes: inputNotesForCircuit,
      outputNotes: [changeNote, dummyOutput2],
      proofs: [proof1, proof2],
      spendingKey: this.spendingKey!,
    });

    // Compute newRoot for the change commitment using on-chain filledSubtrees.
    // Same approach as shield: read current state, compute root after inserting change note.
    const onChainState = await this.readOnChainFilledSubtrees();
    const localSubtrees = await this.loadLocalSubtrees(onChainState.leafCount);
    const useSubtrees = localSubtrees || onChainState.filledSubtrees;
    if (!localSubtrees) {
      console.warn('[ZK Unshield] Using on-chain subtrees for newRoot (may be stale)');
    }
    const { newRoot, updatedSubtrees, pathElements: changePathElements, pathIndices: changePathIndices } = this.computeNewRootFromSubtrees(
      useSubtrees,
      onChainState.leafCount,
      changeNote.commitment,
      onChainState.depth
    );
    // Save updated subtrees for next operation
    await this.saveLocalSubtrees(updatedSubtrees, onChainState.leafCount + 1);
    console.log('[ZK Unshield] newRoot computed from subtrees, leafCount:', onChainState.leafCount);

    // Get PDAs
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );

    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    const [nullifierSetPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.NULLIFIER_SET, poolPDA.toBytes()],
      this.programId
    );

    // Get verification key data PDA
    const [vkDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vk_data'), poolPDA.toBytes()],
      this.programId
    );

    // Build unshield instruction - Anchor discriminator: sha256("global:unshield")[0..8]
    const discriminator = Buffer.from([0x15, 0xe4, 0x37, 0x18, 0xc2, 0x0a, 0x15, 0x16]);
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(amount, 0);

    // Compute the dummy commitment for output_commitment_2
    // This MUST match what the circuit computed: Poseidon(0, 0, 0, tokenMint)
    const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);

    // Debug: log what we're passing on-chain vs what the circuit used
    console.log('[ZK Debug] On-chain public inputs (decimal):');
    console.log('[ZK Debug]   merkle_root:', merkleRoot.toString());
    console.log('[ZK Debug]   nullifier_1:', nullifier1.toString());
    console.log('[ZK Debug]   nullifier_2:', nullifier2.toString());
    console.log('[ZK Debug]   output_commitment_1:', changeNote.commitment.toString());
    console.log('[ZK Debug]   output_commitment_2:', dummyCommitment.toString());
    const FIELD_MODULUS_DBG = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
    const publicAmountOnChain = FIELD_MODULUS_DBG - amount;
    console.log('[ZK Debug]   public_amount (field):', publicAmountOnChain.toString());
    console.log('[ZK Debug]   token_mint:', tokenMintField.toString());
    console.log('[ZK Debug]   amount (raw u64):', amount.toString());

    // IMPORTANT: Pass merkle_root (current root BEFORE insertion), not newRoot!
    // Public inputs in little-endian (matching stored roots) - verifier converts to BE
    // new_root is the merkle root AFTER inserting the change note (or same as current if no change)
    const data = Buffer.concat([
      discriminator,
      zkProof.pi_a,
      zkProof.pi_b,
      zkProof.pi_c,
      bigintToLeBytes(nullifier1),
      bigintToLeBytes(nullifier2),
      bigintToLeBytes(changeNote.commitment),  // output_commitment_1 (change note or dummy)
      bigintToLeBytes(dummyCommitment),        // output_commitment_2 (always dummy for unshield)
      bigintToLeBytes(merkleRoot), // Use merkleRoot, not newRoot!
      amountBuffer,
      bigintToLeBytes(newRoot),    // new_root for merkle tree update
    ]);


    // For native SOL, we still need to pass optional accounts as None
    // Anchor expects all accounts in order, optional ones can be the program ID as placeholder
    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },    // payer
        { pubkey: recipient, isSigner: false, isWritable: true },          // recipient
        { pubkey: poolPDA, isSigner: false, isWritable: true },            // shielded_pool
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },      // merkle_tree
        { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },    // nullifier_set
        { pubkey: vkDataPDA, isSigner: false, isWritable: false },         // verification_key_data
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // token_program (optional but required by Anchor)
        { pubkey: this.programId, isSigner: false, isWritable: false },    // pool_vault (None - use program ID as placeholder)
        { pubkey: this.programId, isSigner: false, isWritable: false },    // recipient_token_account (None - use program ID as placeholder)
      ],
      data,
    });

    // Add compute budget instruction for Groth16 verification (requires ~1.4M compute units)
    const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');

    // SetComputeUnitLimit instruction (discriminator = 2)
    const computeLimitData = Buffer.alloc(5);
    computeLimitData.writeUInt8(2, 0); // Instruction discriminator
    computeLimitData.writeUInt32LE(1_400_000, 1); // 1.4M compute units

    const computeLimitIx = new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: computeLimitData,
    });

    // Pre-check wallet balance for tx fees
    const walletBalanceUnshield = await this.connection.getBalance(walletPublicKey);
    if (walletBalanceUnshield < 100_000) {
      const have = (walletBalanceUnshield / 1e9).toFixed(4);
      throw new Error(`Insufficient SOL for transaction fees. Wallet has ${have} SOL. Please fund your wallet first.`);
    }

    let signature: string = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const tx = new Transaction().add(computeLimitIx).add(ix);
      tx.feePayer = walletPublicKey;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const signedTx = await signTransaction(tx);
      console.log(`[ZK Unshield] Sending tx (attempt ${attempt}/3)...`);
      try {
        signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'processed',
          maxRetries: 3,
        });
      } catch (err: any) {
        const errMsg = err?.message || err?.toString() || '';
        if (errMsg.includes('insufficient lamports')) {
          const match = errMsg.match(/insufficient lamports (\d+), need (\d+)/);
          if (match) {
            const have = (Number(match[1]) / 1e9).toFixed(4);
            const need = (Number(match[2]) / 1e9).toFixed(4);
            throw new Error(`Insufficient SOL for transaction fees. Wallet has ${have} SOL but needs ${need} SOL.`);
          }
          throw new Error('Insufficient SOL for transaction fees. Please fund your wallet first.');
        }
        console.error('[ZK Unshield] Preflight error:', err.message);
        if (err.logs) console.error('[ZK Unshield] Logs:', err.logs);
        throw err;
      }

      try {
        const confirmation = await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'processed'
        );
        if (confirmation.value.err) {
          console.error('[ZK Unshield] Transaction failed on-chain:', confirmation.value.err);
          throw new Error(`Unshield failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        break;
      } catch (e: any) {
        const msg = e?.message || e?.toString() || '';
        if (msg.includes('insufficient lamports')) {
          const match = msg.match(/insufficient lamports (\d+), need (\d+)/);
          if (match) {
            const have = (Number(match[1]) / 1e9).toFixed(4);
            const need = (Number(match[2]) / 1e9).toFixed(4);
            throw new Error(`Insufficient SOL for transaction fees. Wallet has ${have} SOL but needs ${need} SOL.`);
          }
          throw new Error('Insufficient SOL for transaction fees. Please fund your wallet first.');
        }
        if ((msg.includes('timeout') || msg.includes('expired') || msg.includes('block height exceeded')) && attempt < 3) {
          console.warn(`[ZK Unshield] Attempt ${attempt} expired, retrying...`);
          continue;
        }
        if (msg.includes('timeout') || msg.includes('expired') || msg.includes('block height exceeded')) {
          const status = await this.connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') break;
          throw new Error('Unshield transaction dropped after 3 attempts. Network may be congested.');
        }
        throw e;
      }
    }

    // Update local notes
    this.removeSpentNotes(notesToSpend);
    if (changeAmount > BigInt(0)) {
      changeNote.leafIndex = onChainState.leafCount; // Index where change note was inserted
      changeNote.merkleRoot = newRoot;
      changeNote.merklePathElements = changePathElements;
      changeNote.merklePathIndices = changePathIndices;
      changeNote.isOnChain = true;
      this.addNote(changeNote);
    }
    await this.saveNotes();

    const totalTime = Date.now() - unshieldStart;
    console.log('[ZK Unshield] SUCCESS in', totalTime, 'ms (' + (totalTime / 1000).toFixed(1) + 's)', 'signature:', signature.slice(0, 20) + '...');

    return signature;
  }

  /**
   * Unshield tokens via the decentralized relay for sender privacy.
   *
   * Instead of the user's wallet appearing as the payer on-chain,
   * an ephemeral keypair signs the unshield tx. The relay service
   * encrypts and posts the job; a relayer executes it.
   *
   * Privacy: the user's wallet only appears in a small funding tx
   * to an ephemeral address — the actual unshield is unlinkable.
   */
  async unshieldViaRelay(
    recipient: PublicKey,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    if (!this.spendingKeyHash || !this.ownerPubkey) {
      throw new Error('ZK Service not initialized');
    }

    const relayStart = Date.now();
    console.log('[ZK Relay Unshield] Starting relay unshield of', Number(amount) / 1e9, 'SOL...');

    // ── Note selection (same as regular unshield) ──
    let { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    const validNotes = await this.validateNotesNotSpent(notesToSpend);
    if (validNotes.length < notesToSpend.length) {
      const reselection = this.selectNotes(amount);
      notesToSpend = reselection.notesToSpend;
      totalValue = reselection.totalValue;
      if (totalValue < amount) {
        throw new Error(`Insufficient shielded balance after removing zombie notes`);
      }
      notesToSpend = await this.validateNotesNotSpent(notesToSpend);
    } else {
      notesToSpend = validNotes;
    }

    const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));

    // ── Change note ──
    const changeAmount = totalValue - amount;
    let changeNote: Note;
    if (changeAmount > BigInt(0)) {
      changeNote = await createNote(changeAmount, this.ownerPubkey, tokenMintField);
    } else {
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);
      changeNote = {
        amount: BigInt(0), ownerPubkey: BigInt(0), randomness: BigInt(0),
        tokenMint: tokenMintField, commitment: dummyCommitment,
      };
    }

    // ── Nullifiers ──
    const nullifier1 = computeNullifier(notesToSpend[0].commitment, this.spendingKeyHash);
    let nullifier2: bigint;
    let dummyInputNote: Note | undefined;

    if (notesToSpend[1]) {
      nullifier2 = computeNullifier(notesToSpend[1].commitment, this.spendingKeyHash);
    } else {
      const dummyRandomness = generateRandomBigInt();
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), dummyRandomness, tokenMintField);
      nullifier2 = computeNullifier(dummyCommitment, this.spendingKeyHash);
      dummyInputNote = {
        amount: BigInt(0), ownerPubkey: BigInt(0), randomness: dummyRandomness,
        tokenMint: tokenMintField, commitment: dummyCommitment,
      };
    }

    // ── Merkle proof ──
    const note1 = notesToSpend[0];
    if (!note1.merkleRoot) {
      throw new Error('Note missing Merkle root — was it shielded with an older version?');
    }

    let proof1: { pathElements: bigint[]; pathIndices: number[] };
    const merkleRoot = note1.merkleRoot;

    if (note1.merklePathElements && note1.merklePathIndices) {
      let verifyRoot = note1.commitment;
      for (let i = 0; i < MERKLE_TREE_DEPTH; i++) {
        const sibling = note1.merklePathElements[i];
        const isRight = note1.merklePathIndices[i] === 1;
        verifyRoot = isRight
          ? poseidonHash(sibling, verifyRoot)
          : poseidonHash(verifyRoot, sibling);
      }
      if (verifyRoot === merkleRoot) {
        proof1 = { pathElements: note1.merklePathElements, pathIndices: note1.merklePathIndices };
      } else {
        proof1 = await this.reconstructProofFromSubtrees(note1);
      }
    } else {
      proof1 = await this.reconstructProofFromSubtrees(note1);
    }

    const proof2 = notesToSpend[1]?.merklePathElements
      ? { pathElements: notesToSpend[1].merklePathElements, pathIndices: notesToSpend[1].merklePathIndices! }
      : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

    // ── ZK proof generation ──
    const dummyOutput2Commitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);
    const dummyOutput2: Note = {
      amount: BigInt(0), ownerPubkey: BigInt(0), randomness: BigInt(0),
      tokenMint: tokenMintField, commitment: dummyOutput2Commitment,
    };

    const inputNotesForCircuit = notesToSpend[1]
      ? notesToSpend
      : [notesToSpend[0], dummyInputNote!];

    const zkProof = await this.generateProofClientSide({
      merkleRoot,
      nullifier1,
      nullifier2,
      outputCommitment1: changeNote.commitment,
      outputCommitment2: dummyOutput2Commitment,
      publicAmount: -amount,
      inputNotes: inputNotesForCircuit,
      outputNotes: [changeNote, dummyOutput2],
      proofs: [proof1, proof2],
      spendingKey: this.spendingKey!,
    });

    // ── Compute newRoot for change commitment ──
    const onChainState = await this.readOnChainFilledSubtrees();
    const localSubtrees = await this.loadLocalSubtrees(onChainState.leafCount);
    const useSubtrees = localSubtrees || onChainState.filledSubtrees;
    const { newRoot, updatedSubtrees, pathElements: changePathElements, pathIndices: changePathIndices } = this.computeNewRootFromSubtrees(
      useSubtrees, onChainState.leafCount, changeNote.commitment, onChainState.depth
    );
    await this.saveLocalSubtrees(updatedSubtrees, onChainState.leafCount + 1);

    // ── Build unshield instruction with EPHEMERAL payer ──
    const ephemeralKeypair = Keypair.generate();
    console.log('[ZK Relay Unshield] Ephemeral payer:', ephemeralKeypair.publicKey.toBase58().slice(0, 12) + '...');

    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()], this.programId
    );
    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()], this.programId
    );
    const [nullifierSetPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.NULLIFIER_SET, poolPDA.toBytes()], this.programId
    );
    const [vkDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vk_data'), poolPDA.toBytes()], this.programId
    );

    const discriminator = Buffer.from([0x15, 0xe4, 0x37, 0x18, 0xc2, 0x0a, 0x15, 0x16]);
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(amount, 0);

    const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);

    const data = Buffer.concat([
      discriminator,
      zkProof.pi_a, zkProof.pi_b, zkProof.pi_c,
      bigintToLeBytes(nullifier1),
      bigintToLeBytes(nullifier2),
      bigintToLeBytes(changeNote.commitment),
      bigintToLeBytes(dummyCommitment),
      bigintToLeBytes(merkleRoot),
      amountBuffer,
      bigintToLeBytes(newRoot),
    ]);

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: ephemeralKeypair.publicKey, isSigner: true, isWritable: true }, // payer = ephemeral
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },
        { pubkey: vkDataPDA, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: this.programId, isSigner: false, isWritable: false },
        { pubkey: this.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    // Compute budget for Groth16 verification
    const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');
    const computeLimitData = Buffer.alloc(5);
    computeLimitData.writeUInt8(2, 0);
    computeLimitData.writeUInt32LE(1_400_000, 1);

    const computeLimitIx = new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: computeLimitData,
    });

    // Build the tx with ephemeral as payer, sign with ephemeral
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const unshieldTx = new Transaction().add(computeLimitIx).add(ix);
    unshieldTx.feePayer = ephemeralKeypair.publicKey;
    unshieldTx.recentBlockhash = blockhash;
    unshieldTx.sign(ephemeralKeypair);

    const serializedTx = unshieldTx.serialize();
    console.log('[ZK Relay Unshield] Tx serialized:', serializedTx.length, 'bytes');

    // ── Submit via decentralized relay ──
    const { relayTransaction } = await import('../relay');
    const relaySignature = await relayTransaction(
      serializedTx,
      walletPublicKey,
      signTransaction,
    );

    // ── Update local notes ──
    this.removeSpentNotes(notesToSpend);
    if (changeAmount > BigInt(0)) {
      changeNote.leafIndex = onChainState.leafCount;
      changeNote.merkleRoot = newRoot;
      changeNote.merklePathElements = changePathElements;
      changeNote.merklePathIndices = changePathIndices;
      changeNote.isOnChain = true;
      this.addNote(changeNote);
    }
    await this.saveNotes();

    const totalTime = Date.now() - relayStart;
    console.log('[ZK Relay Unshield] SUCCESS in', totalTime, 'ms, relay sig:', relaySignature.slice(0, 20) + '...');

    return relaySignature;
  }

  /**
   * Unshield tokens to a STEALTH ADDRESS for maximum privacy
   *
   * Instead of sending to a known recipient address, this generates
   * a one-time stealth address that only the recipient can identify
   * and spend from using their viewing and spending keys.
   *
   * Privacy benefits:
   * - Recipient's real address is never revealed on-chain
   * - Each payment creates a unique, unlinkable address
   * - Only the recipient (with viewing key) can find their payments
   *
   * @param recipientSpendingPubKey - Recipient's stealth spending public key
   * @param recipientViewingPubKey - Recipient's stealth viewing public key
   * @param amount - Amount to unshield
   * @param walletPublicKey - Payer's wallet
   * @param signTransaction - Transaction signing function
   * @returns StealthUnshieldResult with info for recipient to find funds
   */
  async unshieldStealth(
    recipientSpendingPubKey: string,
    recipientViewingPubKey: string,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<StealthUnshieldResult> {

    // Generate one-time stealth address
    const spendingPubBytes = new PublicKey(recipientSpendingPubKey).toBytes();
    const viewingPubBytes = new PublicKey(recipientViewingPubKey).toBytes();
    const stealthData: StealthAddress = generateStealthAddress(
      spendingPubBytes,
      viewingPubBytes
    );


    // Convert stealth address to PublicKey
    const stealthRecipient = new PublicKey(stealthData.address);

    // Perform the actual unshield to the stealth address
    const signature = await this.unshield(
      stealthRecipient,
      amount,
      walletPublicKey,
      signTransaction
    );


    return {
      signature,
      stealthAddress: stealthData.address,
      ephemeralPublicKey: stealthData.ephemeralPublicKey,
      viewTag: stealthData.viewTag,
      amount,
    };
  }

  /**
   * Select notes for spending (simple greedy algorithm)
   * Only selects notes that are verified on-chain
   */
  private selectNotes(amount: bigint): { notesToSpend: Note[]; totalValue: bigint } {
    // Filter to only spendable notes - MUST be verified on-chain
    // Notes with merkle paths but not on-chain are from failed shield transactions
    const spendableNotes = this.notes.filter(note => note.isOnChain === true);


    if (spendableNotes.length === 0) {
      console.warn('[ZK] No spendable notes! All notes must be synced with on-chain state.');
    }

    const sortedNotes = [...spendableNotes].sort((a, b) =>
      a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0
    );

    const notesToSpend: Note[] = [];
    let totalValue = BigInt(0);

    for (const note of sortedNotes) {
      if (notesToSpend.length >= 2) break;
      if (totalValue >= amount && notesToSpend.length >= 1) break;

      notesToSpend.push(note);
      totalValue += note.amount;
    }

    return { notesToSpend, totalValue };
  }

  /**
   * Remove spent notes from local storage
   */
  private removeSpentNotes(spent: Note[]): void {
    const spentCommitments = new Set(spent.map(n => n.commitment.toString()));
    this.notes = this.notes.filter(n => !spentCommitments.has(n.commitment.toString()));
  }

  /**
   * Add a note with validation to prevent duplicate leafIndex
   * This prevents note corruption from duplicate entries
   */
  private addNote(note: Note): boolean {
    // Validate leafIndex is defined
    if (note.leafIndex === undefined) {
      console.warn('[ZK] Cannot add note without leafIndex');
      return false;
    }

    // Check for duplicate leafIndex
    const existingNote = this.notes.find(n => n.leafIndex === note.leafIndex);
    if (existingNote) {
      // If same commitment, it's a duplicate - skip silently
      if (existingNote.commitment.toString() === note.commitment.toString()) {
        return false;
      }

      // Different commitment at same index - this is corruption!
      console.error('[ZK] CORRUPTION DETECTED: Different note exists at leafIndex', note.leafIndex);
      console.error('[ZK] Existing commitment:', existingNote.commitment.toString().slice(0, 20));
      console.error('[ZK] New commitment:', note.commitment.toString().slice(0, 20));

      // Keep the existing note (blockchain should be source of truth via sync)
      return false;
    }

    // Valid - add the note
    this.notes.push(note);
    return true;
  }

  // Prover function injected by ZkProverProvider
  private proverFunction: ((inputs: Record<string, string>) => Promise<Groth16Proof>) | null = null;

  // Raw-format prover (returns snarkjs format for relayer, NOT byte arrays)
  private proverFunctionRaw: ((inputs: Record<string, string>) => Promise<{
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    publicSignals: string[];
  }>) | null = null;

  // Backend prover removed — all proving is client-side (WebView snarkjs).
  // Spending keys NEVER leave the device.

  /**
   * Set the prover function (called by ZkProverProvider)
   */
  setProver(prover: (inputs: Record<string, string>) => Promise<Groth16Proof>): void {
    this.proverFunction = prover;
  }

  /**
   * Set the raw-format prover (returns snarkjs format for relayer compatibility)
   */
  setProverRaw(prover: (inputs: Record<string, string>) => Promise<{
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    publicSignals: string[];
  }>): void {
    this.proverFunctionRaw = prover;
  }

  /**
   * Convert snarkjs proof format to byte arrays for Solana
   */
  private convertSnarkjsProof(snarkjsProof: any): Groth16Proof {
    const fieldToBytesBE = (value: bigint): Uint8Array => {
      const bytes = new Uint8Array(32);
      let temp = value;
      for (let i = 31; i >= 0; i--) {
        bytes[i] = Number(temp & BigInt(0xff));
        temp = temp >> BigInt(8);
      }
      return bytes;
    };

    const pointToBytes = (point: string[]): Uint8Array => {
      const bytes = new Uint8Array(64);
      bytes.set(fieldToBytesBE(BigInt(point[0])), 0);
      bytes.set(fieldToBytesBE(BigInt(point[1])), 32);
      return bytes;
    };

    const point2ToBytes = (point: string[][]): Uint8Array => {
      const bytes = new Uint8Array(128);
      bytes.set(fieldToBytesBE(BigInt(point[0][1])), 0);
      bytes.set(fieldToBytesBE(BigInt(point[0][0])), 32);
      bytes.set(fieldToBytesBE(BigInt(point[1][1])), 64);
      bytes.set(fieldToBytesBE(BigInt(point[1][0])), 96);
      return bytes;
    };

    return {
      pi_a: pointToBytes(snarkjsProof.pi_a.slice(0, 2)),
      pi_b: point2ToBytes(snarkjsProof.pi_b.slice(0, 2)),
      pi_c: pointToBytes(snarkjsProof.pi_c.slice(0, 2)),
    };
  }

  /**
   * Generate proof client-side via WebView snarkjs.
   * Requires ZkProverProvider to be mounted with circuit files loaded.
   */
  private async generateProofClientSide(inputs: {
    merkleRoot: bigint;
    nullifier1: bigint;
    nullifier2: bigint;
    outputCommitment1: bigint;
    outputCommitment2: bigint;
    publicAmount?: bigint;
    inputNotes: Note[];
    outputNotes?: Note[];
    proofs: { pathElements: bigint[]; pathIndices: number[] }[];
    spendingKey: bigint;
  }): Promise<Groth16Proof> {

    // Format inputs for the circuit (must use snake_case to match circuit signals)
    const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));

    // BN254 field modulus - negative numbers must be represented as p - |amount|
    const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

    // Convert public_amount to field representation
    // For unshield, publicAmount is negative (tokens leaving pool)
    // In field arithmetic: -x = p - x
    let publicAmountField = inputs.publicAmount ?? BigInt(0);
    if (publicAmountField < BigInt(0)) {
      publicAmountField = FIELD_MODULUS + publicAmountField;
    }

    const circuitInputs: Record<string, string> = {
      // Public inputs (snake_case)
      merkle_root: inputs.merkleRoot.toString(),
      nullifier_1: inputs.nullifier1.toString(),
      nullifier_2: inputs.nullifier2.toString(),
      output_commitment_1: inputs.outputCommitment1.toString(),
      output_commitment_2: inputs.outputCommitment2.toString(),
      public_amount: publicAmountField.toString(),
      token_mint: tokenMintField.toString(),

      // Private inputs - Input note 1
      in_amount_1: inputs.inputNotes[0]?.amount.toString() ?? '0',
      in_owner_pubkey_1: inputs.inputNotes[0]?.ownerPubkey.toString() ?? '0',
      in_randomness_1: inputs.inputNotes[0]?.randomness.toString() ?? '0',
      in_path_elements_1: JSON.stringify(inputs.proofs[0].pathElements.map(e => e.toString())),
      in_path_indices_1: JSON.stringify(inputs.proofs[0].pathIndices.map(i => i.toString())),

      // Private inputs - Input note 2
      in_amount_2: inputs.inputNotes[1]?.amount.toString() ?? '0',
      in_owner_pubkey_2: inputs.inputNotes[1]?.ownerPubkey.toString() ?? '0',
      in_randomness_2: inputs.inputNotes[1]?.randomness.toString() ?? '0',
      in_path_elements_2: JSON.stringify(inputs.proofs[1].pathElements.map(e => e.toString())),
      in_path_indices_2: JSON.stringify(inputs.proofs[1].pathIndices.map(i => i.toString())),

      // Private inputs - Output notes
      out_amount_1: inputs.outputNotes?.[0]?.amount.toString() ?? '0',
      out_recipient_1: inputs.outputNotes?.[0]?.ownerPubkey.toString() ?? '0',
      out_randomness_1: inputs.outputNotes?.[0]?.randomness.toString() ?? '0',
      out_amount_2: inputs.outputNotes?.[1]?.amount.toString() ?? '0',
      out_recipient_2: inputs.outputNotes?.[1]?.ownerPubkey.toString() ?? '0',
      out_randomness_2: inputs.outputNotes?.[1]?.randomness.toString() ?? '0',

      // Spending key
      spending_key: inputs.spendingKey.toString(),
    };


    // Verify commitment matches (critical for proof validity)
    const circuitComputedCommitment1 = poseidonHash(
      BigInt(circuitInputs.in_amount_1),
      BigInt(circuitInputs.in_owner_pubkey_1),
      BigInt(circuitInputs.in_randomness_1),
      tokenMintField
    );
    if (circuitComputedCommitment1 !== inputs.inputNotes[0]?.commitment) {
      console.error('[ZK] Commitment mismatch - proof will fail');
      throw new Error('Commitment mismatch: stored note does not match computed commitment');
    }

    // TRUSTLESS: Try client-side prover FIRST (spending_key stays on device)
    if (this.proverFunction) {
      try {
        console.log('[ZK] Generating proof locally (trustless mode)...');
        const proof = await this.proverFunction(circuitInputs);
        return proof;
      } catch (error) {
        console.error('[ZK] Client-side proof generation failed:', error);
        console.error('[ZK] This error means the circuit constraints are not satisfied.');
        console.error('[ZK] Most likely cause: commitment mismatch or invalid merkle proof.');
        throw error;
      }
    }

    // HARD FAIL: Never send spending_key to a remote server.
    // The client-side prover must be loaded via ZkProverProvider.
    throw new Error(
      'ZK Prover not available. Client-side prover is not loaded. ' +
      'Restart the app to load circuits locally. ' +
      'Spending keys NEVER leave this device.'
    );
  }

  /**
   * Scan blockchain for incoming shielded notes
   * Looks for ShieldEvent logs emitted by our program
   */
  async scanIncomingNotes(afterSignature?: string): Promise<{
    found: number;
    newBalance: bigint;
  }> {
    if (!this.ownerPubkey || !this.viewingKey) {
      throw new Error('ZK Service not initialized');
    }


    // Get merkle tree PDA
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );
    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    // Fetch recent signatures for the merkle tree account
    const signatures = await this.connection.getSignaturesForAddress(
      merkleTreePDA,
      {
        limit: 100,
        until: afterSignature,
      }
    );

    let foundCount = 0;

    for (const sigInfo of signatures.reverse()) {
      try {
        const tx = await this.connection.getTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx?.meta?.logMessages) continue;

        // Look for ShieldEvent logs
        for (const log of tx.meta.logMessages) {
          if (log.includes('ShieldEvent')) {
            // Parse the event data from logs
            const eventMatch = log.match(/ShieldEvent: commitment=(\w+), amount=(\d+)/);
            if (eventMatch) {
              const commitment = BigInt('0x' + eventMatch[1]);
              const amount = BigInt(eventMatch[2]);

              // Check if this note belongs to us by checking commitment
              const matched = await this.tryDecryptNote(commitment, amount);
              if (matched) {
                foundCount++;
              }
            }
          }
        }
      } catch (error) {
        console.warn('[ZK] Error processing transaction:', sigInfo.signature, error);
      }
    }

    // Save last scanned signature
    if (signatures.length > 0) {
      await this.setLastScannedSignature(signatures[0].signature);
    }


    return {
      found: foundCount,
      newBalance: this.getShieldedBalance(),
    };
  }

  /**
   * Try to decrypt/claim a note based on commitment
   */
  private async tryDecryptNote(commitment: bigint, amount: bigint): Promise<boolean> {
    if (!this.ownerPubkey) return false;

    // Check if we already have this note
    const existingNote = this.notes.find(n => n.commitment === commitment);
    if (existingNote) return false;

    // For notes we created ourselves, we can reconstruct
    // For incoming notes, we'd need the randomness from encrypted note data
    // This is a simplified check - full implementation would decrypt the note

    // Try to find if this commitment matches our ownerPubkey
    // In a full implementation, the sender encrypts note data with our viewing key
    const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));

    // Brute force check with common randomness values (simplified)
    // Real implementation would decrypt using viewing key
    const potentialNote = await this.checkOutputCommitment(
      commitment,
      amount,
      this.ownerPubkey,
      tokenMintField
    );

    if (potentialNote) {
      potentialNote.leafIndex = this.merkleTree.leafCount;
      this.merkleTree.insert(commitment);
      this.addNote(potentialNote);
      await this.saveNotes();
      return true;
    }

    return false;
  }

  /**
   * Check if a commitment matches expected values
   * Returns the note if it matches, null otherwise
   */
  private async checkOutputCommitment(
    commitment: bigint,
    amount: bigint,
    ownerPubkey: bigint,
    tokenMint: bigint
  ): Promise<Note | null> {
    // In a real system, you'd decrypt the note data using viewing key
    // For now, we check if we can reconstruct the commitment

    // Try different randomness values (very simplified)
    // Real implementation would use encrypted note data
    for (let i = 0; i < 10; i++) {
      const testRandomness = BigInt(i);
      const testCommitment = poseidonHash(amount, ownerPubkey, testRandomness, tokenMint);

      if (testCommitment === commitment) {
        return {
          amount,
          ownerPubkey,
          randomness: testRandomness,
          tokenMint,
          commitment,
        };
      }
    }

    return null;
  }

  /**
   * Get last scanned signature from storage
   */
  async getLastScannedSignature(): Promise<string | undefined> {
    try {
      const sig = await SecureStore.getItemAsync('zk_last_scanned_sig');
      return sig ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Store last scanned signature
   */
  private async setLastScannedSignature(signature: string): Promise<void> {
    try {
      await SecureStore.setItemAsync('zk_last_scanned_sig', signature);
    } catch (error) {
      console.error('[ZK] Failed to save last scanned signature:', error);
    }
  }

  /**
   * Save notes to secure storage
   */
  private async saveNotes(): Promise<void> {
    try {
      const serialized = this.notes.map(note => ({
        amount: note.amount.toString(),
        ownerPubkey: note.ownerPubkey.toString(),
        randomness: note.randomness.toString(),
        tokenMint: note.tokenMint.toString(),
        commitment: note.commitment.toString(),
        leafIndex: note.leafIndex,
        // Store merkle path for later proof generation
        merklePathElements: note.merklePathElements?.map(e => e.toString()),
        merklePathIndices: note.merklePathIndices,
        merkleRoot: note.merkleRoot?.toString(),
        isOnChain: note.isOnChain,
      }));

      await SecureStore.setItemAsync('zk_notes', JSON.stringify(serialized));
    } catch (error) {
      console.error('[ZK] Failed to save notes:', error);
    }
  }

  /**
   * Load notes from secure storage
   */
  private async loadNotes(): Promise<void> {
    try {
      const stored = await SecureStore.getItemAsync('zk_notes');
      if (stored) {
        const parsed = JSON.parse(stored);
        const allNotes = parsed.map((note: any) => ({
          amount: BigInt(note.amount),
          ownerPubkey: BigInt(note.ownerPubkey),
          randomness: BigInt(note.randomness),
          tokenMint: BigInt(note.tokenMint),
          commitment: BigInt(note.commitment),
          leafIndex: note.leafIndex,
          // Restore merkle path if available
          merklePathElements: note.merklePathElements?.map((e: string) => BigInt(e)),
          merklePathIndices: note.merklePathIndices,
          merkleRoot: note.merkleRoot ? BigInt(note.merkleRoot) : undefined,
          isOnChain: note.isOnChain,
        }));

        // Filter notes: only keep notes that belong to current key
        const validNotes = allNotes.filter((note: Note) => {
          return note.ownerPubkey.toString() === this.ownerPubkey?.toString();
        });

        // Deduplicate notes by leafIndex (prevent corruption)
        const seenIndices = new Map<number, Note>();
        const deduplicatedNotes: Note[] = [];
        let duplicatesRemoved = 0;

        for (const note of validNotes) {
          if (note.leafIndex === undefined) {
            console.warn('[ZK] Skipping note without leafIndex');
            duplicatesRemoved++;
            continue;
          }

          const existing = seenIndices.get(note.leafIndex);
          if (existing) {
            console.warn(`[ZK] Duplicate leafIndex ${note.leafIndex} detected - keeping first, removing duplicate`);
            duplicatesRemoved++;
            continue;
          }

          seenIndices.set(note.leafIndex, note);
          deduplicatedNotes.push(note);
        }

        if (duplicatesRemoved > 0) {
        }


        // Check if we need to save cleaned up notes
        const needsSave = deduplicatedNotes.length < allNotes.length || duplicatesRemoved > 0;
        if (needsSave) {
          // Save only valid deduplicated notes
          if (deduplicatedNotes.length > 0) {
            const serialized = deduplicatedNotes.map((note: Note) => ({
              amount: note.amount.toString(),
              ownerPubkey: note.ownerPubkey.toString(),
              randomness: note.randomness.toString(),
              tokenMint: note.tokenMint.toString(),
              commitment: note.commitment.toString(),
              leafIndex: note.leafIndex,
              merklePathElements: note.merklePathElements?.map(e => e.toString()),
              merklePathIndices: note.merklePathIndices,
              merkleRoot: note.merkleRoot?.toString(),
              isOnChain: note.isOnChain,
            }));
            await SecureStore.setItemAsync('zk_notes', JSON.stringify(serialized));
          } else {
            await SecureStore.deleteItemAsync('zk_notes');
          }
        }

        this.notes = deduplicatedNotes;

        // Note: We don't rebuild merkle tree here since it requires full on-chain sync
        // The merkle tree will be synced before any operation that needs it
      }
    } catch (error) {
      console.error('[ZK] Failed to load notes:', error);
      this.notes = [];
    }
  }

  /**
   * Reset storage - clears all notes and caches from SecureStore
   * Call this when migrating data, resetting the wallet, or when there's a persistent root mismatch
   */
  static async resetStorage(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync('zk_notes');
      await SecureStore.deleteItemAsync('zk_all_commitments');
      await SecureStore.deleteItemAsync('zk_global_commitments');
      await SecureStore.deleteItemAsync('zk_last_scanned_sig');
      await AsyncStorage.removeItem('zk_tree_cache');
    } catch (error) {
      console.error('[ZK] Failed to reset storage:', error);
    }
  }

  /**
   * Sync Merkle tree with on-chain state
   *
   * Fast path (relayer available): ~200ms
   *   1. Read on-chain MerkleTreeState (1 RPC call)
   *   2. Load tree cache from AsyncStorage
   *   3. Fetch only NEW commitments from relayer (1 HTTP call)
   *   4. Insert delta into local tree
   *   5. Verify root matches on-chain
   *
   * Slow path (relayer down): ~2.5 min (original behavior)
   *   Falls back to fetchCommitmentsFromChain()
   */
  async syncMerkleTree(): Promise<void> {

    try {
      // Get the MerkleTree PDA
      const [poolPDA] = PublicKey.findProgramAddressSync(
        [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
        this.programId
      );
      const [merkleTreePDA] = PublicKey.findProgramAddressSync(
        [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
        this.programId
      );

      // Step 1: Read on-chain state (1 RPC call, ~200ms)
      const merkleTreeAccount = await this.connection.getAccountInfo(merkleTreePDA);
      if (!merkleTreeAccount) {
        return;
      }

      const rootBytes = merkleTreeAccount.data.slice(8 + 32, 8 + 32 + 32);
      const leafCountOffset = 8 + 32 + 32;
      const onChainLeafCount = Number(merkleTreeAccount.data.readBigUInt64LE(leafCountOffset));

      let onChainRoot = BigInt(0);
      for (let i = 31; i >= 0; i--) {
        onChainRoot = (onChainRoot << BigInt(8)) | BigInt(rootBytes[i]);
      }

      // Step 2: Load tree cache from AsyncStorage
      const localLeafCount = this.merkleTree.leafCount;

      if (localLeafCount === 0) {
        // Tree not loaded yet — try loading from persistent cache
        await this.loadTreeCache();
      }

      const cachedLeafCount = this.merkleTree.leafCount;

      // If local tree is already up-to-date, verify and return
      if (cachedLeafCount === onChainLeafCount && this.merkleTree.root === onChainRoot) {
        console.log('[ZK Sync] Tree already current:', cachedLeafCount, 'leaves');
        this._onChainRoot = null;
        await this.updateNoteIndices();
        return;
      }

      if (cachedLeafCount === onChainLeafCount && this.merkleTree.root !== onChainRoot) {
        // Leaf counts match but roots differ — local tree's root is a known historical
        // root on-chain (from a previous shield/operation), so use it directly.
        // No correction shield needed since the pool tracks up to 100 historical roots.
        console.warn('[ZK Sync] Root mismatch with matching leaf count — using local tree (historical root)');
        this._onChainRoot = null; // Don't trigger correction shield
        await this.updateNoteIndices();
        return;
      }

      // If local tree is ahead of on-chain, trim phantom leaves from failed correction shields.
      // Phantom leaves accumulate when correction shields insert into local tree at position M
      // while on-chain inserts at position N < M, causing progressive desync.
      if (cachedLeafCount > onChainLeafCount) {
        console.warn('[ZK Sync] Local tree ahead of on-chain:', cachedLeafCount, '>', onChainLeafCount, '— trimming to match');
        const rebuiltTree = new MerkleTree(MERKLE_TREE_DEPTH);
        for (let i = 0; i < onChainLeafCount; i++) {
          const leaf = this.merkleTree.getLeaf(i);
          if (leaf !== undefined) {
            rebuiltTree.insert(leaf);
          }
        }
        this.merkleTree = rebuiltTree;
        await this.saveTreeCache();

        // Save correct subtrees for the trimmed tree
        if (onChainLeafCount > 0) {
          const correctSubtrees = this.merkleTree.getFilledSubtrees();
          await this.saveLocalSubtrees(correctSubtrees, onChainLeafCount);
          console.log('[ZK Sync] Saved correct subtrees for', onChainLeafCount, 'leaves');
        }

        this._onChainRoot = onChainRoot;
        await this.updateNoteIndices();
        return;
      }

      // Step 3: Fetch new commitments from chain (fully on-chain, no backend)
      console.log('[ZK Sync] Need', onChainLeafCount - cachedLeafCount, 'new commitments (have', cachedLeafCount, 'of', onChainLeafCount, ')');

      const allCommitments = await this.fetchCommitmentsFromChain(merkleTreePDA, onChainLeafCount);
      console.log('[ZK Sync] Got', allCommitments.length, 'commitments from chain');

      // Rebuild the merkle tree from all commitments
      this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
      for (const commitment of allCommitments) {
        this.merkleTree.insert(commitment);
      }

      // Verify local root matches on-chain root
      if (this.merkleTree.root !== onChainRoot) {
        console.warn('[ZK Sync] Root mismatch after chain rebuild');
        if (this.merkleTree.leafCount === onChainLeafCount) {
          console.warn('[ZK Sync] Leaf counts match — on-chain root was computed with different zero values');
          console.warn('[ZK Sync] Using local tree for proofs');
          this._onChainRoot = onChainRoot;
        } else {
          console.error('[ZK Sync] Leaf count mismatch! Local:', this.merkleTree.leafCount, 'On-chain:', onChainLeafCount);
          throw new Error('Merkle tree leaf count mismatch - some commitments could not be extracted');
        }
      } else {
        this._onChainRoot = null;
      }

      // Save tree cache for next time
      await this.saveTreeCache();
      await this.updateNoteIndices();
      await this.saveNotes();

      // Extract and save correct subtrees so next shield uses them
      if (this.merkleTree.leafCount > 0) {
        const correctSubtrees = this.merkleTree.getFilledSubtrees();
        await this.saveLocalSubtrees(correctSubtrees, this.merkleTree.leafCount);
        console.log('[ZK Sync] Saved correct subtrees for future shields');
      }

    } catch (error) {
      console.error('[ZK] Failed to sync Merkle tree:', error);
      throw error;
    }
  }


  /**
   * Update note leaf indices and on-chain status after tree sync
   */
  private async updateNoteIndices(): Promise<void> {
    for (const note of this.notes) {
      const noteCommitmentStr = note.commitment.toString();

      // Verify stored commitment integrity
      const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));
      const recomputedCommitment = poseidonHash(note.amount, note.ownerPubkey, note.randomness, tokenMintField);
      if (recomputedCommitment !== note.commitment) {
        console.error('[ZK] CRITICAL: Stored commitment does not match recomputed!');
      }

      // Find note in tree
      let found = false;
      for (let i = 0; i < this.merkleTree.leafCount; i++) {
        if (this.merkleTree.getLeaf(i)?.toString() === noteCommitmentStr) {
          note.isOnChain = true;
          if (note.leafIndex !== i) {
            note.leafIndex = i;
          }
          found = true;
          break;
        }
      }

      if (!found) {
        note.isOnChain = false;
        console.warn('[ZK] Note commitment not found in tree:', noteCommitmentStr.slice(0, 20));
      }
    }

    // Remove notes that are not on-chain
    const validNotes = this.notes.filter(note => note.isOnChain === true);
    if (validNotes.length < this.notes.length) {
      this.notes = validNotes;
    }
  }

  /**
   * Load Merkle tree from persistent cache (AsyncStorage)
   */
  private async loadTreeCache(): Promise<void> {
    try {
      const cached = await AsyncStorage.getItem('zk_tree_cache');
      if (!cached) return;

      const data = JSON.parse(cached) as {
        commitments: string[];
        leafCount: number;
        root: string;
      };

      if (!data.commitments || data.commitments.length === 0) return;

      console.log('[ZK Sync] Loading tree cache:', data.commitments.length, 'commitments');
      this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
      for (const c of data.commitments) {
        this.merkleTree.insert(BigInt(c));
      }
      console.log('[ZK Sync] Tree cache loaded, root:', this.merkleTree.root.toString().slice(0, 20) + '...');
    } catch (e) {
      console.warn('[ZK Sync] Failed to load tree cache:', e);
    }
  }

  /**
   * Save Merkle tree to persistent cache (AsyncStorage)
   */
  private async saveTreeCache(): Promise<void> {
    try {
      const commitments: string[] = [];
      for (let i = 0; i < this.merkleTree.leafCount; i++) {
        const leaf = this.merkleTree.getLeaf(i);
        commitments.push(leaf ? leaf.toString() : '0');
      }

      const data = {
        commitments,
        leafCount: this.merkleTree.leafCount,
        root: this.merkleTree.root.toString(),
      };

      await AsyncStorage.setItem('zk_tree_cache', JSON.stringify(data));
      console.log('[ZK Sync] Saved tree cache:', commitments.length, 'commitments');
    } catch (e) {
      console.warn('[ZK Sync] Failed to save tree cache:', e);
    }
  }

  /**
   * Load locally-stored corrected filledSubtrees (tiny: 20 bigints).
   * These are properly updated after each shield, unlike on-chain subtrees
   * where only level 0 gets updated by insert_with_root.
   */
  private async loadLocalSubtrees(expectedLeafCount?: number): Promise<bigint[] | null> {
    try {
      const raw = await AsyncStorage.getItem('zk_local_subtrees');
      if (!raw) return null;
      const data = JSON.parse(raw) as { subtrees: string[]; leafCount: number };
      if (!data.subtrees || data.subtrees.length === 0) return null;
      // Reject subtrees if they don't match the expected on-chain leaf count —
      // stale subtrees (from inflated local tree) produce wrong roots
      const subtrees = data.subtrees.map(s => BigInt(s));
      this._cachedSubtrees = subtrees; // Cache for proof reconstruction
      if (expectedLeafCount !== undefined && data.leafCount !== expectedLeafCount) {
        console.warn('[ZK Shield] Stale local subtrees:', data.leafCount, 'leaves, need', expectedLeafCount);
        return null;
      }
      return subtrees;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save corrected filledSubtrees locally after each shield.
   */
  private async saveLocalSubtrees(subtrees: bigint[], leafCount?: number): Promise<void> {
    try {
      const data = {
        subtrees: subtrees.map(s => s.toString()),
        leafCount: leafCount ?? this.merkleTree.leafCount,
      };
      await AsyncStorage.setItem('zk_local_subtrees', JSON.stringify(data));
      this._cachedSubtrees = subtrees; // Keep in memory for proof reconstruction
    } catch (e) {
      console.warn('[ZK Shield] Could not save local subtrees:', e);
    }
  }

  /**
   * Fetch all commitments from blockchain by parsing shield and unshield transaction logs
   * IMPORTANT: Blockchain is the source of truth - stored notes are used as fallback only
   */
  private async fetchCommitmentsFromChain(merkleTreePDA: PublicKey, expectedCount: number): Promise<bigint[]> {

    // Map of leafIndex -> commitment (blockchain data takes priority)
    const commitmentMap = new Map<number, bigint>();

    // Store notes as fallback ONLY (will be used if blockchain extraction fails)
    const storedNotesFallback = new Map<number, bigint>();
    for (const note of this.notes) {
      if (note.leafIndex !== undefined && note.commitment) {
        storedNotesFallback.set(note.leafIndex, note.commitment);
      }
    }

    // Fetch all transactions for the merkle tree
    let signatures: Array<{signature: string; slot: number}> = [];
    let lastSig: string | undefined;

    // Paginate through all signatures
    while (true) {
      const batch = await this.connection.getSignaturesForAddress(
        merkleTreePDA,
        { limit: 100, before: lastSig }
      );
      if (batch.length === 0) break;

      // Filter only successful transactions
      signatures.push(...batch.filter(s => !s.err).map(s => ({ signature: s.signature, slot: s.slot })));
      lastSig = batch[batch.length - 1].signature;

      // Safety limit
      if (signatures.length > 500) break;
    }


    // Process in chronological order (oldest first)
    signatures.sort((a, b) => a.slot - b.slot);

    // Helper function to fetch transaction with retry on rate limit
    const fetchTxWithRetry = async (sig: string, retries = 5): Promise<any> => {
      for (let i = 0; i < retries; i++) {
        try {
          const tx = await this.connection.getTransaction(sig, {
            maxSupportedTransactionVersion: 0,
          });
          return tx;
        } catch (e: any) {
          if (e?.message?.includes('429') || e?.message?.includes('rate') || e?.message?.includes('Too many')) {
            const delay = Math.pow(2, i) * 1500; // Exponential backoff: 1.5s, 3s, 6s, 12s, 24s
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            throw e;
          }
        }
      }
      return null;
    };

    // Helper to parse a fetched transaction and extract commitments into commitmentMap
    const parseTxCommitments = (tx: any) => {
      const logs = tx.meta.logMessages;

      let isShield = false;
      let isUnshield = false;
      let isTransfer = false;
      let leafIndex: number | null = null;
      let transferIndices: [number, number] | null = null;

      for (const log of logs) {
        if (log.includes('Shield') && !log.includes('Unshield')) isShield = true;
        if (log.includes('Unshield')) isUnshield = true;
        if (log.includes('Private transfer completed') || log.includes('Instruction: Transfer')) isTransfer = true;

        const indexMatch = log.match(/Commitment added at index: (\d+)/);
        if (indexMatch) leafIndex = parseInt(indexMatch[1], 10);

        const changeIndexMatch = log.match(/Change commitment at index: (\d+)/);
        if (changeIndexMatch) leafIndex = parseInt(changeIndexMatch[1], 10);

        const transferMatch = log.match(/New commitments at indices: (\d+), (\d+)/);
        if (transferMatch) transferIndices = [parseInt(transferMatch[1], 10), parseInt(transferMatch[2], 10)];
      }

      const txData = tx.transaction.message;

      const extractCommitmentBytes = (data: Uint8Array, offset: number, len: number = 32): bigint => {
        const bytes = data.slice(offset, offset + len);
        let c = BigInt(0);
        for (let i = 31; i >= 0; i--) c = (c << BigInt(8)) | BigInt(bytes[i]);
        return c;
      };

      if (isShield && leafIndex !== null) {
        if ('compiledInstructions' in txData) {
          const pi = txData.staticAccountKeys.findIndex((k: PublicKey) => k.equals(this.programId));
          if (pi !== -1) {
            for (const ix of txData.compiledInstructions) {
              if (ix.programIdIndex === pi && ix.data.length >= 80) {
                const commitment = extractCommitmentBytes(Buffer.from(ix.data), 16);
                commitmentMap.set(leafIndex, commitment);
                break;
              }
            }
          }
        } else {
          for (const ix of txData.instructions) {
            const ixDataRaw = typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data;
            if (ix.programId.equals(this.programId) && ixDataRaw.length >= 80) {
              const commitment = extractCommitmentBytes(ixDataRaw, 16);
              commitmentMap.set(leafIndex, commitment);
              break;
            }
          }
        }
      }

      if (isUnshield && leafIndex !== null) {
        const OFFSET = 8 + 256 + 32 + 32; // 328
        if ('compiledInstructions' in txData) {
          const pi = txData.staticAccountKeys.findIndex((k: PublicKey) => k.equals(this.programId));
          if (pi !== -1) {
            for (const ix of txData.compiledInstructions) {
              if (ix.programIdIndex === pi && ix.data.length > 400) {
                const commitment = extractCommitmentBytes(Buffer.from(ix.data), OFFSET);
                commitmentMap.set(leafIndex, commitment);
                break;
              }
            }
          }
        } else {
          for (const ix of txData.instructions) {
            const ixDataRaw = typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data;
            if (ix.programId.equals(this.programId) && ixDataRaw.length > 400) {
              const commitment = extractCommitmentBytes(ixDataRaw, OFFSET);
              commitmentMap.set(leafIndex, commitment);
              break;
            }
          }
        }
      }

      if (isTransfer && transferIndices) {
        const OFF1 = 8 + 256 + 32 + 32; // 328
        const OFF2 = OFF1 + 32; // 360
        if ('compiledInstructions' in txData) {
          const pi = txData.staticAccountKeys.findIndex((k: PublicKey) => k.equals(this.programId));
          if (pi !== -1) {
            for (const ix of txData.compiledInstructions) {
              if (ix.programIdIndex === pi && ix.data.length > 400) {
                commitmentMap.set(transferIndices[0], extractCommitmentBytes(ix.data, OFF1));
                commitmentMap.set(transferIndices[1], extractCommitmentBytes(ix.data, OFF2));
                break;
              }
            }
          }
        } else {
          for (const ix of txData.instructions) {
            const ixDataRaw = typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data;
            if (ix.programId.equals(this.programId) && ixDataRaw.length > 400) {
              commitmentMap.set(transferIndices[0], extractCommitmentBytes(ixDataRaw, OFF1));
              commitmentMap.set(transferIndices[1], extractCommitmentBytes(ixDataRaw, OFF2));
              break;
            }
          }
        }
      }
    };

    // Load global commitment cache (all commitments ever seen)
    let globalCommitmentCache: Map<number, string> = new Map();
    try {
      const cached = await SecureStore.getItemAsync('zk_global_commitments');
      if (cached) {
        const parsed = JSON.parse(cached);
        globalCommitmentCache = new Map(Object.entries(parsed).map(([k, v]) => [parseInt(k), v as string]));
      }
    } catch (e) {
      console.warn('[ZK] Failed to load commitment cache');
    }

    // Add delay between fetches to avoid rate limiting
    const failedSignatures: string[] = [];
    let fetchCount = 0;
    for (const { signature } of signatures) {
      try {
        // Add small delay every 3 fetches to avoid rate limiting
        if (fetchCount > 0 && fetchCount % 3 === 0) {
          await new Promise(resolve => setTimeout(resolve, 400));
        }
        fetchCount++;

        const tx = await fetchTxWithRetry(signature);

        if (!tx?.meta?.logMessages) {
          failedSignatures.push(signature);
          continue;
        }

        parseTxCommitments(tx);
      } catch (e) {
        console.warn('[ZK] Failed to parse transaction:', e);
      }
    }

    // Second pass: retry failed fetches with longer delays
    if (failedSignatures.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5s cooldown

      for (const sig of failedSignatures) {
        try {
          await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5s between retries
          const tx = await fetchTxWithRetry(sig, 5);
          if (tx?.meta?.logMessages) {
            parseTxCommitments(tx);
          }
        } catch (e) {
          console.warn('[ZK] Retry failed for transaction:', e);
        }
      }
    }


    // Save extracted commitments to global cache
    for (const [index, commitment] of commitmentMap) {
      globalCommitmentCache.set(index, commitment.toString());
    }

    // Persist global cache
    try {
      const cacheObj: Record<string, string> = {};
      for (const [k, v] of globalCommitmentCache) {
        cacheObj[k.toString()] = v;
      }
      await SecureStore.setItemAsync('zk_global_commitments', JSON.stringify(cacheObj));
    } catch (e) {
      console.warn('[ZK] Failed to save commitment cache');
    }

    // Build ordered array with multiple fallback layers
    const commitments: bigint[] = [];
    let missingCount = 0;
    let cacheHits = 0;
    for (let i = 0; i < expectedCount; i++) {
      const commitment = commitmentMap.get(i);
      if (commitment) {
        commitments.push(commitment);
      } else {
        // Layer 1: Try stored notes fallback (our own notes)
        const fallbackCommitment = storedNotesFallback.get(i);
        if (fallbackCommitment) {
          commitments.push(fallbackCommitment);
          missingCount++;
        } else {
          // Layer 2: Try global commitment cache (all commitments ever seen)
          const cachedCommitment = globalCommitmentCache.get(i);
          if (cachedCommitment) {
            commitments.push(BigInt(cachedCommitment));
            cacheHits++;
          } else {
            // No fallback available - this will corrupt the tree
            console.error('[ZK] No fallback available for index', i);
            throw new Error(`Missing commitment at index ${i} - cannot rebuild merkle tree`);
          }
        }
      }
    }

    if (missingCount > 0 || cacheHits > 0) {
      console.warn('[ZK] Had', missingCount, 'note fallbacks and', cacheHits, 'cache hits');
    }

    return commitments;
  }

  /**
   * Read the on-chain MerkleTreeState account to get filled_subtrees, root, and leaf_count.
   * This is a single RPC call (~200ms) vs fetchCommitmentsFromChain (~2.5 min).
   * Used for optimistic shield where we only need subtrees to compute the new root.
   *
   * On-chain layout (MerkleTreeState):
   *   8 bytes  - Anchor discriminator
   *   32 bytes - pool (Pubkey)
   *   32 bytes - root ([u8; 32])
   *   8 bytes  - leaf_count (u64 LE)
   *   1 byte   - depth (u8)
   *   4 bytes  - filled_subtrees Vec length (u32 LE, Borsh Vec prefix)
   *   N * 32   - filled_subtrees entries ([u8; 32] each)
   *   1 byte   - bump (u8)
   */
  private async readOnChainFilledSubtrees(): Promise<{
    root: bigint;
    leafCount: number;
    depth: number;
    filledSubtrees: bigint[];
  }> {
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );
    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    const account = await this.connection.getAccountInfo(merkleTreePDA);
    if (!account) {
      throw new Error('MerkleTree account not found on-chain');
    }

    const data = account.data;
    let offset = 8; // skip discriminator

    // pool: 32 bytes (skip)
    offset += 32;

    // root: 32 bytes (little-endian)
    const rootBytes = data.slice(offset, offset + 32);
    let root = BigInt(0);
    for (let i = 31; i >= 0; i--) {
      root = (root << BigInt(8)) | BigInt(rootBytes[i]);
    }
    offset += 32;

    // leaf_count: u64 LE
    const leafCount = Number(data.readBigUInt64LE(offset));
    offset += 8;

    // depth: u8
    const depth = data[offset];
    offset += 1;

    // filled_subtrees: Borsh Vec<[u8; 32]>
    // Vec prefix: 4 bytes u32 LE length
    const vecLen = data.readUInt32LE(offset);
    offset += 4;

    const filledSubtrees: bigint[] = [];
    for (let i = 0; i < vecLen; i++) {
      const bytes = data.slice(offset, offset + 32);
      let val = BigInt(0);
      for (let j = 31; j >= 0; j--) {
        val = (val << BigInt(8)) | BigInt(bytes[j]);
      }
      filledSubtrees.push(val);
      offset += 32;
    }

    return { root, leafCount, depth, filledSubtrees };
  }

  /**
   * Compute the new Merkle root after inserting a leaf, using only filledSubtrees.
   * This mirrors the on-chain insert logic from merkle_tree.rs.
   *
   * Algorithm: Walk from leaf to root. At each level:
   *   - If currentIndex is even (left child): hash(currentHash, zeroValue[level])
   *   - If currentIndex is odd (right child): hash(filledSubtrees[level], currentHash)
   *
   * Also returns the updated filledSubtrees (level 0 gets the new leaf).
   */
  private computeNewRootFromSubtrees(
    filledSubtrees: bigint[],
    leafCount: number,
    newLeaf: bigint,
    depth: number = MERKLE_TREE_DEPTH
  ): { newRoot: bigint; updatedSubtrees: bigint[]; pathElements: bigint[]; pathIndices: number[] } {
    const subtrees = [...filledSubtrees]; // copy to avoid mutation
    let currentHash = newLeaf;
    let currentIndex = leafCount;
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    for (let level = 0; level < depth; level++) {
      if (currentIndex % 2 === 1) {
        // Odd index = right child, sibling is filledSubtrees[level]
        pathElements.push(subtrees[level]);
        pathIndices.push(1);
        currentHash = poseidonHash(subtrees[level], currentHash);
      } else {
        // Even index = left child: UPDATE subtree at this level, then hash with zero
        const zeroVal = this.merkleTree.getZeroValueForLevel(level);
        pathElements.push(zeroVal);
        pathIndices.push(0);
        subtrees[level] = currentHash;
        currentHash = poseidonHash(currentHash, zeroVal);
      }
      currentIndex = currentIndex >> 1;
    }

    return { newRoot: currentHash, updatedSubtrees: subtrees, pathElements, pathIndices };
  }

  /**
   * Clear all notes but keep the Merkle tree intact
   * Use this when notes are unrecoverable (wrong indices, etc.)
   */
  async clearNotes(): Promise<void> {
    this.notes = [];
    await SecureStore.deleteItemAsync('zk_notes');
  }

  /**
   * Reconstruct Merkle proof from saved local subtrees and the note's leafIndex.
   * Works because: at odd-bit levels, subtrees are unchanged by insertion;
   * at even-bit levels, the sibling is always zeros[level].
   */
  private async reconstructProofFromSubtrees(note: Note): Promise<{ pathElements: bigint[]; pathIndices: number[] }> {
    if (note.leafIndex === undefined) {
      throw new Error('Cannot reconstruct proof: note has no leafIndex');
    }

    // Load saved subtrees from AsyncStorage (saved after each shield/unshield)
    // These subtrees represent the tree state AFTER the last insertion.
    // For odd-bit levels of the note's leafIndex, the subtree value is unchanged
    // from before insertion, so it's the correct sibling for the proof.
    if (!this._cachedSubtrees) {
      // Load without leafCount validation — we need the subtrees regardless
      try {
        const rawStr = await AsyncStorage.getItem('zk_local_subtrees');
        if (rawStr) {
          const data = JSON.parse(rawStr) as { subtrees: string[]; leafCount: number };
          this._cachedSubtrees = data.subtrees.map(s => BigInt(s));
        }
      } catch (e) {
        // ignore
      }
    }

    const raw = this._cachedSubtrees;
    if (!raw || raw.length === 0) {
      throw new Error('Cannot reconstruct proof: no saved subtrees available');
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let currentIndex = note.leafIndex;

    for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
      if (currentIndex % 2 === 1) {
        // Odd = right child: sibling is the filled subtree (unchanged by insertion)
        pathElements.push(raw[level]);
        pathIndices.push(1);
      } else {
        // Even = left child: sibling is empty (zero value)
        pathElements.push(this.merkleTree.getZeroValueForLevel(level));
        pathIndices.push(0);
      }
      currentIndex = currentIndex >> 1;
    }

    // Verify reconstruction
    let verifyRoot = note.commitment;
    for (let i = 0; i < MERKLE_TREE_DEPTH; i++) {
      const sibling = pathElements[i];
      const isRight = pathIndices[i] === 1;
      verifyRoot = isRight
        ? poseidonHash(sibling, verifyRoot)
        : poseidonHash(verifyRoot, sibling);
    }

    if (note.merkleRoot && verifyRoot !== note.merkleRoot) {
      console.error('[ZK Unshield] Reconstructed proof does NOT match root!');
      console.error('[ZK Unshield] Expected:', note.merkleRoot.toString().slice(0, 20) + '...');
      console.error('[ZK Unshield] Got:', verifyRoot.toString().slice(0, 20) + '...');
      throw new Error('Cannot reconstruct valid Merkle proof for this note');
    }

    console.log('[ZK Unshield] Proof reconstructed from subtrees, verified OK');
    return { pathElements, pathIndices };
  }

  /**
   * Reset the service
   */
  async reset(): Promise<void> {
    this.spendingKey = null;
    this.spendingKeyHash = null;
    this.ownerPubkey = null;
    this.viewingKey = null;
    this.notes = [];
    this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
    this.isInitialized = false;
    this._onChainRoot = null;

    await SecureStore.deleteItemAsync('zk_notes');
    // Also clear the global commitment cache to force fresh rebuild from chain
    await SecureStore.deleteItemAsync('zk_global_commitments');
    // Clear tree cache
    await AsyncStorage.removeItem('zk_tree_cache');
  }

  /**
   * Export a note as a shareable string
   * Format: p01note:<base64 encoded JSON>
   * Used for sharing received notes with the recipient
   */
  exportNote(note: Note): string {
    const noteData = {
      a: note.amount.toString(),
      o: note.ownerPubkey.toString(),
      r: note.randomness.toString(),
      t: note.tokenMint.toString(),
      c: note.commitment.toString(),
      i: note.leafIndex,
    };
    const json = JSON.stringify(noteData);
    const base64 = Buffer.from(json).toString('base64');
    return `p01note:${base64}`;
  }

  /**
   * Import a note from a shared string
   * Verifies the commitment matches before adding
   */
  async importNote(noteString: string): Promise<Note> {

    if (!noteString.startsWith('p01note:')) {
      console.error('[ZK Import] Invalid format - does not start with p01note:');
      throw new Error('Invalid note format. Must start with "p01note:"');
    }

    const base64 = noteString.slice(8);

    let json: string;
    let noteData: any;
    try {
      json = Buffer.from(base64, 'base64').toString('utf8');
      noteData = JSON.parse(json);
    } catch (e) {
      console.error('[ZK Import] Failed to parse note:', e);
      throw new Error('Invalid note format: could not decode');
    }

    const note: Note = {
      amount: BigInt(noteData.a),
      ownerPubkey: BigInt(noteData.o),
      randomness: BigInt(noteData.r),
      tokenMint: BigInt(noteData.t),
      commitment: BigInt(noteData.c),
      leafIndex: noteData.i,
    };

    // Verify the commitment matches
    const computedCommitment = poseidonHash(note.amount, note.ownerPubkey, note.randomness, note.tokenMint);
    if (computedCommitment !== note.commitment) {
      throw new Error('Invalid note: commitment does not match');
    }

    // Verify this note belongs to us
    if (note.ownerPubkey !== this.ownerPubkey) {
      throw new Error('This note does not belong to your wallet');
    }

    // Check if note already exists
    const exists = this.notes.some(n => n.commitment === note.commitment);
    if (exists) {
      throw new Error('This note is already in your wallet');
    }

    // Sync merkle tree to verify the note exists on-chain
    await this.syncMerkleTree();

    // Verify the note is in the merkle tree
    const onChainIndex = Array.from({ length: this.merkleTree.leafCount })
      .map((_, i) => this.merkleTree.getLeaf(i))
      .findIndex(leaf => leaf === note.commitment);


    if (onChainIndex === -1) {
      console.error('[ZK Import] Note not found in merkle tree. Tree has', this.merkleTree.leafCount, 'leaves');
      throw new Error('This note is not yet on-chain. Please wait for confirmation and try again.');
    }

    note.leafIndex = onChainIndex;
    note.isOnChain = true;

    // Check if note has already been spent (nullifier check)
    if (this.spendingKeyHash) {
      const nullifier = computeNullifier(note.commitment, this.spendingKeyHash);
      const nullifierBytes = bigintToLeBytes(nullifier);
      const isSpent = await this.checkNullifierOnChain(nullifierBytes);

      if (isSpent) {
        console.error('[ZK Import] Note has already been spent (nullifier in bloom filter)');
        throw new Error('This note has already been spent and cannot be imported.');
      }
    }

    // Add to local notes
    this.addNote(note);
    await this.saveNotes();

    return note;
  }

  /**
   * Get the last sent note for sharing with recipient
   * Called after a successful transfer
   */
  getLastSentNote(): { noteString: string; amount: bigint; leafIndex: number } | null {
    return this._lastSentNote;
  }

  private _lastSentNote: { noteString: string; amount: bigint; leafIndex: number } | null = null;

  /**
   * Get the user's stealth keys for receiving private transfers
   * Returns public keys that others can use to generate stealth addresses
   */
  getStealthKeys(): { spendingPublicKey: string; viewingPublicKey: string; viewingX25519Public: string; encoded: string } | null {
    if (!this.spendingKey || !this.viewingKey) {
      console.warn('[ZK] Stealth keys not initialized');
      return null;
    }

    // Convert bigint spending key to bytes for deriving public key
    const spendingKeyBytes = bigintToLeBytes(this.spendingKey);

    // Derive spending public key from spending key (as a keypair seed)
    const spendingKeypair = Keypair.fromSeed(spendingKeyBytes);
    const spendingPublicKey = spendingKeypair.publicKey.toBase58();

    // Derive viewing public key from viewing key
    const viewingKeypair = Keypair.fromSeed(this.viewingKey);
    const viewingPublicKey = viewingKeypair.publicKey.toBase58();

    // Derive X25519 viewing keypair from viewing seed for ECDH
    // Uses nacl.box.keyPair.fromSecretKey with hashed seed
    const viewingX25519Secret = nacl.hash(this.viewingKey).slice(0, 32);
    const viewingX25519Keypair = nacl.box.keyPair.fromSecretKey(viewingX25519Secret);
    const viewingX25519Public = Buffer.from(viewingX25519Keypair.publicKey).toString('base64');

    // Encode keys for easy sharing (base64)
    // Format: spendingPub(32) + viewingPub(32) + viewingX25519Pub(32) = 96 bytes
    const combined = Buffer.concat([
      spendingKeypair.publicKey.toBytes(),
      viewingKeypair.publicKey.toBytes(),
      viewingX25519Keypair.publicKey
    ]);
    const encoded = combined.toString('base64');

    return {
      spendingPublicKey,
      viewingPublicKey,
      viewingX25519Public,
      encoded,
    };
  }

  /**
   * PRIVATE SEND - True Zero-Knowledge Transfer
   *
   * This is the ultimate privacy solution:
   * 1. Sender is hidden (relayer sends on their behalf)
   * 2. Recipient is hidden (stealth address)
   * 3. Amount is hidden (fixed denominations like Tornado Cash)
   *
   * Flow:
   * 1. User creates ZK proof showing they have funds in pool
   * 2. Relayer verifies proof and sends from ITS OWN wallet
   * 3. On-chain shows: "Relayer → Stealth Address" (no link to depositor!)
   * 4. Recipient scans for payments using their viewing key
   *
   * @param recipientStealthKeys - Recipient's encoded stealth keys (from getStealthKeys)
   * @param denominationIndex - 0=0.1 SOL, 1=1 SOL, 2=10 SOL
   * @param walletPublicKey - User's wallet for signing
   * @param signTransaction - Transaction signing function
   */
  async privateSend(
    recipientStealthKeys: string,
    denominationIndex: number,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<{
    success: boolean;
    txSignature?: string;
    stealthAddress?: string;
    ephemeralPublicKey?: string;
    viewTag?: number;
    error?: string;
  }> {

    // Fixed denominations (must match relayer)
    const DENOMINATIONS = [
      0.1 * 1e9,   // 0.1 SOL = 100M lamports
      1 * 1e9,     // 1 SOL = 1B lamports
      10 * 1e9,    // 10 SOL = 10B lamports
    ];

    if (denominationIndex < 0 || denominationIndex >= DENOMINATIONS.length) {
      return { success: false, error: 'Invalid denomination index' };
    }

    const amount = BigInt(DENOMINATIONS[denominationIndex]);

    try {
      // 1. Decode recipient's stealth keys
      const keyBuffer = Buffer.from(recipientStealthKeys, 'base64');

      // Decode recipient stealth keys: spending_ed25519(32) + viewing_x25519(32)
      if (keyBuffer.length < 64) {
        return { success: false, error: `Invalid stealth keys format (got ${keyBuffer.length} bytes)` };
      }

      const recipientSpendingPub = new Uint8Array(keyBuffer.slice(0, 32));
      const recipientViewingPub = new Uint8Array(keyBuffer.slice(32, 64));

      // 2. Generate stealth address for recipient
      const stealthData = generateStealthAddress(
        recipientSpendingPub,
        recipientViewingPub,
      );

      // 3. Select notes for the exact denomination
      if (!this.spendingKey || !this.spendingKeyHash) {
        return { success: false, error: 'ZK Service not initialized' };
      }

      // Sync merkle tree first
      await this.syncMerkleTree();

      const { notesToSpend, totalValue } = this.selectNotes(amount);
      if (totalValue < amount) {
        return {
          success: false,
          error: `Insufficient shielded balance. Have ${Number(totalValue) / 1e9} SOL, need ${Number(amount) / 1e9} SOL`
        };
      }

      // 4. Generate ZK proof
      const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));
      const merkleRoot = this.merkleTree.root;

      // Compute nullifiers
      const nullifier1 = computeNullifier(notesToSpend[0].commitment, this.spendingKeyHash);
      let nullifier2: bigint;
      let dummyInputNote: Note | undefined;

      if (notesToSpend[1]) {
        nullifier2 = computeNullifier(notesToSpend[1].commitment, this.spendingKeyHash);
      } else {
        // Create unique dummy input note
        const dummyRandomness = generateRandomBigInt();
        const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), dummyRandomness, tokenMintField);
        nullifier2 = computeNullifier(dummyCommitment, this.spendingKeyHash);
        dummyInputNote = {
          amount: BigInt(0),
          ownerPubkey: BigInt(0),
          randomness: dummyRandomness,
          tokenMint: tokenMintField,
          commitment: dummyCommitment,
        };
      }

      // Generate merkle proofs
      const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
      const proof2 = notesToSpend[1]
        ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
        : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

      const inputNotesForCircuit = notesToSpend[1]
        ? notesToSpend
        : [notesToSpend[0], dummyInputNote!];

      // Create change note
      const changeAmount = totalValue - amount;
      const changeNote = await createNote(changeAmount, this.ownerPubkey!, tokenMintField);

      // Dummy output (for the transfer that goes to relayer, which handles sending to stealth)
      const dummyOutput2Commitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);
      const dummyOutput2: Note = {
        amount: BigInt(0),
        ownerPubkey: BigInt(0),
        randomness: BigInt(0),
        tokenMint: tokenMintField,
        commitment: dummyOutput2Commitment,
      };

      // Generate proof
      const zkProof = await this.generateProofClientSide({
        merkleRoot,
        nullifier1,
        nullifier2,
        outputCommitment1: changeNote.commitment,
        outputCommitment2: dummyOutput2Commitment,
        publicAmount: -amount, // Negative for unshield
        inputNotes: inputNotesForCircuit,
        outputNotes: [changeNote, dummyOutput2],
        proofs: [proof1, proof2],
        spendingKey: this.spendingKey,
      });


      // 5. Build on-chain unshield tx to stealth address via decentralized relay
      const stealthRecipient = new PublicKey(stealthData.address);

      // Compute newRoot for the change commitment
      const onChainState = await this.readOnChainFilledSubtrees();
      const localSubtrees = await this.loadLocalSubtrees(onChainState.leafCount);
      const useSubtrees = localSubtrees || onChainState.filledSubtrees;
      const { newRoot, updatedSubtrees, pathElements: changePathElements, pathIndices: changePathIndices } = this.computeNewRootFromSubtrees(
        useSubtrees, onChainState.leafCount, changeNote.commitment, onChainState.depth
      );
      await this.saveLocalSubtrees(updatedSubtrees, onChainState.leafCount + 1);

      // Build unshield tx with ephemeral payer (sender privacy)
      const ephemeralKeypair = Keypair.generate();

      const [poolPDA] = PublicKey.findProgramAddressSync(
        [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()], this.programId
      );
      const [merkleTreePDA] = PublicKey.findProgramAddressSync(
        [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()], this.programId
      );
      const [nullifierSetPDA] = PublicKey.findProgramAddressSync(
        [PDA_SEEDS.NULLIFIER_SET, poolPDA.toBytes()], this.programId
      );
      const [vkDataPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('vk_data'), poolPDA.toBytes()], this.programId
      );

      const unshieldDiscriminator = Buffer.from([0x15, 0xe4, 0x37, 0x18, 0xc2, 0x0a, 0x15, 0x16]);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(amount, 0);
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);

      const txData = Buffer.concat([
        unshieldDiscriminator,
        zkProof.pi_a, zkProof.pi_b, zkProof.pi_c,
        bigintToLeBytes(nullifier1),
        bigintToLeBytes(nullifier2),
        bigintToLeBytes(changeNote.commitment),
        bigintToLeBytes(dummyCommitment),
        bigintToLeBytes(merkleRoot),
        amountBuffer,
        bigintToLeBytes(newRoot),
      ]);

      const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');

      const computeLimitData = Buffer.alloc(5);
      computeLimitData.writeUInt8(2, 0);
      computeLimitData.writeUInt32LE(1_400_000, 1);

      const computeLimitIx = new TransactionInstruction({
        programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: computeLimitData,
      });

      const unshieldIx = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: ephemeralKeypair.publicKey, isSigner: true, isWritable: true },
          { pubkey: stealthRecipient, isSigner: false, isWritable: true },
          { pubkey: poolPDA, isSigner: false, isWritable: true },
          { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
          { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },
          { pubkey: vkDataPDA, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: this.programId, isSigner: false, isWritable: false },
          { pubkey: this.programId, isSigner: false, isWritable: false },
        ],
        data: txData,
      });

      // Build + sign with ephemeral keypair
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      const unshieldTx = new Transaction().add(computeLimitIx).add(unshieldIx);
      unshieldTx.feePayer = ephemeralKeypair.publicKey;
      unshieldTx.recentBlockhash = blockhash;
      unshieldTx.sign(ephemeralKeypair);

      const serializedTx = unshieldTx.serialize();
      console.log('[ZK Private Send] Tx serialized:', serializedTx.length, 'bytes, submitting via relay...');

      // 6. Submit via decentralized on-chain relay
      const { relayTransaction } = await import('../relay');
      const txSignature = await relayTransaction(
        serializedTx,
        walletPublicKey,
        signTransaction,
      );

      // 7. Mark notes as spent locally and add change note
      this.removeSpentNotes(notesToSpend);
      if (changeAmount > BigInt(0)) {
        changeNote.leafIndex = onChainState.leafCount;
        changeNote.merkleRoot = newRoot;
        changeNote.merklePathElements = changePathElements;
        changeNote.merklePathIndices = changePathIndices;
        changeNote.isOnChain = true;
        this.addNote(changeNote);
      }
      await this.saveNotes();

      return {
        success: true,
        txSignature,
        stealthAddress: stealthData.address,
        ephemeralPublicKey: stealthData.ephemeralPublicKey,
        viewTag: stealthData.viewTag,
      };

    } catch (error: any) {
      console.error('[ZK Private Send] Error:', error);
      return { success: false, error: error.message || 'Private send failed' };
    }
  }

  /**
   * Scan for incoming stealth payments
   * This is called periodically to find payments sent to our stealth addresses
   */
  // Store found stealth payments for later withdrawal
  private _foundStealthPayments: Array<{
    stealthAddress: string;
    privateKey: Uint8Array;
    amount: number;
    signature: string;
    ephemeralPublicKey: string;
  }> = [];

  async scanStealthPayments(): Promise<{
    found: number;
    amount: number;
    payments: Array<{ stealthAddress: string; amount: number; signature: string }>;
  }> {

    try {
      // TRUSTLESS: Scan blockchain directly instead of relying on the relayer.
      // Uses the specter-sdk StealthIndexer to find on-chain stealth announcements.
      const stealthKeys = this.getStealthKeys();
      if (!stealthKeys) {
        return { found: 0, amount: 0, payments: [] };
      }

      // @ts-expect-error -- @p01/specter-sdk is a workspace package not yet linked in mobile
      const { scanForPayments: sdkScanForPayments } = await import('@p01/specter-sdk');

      const viewingKeyBytes = this.viewingKey!;
      const spendingKeyBytes = bigintToLeBytes(this.spendingKey!);

      // Derive spending public key for the scanner
      const spendingKeypair = Keypair.fromSeed(spendingKeyBytes);
      const spendingPubKeyBytes = spendingKeypair.publicKey.toBytes();

      const onChainPayments = await sdkScanForPayments(
        this.connection,
        viewingKeyBytes,
        spendingPubKeyBytes,
        { limit: 100 }
      );

      let found = 0;
      let totalAmount = 0;
      const foundPayments: Array<{ stealthAddress: string; amount: number; signature: string }> = [];

      for (const payment of onChainPayments) {
        try {
          const sig = payment.signature || '';

          // Check if we already have this payment
          if (this._foundStealthPayments.some(p => p.signature === sig)) {
            continue;
          }

          // Derive stealth private key locally using the ephemeral pubkey
          const result = scanStealthPayment(
            Buffer.from(payment.ephemeralPubKey).toString('base64'),
            viewingKeyBytes,
            spendingPubKeyBytes,
            payment.viewTag
          );

          if (!result.found || !result.privateKey) {
            continue;
          }

          const stealthAddress = payment.stealthAddress.toBase58();
          const amount = Number(payment.amount);

          found++;
          totalAmount += amount;

          this._foundStealthPayments.push({
            stealthAddress,
            privateKey: result.privateKey,
            amount,
            signature: sig,
            ephemeralPublicKey: Buffer.from(payment.ephemeralPubKey).toString('base64'),
          });

          foundPayments.push({
            stealthAddress,
            amount,
            signature: sig,
          });
        } catch (e) {
          // Not for us or parse error, skip
        }
      }

      return { found, amount: totalAmount, payments: foundPayments };
    } catch (error) {
      console.error('[ZK] Stealth scan error:', error);
      return { found: 0, amount: 0, payments: [] };
    }
  }

  /**
   * Get pending stealth payments that can be swept
   */
  getPendingStealthPayments(): Array<{ stealthAddress: string; amount: number; signature: string }> {
    return this._foundStealthPayments.map(p => ({
      stealthAddress: p.stealthAddress,
      amount: p.amount,
      signature: p.signature,
    }));
  }

  /**
   * Sweep SOL from a stealth address to the recipient wallet
   * This transfers the funds from the one-time stealth address to the user's main wallet
   */
  async sweepStealthPayment(
    stealthAddress: string,
    recipientAddress: string
  ): Promise<{ success: boolean; signature?: string; error?: string }> {

    try {
      // Find the stealth payment with private key
      const payment = this._foundStealthPayments.find(p => p.stealthAddress === stealthAddress);
      if (!payment) {
        return { success: false, error: 'Stealth payment not found. Run scanStealthPayments first.' };
      }

      // Create keypair from the stealth private key
      const stealthKeypair = Keypair.fromSecretKey(payment.privateKey);

      // Verify the keypair matches the stealth address
      if (stealthKeypair.publicKey.toBase58() !== stealthAddress) {
        return { success: false, error: 'Stealth keypair mismatch' };
      }

      // Get balance of stealth address
      const balance = await this.connection.getBalance(stealthKeypair.publicKey);

      if (balance === 0) {
        return { success: false, error: 'Stealth address has no balance' };
      }

      // Calculate amount to send (balance minus tx fee)
      const txFee = 5000; // 0.000005 SOL
      const amountToSend = balance - txFee;

      if (amountToSend <= 0) {
        return { success: false, error: 'Balance too low to cover transaction fee' };
      }

      // Create transfer transaction
      const recipient = new PublicKey(recipientAddress);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: stealthKeypair.publicKey,
          toPubkey: recipient,
          lamports: amountToSend,
        })
      );

      transaction.feePayer = stealthKeypair.publicKey;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.sign(stealthKeypair);

      const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'processed',
        maxRetries: 3,
      });

      await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );


      // Remove the swept payment from pending list
      this._foundStealthPayments = this._foundStealthPayments.filter(p => p.stealthAddress !== stealthAddress);

      return { success: true, signature };
    } catch (error: any) {
      console.error('[ZK] Sweep error:', error);
      return { success: false, error: error.message || 'Sweep failed' };
    }
  }

  /**
   * Sweep all pending stealth payments to a recipient address
   */
  async sweepAllStealthPayments(recipientAddress: string): Promise<{
    success: boolean;
    swept: number;
    totalAmount: number;
    signatures: string[];
    errors: string[];
  }> {

    const results = {
      success: true,
      swept: 0,
      totalAmount: 0,
      signatures: [] as string[],
      errors: [] as string[],
    };

    const payments = [...this._foundStealthPayments];

    for (const payment of payments) {
      const result = await this.sweepStealthPayment(payment.stealthAddress, recipientAddress);

      if (result.success && result.signature) {
        results.swept++;
        results.totalAmount += payment.amount;
        results.signatures.push(result.signature);
      } else {
        results.errors.push(`${payment.stealthAddress.slice(0, 16)}...: ${result.error}`);
      }
    }

    if (results.errors.length > 0) {
      results.success = false;
    }

    return results;
  }
}

// Singleton instance
let zkServiceInstance: ZkService | null = null;

export function getZkService(): ZkService {
  if (!zkServiceInstance) {
    zkServiceInstance = new ZkService();
  }
  return zkServiceInstance;
}

/**
 * TreeSyncManager — Fully on-chain Merkle tree sync.
 *
 * Polls the MerkleTree PDA on-chain every 10s for new leaf count changes.
 * When a change is detected, triggers a full sync via ZkService.syncMerkleTree().
 * No backend dependency — all data comes from Solana RPC.
 */
export class TreeSyncManager {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _isRunning: boolean = false;
  private lastKnownLeafCount: number = 0;

  get isRunning(): boolean {
    return this._isRunning;
  }

  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    console.log('[TreeSync] Started on-chain polling (10s interval)');
    this.poll(); // Initial poll
    this.pollTimer = setInterval(() => this.poll(), 10_000);
  }

  stop(): void {
    this._isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[TreeSync] Stopped');
  }

  private async poll(): Promise<void> {
    if (!this._isRunning) return;

    try {
      const zkService = getZkService();
      if (!zkService) return;

      const connection = getConnection();
      const programId = (zkService as any).programId as PublicKey;
      const tokenMint = (zkService as any).tokenMint as PublicKey;
      if (!programId || !tokenMint) return;

      const [poolPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('shielded_pool'), tokenMint.toBytes()], programId
      );
      const [merkleTreePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('merkle_tree'), poolPDA.toBytes()], programId
      );

      const account = await connection.getAccountInfo(merkleTreePDA);
      if (!account) return;

      const leafCountOffset = 8 + 32 + 32; // disc + pool_authority + root
      const onChainLeafCount = Number(account.data.readBigUInt64LE(leafCountOffset));

      if (onChainLeafCount > this.lastKnownLeafCount) {
        console.log('[TreeSync] New leaves detected:', this.lastKnownLeafCount, '->', onChainLeafCount);
        this.lastKnownLeafCount = onChainLeafCount;
        // Trigger full sync
        await zkService.syncMerkleTree();
      }
    } catch (e: any) {
      // Silent — polling errors are non-fatal
      console.warn('[TreeSync] Poll error:', e.message);
    }
  }
}

let treeSyncInstance: TreeSyncManager | null = null;

export function getTreeSyncManager(): TreeSyncManager {
  if (!treeSyncInstance) {
    treeSyncInstance = new TreeSyncManager();
  }
  return treeSyncInstance;
}
