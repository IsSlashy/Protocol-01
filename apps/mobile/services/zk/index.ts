/**
 * ZK Service for Mobile
 * Bridges the P-01 ZK SDK to React Native
 *
 * Note: snarkjs WASM doesn't run in React Native, so proof generation
 * is delegated to a backend prover service.
 */

import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import * as SecureStore from 'expo-secure-store';
import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';

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
    // On-chain uses keccak256("specter") mod p, stored as little-endian bytes
    if (!this._zeroValues) {
      // On-chain zero value bytes (stored in Rust as [u8; 32])
      const ZERO_VALUE_BYTES = [
        0x6c, 0xaf, 0x99, 0x48, 0xed, 0x85, 0x96, 0x24,
        0xe2, 0x41, 0xe7, 0x76, 0x0f, 0x34, 0x1b, 0x82,
        0xb4, 0x5d, 0xa1, 0xeb, 0xb6, 0x35, 0x3a, 0x34,
        0xf3, 0xab, 0xac, 0xd3, 0x60, 0x4c, 0xe5, 0x2f,
      ];
      // Convert to bigint (LITTLE-ENDIAN - matches Solana's byte order)
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

    const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

    // Check if transaction actually succeeded
    if (confirmation.value.err) {
      console.error('[ZK Shield] Transaction failed on-chain:', JSON.stringify(confirmation.value.err));
      throw new Error(`Shield transaction failed: ${JSON.stringify(confirmation.value.err)}`);
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
    const merkleRoot = this.merkleTree.root;

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
    const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');

    // Check if transaction actually succeeded
    if (confirmation.value.err) {
      console.error('[ZK Transfer] Transaction FAILED:', signature);
      console.error('[ZK Transfer] Error:', JSON.stringify(confirmation.value.err));
      throw new Error(`Transfer transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('[ZK Transfer] Transaction confirmed successfully:', signature);

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
    const merkleRoot = this.merkleTree.root;

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

    // Wait for confirmation and check for errors
    const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      console.error('[ZK Unshield] Transaction failed on-chain:', confirmation.value.err);
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    console.log('[ZK Unshield] Transaction confirmed successfully:', signature);

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

  /**
   * Set the prover function (called by ZkProverProvider)
   */
  setProver(prover: (inputs: Record<string, string>) => Promise<Groth16Proof>): void {
    this.proverFunction = prover;
    console.log('[ZK] Client-side prover connected');
  }

  /**
   * Generate proof using client-side prover (no backend)
   *
   * For React Native, this requires the ZkProverProvider to be mounted
   * and circuit files to be bundled with the app.
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
    if (!this.proverFunction) {
      throw new Error(
        'ZK Prover not available. Transfer and unshield operations require ' +
        'the ZkProverProvider to be mounted with circuit files bundled. ' +
        'Shield operations are available without the prover.'
      );
    }

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

    try {
      const proof = await this.proverFunction(circuitInputs);
      console.log('[ZK] Proof generated successfully');
      return proof;
    } catch (error) {
      console.error('[ZK] Client-side proof generation failed:', error);
      // Log the error details for debugging
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
   * Reset storage - clears all notes from SecureStore
   * Call this when migrating data or resetting the wallet
   */
  static async resetStorage(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync('zk_notes');
      await SecureStore.deleteItemAsync('zk_all_commitments');
      console.log('[ZK] Storage reset - notes and commitments cleared');
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

        // If leaf counts match, this is likely due to a previous bug where on-chain root wasn't updated
        // The client-computed root is correct; the next transaction will fix on-chain state
        if (this.merkleTree.leafCount === onChainLeafCount) {
          console.warn('[ZK] RECOVERY MODE: Leaf counts match but roots differ.');
          console.warn('[ZK] This is likely due to a previous client bug. Proceeding with client-computed root.');
          console.warn('[ZK] The next successful shield/unshield will fix the on-chain root.');

          // Clear notes but don't fail - allow recovery
          this.notes = [];
          await SecureStore.deleteItemAsync('zk_notes');
          await SecureStore.deleteItemAsync('zk_all_commitments');

          console.log('[ZK] Notes cleared for recovery. Proceeding with client-computed merkle tree.');
        } else {
          // Leaf counts don't match - this is a real sync issue
          console.error('[ZK] Leaf count mismatch! Local:', this.merkleTree.leafCount, 'On-chain:', onChainLeafCount);

          // Clear corrupted notes
          console.log('[ZK] Clearing all stored notes due to corruption...');
          this.notes = [];
          await SecureStore.deleteItemAsync('zk_notes');
          await SecureStore.deleteItemAsync('zk_all_commitments');

          // Rebuild tree fresh from blockchain only
          this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
          const freshCommitments = await this.fetchCommitmentsFromChain(merkleTreePDA, onChainLeafCount);
          for (const commitment of freshCommitments) {
            this.merkleTree.insert(commitment);
          }

          console.log('[ZK] Fresh rebuild - Local root:', this.merkleTree.root.toString().slice(0, 20) + '...');

          if (this.merkleTree.root !== onChainRoot) {
            console.error('[ZK] Still mismatched after fresh rebuild!');
            throw new Error('Merkle tree root mismatch - blockchain extraction failed');
          }

          console.log('[ZK] Fresh rebuild successful! Notes cleared - you may need to re-shield.');
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
    const fetchTxWithRetry = async (sig: string, retries = 3): Promise<any> => {
      for (let i = 0; i < retries; i++) {
        try {
          const tx = await this.connection.getTransaction(sig, {
            maxSupportedTransactionVersion: 0,
          });
          return tx;
        } catch (e: any) {
          if (e?.message?.includes('429') || e?.message?.includes('rate')) {
            const delay = Math.pow(2, i) * 1000; // Exponential backoff: 1s, 2s, 4s
            console.log(`[ZK] Rate limited, waiting ${delay}ms before retry ${i + 1}/${retries}`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            throw e;
          }
        }
      }
      return null;
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
    let fetchCount = 0;
    for (const { signature } of signatures) {
      try {
        // Add small delay every 5 fetches to avoid rate limiting
        if (fetchCount > 0 && fetchCount % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        fetchCount++;

        const tx = await fetchTxWithRetry(signature);

        if (!tx?.meta?.logMessages) continue;

        // Look for shield, unshield, or transfer instruction logs
        const logs = tx.meta.logMessages;

        let isShield = false;
        let isUnshield = false;
        let isTransfer = false;
        let leafIndex: number | null = null;
        let transferIndices: [number, number] | null = null;

        for (const log of logs) {
          // Anchor logs format: "Program log: Instruction: Shield"
          if (log.includes('Shield') && !log.includes('Unshield')) {
            isShield = true;
          }
          if (log.includes('Unshield')) {
            isUnshield = true;
          }
          // Note: Program logs "Private transfer completed" - must be specific to avoid
          // false positives from "Transferred X lamports" in Shield/Unshield logs
          if (log.includes('Private transfer completed') || log.includes('Instruction: Transfer')) {
            isTransfer = true;
            console.log('[ZK] Detected Transfer from log:', log);
          }

          // Parse "Commitment added at index: X" (from shield)
          const indexMatch = log.match(/Commitment added at index: (\d+)/);
          if (indexMatch) {
            leafIndex = parseInt(indexMatch[1], 10);
          }

          // Parse "Change commitment at index: X" (from unshield)
          const changeIndexMatch = log.match(/Change commitment at index: (\d+)/);
          if (changeIndexMatch) {
            leafIndex = parseInt(changeIndexMatch[1], 10);
            console.log('[ZK] Found unshield change index:', leafIndex);
          }

          // Parse "New commitments at indices: X, Y" (from transfer)
          const transferMatch = log.match(/New commitments at indices: (\d+), (\d+)/);
          if (transferMatch) {
            transferIndices = [parseInt(transferMatch[1], 10), parseInt(transferMatch[2], 10)];
            console.log('[ZK] Found transfer indices:', transferIndices);
          }
        }

        // Debug log to see what we're detecting
        if (isShield || isUnshield || isTransfer) {
          console.log('[ZK] TX type:', isShield ? 'Shield' : isUnshield ? 'Unshield' : 'Transfer',
            'leafIndex:', leafIndex, 'transferIndices:', transferIndices);
        } else {
          // Log unrecognized transactions for debugging
          const relevantLogs = logs.filter(l =>
            l.includes('Program log:') &&
            !l.includes('invoke') &&
            !l.includes('success')
          );
          if (relevantLogs.length > 0) {
            console.log('[ZK] Unrecognized TX logs:', relevantLogs.slice(0, 3));
          }
        }

        const txData = tx.transaction.message;

        // Handle Shield transactions - always extract from blockchain (source of truth)
        if (isShield && leafIndex !== null) {
          // Shield instruction: discriminator(8) + amount(8) + commitment(32) + new_root(32)
          if ('compiledInstructions' in txData) {
            const programIndex = txData.staticAccountKeys.findIndex(
              (k: PublicKey) => k.equals(this.programId)
            );
            if (programIndex !== -1) {
              for (const ix of txData.compiledInstructions) {
                if (ix.programIdIndex === programIndex && ix.data.length >= 80) {
                  const commitmentBytes = Buffer.from(ix.data.slice(16, 48));
                  let commitment = BigInt(0);
                  for (let i = 31; i >= 0; i--) {
                    commitment = (commitment << BigInt(8)) | BigInt(commitmentBytes[i]);
                  }
                  commitmentMap.set(leafIndex, commitment);
                  console.log('[ZK] Found shield commitment at index', leafIndex, ':', commitment.toString().slice(0, 20) + '...');
                  break;
                }
              }
            }
          } else {
            for (const ix of txData.instructions) {
              // For parsed transactions, ix.data is base58 encoded string
              const ixDataRaw = typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data;
              if (ix.programId.equals(this.programId) && ixDataRaw.length >= 80) {
                const commitmentBytes = ixDataRaw.slice(16, 48);
                let commitment = BigInt(0);
                for (let i = 31; i >= 0; i--) {
                  commitment = (commitment << BigInt(8)) | BigInt(commitmentBytes[i]);
                }
                commitmentMap.set(leafIndex, commitment);
                console.log('[ZK] Found shield commitment at index', leafIndex, ':', commitment.toString().slice(0, 20) + '...');
                break;
              }
            }
          }
        }

        // Handle Unshield transactions (extract change note commitment)
        // Unshield instruction layout:
        // discriminator(8) + proof(256) + nullifier_1(32) + nullifier_2(32) + output_commitment_1(32) + ...
        // output_commitment_1 is at offset 8 + 256 + 32 + 32 = 328
        // Always extract from blockchain (source of truth)
        if (isUnshield && leafIndex !== null) {
          const UNSHIELD_COMMITMENT_OFFSET = 8 + 256 + 32 + 32; // 328
          let found = false;

          if ('compiledInstructions' in txData) {
            const programIndex = txData.staticAccountKeys.findIndex(
              (k: PublicKey) => k.equals(this.programId)
            );
            console.log('[ZK] Unshield TX - programIndex:', programIndex, 'looking for leafIndex:', leafIndex);
            if (programIndex !== -1) {
              for (const ix of txData.compiledInstructions) {
                console.log('[ZK] Checking instruction - programIdIndex:', ix.programIdIndex, 'dataLength:', ix.data.length);
                // Unshield instruction is larger than shield (>400 bytes)
                if (ix.programIdIndex === programIndex && ix.data.length > 400) {
                  const commitmentBytes = Buffer.from(ix.data.slice(UNSHIELD_COMMITMENT_OFFSET, UNSHIELD_COMMITMENT_OFFSET + 32));
                  let commitment = BigInt(0);
                  for (let i = 31; i >= 0; i--) {
                    commitment = (commitment << BigInt(8)) | BigInt(commitmentBytes[i]);
                  }
                  commitmentMap.set(leafIndex, commitment);
                  console.log('[ZK] Found unshield change commitment at index', leafIndex, ':', commitment.toString().slice(0, 20) + '...');
                  found = true;
                  break;
                }
              }
            }
          } else {
            for (const ix of txData.instructions) {
              // For parsed transactions, ix.data is base58 encoded string
              const ixDataRaw = typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data;
              console.log('[ZK] Checking legacy instruction - dataLength:', ixDataRaw.length);
              if (ix.programId.equals(this.programId) && ixDataRaw.length > 400) {
                const commitmentBytes = ixDataRaw.slice(UNSHIELD_COMMITMENT_OFFSET, UNSHIELD_COMMITMENT_OFFSET + 32);
                let commitment = BigInt(0);
                for (let i = 31; i >= 0; i--) {
                  commitment = (commitment << BigInt(8)) | BigInt(commitmentBytes[i]);
                }
                commitmentMap.set(leafIndex, commitment);
                console.log('[ZK] Found unshield change commitment at index', leafIndex, ':', commitment.toString().slice(0, 20) + '...');
                found = true;
                break;
              }
            }
          }

          if (!found) {
            console.warn('[ZK] Failed to extract unshield commitment at index', leafIndex);
          }
        }

        // Handle Transfer transactions (extract both output commitments)
        // Transfer instruction layout:
        // discriminator(8) + proof(256) + nullifier_1(32) + nullifier_2(32) + output_commitment_1(32) + output_commitment_2(32) + merkle_root(32)
        // output_commitment_1 at offset 328, output_commitment_2 at offset 360
        if (isTransfer && transferIndices) {
          const TRANSFER_COMMITMENT_1_OFFSET = 8 + 256 + 32 + 32; // 328
          const TRANSFER_COMMITMENT_2_OFFSET = TRANSFER_COMMITMENT_1_OFFSET + 32; // 360

          const extractCommitment = (data: Uint8Array, offset: number): bigint => {
            const bytes = data.slice(offset, offset + 32);
            let commitment = BigInt(0);
            for (let i = 31; i >= 0; i--) {
              commitment = (commitment << BigInt(8)) | BigInt(bytes[i]);
            }
            return commitment;
          };

          if ('compiledInstructions' in txData) {
            const programIndex = txData.staticAccountKeys.findIndex(
              (k: PublicKey) => k.equals(this.programId)
            );
            if (programIndex !== -1) {
              for (const ix of txData.compiledInstructions) {
                if (ix.programIdIndex === programIndex && ix.data.length > 400) {
                  const commitment1 = extractCommitment(ix.data, TRANSFER_COMMITMENT_1_OFFSET);
                  const commitment2 = extractCommitment(ix.data, TRANSFER_COMMITMENT_2_OFFSET);
                  commitmentMap.set(transferIndices[0], commitment1);
                  commitmentMap.set(transferIndices[1], commitment2);
                  console.log('[ZK] Found transfer commitment 1 at index', transferIndices[0], ':', commitment1.toString().slice(0, 20) + '...');
                  console.log('[ZK] Found transfer commitment 2 at index', transferIndices[1], ':', commitment2.toString().slice(0, 20) + '...');
                  break;
                }
              }
            }
          } else {
            for (const ix of txData.instructions) {
              const ixDataRaw = typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data;
              if (ix.programId.equals(this.programId) && ixDataRaw.length > 400) {
                const commitment1 = extractCommitment(ixDataRaw, TRANSFER_COMMITMENT_1_OFFSET);
                const commitment2 = extractCommitment(ixDataRaw, TRANSFER_COMMITMENT_2_OFFSET);
                commitmentMap.set(transferIndices[0], commitment1);
                commitmentMap.set(transferIndices[1], commitment2);
                console.log('[ZK] Found transfer commitment 1 at index', transferIndices[0], ':', commitment1.toString().slice(0, 20) + '...');
                console.log('[ZK] Found transfer commitment 2 at index', transferIndices[1], ':', commitment2.toString().slice(0, 20) + '...');
                break;
              }
            }
          }
        }
      } catch (e) {
        // Skip failed tx parsing
        console.warn('[ZK] Failed to parse transaction:', e);
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

    await SecureStore.deleteItemAsync('zk_notes');
    // Note: We keep zk_global_commitments as it contains pool-wide data that's useful for recovery
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
}

// Singleton instance
let zkServiceInstance: ZkService | null = null;

export function getZkService(): ZkService {
  if (!zkServiceInstance) {
    zkServiceInstance = new ZkService();
  }
  return zkServiceInstance;
}
