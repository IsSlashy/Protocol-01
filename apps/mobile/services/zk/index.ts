/**
 * ZK Service for Mobile
 * Bridges the P-01 ZK SDK to React Native
 *
 * Note: snarkjs WASM doesn't run in React Native, so proof generation
 * is delegated to a backend prover service.
 */

import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import * as SecureStore from 'expo-secure-store';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { generateStealthAddress, scanStealthPayment, type StealthAddress } from '../../utils/crypto/stealth';

// Constants from zk-sdk
const ZK_SHIELDED_PROGRAM_ID = '8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY';
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
  viewTag: string;
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
      console.log('[MerkleTree] Base zero value:', baseZero.toString().slice(0, 20) + '...');

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

    console.log('[ZK] Service initialized');

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
        console.log('[ZK] Nullifier set account not found');
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
      console.log(`[ZK] Removed ${removedCount} zombie notes (already spent on-chain)`);
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
    console.log('[ZK Shield] Starting shield...');

    if (!this.ownerPubkey) {
      throw new Error('ZK Service not initialized');
    }
    // Sync merkle tree with on-chain state first
    await this.syncMerkleTree();

    const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));

    // Create note for self
    const note = await createNote(amount, this.ownerPubkey, tokenMintField);

    // Get current leaf count before insertion
    const leafIndexBeforeInsert = this.merkleTree.leafCount;
    console.log('[ZK Shield] Inserting at leaf index:', leafIndexBeforeInsert);

    // Update local Merkle tree
    const newRoot = this.merkleTree.insert(note.commitment);
    const newRootBytes = bigintToLeBytes(newRoot);

    // Store merkle path for this note (for later unshield/transfer)
    const merklePath = this.merkleTree.generateProof(leafIndexBeforeInsert);
    note.merklePathElements = merklePath.pathElements;
    note.merklePathIndices = merklePath.pathIndices;
    note.merkleRoot = newRoot;
    note.leafIndex = leafIndexBeforeInsert;
    note.isOnChain = true; // Will be confirmed after tx
    console.log('[ZK Shield] Merkle path stored, root:', newRoot.toString().slice(0, 20) + '...');

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

    // Build and sign transaction
    const tx = new Transaction().add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signedTx = await signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: true,
      preflightCommitment: 'confirmed',
    });

    // Use 'processed' for faster confirmation, retry on timeout
    try {
      const confirmation = await this.connection.confirmTransaction(signature, 'processed');
      if (confirmation.value.err) {
        console.error('[ZK Shield] Transaction failed on-chain:', JSON.stringify(confirmation.value.err));
        throw new Error(`Shield transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
    } catch (e: any) {
      // Check if it's a timeout - the transaction might still succeed
      if (e.message?.includes('timeout') || e.message?.includes('expired')) {
        console.warn('[ZK Shield] Confirmation timed out, checking transaction status...');
        // Give it a bit more time and check status
        await new Promise(r => setTimeout(r, 5000));
        const status = await this.connection.getSignatureStatus(signature);
        if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
          console.log('[ZK Shield] Transaction confirmed after retry check');
        } else if (status.value?.err) {
          throw new Error(`Shield transaction failed: ${JSON.stringify(status.value.err)}`);
        } else {
          console.warn('[ZK Shield] Transaction status uncertain, proceeding optimistically. Check explorer:', signature);
        }
      } else {
        throw e;
      }
    }

    console.log('[ZK Shield] Transaction confirmed:', signature);

    // Note already has leafIndex and merkle path set from before insertion
    // Just verify the on-chain state matches our expectation
    try {
      // Reuse poolPDA and merkleTreePDA from above
      const merkleTreeAccount = await this.connection.getAccountInfo(merkleTreePDA);
      if (merkleTreeAccount) {
        const onChainLeafCount = merkleTreeAccount.data.readBigUInt64LE(8 + 32 + 32);
        const onChainLeafIndex = Number(onChainLeafCount) - 1;
        if (onChainLeafIndex !== note.leafIndex) {
          console.warn('[ZK Shield] On-chain leaf index mismatch:', note.leafIndex, '!=', onChainLeafIndex);
          // Update to match on-chain if different (rare race condition)
          note.leafIndex = onChainLeafIndex;
          // Need to regenerate merkle path for the correct index
          const newPath = this.merkleTree.generateProof(onChainLeafIndex);
          note.merklePathElements = newPath.pathElements;
          note.merklePathIndices = newPath.pathIndices;
        }
      }
    } catch (e) {
      console.warn('[ZK Shield] Could not verify on-chain leaf index');
    }

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

    return signature;
  }

  /**
   * Transfer shielded tokens (requires backend prover)
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
    console.log('[ZK Transfer] Syncing Merkle tree with on-chain state...');
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
      console.log('[ZK Transfer] Created unique dummy input note with randomness:', dummyRandomness.toString().slice(0, 20) + '...');
      console.log('[ZK Transfer] Dummy nullifier_2:', nullifier2.toString().slice(0, 20) + '...');
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

    // Request proof from backend prover
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

    console.log('[ZK Transfer] Building tx with merkle_root:', merkleRoot.toString().slice(0, 20) + '...');
    console.log('[ZK Transfer] New root after insertion:', newRoot.toString().slice(0, 20) + '...');

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

    const tx = new Transaction().add(computeLimitIx).add(computePriceIx).add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signedTx = await signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: true,
      preflightCommitment: 'confirmed',
    });

    console.log('[ZK Transfer] Transaction sent:', signature);

    // Wait for confirmation with timeout handling
    try {
      const confirmation = await this.connection.confirmTransaction(signature, 'processed');
      if (confirmation.value.err) {
        console.error('[ZK Transfer] Transaction FAILED:', signature);
        console.error('[ZK Transfer] Error:', JSON.stringify(confirmation.value.err));
        throw new Error(`Transfer transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      console.log('[ZK Transfer] Transaction confirmed successfully:', signature);
    } catch (e: any) {
      if (e.message?.includes('timeout') || e.message?.includes('expired')) {
        console.warn('[ZK Transfer] Confirmation timed out, checking status...');
        await new Promise(r => setTimeout(r, 5000));
        const status = await this.connection.getSignatureStatus(signature);
        if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
          console.log('[ZK Transfer] Transaction confirmed after retry');
        } else if (status.value?.err) {
          throw new Error(`Transfer failed: ${JSON.stringify(status.value.err)}`);
        } else {
          console.warn('[ZK Transfer] Status uncertain, check explorer:', signature);
        }
      } else {
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

    console.log('[ZK Transfer] Note to share with recipient:', this._lastSentNote.noteString.slice(0, 50) + '...');

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

    // Sync Merkle tree with on-chain state before generating proofs
    console.log('[ZK Unshield] Syncing Merkle tree with on-chain state...');
    await this.syncMerkleTree();

    // Select notes to spend
    let { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    // Validate selected notes are not already spent on-chain (detect zombie notes)
    console.log('[ZK Unshield] Validating selected notes are not already spent...');
    const validNotes = await this.validateNotesNotSpent(notesToSpend);

    // If any notes were removed as zombies, re-select
    if (validNotes.length < notesToSpend.length) {
      console.log('[ZK Unshield] Some notes were zombie (already spent), re-selecting...');
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
    console.log('[ZK Unshield] All selected notes validated as unspent');

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
      console.log('[ZK Unshield] Created dummy change note with commitment:', dummyCommitment.toString().slice(0, 20) + '...');
    }

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
      // The circuit allows any randomness for dummy notes (amount=0), so we use a random value.
      const dummyRandomness = generateRandomBigInt();
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), dummyRandomness, tokenMintField);
      nullifier2 = computeNullifier(dummyCommitment, this.spendingKeyHash);

      // Store the dummy note so we can pass it to the circuit
      dummyInputNote = {
        amount: BigInt(0),
        ownerPubkey: BigInt(0),
        randomness: dummyRandomness,
        tokenMint: tokenMintField,
        commitment: dummyCommitment,
      };
      console.log('[ZK Unshield] Created unique dummy input note with randomness:', dummyRandomness.toString().slice(0, 20) + '...');
      console.log('[ZK Unshield] Dummy commitment:', dummyCommitment.toString().slice(0, 20) + '...');
      console.log('[ZK Unshield] Dummy nullifier_2:', nullifier2.toString().slice(0, 20) + '...');
    }

    // Generate proofs from synced tree
    // NOTE: Historical roots are not supported on-chain, so we MUST use current root
    console.log('[ZK Unshield] Generating merkle proofs from synced tree (current root required)');

    const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
    // IMPORTANT: We must use the LOCAL tree root because the proof siblings come from the local tree.
    // Using a different root would cause circuit verification to fail.
    const merkleRoot = this.merkleTree.root;
    if (this._onChainRoot && this._onChainRoot !== merkleRoot) {
      console.warn('[ZK Unshield] WARNING: Local root differs from on-chain. This may cause transaction to fail.');
      console.warn('[ZK Unshield] Local root:', merkleRoot.toString().slice(0, 20) + '...');
      console.warn('[ZK Unshield] On-chain root:', this._onChainRoot.toString().slice(0, 20) + '...');
      console.warn('[ZK Unshield] The sync may have failed. Try refreshing the wallet or resetting ZK state.');
    }

    const proof2 = notesToSpend[1]
      ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
      : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

    console.log('[ZK Unshield] Using current merkle root:', merkleRoot.toString().slice(0, 20) + '...');
    console.log('[ZK Unshield] Note 1 at leaf index:', notesToSpend[0].leafIndex);
    console.log('[ZK Unshield] Note 1 commitment:', notesToSpend[0].commitment.toString().slice(0, 20) + '...');
    console.log('[ZK Unshield] Merkle tree leaf count:', this.merkleTree.leafCount);
    console.log('[ZK Unshield] Proof1 pathIndices (first 5):', proof1.pathIndices.slice(0, 5));
    console.log('[ZK Unshield] Proof1 pathElements (first 3):', proof1.pathElements.slice(0, 3).map(e => e.toString().slice(0, 15) + '...'));

    // Verify the proof locally before sending to circuit
    let computedRoot = notesToSpend[0].commitment;
    for (let i = 0; i < MERKLE_TREE_DEPTH; i++) {
      const sibling = proof1.pathElements[i];
      const isRight = proof1.pathIndices[i] === 1;
      computedRoot = isRight
        ? poseidonHash(sibling, computedRoot)
        : poseidonHash(computedRoot, sibling);
    }
    console.log('[ZK Unshield] Locally computed root:', computedRoot.toString().slice(0, 20) + '...');
    console.log('[ZK Unshield] Roots match:', computedRoot === merkleRoot);

    // Create dummy second output note (amount=0)
    const dummyOutput2Commitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);
    const dummyOutput2: Note = {
      amount: BigInt(0),
      ownerPubkey: BigInt(0),
      randomness: BigInt(0),
      tokenMint: tokenMintField,
      commitment: dummyOutput2Commitment,
    };

    // Request proof from backend
    // If we have only 1 real note, include the dummy input note with unique randomness
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

    // Update Merkle tree - ALWAYS insert the change commitment
    // The on-chain program inserts if commitment != [0u8; 32], and our dummy is Poseidon(0,0,0,tokenMint) != zeros
    // So we must always compute the new root with the change note inserted
    const newRoot = this.merkleTree.insert(changeNote.commitment);

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

    console.log('[ZK Unshield] Building tx with merkle_root:', merkleRoot.toString().slice(0, 20) + '...');
    console.log('[ZK Unshield] Recipient:', recipient.toBase58());
    console.log('[ZK Unshield] Amount:', amount.toString(), 'lamports');

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

    const tx = new Transaction().add(computeLimitIx).add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signedTx = await signTransaction(tx);
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false, // Enable preflight to catch errors
        preflightCommitment: 'confirmed',
      });
    } catch (err: any) {
      console.error('[ZK Unshield] Preflight error:', err.message);
      if (err.logs) {
        console.error('[ZK Unshield] Logs:', err.logs);
      }
      throw err;
    }

    // Wait for confirmation with timeout handling
    try {
      const confirmation = await this.connection.confirmTransaction(signature, 'processed');
      if (confirmation.value.err) {
        console.error('[ZK Unshield] Transaction failed on-chain:', confirmation.value.err);
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      console.log('[ZK Unshield] Transaction confirmed successfully:', signature);
    } catch (e: any) {
      if (e.message?.includes('timeout') || e.message?.includes('expired')) {
        console.warn('[ZK Unshield] Confirmation timed out, checking status...');
        await new Promise(r => setTimeout(r, 5000));
        const status = await this.connection.getSignatureStatus(signature);
        if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
          console.log('[ZK Unshield] Transaction confirmed after retry');
        } else if (status.value?.err) {
          throw new Error(`Unshield failed: ${JSON.stringify(status.value.err)}`);
        } else {
          console.warn('[ZK Unshield] Status uncertain, check explorer:', signature);
        }
      } else {
        throw e;
      }
    }

    // Update local notes
    this.removeSpentNotes(notesToSpend);
    if (changeAmount > BigInt(0)) {
      changeNote.leafIndex = this.merkleTree.leafCount - 1;
      changeNote.isOnChain = true;
      this.addNote(changeNote);
    }
    await this.saveNotes();

    return signature;
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
    console.log('[ZK Stealth Unshield] Generating stealth address for recipient...');

    // Generate one-time stealth address
    const stealthData: StealthAddress = await generateStealthAddress(
      recipientSpendingPubKey,
      recipientViewingPubKey
    );

    console.log('[ZK Stealth Unshield] Stealth address:', stealthData.address);
    console.log('[ZK Stealth Unshield] Ephemeral pubkey:', stealthData.ephemeralPublicKey);
    console.log('[ZK Stealth Unshield] View tag:', stealthData.viewTag);

    // Convert stealth address to PublicKey
    const stealthRecipient = new PublicKey(stealthData.address);

    // Perform the actual unshield to the stealth address
    const signature = await this.unshield(
      stealthRecipient,
      amount,
      walletPublicKey,
      signTransaction
    );

    console.log('[ZK Stealth Unshield] Complete! Tx:', signature);
    console.log('[ZK Stealth Unshield] Recipient should scan with viewing key to find funds');

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

    console.log('[ZK] Spendable notes:', spendableNotes.length, 'of', this.notes.length);

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
        console.log('[ZK] Note already exists at index', note.leafIndex, '- skipping duplicate');
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
    console.log('[ZK] Added note at leafIndex', note.leafIndex, 'amount:', note.amount.toString());
    return true;
  }

  // Prover function injected by ZkProverProvider
  private proverFunction: ((inputs: Record<string, string>) => Promise<Groth16Proof>) | null = null;

  // Backend prover URL (for mobile without bundled circuits)
  private static BACKEND_PROVER_URL = 'https://corps-mag-distributed-ref.trycloudflare.com'; // Cloudflare tunnel to local relayer

  /**
   * Set the backend prover URL
   */
  static setBackendProverUrl(url: string): void {
    ZkService.BACKEND_PROVER_URL = url;
    console.log('[ZK] Backend prover URL set to:', url);
  }

  /**
   * Set the prover function (called by ZkProverProvider)
   */
  setProver(prover: (inputs: Record<string, string>) => Promise<Groth16Proof>): void {
    this.proverFunction = prover;
    console.log('[ZK] Client-side prover connected');
  }

  /**
   * Generate proof using backend prover service
   * This is the preferred method for mobile as it doesn't require bundling 19MB circuits
   */
  private async generateProofViaBackend(inputs: Record<string, string>): Promise<Groth16Proof> {
    console.log('[ZK] Requesting proof from backend prover...');
    console.log('[ZK] Backend URL:', ZkService.BACKEND_PROVER_URL);

    try {
      const response = await fetch(`${ZkService.BACKEND_PROVER_URL}/prove`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`Backend prover error: ${error.message || error.error || response.statusText}`);
      }

      const result = await response.json();

      if (!result.success || !result.proof) {
        throw new Error(result.message || 'Backend prover returned invalid response');
      }

      console.log('[ZK] Backend proof generated in', result.proofTimeMs, 'ms');

      // Convert snarkjs proof format to our Groth16Proof format
      return this.convertSnarkjsProof(result.proof);
    } catch (error: any) {
      console.error('[ZK] Backend prover failed:', error);
      throw new Error(`Backend prover failed: ${error.message}`);
    }
  }

  /**
   * Generate proof via backend and return raw snarkjs format
   * Used for relayer which expects snarkjs format (not byte arrays for Solana)
   */
  private async generateProofViaBackendRaw(inputs: Record<string, string>): Promise<{
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    publicSignals: string[];
  }> {
    console.log('[ZK] Requesting raw proof from backend prover...');
    console.log('[ZK] Backend URL:', ZkService.BACKEND_PROVER_URL);

    try {
      const response = await fetch(`${ZkService.BACKEND_PROVER_URL}/prove`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`Backend prover error: ${error.message || error.error || response.statusText}`);
      }

      const result = await response.json();

      if (!result.success || !result.proof) {
        throw new Error(result.message || 'Backend prover returned invalid response');
      }

      console.log('[ZK] Backend raw proof generated in', result.proofTimeMs, 'ms');

      // Return raw snarkjs format (string arrays, not byte arrays)
      return {
        proof: result.proof,
        publicSignals: result.publicSignals,
      };
    } catch (error: any) {
      console.error('[ZK] Backend prover failed:', error);
      throw new Error(`Backend prover failed: ${error.message}`);
    }
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
   * Generate proof - tries backend prover first, then falls back to client-side
   *
   * Backend prover is preferred for mobile as it doesn't require bundling 19MB circuits.
   * Client-side prover requires ZkProverProvider to be mounted with circuit files.
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
      console.log('[ZK] Converting negative public_amount to field representation:', publicAmountField.toString().slice(0, 20) + '...');
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

    console.log('[ZK] Generating proof...');

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

    // Try backend prover first (preferred for mobile - no 19MB circuit bundling)
    try {
      console.log('[ZK] Trying backend prover...');
      const proof = await this.generateProofViaBackend(circuitInputs);
      console.log('[ZK] Backend proof generated successfully');
      return proof;
    } catch (backendError: any) {
      console.warn('[ZK] Backend prover failed:', backendError.message);
      console.log('[ZK] Falling back to client-side prover...');
    }

    // Fall back to client-side prover
    if (!this.proverFunction) {
      throw new Error(
        'ZK Prover not available. The backend prover is not reachable and ' +
        'client-side prover is not loaded. Please ensure the relayer is running ' +
        'or restart the app to load circuits locally.'
      );
    }

    try {
      const proof = await this.proverFunction(circuitInputs);
      console.log('[ZK] Client-side proof generated successfully');
      return proof;
    } catch (error) {
      console.error('[ZK] Client-side proof generation failed:', error);
      console.error('[ZK] This error means the circuit constraints are not satisfied.');
      console.error('[ZK] Most likely cause: commitment mismatch or invalid merkle proof.');
      throw error;
    }
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

    console.log('[ZK] Scanning for incoming notes...');

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
                console.log('[ZK] Found incoming note:', {
                  amount: amount.toString(),
                  commitment: commitment.toString(16).slice(0, 16) + '...',
                });
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

    console.log(`[ZK] Scan complete. Found ${foundCount} notes.`);

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
          console.log(`[ZK] Removed ${duplicatesRemoved} corrupted/duplicate notes`);
        }

        console.log('[ZK] Valid notes after filter:', deduplicatedNotes.length);

        // Check if we need to save cleaned up notes
        const needsSave = deduplicatedNotes.length < allNotes.length || duplicatesRemoved > 0;
        if (needsSave) {
          console.log(`[ZK] Cleaned up ${allNotes.length - deduplicatedNotes.length} notes total`);
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
      console.log('[ZK] Storage fully reset - all notes and caches cleared');
    } catch (error) {
      console.error('[ZK] Failed to reset storage:', error);
    }
  }

  /**
   * Sync Merkle tree with on-chain state
   * This fetches all commitments from the blockchain and rebuilds the tree
   */
  async syncMerkleTree(): Promise<void> {
    console.log('[ZK] Syncing Merkle tree with on-chain state...');

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

      // Fetch the on-chain merkle tree state
      const merkleTreeAccount = await this.connection.getAccountInfo(merkleTreePDA);
      if (!merkleTreeAccount) {
        console.log('[ZK] Merkle tree account not found - pool may not be initialized');
        return;
      }

      // Parse the on-chain root and leaf count
      // Layout: 8 (discriminator) + 32 (pool) + 32 (root) + 8 (leaf_count)
      const rootBytes = merkleTreeAccount.data.slice(8 + 32, 8 + 32 + 32);
      const leafCountOffset = 8 + 32 + 32;
      const onChainLeafCount = Number(merkleTreeAccount.data.readBigUInt64LE(leafCountOffset));

      // Convert on-chain root to bigint (little-endian - matches bigintToLeBytes)
      let onChainRoot = BigInt(0);
      for (let i = 31; i >= 0; i--) {
        onChainRoot = (onChainRoot << BigInt(8)) | BigInt(rootBytes[i]);
      }

      console.log('[ZK] On-chain leaf count:', onChainLeafCount);
      console.log('[ZK] On-chain root:', onChainRoot.toString().slice(0, 20) + '...');

      // Fetch all commitments from blockchain
      // We always fetch fresh to ensure consistency with on-chain state
      console.log('[ZK] Fetching commitments from blockchain...');
      const allCommitments = await this.fetchCommitmentsFromChain(merkleTreePDA, onChainLeafCount);

      // Rebuild the merkle tree from all commitments
      this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
      for (const commitment of allCommitments) {
        this.merkleTree.insert(commitment);
      }

      console.log('[ZK] Merkle tree rebuilt with', this.merkleTree.leafCount, 'leaves');
      console.log('[ZK] Local root:', this.merkleTree.root.toString().slice(0, 20) + '...');

      // Verify local root matches on-chain root
      if (this.merkleTree.root !== onChainRoot) {
        console.warn('[ZK] ROOT MISMATCH detected');
        console.warn('[ZK]   Local root:', this.merkleTree.root.toString().slice(0, 20) + '...');
        console.warn('[ZK]   On-chain root:', onChainRoot.toString().slice(0, 20) + '...');
        console.warn('[ZK]   Leaf counts match:', this.merkleTree.leafCount === onChainLeafCount);

        // IMPORTANT: Backup user notes before clearing - we need to preserve imported notes!
        const backupNotes = [...this.notes];
        console.log('[ZK] Backed up', backupNotes.length, 'notes before rebuild');

        // ROOT MISMATCH - clear local cache but KEEP global cache as fallback
        // Global cache is needed when some transactions can't be fetched due to rate limiting
        console.warn('[ZK] Clearing local cache and retrying fresh extraction...');
        await SecureStore.deleteItemAsync('zk_all_commitments');
        // Keep zk_global_commitments as fallback for rate-limited transactions

        // Rebuild tree fresh from blockchain only (no cache fallback)
        this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
        const freshCommitments = await this.fetchCommitmentsFromChain(merkleTreePDA, onChainLeafCount);
        for (const commitment of freshCommitments) {
          this.merkleTree.insert(commitment);
        }

        console.log('[ZK] Fresh rebuild - Local root:', this.merkleTree.root.toString().slice(0, 20) + '...');

        // Check if fresh rebuild matches
        if (this.merkleTree.root !== onChainRoot) {
          console.warn('[ZK] Root mismatch after rebuild - on-chain root is stale');
          console.warn('[ZK]   Local root:', this.merkleTree.root.toString().slice(0, 30) + '...');
          console.warn('[ZK]   On-chain root:', onChainRoot.toString().slice(0, 30) + '...');
          console.warn('[ZK]   Leaf counts match:', this.merkleTree.leafCount === onChainLeafCount);
          console.warn('[ZK] The on-chain root was computed with different zero values.');
          console.warn('[ZK] To fix: shield a small amount (0.001 SOL). This updates the on-chain root.');
          console.warn('[ZK] The local tree is correct - using it for future operations.');

          // Store the on-chain root for reference but DO NOT use it for proofs
          // Using on-chain root with local siblings causes proof failure!
          this._onChainRoot = onChainRoot;
        } else {
          console.log('[ZK] Fresh rebuild successful! Root now matches on-chain.');
          this._onChainRoot = null;
        }

        // Restore backed up notes - don't lose imported notes!
        this.notes = backupNotes;
        console.log('[ZK] Restored', this.notes.length, 'notes after rebuild');

        if (this.merkleTree.leafCount !== onChainLeafCount) {
          console.error('[ZK] Leaf count mismatch after fresh rebuild! Local:', this.merkleTree.leafCount, 'On-chain:', onChainLeafCount);
          throw new Error('Merkle tree leaf count mismatch - some commitments could not be extracted');
        }
      } else {
        console.log('[ZK] Root matches on-chain! Tree synced successfully.');
      }

      // Update leaf indices for user's notes and mark which are on-chain
      for (const note of this.notes) {
        const noteCommitmentStr = note.commitment.toString();

        // Verify the stored commitment matches what we'd compute
        const tokenMintField = BigInt('0x' + Buffer.from(this.tokenMint.toBytes()).toString('hex'));
        const recomputedCommitment = poseidonHash(note.amount, note.ownerPubkey, note.randomness, tokenMintField);
        if (recomputedCommitment !== note.commitment) {
          console.error('[ZK] CRITICAL: Stored commitment does not match recomputed!');
          console.error('[ZK]   Stored:', note.commitment.toString().slice(0, 20));
          console.error('[ZK]   Recomputed:', recomputedCommitment.toString().slice(0, 20));
          console.error('[ZK]   Note fields:', {
            amount: note.amount.toString(),
            ownerPubkey: note.ownerPubkey.toString().slice(0, 20),
            randomness: note.randomness.toString().slice(0, 20),
            tokenMint: tokenMintField.toString().slice(0, 20),
          });
        }

        const onChainIndex = allCommitments.findIndex(c => c.toString() === noteCommitmentStr);
        if (onChainIndex !== -1) {
          note.isOnChain = true;
          if (note.leafIndex !== onChainIndex) {
            console.log('[ZK] Updating note leaf index:', note.leafIndex, '->', onChainIndex);
            note.leafIndex = onChainIndex;
          }
          console.log('[ZK] Note verified on-chain at index', onChainIndex, 'amount:', note.amount.toString());
        } else {
          note.isOnChain = false;
          console.warn('[ZK] Note commitment not found in on-chain tree:', noteCommitmentStr.slice(0, 20));
        }
      }

      // Remove notes that are not on-chain (they failed to shield)
      const validNotes = this.notes.filter(note => note.isOnChain === true);
      if (validNotes.length < this.notes.length) {
        console.log(`[ZK] Removing ${this.notes.length - validNotes.length} invalid notes (not on-chain)`);
        this.notes = validNotes;
      }

      // Save updated notes
      await this.saveNotes();

    } catch (error) {
      console.error('[ZK] Failed to sync Merkle tree:', error);
      throw error;
    }
  }

  /**
   * Fetch all commitments from blockchain by parsing shield and unshield transaction logs
   * IMPORTANT: Blockchain is the source of truth - stored notes are used as fallback only
   */
  private async fetchCommitmentsFromChain(merkleTreePDA: PublicKey, expectedCount: number): Promise<bigint[]> {
    console.log('[ZK] Fetching commitments from blockchain...');

    // Map of leafIndex -> commitment (blockchain data takes priority)
    const commitmentMap = new Map<number, bigint>();

    // Store notes as fallback ONLY (will be used if blockchain extraction fails)
    const storedNotesFallback = new Map<number, bigint>();
    for (const note of this.notes) {
      if (note.leafIndex !== undefined && note.commitment) {
        storedNotesFallback.set(note.leafIndex, note.commitment);
        console.log('[ZK] Stored note fallback at index', note.leafIndex, ':', note.commitment.toString().slice(0, 20) + '...');
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

    console.log('[ZK] Found', signatures.length, 'transactions to process');

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
            console.log(`[ZK] Rate limited, waiting ${delay}ms before retry ${i + 1}/${retries}`);
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
                console.log('[ZK] Found shield commitment at index', leafIndex, ':', commitment.toString().slice(0, 20) + '...');
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
              console.log('[ZK] Found shield commitment at index', leafIndex, ':', commitment.toString().slice(0, 20) + '...');
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
                console.log('[ZK] Found unshield change commitment at index', leafIndex, ':', commitment.toString().slice(0, 20) + '...');
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
              console.log('[ZK] Found unshield change commitment at index', leafIndex, ':', commitment.toString().slice(0, 20) + '...');
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
                console.log('[ZK] Found transfer commitments at indices', transferIndices[0], transferIndices[1]);
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
              console.log('[ZK] Found transfer commitments at indices', transferIndices[0], transferIndices[1]);
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
        console.log('[ZK] Loaded', globalCommitmentCache.size, 'cached commitments');
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
      console.log('[ZK] Retrying', failedSignatures.length, 'failed fetches after cooldown...');
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

    console.log('[ZK] Extracted', commitmentMap.size, 'commitments');

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
      console.log('[ZK] Saved', globalCommitmentCache.size, 'commitments to global cache');
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
          console.log('[ZK] Using stored note fallback for index', i, ':', fallbackCommitment.toString().slice(0, 20) + '...');
          commitments.push(fallbackCommitment);
          missingCount++;
        } else {
          // Layer 2: Try global commitment cache (all commitments ever seen)
          const cachedCommitment = globalCommitmentCache.get(i);
          if (cachedCommitment) {
            console.log('[ZK] Using global cache for index', i, ':', cachedCommitment.slice(0, 20) + '...');
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
   * Clear all notes but keep the Merkle tree intact
   * Use this when notes are unrecoverable (wrong indices, etc.)
   */
  async clearNotes(): Promise<void> {
    this.notes = [];
    await SecureStore.deleteItemAsync('zk_notes');
    console.log('[ZK] Cleared all notes. Tree remains with', this.merkleTree.leafCount, 'leaves');
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
    console.log('[ZK Import] Starting import...');
    console.log('[ZK Import] Note string length:', noteString.length);

    if (!noteString.startsWith('p01note:')) {
      console.error('[ZK Import] Invalid format - does not start with p01note:');
      throw new Error('Invalid note format. Must start with "p01note:"');
    }

    const base64 = noteString.slice(8);
    console.log('[ZK Import] Base64 length:', base64.length);

    let json: string;
    let noteData: any;
    try {
      json = Buffer.from(base64, 'base64').toString('utf8');
      noteData = JSON.parse(json);
      console.log('[ZK Import] Parsed note data successfully');
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

    console.log('[ZK Import] Note details:');
    console.log('[ZK Import]   amount:', note.amount.toString());
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

    console.log('[ZK Import] Found at index:', onChainIndex);

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
      console.log('[ZK Import] Nullifier check passed - note is unspent');
    }

    // Add to local notes
    this.addNote(note);
    await this.saveNotes();

    console.log('[ZK Import] SUCCESS! Imported note at index', onChainIndex, 'amount:', note.amount.toString());
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
    viewTag?: string;
    error?: string;
  }> {
    console.log('[ZK Private Send] Starting true ZK transfer...');

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
    console.log('[ZK Private Send] Denomination:', DENOMINATIONS[denominationIndex] / 1e9, 'SOL');

    try {
      // 1. Decode recipient's stealth keys
      const keyBuffer = Buffer.from(recipientStealthKeys, 'base64');

      // Support both old format (64 bytes) and new format (96 bytes with X25519)
      let recipientSpendingPubKey: string;
      let recipientViewingPubKey: string;
      let recipientViewingX25519Pub: Uint8Array | undefined;

      if (keyBuffer.length === 96) {
        // New format: spending(32) + viewing(32) + viewingX25519(32)
        recipientSpendingPubKey = new PublicKey(keyBuffer.slice(0, 32)).toBase58();
        recipientViewingPubKey = new PublicKey(keyBuffer.slice(32, 64)).toBase58();
        recipientViewingX25519Pub = new Uint8Array(keyBuffer.slice(64, 96));
        console.log('[ZK Private Send] Using new stealth format with X25519 key');
      } else if (keyBuffer.length === 64) {
        // Old format: spending(32) + viewing(32)
        recipientSpendingPubKey = new PublicKey(keyBuffer.slice(0, 32)).toBase58();
        recipientViewingPubKey = new PublicKey(keyBuffer.slice(32, 64)).toBase58();
        console.log('[ZK Private Send] Using legacy stealth format (64 bytes)');
      } else {
        return { success: false, error: `Invalid stealth keys format (got ${keyBuffer.length} bytes)` };
      }

      // 2. Generate stealth address for recipient
      console.log('[ZK Private Send] Generating stealth address...');
      const stealthData = await generateStealthAddress(
        recipientSpendingPubKey,
        recipientViewingPubKey,
        recipientViewingX25519Pub
      );
      console.log('[ZK Private Send] Stealth address:', stealthData.address);

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
      console.log('[ZK Private Send] Generating ZK proof...');
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

      console.log('[ZK Private Send] Proof generated, sending to relayer...');

      // 5. Create request for relayer
      const requestBody = {
        proof: {
          pi_a: Array.from(zkProof.pi_a),
          pi_b: Array.from(zkProof.pi_b),
          pi_c: Array.from(zkProof.pi_c),
        },
        publicSignals: [
          merkleRoot.toString(),
          nullifier1.toString(),
          nullifier2.toString(),
          changeNote.commitment.toString(),
          dummyOutput2Commitment.toString(),
        ],
        nullifier: nullifier1.toString(),
        encryptedRecipient: '', // Not needed - we send stealth address directly
        ephemeralPublicKey: stealthData.ephemeralPublicKey,
        viewTag: stealthData.viewTag,
        denominationIndex,
        feeCommitment: '0', // Fee paid from shielded balance (TODO)
        stealthAddress: stealthData.address, // Direct stealth address
      };

      // 6. Send to relayer
      const response = await fetch(`${ZkService.BACKEND_PROVER_URL}/relay/private-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const result = await response.json();

      if (!result.success) {
        console.error('[ZK Private Send] Relayer error:', result.error);
        return { success: false, error: result.error || 'Relayer rejected request' };
      }

      // Relayer returns 'signature' not 'txSignature'
      const txSignature = result.signature || result.txSignature;
      console.log('[ZK Private Send] SUCCESS! Tx:', txSignature);
      console.log('[ZK Private Send] Stealth address:', result.stealthAddress);

      // 7. Mark notes as spent locally and add change note
      this.removeSpentNotes(notesToSpend);
      if (changeAmount > BigInt(0)) {
        const newRoot = this.merkleTree.insert(changeNote.commitment);
        changeNote.leafIndex = this.merkleTree.leafCount - 1;
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
   * Generate a proof for relayer-based private transfer (any amount)
   * This creates a proof showing we own funds, which the relayer verifies
   * before sending SOL to the recipient's stealth address.
   *
   * @param amount - Amount in lamports
   * @returns Proof data for relayer
   */
  async generateTransferProofForRelayer(amount: bigint): Promise<{
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    publicSignals: string[];
    nullifier: string;
    changeNoteData?: { noteString: string; amount: bigint; leafIndex: number };
  }> {
    if (!this.spendingKey || !this.spendingKeyHash || !this.ownerPubkey) {
      throw new Error('ZK Service not initialized');
    }

    console.log('[ZK] Generating transfer proof for relayer, amount:', Number(amount) / 1e9, 'SOL');

    // Sync merkle tree first
    await this.syncMerkleTree();

    // Select notes to spend
    const { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance. Have ${Number(totalValue) / 1e9} SOL, need ${Number(amount) / 1e9} SOL`);
    }

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

    // Create change note (remaining balance stays in pool)
    const changeAmount = totalValue - amount;
    const changeNote = await createNote(changeAmount, this.ownerPubkey, tokenMintField);

    // Create dummy output (the "spent" amount - relayer will send actual SOL)
    const dummyOutput2Commitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMintField);
    const dummyOutput2: Note = {
      amount: BigInt(0),
      ownerPubkey: BigInt(0),
      randomness: BigInt(0),
      tokenMint: tokenMintField,
      commitment: dummyOutput2Commitment,
    };

    // BN254 field modulus - negative numbers must be represented as p - |amount|
    const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

    // Convert public_amount to field representation (negative for withdrawal)
    const publicAmountField = FIELD_MODULUS - amount; // amount is positive, we want -amount in field

    // Build circuit inputs directly for backend prover (returns raw snarkjs format)
    const circuitInputs: Record<string, string> = {
      // Public inputs (snake_case)
      merkle_root: merkleRoot.toString(),
      nullifier_1: nullifier1.toString(),
      nullifier_2: nullifier2.toString(),
      output_commitment_1: changeNote.commitment.toString(),
      output_commitment_2: dummyOutput2Commitment.toString(),
      public_amount: publicAmountField.toString(),
      token_mint: tokenMintField.toString(),

      // Private inputs - Input note 1
      in_amount_1: inputNotesForCircuit[0]?.amount.toString() ?? '0',
      in_owner_pubkey_1: inputNotesForCircuit[0]?.ownerPubkey.toString() ?? '0',
      in_randomness_1: inputNotesForCircuit[0]?.randomness.toString() ?? '0',
      in_path_elements_1: JSON.stringify(proof1.pathElements.map(e => e.toString())),
      in_path_indices_1: JSON.stringify(proof1.pathIndices.map(i => i.toString())),

      // Private inputs - Input note 2
      in_amount_2: inputNotesForCircuit[1]?.amount.toString() ?? '0',
      in_owner_pubkey_2: inputNotesForCircuit[1]?.ownerPubkey.toString() ?? '0',
      in_randomness_2: inputNotesForCircuit[1]?.randomness.toString() ?? '0',
      in_path_elements_2: JSON.stringify(proof2.pathElements.map(e => e.toString())),
      in_path_indices_2: JSON.stringify(proof2.pathIndices.map(i => i.toString())),

      // Private inputs - Output notes
      out_amount_1: changeNote.amount.toString(),
      out_recipient_1: changeNote.ownerPubkey.toString(),
      out_randomness_1: changeNote.randomness.toString(),
      out_amount_2: dummyOutput2.amount.toString(),
      out_recipient_2: dummyOutput2.ownerPubkey.toString(),
      out_randomness_2: dummyOutput2.randomness.toString(),

      // Spending key
      spending_key: this.spendingKey.toString(),
    };

    // Generate proof using backend (returns raw snarkjs format for relayer)
    const { proof: snarkjsProof } = await this.generateProofViaBackendRaw(circuitInputs);

    console.log('[ZK] Raw snarkjs proof generated for relayer');

    // Store change note data (will be applied after relayer confirms)
    const changeNoteData = changeAmount > BigInt(0) ? {
      noteString: this.exportNote(changeNote),
      amount: changeAmount,
      leafIndex: -1, // Will be set after on-chain confirmation
    } : undefined;

    // Store notes to spend for later marking
    this._pendingSpendNotes = notesToSpend;
    this._pendingChangeNote = changeNote;

    // Return raw snarkjs format proof (string arrays, not byte arrays)
    // This is what snarkjs.groth16.verify expects on the relayer side
    return {
      proof: snarkjsProof,
      publicSignals: [
        merkleRoot.toString(),
        nullifier1.toString(),
        nullifier2.toString(),
        changeNote.commitment.toString(),
        dummyOutput2Commitment.toString(),
        publicAmountField.toString(), // public_amount as field element
        tokenMintField.toString(),
      ],
      nullifier: nullifier1.toString(),
      changeNoteData,
    };
  }

  // Pending notes for after relayer confirms
  private _pendingSpendNotes: Note[] = [];
  private _pendingChangeNote: Note | null = null;

  /**
   * Mark a note as spent after relayer confirms the transfer
   * @param nullifier - The nullifier string from the proof
   */
  async markNoteSpent(nullifier: string): Promise<void> {
    console.log('[ZK] Marking notes as spent after relayer confirmation');

    // Remove the spent notes
    if (this._pendingSpendNotes.length > 0) {
      this.removeSpentNotes(this._pendingSpendNotes);
      this._pendingSpendNotes = [];
    }

    // Add change note if it exists
    if (this._pendingChangeNote && this._pendingChangeNote.amount > BigInt(0)) {
      // In a real implementation, we'd need to update the merkle tree
      // For now, we track it locally - the next sync will pick it up
      this._pendingChangeNote.isOnChain = false; // Will be confirmed on next sync
      this.addNote(this._pendingChangeNote);
      console.log('[ZK] Change note added:', Number(this._pendingChangeNote.amount) / 1e9, 'SOL');
      this._pendingChangeNote = null;
    }

    await this.saveNotes();
    console.log('[ZK] Notes updated, new balance:', Number(this.getShieldedBalance()) / 1e9, 'SOL');
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
    console.log('[ZK] Scanning for stealth payments...');

    try {
      const RELAYER_URL = ZkService.BACKEND_PROVER_URL;
      const response = await fetch(`${RELAYER_URL}/relay/stealth-payments?limit=100`);

      if (!response.ok) {
        console.warn('[ZK] Failed to fetch stealth payments');
        return { found: 0, amount: 0, payments: [] };
      }

      const data = await response.json();
      const payments = data.payments || [];

      if (payments.length === 0) {
        return { found: 0, amount: 0, payments: [] };
      }

      // Get our stealth keys for scanning
      const stealthKeys = this.getStealthKeys();
      if (!stealthKeys) {
        return { found: 0, amount: 0, payments: [] };
      }

      // Try to scan each payment
      let found = 0;
      let totalAmount = 0;
      const foundPayments: Array<{ stealthAddress: string; amount: number; signature: string }> = [];

      for (const payment of payments) {
        try {
          // Check if we already have this payment
          if (this._foundStealthPayments.some(p => p.signature === payment.signature)) {
            continue;
          }

          const result = await scanStealthPayment(
            payment.ephemeralPublicKey,
            this.viewingKey!,
            bigintToLeBytes(this.spendingKey!),
            payment.viewTag
          );

          if (result.found && result.stealthAddress === payment.stealthAddress && result.privateKey) {
            console.log('[ZK] Found stealth payment!', payment.amount, 'SOL at', payment.stealthAddress.slice(0, 16) + '...');
            found++;
            totalAmount += payment.amount;

            // Store the payment with private key for later withdrawal
            this._foundStealthPayments.push({
              stealthAddress: payment.stealthAddress,
              privateKey: result.privateKey,
              amount: payment.amount,
              signature: payment.signature,
              ephemeralPublicKey: payment.ephemeralPublicKey,
            });

            foundPayments.push({
              stealthAddress: payment.stealthAddress,
              amount: payment.amount,
              signature: payment.signature,
            });
          }
        } catch (e) {
          // Not for us, skip
        }
      }

      if (found > 0) {
        console.log('[ZK] Found', found, 'stealth payments totaling', totalAmount, 'SOL');
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
    console.log('[ZK] Sweeping stealth payment from', stealthAddress.slice(0, 16) + '...');

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
      console.log('[ZK] Stealth address balance:', balance / 1e9, 'SOL');

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
      transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      transaction.sign(stealthKeypair);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      await this.connection.confirmTransaction(signature, 'confirmed');

      console.log('[ZK] Sweep successful! Signature:', signature);
      console.log('[ZK] Transferred', amountToSend / 1e9, 'SOL to', recipientAddress.slice(0, 16) + '...');

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
    console.log('[ZK] Sweeping all stealth payments...');

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

    console.log('[ZK] Sweep complete:', results.swept, 'payments,', results.totalAmount, 'SOL');
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
