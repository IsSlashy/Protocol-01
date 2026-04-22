/**
 * ZK Service for Mobile
 * Bridges the P-01 ZK SDK to React Native
 *
 * Proof generation runs client-side in a hidden WebView with the Winterfell
 * STARK prover (WASM). Spending keys NEVER leave the device.
 * See StarkProver + StarkProverProvider.
 */

import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, Keypair } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { keccak_256 } from '@noble/hashes/sha3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { generateStealthAddress, scanStealthPayment, type StealthAddress } from '../../utils/crypto/stealth';

// Constants from zk-sdk
const ZK_SHIELDED_PROGRAM_ID = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';
// STARK migration: tree depth is canonicalized to 15 (matches circuit 6 CANONICAL_DEPTH
// and ShieldedPool::DEFAULT_TREE_DEPTH). Changing this invalidates all prior deposits.
const MERKLE_TREE_DEPTH = 15;

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

// Goldilocks-Poseidon: matches stark/src/poseidon/mod.rs byte-for-byte.
// Used by the MerkleTree client-side tree so the root it feeds into circuit 6
// (merkle_update) agrees with the on-chain verifier.
import {
  GOLDILOCKS_MODULUS,
  goldilocksHash2to1,
  computeGoldilocksZeroCascade,
} from './goldilocks-poseidon';

// STARK verifier integration (circuit 6 merkle_update for shield).
import {
  submitAndVerifyStarkProof,
  closeStarkProofBuffer,
  type GenericStarkProof,
  type WalletSigner,
} from '../stark';

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
 * Reduce a bigint to the Goldilocks field (2^64 - 2^32 + 1). Handles negatives.
 */
function truncateToGoldilocks(value: bigint): bigint {
  const r = value % GOLDILOCKS_MODULUS;
  return r < 0n ? r + GOLDILOCKS_MODULUS : r;
}

/**
 * Hash a 32-byte buffer down into the Goldilocks field. Takes the low 8 bytes
 * as u64 LE, then reduces. Matches how on-chain code treats pubkeys/mints for
 * circuit public inputs (bytes 0..8 as the Goldilocks value, 8..32 must be 0).
 */
function bytesToGoldilocks(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i] ?? 0);
  }
  return truncateToGoldilocks(v);
}

/**
 * Pack a Goldilocks u64 into a 32-byte buffer (bytes 0..8 = u64 LE, 8..32 = 0).
 * This is the canonical on-chain Goldilocks commitment/root layout.
 */
function packGoldilocksU64(n: bigint): Uint8Array {
  const g = truncateToGoldilocks(n);
  const bytes = new Uint8Array(32);
  let temp = g;
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
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
 * Derive spending key from seed phrase.
 *
 * Returns the raw 32-byte SHA-256 seed (needed for Ed25519 keypair derivation
 * used by stealth-address receiving + specter-sdk scan) plus the Goldilocks
 * variants driving STARK circuit 5. The Goldilocks `spendingKeyGl` is the low
 * 8 bytes of the seed; `ownerPubkeyGl = hash2(sk, 0)` matches circuit 5's
 * cycle-0 derivation (`owner = Poseidon(spending_key, 0)`), so shielded notes
 * created by this client are spendable on-chain.
 */
async function deriveSpendingKey(seedPhrase: string): Promise<{
  spendingKeyBytes: Uint8Array;
  spendingKeyGl: bigint;
  ownerPubkeyGl: bigint;
}> {
  const crypto = require('expo-crypto');
  const seed = new TextEncoder().encode(seedPhrase + ':spending_key');

  const hashResult = await crypto.digestStringAsync(
    crypto.CryptoDigestAlgorithm.SHA256,
    Buffer.from(seed).toString('hex')
  );

  const hashBytes = new Uint8Array(Buffer.from(hashResult, 'hex'));
  let spendingKeyGl = 0n;
  for (let i = 7; i >= 0; i--) {
    spendingKeyGl = (spendingKeyGl << 8n) | BigInt(hashBytes[i] ?? 0);
  }
  spendingKeyGl = truncateToGoldilocks(spendingKeyGl);
  const ownerPubkeyGl = goldilocksHash2to1(spendingKeyGl, 0n);

  return { spendingKeyBytes: hashBytes, spendingKeyGl, ownerPubkeyGl };
}

/**
 * Fresh Goldilocks-field randomness (u64 reduced mod the Goldilocks modulus).
 */
async function randomGoldilocksU64(): Promise<bigint> {
  const crypto = require('expo-crypto');
  const bytes = await crypto.getRandomBytesAsync(8);
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]);
  }
  return truncateToGoldilocks(v);
}

/**
 * Build a Goldilocks note commitment that matches circuit 5 (transfer).
 *
 * Layout (from `stark/src/air/transfer.rs`):
 *   commitment = hash2(hash2(amount, rand), hash2(owner, mint))
 *
 * This is the shared layout for both the input side (where `owner` is the
 * sender's own pubkey) and the output side (where `owner` is the recipient's
 * pubkey). Inputs MUST already be Goldilocks elements.
 */
function computeGoldilocksCommitment(
  amountGl: bigint,
  ownerPubkeyGl: bigint,
  randomnessGl: bigint,
  tokenMintGl: bigint,
): bigint {
  const leftHash = goldilocksHash2to1(amountGl, randomnessGl);
  const rightHash = goldilocksHash2to1(ownerPubkeyGl, tokenMintGl);
  return goldilocksHash2to1(leftHash, rightHash);
}

/**
 * Create a new Goldilocks-field note whose commitment follows the circuit 5
 * layout. The resulting commitment is a u64 that packs into bytes 0..8 of the
 * on-chain [u8; 32] and is consistent with both:
 *   - circuit 6 (merkle_update) at shield time, which treats the commitment
 *     as an opaque leaf value, and
 *   - circuit 5 (transfer) at spend time, which reconstructs the commitment
 *     inside the trace from (spending_key, amount, randomness, token_mint).
 *
 * `ownerPubkeyGl` MUST be `hash2(spending_key_gl, 0)` — exactly what circuit 5
 * derives in cycle 0.
 */
async function createGoldilocksNote(
  amount: bigint,
  ownerPubkeyGl: bigint,
  tokenMintGl: bigint,
): Promise<Note> {
  const randomness = await randomGoldilocksU64();
  const amountGl = truncateToGoldilocks(amount);
  const commitment = computeGoldilocksCommitment(amountGl, ownerPubkeyGl, randomness, tokenMintGl);

  return {
    amount: amountGl,
    ownerPubkey: ownerPubkeyGl,
    randomness,
    tokenMint: tokenMintGl,
    commitment,
  };
}

/**
 * Compute the nullifier for a Goldilocks note.
 *
 * Matches `stark/src/air/transfer.rs`: `nullifier = Poseidon(commitment, owner)`
 * where `owner = Poseidon(spending_key, 0)` is derived in cycle 0 of circuit 5.
 * Callers pass `ownerPubkeyGl` (the cycle-0 derivation) so what we store and
 * what circuit 5 reconstructs agree byte-for-byte.
 */
function computeNullifier(commitment: bigint, ownerPubkeyGl: bigint): bigint {
  return goldilocksHash2to1(commitment, ownerPubkeyGl);
}

/**
 * Client-side Merkle tree (matches on-chain structure).
 *
 * Hash: Goldilocks-Poseidon (width=3, hash2-to-1) — binary-identical to
 *   `stark/src/poseidon/mod.rs` and the circuit 6 AIR.
 * Leaves: Goldilocks field elements (u64 values packed into bytes 0..8 of the
 *   on-chain [u8; 32] commitment, zeros 8..32).
 * Empty tree: `computeGoldilocksZeroCascade(depth)` starts at 0n and folds
 *   upward with `hash(0,0), hash(h1,h1), …` — matches circuit 6's CANONICAL
 *   empty-tree zeros.
 */
class MerkleTree {
  private depth: number;
  private leaves: bigint[] = [];
  private nodes: Map<string, bigint> = new Map();
  private _root: bigint | null = null;
  private _zeroValues: bigint[] | null = null;

  constructor(depth: number = MERKLE_TREE_DEPTH) {
    this.depth = depth;
    // Root is computed lazily so consumers can import the class before the
    // Goldilocks-Poseidon module is warmed up.
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
    if (!this._zeroValues) {
      this._zeroValues = computeGoldilocksZeroCascade(this.depth);
    }
    return this._zeroValues[level];
  }

  insert(leaf: bigint): bigint {
    const index = this.leaves.length;
    this.leaves.push(leaf);

    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = this.getNode(level, siblingIndex);

      this.setNode(level, currentIndex, currentHash);

      currentHash = isRight
        ? goldilocksHash2to1(sibling, currentHash)
        : goldilocksHash2to1(currentHash, sibling);
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
        ? goldilocksHash2to1(sibling, currentHash)
        : goldilocksHash2to1(currentHash, sibling);
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
          currentHash = goldilocksHash2to1(currentHash, this.getZeroValue(level));
        } else {
          currentHash = goldilocksHash2to1(subtrees[level], currentHash);
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
  // 32-byte SHA-256 seed. Used as the Ed25519 keypair seed for stealth
  // address derivation + specter-sdk scanning. Never leaves the device.
  private spendingKeyBytes: Uint8Array | null = null;
  // Goldilocks variants (STARK circuit 5). ownerPubkeyGl = hash2(spendingKeyGl, 0).
  private spendingKeyGl: bigint | null = null;
  private ownerPubkeyGl: bigint | null = null;
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
    this.spendingKeyBytes = keys.spendingKeyBytes;
    this.spendingKeyGl = keys.spendingKeyGl;
    this.ownerPubkeyGl = keys.ownerPubkeyGl;
    // ZK address encodes the Goldilocks owner pubkey so recipients of a
    // transfer can be bound to the value circuit 5 derives from their
    // spending key (cycle 0: owner = hash2(sk, 0)).
    this.viewingKey = bigintToLeBytes(keys.ownerPubkeyGl);


    // Load persisted notes
    await this.loadNotes();

    this.isInitialized = true;
  }

  /**
   * Get ZK address for receiving payments
   */
  getZkAddress(): ZkAddress {
    if (!this.ownerPubkeyGl || !this.viewingKey) {
      throw new Error('ZK Service not initialized');
    }

    // receivingPubkey is the Goldilocks owner pubkey so circuit 5 can
    // reconstruct output commitments from the recipient's spending key.
    const pubkeyBytes = bigintToLeBytes(this.ownerPubkeyGl);
    const combined = new Uint8Array(64);
    combined.set(pubkeyBytes, 0);
    combined.set(this.viewingKey, 32);

    // Using base64 for React Native compatibility
    const encoded = `zk:${Buffer.from(combined).toString('base64')}`;

    return {
      receivingPubkey: this.ownerPubkeyGl,
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
      const nullifier = computeNullifier(note.commitment, this.ownerPubkeyGl!);
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
   * Shield tokens (deposit from transparent to shielded) — STARK flow.
   *
   * Flow:
   *   1. Read on-chain subtrees + current root (pool.merkle_root).
   *   2. Create a Goldilocks-field note for the depositor.
   *   3. Compute (old_root, new_root, path) from filled subtrees.
   *   4. Generate a circuit 6 (merkle_update) STARK proof on device.
   *   5. Upload + verify the proof on-chain (phase 1 + DEEP-ALI phase 2),
   *      leaving the proof buffer open.
   *   6. Call zk_shielded::shield_stark (consumes the proof buffer, performs
   *      the actual deposit, inserts the commitment, updates pool root).
   *   7. Close the proof buffer to recover rent.
   *
   * The STARK circuit binds (old_root → new_root) given an insertion of
   * `commitment` at the tree's next slot. `shield_stark` enforces
   * `pool.merkle_root == old_root`, so a malicious client cannot poison the
   * root with an arbitrary successor.
   */
  async shield(
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {

    if (!this.ownerPubkeyGl) {
      throw new Error('ZK Service not initialized');
    }

    if (!this.merkleUpdateProver) {
      throw new Error(
        'STARK merkle_update prover not available. ' +
        'StarkProverProvider must be mounted and warmed up before shield().'
      );
    }

    // -----------------------------------------------------------------
    // 1. Read on-chain state (single RPC, ~200ms).
    // -----------------------------------------------------------------
    console.log('[ZK Shield] Reading on-chain state...');
    const onChainState = await this.readOnChainFilledSubtrees();

    // Prefer locally-stored correct subtrees over on-chain ones (on-chain
    // subtrees can be stale for levels > 0 in some historical states).
    const localSubtrees = await this.loadLocalSubtrees(onChainState.leafCount);
    let useSubtrees: bigint[];
    if (localSubtrees) {
      useSubtrees = localSubtrees;
    } else if (this.merkleTree.leafCount === onChainState.leafCount && onChainState.leafCount > 0) {
      console.log('[ZK Shield] Computing subtrees from synced tree');
      useSubtrees = this.merkleTree.getFilledSubtrees();
      await this.saveLocalSubtrees(useSubtrees, onChainState.leafCount);
    } else {
      console.warn('[ZK Shield] Using on-chain subtrees (may be stale for levels > 0)');
      useSubtrees = onChainState.filledSubtrees;
    }

    // -----------------------------------------------------------------
    // 2. Create Goldilocks note for self. The commitment uses circuit 5's
    //    layout so this note can later be spent via transfer_stark.
    // -----------------------------------------------------------------
    const tokenMintGl = bytesToGoldilocks(this.tokenMint.toBytes());
    const note = await createGoldilocksNote(amount, this.ownerPubkeyGl, tokenMintGl);

    // -----------------------------------------------------------------
    // 3. Compute (old_root, new_root, path) from subtrees.
    //    The circuit checks that both roots arise from the same path.
    // -----------------------------------------------------------------
    const leafIndexBeforeInsert = onChainState.leafCount;

    // oldRoot: same path, leaf = 0.
    const { newRoot: computedOldRoot } = this.computeNewRootFromSubtrees(
      useSubtrees,
      onChainState.leafCount,
      0n,
      onChainState.depth,
    );

    // newRoot: same path, leaf = commitment. Also returns the updated subtrees
    // we'll persist once the shield transaction lands.
    const { newRoot, updatedSubtrees, pathElements, pathIndices } = this.computeNewRootFromSubtrees(
      useSubtrees,
      onChainState.leafCount,
      note.commitment,
      onChainState.depth,
    );

    // Sanity: if the client's view of oldRoot doesn't match the on-chain root,
    // shield_stark will reject with InvalidMerkleRoot. Fail fast.
    if (computedOldRoot !== onChainState.root) {
      throw new Error(
        `Shield aborted: client merkle state is out of sync with on-chain pool. ` +
        `Expected root ${onChainState.root.toString()} but local subtrees produce ${computedOldRoot.toString()}. ` +
        `Call syncMerkleTree() or reset the local tree.`,
      );
    }

    const oldRootBytes = packGoldilocksU64(computedOldRoot);
    const newRootBytes = packGoldilocksU64(newRoot);
    const commitmentBytes = packGoldilocksU64(note.commitment);

    console.log(
      '[ZK Shield] Roots computed leaf=%d old=%s new=%s',
      leafIndexBeforeInsert,
      computedOldRoot.toString().slice(0, 20),
      newRoot.toString().slice(0, 20),
    );

    note.leafIndex = leafIndexBeforeInsert;
    note.merkleRoot = newRoot;
    note.merklePathElements = pathElements;
    note.merklePathIndices = pathIndices;
    note.isOnChain = true;

    // -----------------------------------------------------------------
    // 4. Generate circuit 6 STARK proof on device.
    // -----------------------------------------------------------------
    console.log('[ZK Shield] Generating circuit 6 (merkle_update) STARK proof...');
    const starkResult = await this.merkleUpdateProver(
      '0', // old_leaf (empty slot)
      note.commitment.toString(), // new_leaf = commitment (Goldilocks u64)
      pathElements.map(e => e.toString()),
      pathIndices,
    );
    console.log(
      '[ZK Shield] STARK proof generated in %dms (%d bytes)',
      (starkResult as any).durationMs ?? 0,
      starkResult.proofSize,
    );

    const proofBytes = Buffer.from(starkResult.proofHex, 'hex');
    const publicInputs = starkResult.publicInputs.map((s) => BigInt(s));

    const starkProof: GenericStarkProof = {
      proofBytes,
      circuitId: 6, // CIRCUIT_MERKLE_UPDATE
      publicInputs,
      proofSize: starkResult.proofSize,
    };

    // -----------------------------------------------------------------
    // 5. Pre-flight SOL balance for proof-upload + shield amount + fees.
    // -----------------------------------------------------------------
    const walletBalance = await this.connection.getBalance(walletPublicKey);
    const shieldAmount = Number(amount);
    // STARK proof upload (~13 chunks + init + verify + deep-ali + close) ≈ 13 * 5k + 50k
    const starkUploadFees = 120_000;
    const shieldFees = 15_000;
    const required = shieldAmount + starkUploadFees + shieldFees;
    if (walletBalance < required) {
      const have = (walletBalance / 1e9).toFixed(4);
      const need = (required / 1e9).toFixed(4);
      throw new Error(`Insufficient SOL. Need ${need} SOL (${(shieldAmount / 1e9).toFixed(4)} to shield + STARK upload fees), wallet has ${have} SOL.`);
    }

    // -----------------------------------------------------------------
    // 6. Upload + verify STARK proof on-chain (buffer left open).
    // -----------------------------------------------------------------
    const walletSigner: WalletSigner = {
      publicKey: walletPublicKey,
      signTransaction,
    };

    console.log('[ZK Shield] Uploading + verifying STARK proof on-chain...');
    const { proofBuffer } = await submitAndVerifyStarkProof(
      starkProof,
      walletSigner,
      (step) => console.log('[ZK Shield][STARK]', step),
      this.connection,
    );

    // -----------------------------------------------------------------
    // 7. Build shield_stark instruction.
    // -----------------------------------------------------------------
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId,
    );

    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId,
    );

    // Anchor discriminator: sha256("global:shield_stark")[0..8]
    const SHIELD_STARK_DISCRIMINATOR = Buffer.from([241, 184, 171, 177, 138, 30, 238, 145]);
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(amount, 0);

    const ixData = Buffer.concat([
      SHIELD_STARK_DISCRIMINATOR,
      commitmentBytes,
      oldRootBytes,
      newRootBytes,
      amountBuffer,
    ]);

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: proofBuffer, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        // Optional SPL accounts — Anchor requires them as placeholders for native SOL.
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: this.programId, isSigner: false, isWritable: false }, // user_token_account
        { pubkey: this.programId, isSigner: false, isWritable: false }, // pool_vault
      ],
      data: ixData,
    });

    // -----------------------------------------------------------------
    // 8. Send shield_stark with retry on dropped tx.
    // -----------------------------------------------------------------
    const MAX_RETRIES = 3;
    let signature = '';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const tx = new Transaction().add(ix);
      tx.feePayer = walletPublicKey;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const signedTx = await signTransaction(tx);
      console.log(`[ZK Shield] Sending shield_stark tx (attempt ${attempt}/${MAX_RETRIES})...`);
      signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'processed',
        maxRetries: 3,
      });
      console.log(`[ZK Shield] Tx sent: ${signature}`);

      try {
        const confirmation = await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'processed',
        );
        if (confirmation.value.err) {
          console.error('[ZK Shield] Transaction failed on-chain:', JSON.stringify(confirmation.value.err));
          throw new Error(`Shield transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
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
          const status = await this.connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
            break;
          }
          throw new Error(`Shield transaction dropped after ${MAX_RETRIES} attempts. Devnet may be congested — try again.`);
        }
        throw e;
      }
    }

    // -----------------------------------------------------------------
    // 9. Close the STARK proof buffer (recover rent, best-effort).
    // -----------------------------------------------------------------
    try {
      await closeStarkProofBuffer(proofBuffer, walletSigner, this.connection);
    } catch (err) {
      console.warn('[ZK Shield] Could not close STARK proof buffer:', err);
    }

    // -----------------------------------------------------------------
    // 10. Post-confirmation bookkeeping.
    // -----------------------------------------------------------------
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
    } catch {
      console.warn('[ZK Shield] Could not verify on-chain leaf index');
    }

    await this.saveLocalSubtrees(updatedSubtrees, onChainState.leafCount + 1);

    this.addNote(note);
    await this.saveNotes();

    try {
      const cached = await SecureStore.getItemAsync('zk_all_commitments');
      const allCommitments: string[] = cached ? JSON.parse(cached) : [];
      while (allCommitments.length < note.leafIndex!) {
        allCommitments.push('0');
      }
      if (allCommitments.length === note.leafIndex) {
        allCommitments.push(note.commitment.toString());
        await SecureStore.setItemAsync('zk_all_commitments', JSON.stringify(allCommitments));
      }
    } catch {
      console.warn('[ZK Shield] Could not update commitment cache');
    }

    console.log('[ZK Shield] STARK shield complete');
    return signature;
  }

  /**
   * Transfer shielded tokens via circuit 5 (transfer) STARK proof.
   *
   * Spends up to two input notes and creates two output commitments
   * (recipient + change). Uses `public_amount = 0` — no value enters or
   * leaves the pool. On-chain the instruction inserts both outputs into
   * the Merkle tree and creates nullifier PDAs for double-spend protection.
   *
   * Flow:
   *   1. Sync tree + select ≤2 notes covering `amount`.
   *   2. Generate fresh Goldilocks randomness for both outputs.
   *   3. Call transferProver — returns STARK proof + public inputs
   *      [n1, n2, oc1, oc2, public_amount, token_mint].
   *   4. Upload + verify proof on-chain (circuit 5, DEEP-ALI phase 2).
   *   5. Build transfer_stark ix and send with retry.
   *   6. Persist change note locally and export recipient note for sharing.
   */
  async transfer(
    recipient: ZkAddress,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    if (!this.spendingKeyGl || !this.ownerPubkeyGl) {
      throw new Error('ZK Service not initialized');
    }
    if (!this.transferProver) {
      throw new Error(
        'STARK transfer prover not available. ' +
        'StarkProverProvider must be mounted and warmed up before transfer().'
      );
    }

    // -----------------------------------------------------------------
    // 1. Sync + select notes. selectNotes returns notes marked is_on_chain,
    //    which post-migration are Goldilocks-native commitments.
    // -----------------------------------------------------------------
    await this.syncMerkleTree();

    const { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    // -----------------------------------------------------------------
    // 2. Derive Goldilocks token_mint + allocate fresh randomness for
    //    both output notes (recipient + change).
    // -----------------------------------------------------------------
    const tokenMintGl = bytesToGoldilocks(this.tokenMint.toBytes());
    const changeAmount = totalValue - amount;
    const amountGl = truncateToGoldilocks(amount);
    const changeAmountGl = truncateToGoldilocks(changeAmount);

    const outRand1 = await randomGoldilocksU64();
    const outRand2 = await randomGoldilocksU64();

    // Locally-computed output commitments (for sanity checks post-proof).
    const expectedRecipientCommit = computeGoldilocksCommitment(
      amountGl,
      recipient.receivingPubkey,
      outRand1,
      tokenMintGl,
    );
    const expectedChangeCommit = computeGoldilocksCommitment(
      changeAmountGl,
      this.ownerPubkeyGl,
      outRand2,
      tokenMintGl,
    );

    // -----------------------------------------------------------------
    // 3. Build input-note inputs. When only one real note is available,
    //    synthesize a dummy with amount=0 + fresh randomness so the
    //    nullifier is unique (no collision across transfers).
    // -----------------------------------------------------------------
    const in1 = notesToSpend[0];
    const inAmount1 = truncateToGoldilocks(in1.amount);
    const inRand1 = truncateToGoldilocks(in1.randomness);

    let inAmount2: bigint;
    let inRand2: bigint;
    if (notesToSpend[1]) {
      inAmount2 = truncateToGoldilocks(notesToSpend[1].amount);
      inRand2 = truncateToGoldilocks(notesToSpend[1].randomness);
    } else {
      inAmount2 = 0n;
      inRand2 = await randomGoldilocksU64();
    }

    // -----------------------------------------------------------------
    // 4. Generate circuit 5 STARK proof on device.
    // -----------------------------------------------------------------
    console.log('[ZK Transfer] Generating circuit 5 (transfer) STARK proof...');
    const starkResult = await this.transferProver(
      this.spendingKeyGl.toString(),
      tokenMintGl.toString(),
      inAmount1.toString(),
      inRand1.toString(),
      inAmount2.toString(),
      inRand2.toString(),
      amountGl.toString(),
      outRand1.toString(),
      recipient.receivingPubkey.toString(),
      changeAmountGl.toString(),
      outRand2.toString(),
      this.ownerPubkeyGl.toString(),
      '0', // public_amount = 0 for private transfer
    );
    console.log(
      '[ZK Transfer] STARK proof generated in %dms (%d bytes)',
      (starkResult as any).durationMs ?? 0,
      starkResult.proofSize,
    );

    const publicInputs = starkResult.publicInputs.map((s) => BigInt(s));
    const n1Gl = publicInputs[0];
    const n2Gl = publicInputs[1];
    const oc1Gl = publicInputs[2];
    const oc2Gl = publicInputs[3];

    // Circuit-computed outputs MUST match our local derivation — otherwise
    // the circuit is deriving from different (amount, rand, owner, mint)
    // than we stored, and the note we "saved" for the recipient is wrong.
    if (oc1Gl !== expectedRecipientCommit || oc2Gl !== expectedChangeCommit) {
      throw new Error(
        'Transfer aborted: circuit-computed output commitments disagree with local derivation. ' +
        `oc1 expected=${expectedRecipientCommit} got=${oc1Gl}; ` +
        `oc2 expected=${expectedChangeCommit} got=${oc2Gl}.`,
      );
    }

    const starkProof: GenericStarkProof = {
      proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
      circuitId: 5, // CIRCUIT_TRANSFER
      publicInputs,
      proofSize: starkResult.proofSize,
    };

    // -----------------------------------------------------------------
    // 5. Read on-chain tree + compute (old_root, new_root). The circuit
    //    does not check Merkle membership of inputs, but transfer_stark
    //    rejects unless merkle_root is a known valid root of the pool.
    //    new_root is computed by inserting both outputs sequentially on
    //    a copy of the on-chain filled subtrees.
    // -----------------------------------------------------------------
    const onChainState = await this.readOnChainFilledSubtrees();

    const localSubtrees = await this.loadLocalSubtrees(onChainState.leafCount);
    let useSubtrees: bigint[];
    if (localSubtrees) {
      useSubtrees = localSubtrees;
    } else if (this.merkleTree.leafCount === onChainState.leafCount && onChainState.leafCount > 0) {
      useSubtrees = this.merkleTree.getFilledSubtrees();
      await this.saveLocalSubtrees(useSubtrees, onChainState.leafCount);
    } else {
      useSubtrees = onChainState.filledSubtrees;
    }

    // Sanity-check that our view of the current root matches on-chain.
    const { newRoot: computedCurrentRoot } = this.computeNewRootFromSubtrees(
      useSubtrees,
      onChainState.leafCount,
      0n,
      onChainState.depth,
    );
    if (computedCurrentRoot !== onChainState.root) {
      throw new Error(
        `Transfer aborted: client merkle state is out of sync with on-chain pool. ` +
        `Expected root ${onChainState.root.toString()} but local subtrees produce ${computedCurrentRoot.toString()}. ` +
        `Call syncMerkleTree() or reset the local tree.`,
      );
    }

    // Insert recipient (leafIndex_1 = leafCount), then change (leafIndex_2 = leafCount+1).
    const recipientLeafIndex = onChainState.leafCount;
    const {
      updatedSubtrees: afterRecipientSubtrees,
    } = this.computeNewRootFromSubtrees(
      useSubtrees,
      recipientLeafIndex,
      oc1Gl,
      onChainState.depth,
    );

    const changeLeafIndex = recipientLeafIndex + 1;
    const {
      newRoot: finalNewRoot,
      updatedSubtrees: finalSubtrees,
    } = this.computeNewRootFromSubtrees(
      afterRecipientSubtrees,
      changeLeafIndex,
      oc2Gl,
      onChainState.depth,
    );

    const merkleRootBytes = packGoldilocksU64(onChainState.root);
    const newRootBytes = packGoldilocksU64(finalNewRoot);
    const n1Bytes = packGoldilocksU64(n1Gl);
    const n2Bytes = packGoldilocksU64(n2Gl);
    const oc1Bytes = packGoldilocksU64(oc1Gl);
    const oc2Bytes = packGoldilocksU64(oc2Gl);

    // -----------------------------------------------------------------
    // 6. Pre-flight SOL balance for proof upload + 2× nullifier PDA rent.
    //    NullifierRecord::LEN = 41 bytes → ~980k lamports rent each.
    // -----------------------------------------------------------------
    const walletBalance = await this.connection.getBalance(walletPublicKey);
    const starkUploadFees = 120_000; // ~13 chunks + init + phase1 + phase2 + close
    const nullifierRent = 2_000_000; // 2× ~980k for NullifierRecord init
    const txFees = 15_000;
    const required = starkUploadFees + nullifierRent + txFees;
    if (walletBalance < required) {
      const have = (walletBalance / 1e9).toFixed(4);
      const need = (required / 1e9).toFixed(4);
      throw new Error(`Insufficient SOL. Need ~${need} SOL (STARK upload + nullifier PDAs + fees), wallet has ${have} SOL.`);
    }

    // -----------------------------------------------------------------
    // 7. Upload + verify STARK proof on-chain (buffer left open).
    // -----------------------------------------------------------------
    const walletSigner: WalletSigner = {
      publicKey: walletPublicKey,
      signTransaction,
    };

    console.log('[ZK Transfer] Uploading + verifying STARK proof on-chain...');
    const { proofBuffer } = await submitAndVerifyStarkProof(
      starkProof,
      walletSigner,
      (step) => console.log('[ZK Transfer][STARK]', step),
      this.connection,
    );

    // -----------------------------------------------------------------
    // 8. Build transfer_stark instruction.
    // -----------------------------------------------------------------
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId,
    );

    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId,
    );

    const [nullifierRecord1PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('nullifier'), poolPDA.toBytes(), Buffer.from(n1Bytes)],
      this.programId,
    );
    const [nullifierRecord2PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('nullifier'), poolPDA.toBytes(), Buffer.from(n2Bytes)],
      this.programId,
    );

    // Anchor discriminator: sha256("global:transfer_stark")[0..8]
    const TRANSFER_STARK_DISCRIMINATOR = Buffer.from([101, 77, 136, 73, 63, 103, 214, 251]);

    const ixData = Buffer.concat([
      TRANSFER_STARK_DISCRIMINATOR,
      n1Bytes,
      n2Bytes,
      oc1Bytes,
      oc2Bytes,
      merkleRootBytes,
      newRootBytes,
    ]);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: nullifierRecord1PDA, isSigner: false, isWritable: true },
        { pubkey: nullifierRecord2PDA, isSigner: false, isWritable: true },
        { pubkey: proofBuffer, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ixData,
    });

    // -----------------------------------------------------------------
    // 9. Send with retry on dropped tx (match shield() pattern).
    // -----------------------------------------------------------------
    const MAX_RETRIES = 3;
    let signature = '';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const tx = new Transaction().add(ix);
      tx.feePayer = walletPublicKey;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const signedTx = await signTransaction(tx);
      console.log(`[ZK Transfer] Sending transfer_stark tx (attempt ${attempt}/${MAX_RETRIES})...`);
      signature = await this.connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'processed',
        maxRetries: 3,
      });
      console.log(`[ZK Transfer] Tx sent: ${signature}`);

      try {
        const confirmation = await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'processed',
        );
        if (confirmation.value.err) {
          console.error('[ZK Transfer] Transaction failed on-chain:', JSON.stringify(confirmation.value.err));
          throw new Error(`Transfer transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        console.log(`[ZK Transfer] Confirmed on attempt ${attempt}`);
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
        if (msg.includes('timeout') || msg.includes('expired') || msg.includes('block height exceeded')) {
          console.warn(`[ZK Transfer] Attempt ${attempt} expired, tx dropped by network`);
          if (attempt < MAX_RETRIES) continue;
          const status = await this.connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
            break;
          }
          throw new Error(`Transfer transaction dropped after ${MAX_RETRIES} attempts. Devnet may be congested — try again.`);
        }
        throw e;
      }
    }

    // -----------------------------------------------------------------
    // 10. Close the STARK proof buffer (best-effort rent recovery).
    // -----------------------------------------------------------------
    try {
      await closeStarkProofBuffer(proofBuffer, walletSigner, this.connection);
    } catch (err) {
      console.warn('[ZK Transfer] Could not close STARK proof buffer:', err);
    }

    // -----------------------------------------------------------------
    // 11. Post-confirmation bookkeeping: remove spent inputs, keep change
    //     locally, export recipient note for out-of-band delivery.
    // -----------------------------------------------------------------
    await this.saveLocalSubtrees(finalSubtrees, changeLeafIndex + 1);

    this.removeSpentNotes(notesToSpend);

    const changeNote: Note = {
      amount: changeAmountGl,
      ownerPubkey: this.ownerPubkeyGl,
      randomness: outRand2,
      tokenMint: tokenMintGl,
      commitment: oc2Gl,
      leafIndex: changeLeafIndex,
      merkleRoot: finalNewRoot,
      isOnChain: true,
    };
    if (changeAmount > 0n) {
      this.addNote(changeNote);
    }
    await this.saveNotes();

    // Build the recipient note so the sender can hand it off.
    const recipientNote: Note = {
      amount: amountGl,
      ownerPubkey: recipient.receivingPubkey,
      randomness: outRand1,
      tokenMint: tokenMintGl,
      commitment: oc1Gl,
      leafIndex: recipientLeafIndex,
      isOnChain: true,
    };

    this._lastSentNote = {
      noteString: this.exportNote(recipientNote),
      amount,
      leafIndex: recipientLeafIndex,
    };

    console.log('[ZK Transfer] STARK transfer complete');
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
    if (!this.spendingKeyGl || !this.ownerPubkeyGl) {
      throw new Error('ZK Service not initialized');
    }
    if (!this.transferProver) {
      throw new Error(
        'STARK transfer prover not available. ' +
        'StarkProverProvider must be mounted and warmed up before unshield().'
      );
    }
    if (amount <= 0n) {
      throw new Error('Unshield amount must be > 0');
    }

    const unshieldStart = Date.now();
    console.log('[ZK Unshield] Starting STARK unshield of', Number(amount) / 1e9, 'SOL...');

    // -----------------------------------------------------------------
    // 1. Sync + select notes.
    // -----------------------------------------------------------------
    await this.syncMerkleTree();

    const { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    // -----------------------------------------------------------------
    // 2. Build circuit 5 inputs.
    //    - Output 1 (change): amount = change, owner = self. Circuit always
    //      produces a non-zero Poseidon commitment; the program inserts it
    //      into the tree even for change=0 (we accept the dead 0-leaf).
    //    - Output 2 (unshield dummy): amount = 0, recipient = 0. Never
    //      inserted on-chain but bound in public_inputs_hash.
    // -----------------------------------------------------------------
    const tokenMintGl = bytesToGoldilocks(this.tokenMint.toBytes());
    const changeAmount = totalValue - amount;
    const changeAmountGl = truncateToGoldilocks(changeAmount);

    const outRand1 = await randomGoldilocksU64();
    const outRand2 = await randomGoldilocksU64();
    const dummyOwnerGl = 0n;

    const expectedChangeCommit = computeGoldilocksCommitment(
      changeAmountGl,
      this.ownerPubkeyGl,
      outRand1,
      tokenMintGl,
    );
    const expectedDummy2Commit = computeGoldilocksCommitment(
      0n,
      dummyOwnerGl,
      outRand2,
      tokenMintGl,
    );

    // -----------------------------------------------------------------
    // 3. Input-note inputs. Synthesize a 0-amount dummy with fresh
    //    randomness if only one real input is available.
    // -----------------------------------------------------------------
    const in1 = notesToSpend[0];
    const inAmount1 = truncateToGoldilocks(in1.amount);
    const inRand1 = truncateToGoldilocks(in1.randomness);

    let inAmount2: bigint;
    let inRand2: bigint;
    if (notesToSpend[1]) {
      inAmount2 = truncateToGoldilocks(notesToSpend[1].amount);
      inRand2 = truncateToGoldilocks(notesToSpend[1].randomness);
    } else {
      inAmount2 = 0n;
      inRand2 = await randomGoldilocksU64();
    }

    // public_amount = -amount reinterpreted as u64 via two's complement.
    // This must match `amount.wrapping_neg()` on-chain, which is what the
    // verifier uses when reconstructing the public-inputs hash.
    const publicAmountField = (1n << 64n) - amount;

    // -----------------------------------------------------------------
    // 4. Generate circuit 5 STARK proof.
    // -----------------------------------------------------------------
    console.log('[ZK Unshield] Generating circuit 5 (transfer) STARK proof with negative public_amount...');
    const starkResult = await this.transferProver(
      this.spendingKeyGl.toString(),
      tokenMintGl.toString(),
      inAmount1.toString(),
      inRand1.toString(),
      inAmount2.toString(),
      inRand2.toString(),
      changeAmountGl.toString(),     // out_amount_1 = change
      outRand1.toString(),           // out_rand_1
      this.ownerPubkeyGl.toString(), // out_recipient_1 = self
      '0',                           // out_amount_2 = 0 (dummy)
      outRand2.toString(),           // out_rand_2
      dummyOwnerGl.toString(),       // out_recipient_2 = 0 (dummy)
      publicAmountField.toString(),
    );
    console.log(
      '[ZK Unshield] STARK proof generated in %dms (%d bytes)',
      (starkResult as any).durationMs ?? 0,
      starkResult.proofSize,
    );

    const publicInputs = starkResult.publicInputs.map((s) => BigInt(s));
    const n1Gl = publicInputs[0];
    const n2Gl = publicInputs[1];
    const oc1Gl = publicInputs[2];
    const oc2Gl = publicInputs[3];
    const pubAmtGl = publicInputs[4];

    if (oc1Gl !== expectedChangeCommit || oc2Gl !== expectedDummy2Commit) {
      throw new Error(
        'Unshield aborted: circuit-computed output commitments disagree with local derivation. ' +
        `oc1(change) expected=${expectedChangeCommit} got=${oc1Gl}; ` +
        `oc2(dummy) expected=${expectedDummy2Commit} got=${oc2Gl}.`,
      );
    }
    if (pubAmtGl !== publicAmountField) {
      throw new Error(
        `Unshield aborted: circuit public_amount disagrees with -amount two's complement. ` +
        `expected=${publicAmountField} got=${pubAmtGl}.`,
      );
    }

    const starkProof: GenericStarkProof = {
      proofBytes: Buffer.from(starkResult.proofHex, 'hex'),
      circuitId: 5, // CIRCUIT_TRANSFER
      publicInputs,
      proofSize: starkResult.proofSize,
    };

    // -----------------------------------------------------------------
    // 5. Read on-chain tree + compute (old_root, new_root). Only oc1 is
    //    inserted on-chain; oc2 is never materialized in the tree. Since
    //    Poseidon never produces [0;32], oc1 is always inserted.
    // -----------------------------------------------------------------
    const onChainState = await this.readOnChainFilledSubtrees();

    const localSubtrees = await this.loadLocalSubtrees(onChainState.leafCount);
    let useSubtrees: bigint[];
    if (localSubtrees) {
      useSubtrees = localSubtrees;
    } else if (this.merkleTree.leafCount === onChainState.leafCount && onChainState.leafCount > 0) {
      useSubtrees = this.merkleTree.getFilledSubtrees();
      await this.saveLocalSubtrees(useSubtrees, onChainState.leafCount);
    } else {
      useSubtrees = onChainState.filledSubtrees;
    }

    const { newRoot: computedCurrentRoot } = this.computeNewRootFromSubtrees(
      useSubtrees,
      onChainState.leafCount,
      0n,
      onChainState.depth,
    );
    if (computedCurrentRoot !== onChainState.root) {
      throw new Error(
        `Unshield aborted: client merkle state is out of sync with on-chain pool. ` +
        `Expected root ${onChainState.root.toString()} but local subtrees produce ${computedCurrentRoot.toString()}. ` +
        `Call syncMerkleTree() or reset the local tree.`,
      );
    }

    // Insert change commitment (oc1) at leafCount.
    const changeLeafIndex = onChainState.leafCount;
    const {
      newRoot: finalNewRoot,
      updatedSubtrees: finalSubtrees,
      pathElements: changePathElements,
      pathIndices: changePathIndices,
    } = this.computeNewRootFromSubtrees(
      useSubtrees,
      changeLeafIndex,
      oc1Gl,
      onChainState.depth,
    );

    const merkleRootBytes = packGoldilocksU64(onChainState.root);
    const newRootBytes = packGoldilocksU64(finalNewRoot);
    const n1Bytes = packGoldilocksU64(n1Gl);
    const n2Bytes = packGoldilocksU64(n2Gl);
    const oc1Bytes = packGoldilocksU64(oc1Gl);
    const oc2Bytes = packGoldilocksU64(oc2Gl);

    // -----------------------------------------------------------------
    // 6. Pre-flight SOL balance: STARK upload + 2× nullifier PDA rent.
    // -----------------------------------------------------------------
    const walletBalance = await this.connection.getBalance(walletPublicKey);
    const starkUploadFees = 120_000; // ~13 chunks + init + phase1 + phase2 + close
    const nullifierRent = 2_000_000; // 2× ~980k for NullifierRecord init
    const txFees = 15_000;
    const required = starkUploadFees + nullifierRent + txFees;
    if (walletBalance < required) {
      const have = (walletBalance / 1e9).toFixed(4);
      const need = (required / 1e9).toFixed(4);
      throw new Error(`Insufficient SOL. Need ~${need} SOL (STARK upload + nullifier PDAs + fees), wallet has ${have} SOL.`);
    }

    // -----------------------------------------------------------------
    // 7. Upload + verify STARK proof on-chain.
    // -----------------------------------------------------------------
    const walletSigner: WalletSigner = {
      publicKey: walletPublicKey,
      signTransaction,
    };

    console.log('[ZK Unshield] Uploading + verifying STARK proof on-chain...');
    const { proofBuffer } = await submitAndVerifyStarkProof(
      starkProof,
      walletSigner,
      (step) => console.log('[ZK Unshield][STARK]', step),
      this.connection,
    );

    // -----------------------------------------------------------------
    // 8. Build unshield_stark instruction.
    // -----------------------------------------------------------------
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId,
    );
    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId,
    );
    const [nullifierRecord1PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('nullifier'), poolPDA.toBytes(), Buffer.from(n1Bytes)],
      this.programId,
    );
    const [nullifierRecord2PDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('nullifier'), poolPDA.toBytes(), Buffer.from(n2Bytes)],
      this.programId,
    );

    // Anchor discriminator: sha256("global:unshield_stark")[0..8]
    const UNSHIELD_STARK_DISCRIMINATOR = Buffer.from([189, 84, 110, 154, 217, 120, 183, 239]);
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(amount, 0);

    const ixData = Buffer.concat([
      UNSHIELD_STARK_DISCRIMINATOR,
      n1Bytes,
      n2Bytes,
      oc1Bytes,
      oc2Bytes,
      merkleRootBytes,
      amountBuffer,
      newRootBytes,
    ]);

    // Optional SPL accounts — always include as placeholders so Anchor's
    // Option<> deserialization returns None for the native-SOL path.
    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },    // payer
        { pubkey: recipient, isSigner: false, isWritable: true },          // recipient
        { pubkey: poolPDA, isSigner: false, isWritable: true },            // shielded_pool
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },      // merkle_tree
        { pubkey: nullifierRecord1PDA, isSigner: false, isWritable: true }, // nullifier_record_1
        { pubkey: nullifierRecord2PDA, isSigner: false, isWritable: true }, // nullifier_record_2
        { pubkey: proofBuffer, isSigner: false, isWritable: false },        // stark_proof_buffer
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // token_program (optional)
        { pubkey: this.programId, isSigner: false, isWritable: false },    // pool_vault (placeholder for None)
        { pubkey: this.programId, isSigner: false, isWritable: false },    // recipient_token_account (placeholder for None)
      ],
      data: ixData,
    });

    // -----------------------------------------------------------------
    // 9. Send with retry on dropped tx.
    // -----------------------------------------------------------------
    const MAX_RETRIES = 3;
    let signature = '';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const tx = new Transaction().add(ix);
      tx.feePayer = walletPublicKey;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;

      const signedTx = await signTransaction(tx);
      console.log(`[ZK Unshield] Sending unshield_stark tx (attempt ${attempt}/${MAX_RETRIES})...`);
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
          'processed',
        );
        if (confirmation.value.err) {
          console.error('[ZK Unshield] Transaction failed on-chain:', JSON.stringify(confirmation.value.err));
          throw new Error(`Unshield transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        console.log(`[ZK Unshield] Confirmed on attempt ${attempt}`);
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
        if (msg.includes('timeout') || msg.includes('expired') || msg.includes('block height exceeded')) {
          console.warn(`[ZK Unshield] Attempt ${attempt} expired, tx dropped by network`);
          if (attempt < MAX_RETRIES) continue;
          const status = await this.connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
            break;
          }
          throw new Error(`Unshield transaction dropped after ${MAX_RETRIES} attempts. Devnet may be congested — try again.`);
        }
        throw e;
      }
    }

    // -----------------------------------------------------------------
    // 10. Close the STARK proof buffer (best-effort rent recovery).
    // -----------------------------------------------------------------
    try {
      await closeStarkProofBuffer(proofBuffer, walletSigner, this.connection);
    } catch (err) {
      console.warn('[ZK Unshield] Could not close STARK proof buffer:', err);
    }

    // -----------------------------------------------------------------
    // 11. Post-confirmation bookkeeping. oc1 was inserted in-order, so
    //     we persist the updated subtrees with leafCount = changeLeafIndex+1.
    //     We only materialize a spendable Note locally when there's real
    //     change; a 0-amount change leaf is dead weight.
    // -----------------------------------------------------------------
    await this.saveLocalSubtrees(finalSubtrees, changeLeafIndex + 1);

    this.removeSpentNotes(notesToSpend);
    if (changeAmount > 0n) {
      const changeNote: Note = {
        amount: changeAmountGl,
        ownerPubkey: this.ownerPubkeyGl,
        randomness: outRand1,
        tokenMint: tokenMintGl,
        commitment: oc1Gl,
        leafIndex: changeLeafIndex,
        merkleRoot: finalNewRoot,
        merklePathElements: changePathElements,
        merklePathIndices: changePathIndices,
        isOnChain: true,
      };
      this.addNote(changeNote);
    }
    await this.saveNotes();

    const totalTime = Date.now() - unshieldStart;
    console.log(
      '[ZK Unshield] STARK unshield complete in %dms (%ss), sig=%s',
      totalTime,
      (totalTime / 1000).toFixed(1),
      signature.slice(0, 20) + '...',
    );
    return signature;
  }

  /**
   * Unshield tokens via an ephemeral signer for sender privacy.
   *
   * The user's wallet only signs one on-chain tx — a SystemProgram
   * transfer to a freshly-generated ephemeral keypair. That ephemeral
   * keypair then authors every tx in the STARK unshield pipeline
   * (init_proof_buffer → write_proof_chunk × N → verify phase 1 →
   * verify phase 2 → unshield_stark → close_proof_buffer), so the
   * unshield itself carries no reference to the user's wallet. Any
   * SOL left over in the ephemeral (buffer-rent refund + safety
   * margin) is swept back to the user at the end.
   *
   * Privacy ceiling: this gives one-hop indirection — a chain
   * observer can still correlate `user → ephemeral → unshield`. A
   * stronger relay (funding ephemeral from an unrelated source) is
   * future work; see confidentialRelay for the MPC path.
   */
  async unshieldViaRelay(
    recipient: PublicKey,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    if (amount <= 0n) {
      throw new Error('Unshield amount must be > 0');
    }

    // -----------------------------------------------------------------
    // 1. Budget the ephemeral funding. Circuit-5 STARK proof ≈ 120KB;
    //    buffer rent ~0.84 SOL and is refunded on close. init + 121
    //    chunks + phase1/2 + unshield + close ≈ 650k tx fees. 2×
    //    NullifierRecord ≈ 2M rent (never refunded). Sweep at the end
    //    returns buffer rent + cushion.
    // -----------------------------------------------------------------
    const PROOF_DATA_OFFSET = 83;
    const MAX_STARK_PROOF_SIZE = 140_000;
    const BUFFER_RENT = await this.connection.getMinimumBalanceForRentExemption(
      PROOF_DATA_OFFSET + MAX_STARK_PROOF_SIZE,
    );
    const UPLOAD_FEES = 1_000_000;
    const NULLIFIER_RENT = 2_000_000;
    const UNSHIELD_FEE = 10_000;
    const SWEEP_FEE = 5_000;
    const RESIZE_CUSHION = 1_000_000;
    const ephemeralFunding =
      BUFFER_RENT + UPLOAD_FEES + NULLIFIER_RENT + UNSHIELD_FEE + SWEEP_FEE + RESIZE_CUSHION;

    const userWalletBalance = await this.connection.getBalance(walletPublicKey);
    const fundingTxFee = 5_000;
    if (userWalletBalance < ephemeralFunding + fundingTxFee) {
      const have = (userWalletBalance / 1e9).toFixed(4);
      const need = ((ephemeralFunding + fundingTxFee) / 1e9).toFixed(4);
      const recovered = ((BUFFER_RENT + RESIZE_CUSHION - SWEEP_FEE) / 1e9).toFixed(4);
      throw new Error(
        `Insufficient SOL for relayed unshield: wallet has ${have} SOL, need ~${need} SOL. ` +
        `~${recovered} SOL is swept back after the unshield; the rest covers nullifier PDAs + STARK fees.`
      );
    }

    // -----------------------------------------------------------------
    // 2. Generate + fund ephemeral in one user-signed tx.
    // -----------------------------------------------------------------
    const ephemeral = Keypair.generate();
    console.log(
      '[ZK Unshield Relay] Ephemeral:',
      ephemeral.publicKey.toBase58().slice(0, 12) + '...',
      '— funding', (ephemeralFunding / 1e9).toFixed(4), 'SOL',
    );

    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: walletPublicKey,
        toPubkey: ephemeral.publicKey,
        lamports: ephemeralFunding,
      }),
    );
    fundTx.feePayer = walletPublicKey;
    const { blockhash: fundBh, lastValidBlockHeight: fundHeight } =
      await this.connection.getLatestBlockhash('confirmed');
    fundTx.recentBlockhash = fundBh;
    const signedFund = await signTransaction(fundTx);
    const fundSig = await this.connection.sendRawTransaction(signedFund.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(
      { signature: fundSig, blockhash: fundBh, lastValidBlockHeight: fundHeight },
      'confirmed',
    );
    console.log('[ZK Unshield Relay] Ephemeral funded:', fundSig.slice(0, 20) + '...');

    // -----------------------------------------------------------------
    // 3. Run the STARK unshield with ephemeral as payer/authority.
    //    On failure, best-effort sweep whatever made it into ephemeral
    //    so the user doesn't eat the funding tx amount.
    // -----------------------------------------------------------------
    const ephemeralSign = async (tx: Transaction): Promise<Transaction> => {
      tx.partialSign(ephemeral);
      return tx;
    };

    let unshieldSig: string;
    try {
      unshieldSig = await this.unshield(recipient, amount, ephemeral.publicKey, ephemeralSign);
    } catch (err) {
      await this._sweepEphemeralToUser(ephemeral, walletPublicKey).catch(() => {});
      throw err;
    }

    await this._sweepEphemeralToUser(ephemeral, walletPublicKey).catch((e) => {
      console.warn('[ZK Unshield Relay] Sweep failed (lamports stranded in ephemeral):', e);
    });

    return unshieldSig;
  }

  /**
   * Sweep SOL left in an ephemeral keypair back to the user wallet.
   * Used by unshieldViaRelay / privateSend after the STARK pipeline
   * has returned the proof-buffer rent. Best-effort: leaves the tail
   * if the sweep tx would cost more than the balance.
   */
  private async _sweepEphemeralToUser(
    ephemeral: Keypair,
    userWallet: PublicKey,
  ): Promise<void> {
    const SWEEP_FEE = 5_000;
    const remaining = await this.connection.getBalance(ephemeral.publicKey);
    if (remaining <= SWEEP_FEE) return;

    const sweepAmount = remaining - SWEEP_FEE;
    const sweepTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: ephemeral.publicKey,
        toPubkey: userWallet,
        lamports: sweepAmount,
      }),
    );
    sweepTx.feePayer = ephemeral.publicKey;
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');
    sweepTx.recentBlockhash = blockhash;
    sweepTx.sign(ephemeral);

    const sig = await this.connection.sendRawTransaction(sweepTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    console.log(
      '[ZK Unshield Relay] Swept',
      (sweepAmount / 1e9).toFixed(6),
      'SOL back:',
      sig.slice(0, 20) + '...',
    );
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
  /**
   * Resolve a wallet address to stealth meta-address via registry.
   * Uses MPC private_lookup when enabled (hides the query from RPC).
   */
  async resolveRecipientStealth(
    walletAddress: PublicKey
  ): Promise<{ spendingPubKey: Uint8Array; viewingPubKey: Uint8Array; wasMpcProtected: boolean } | null> {
    const { lookupMetaAddress } = await import('../arcium/privateLookup');
    const result = await lookupMetaAddress(walletAddress);
    if (!result.isRegistered || !result.spendingPubKey || !result.viewingPubKey) return null;
    return {
      spendingPubKey: result.spendingPubKey,
      viewingPubKey: result.viewingPubKey,
      wasMpcProtected: result.wasMpcProtected,
    };
  }

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


  // STARK merkle_update prover (circuit 6), injected by StarkProverProvider.
  // Returns a hex-encoded proof + string-encoded Goldilocks u64 public inputs.
  private merkleUpdateProver: ((
    oldLeaf: string,
    newLeaf: string,
    pathElements: string[],
    pathIndices: number[],
  ) => Promise<{
    circuitId: number;
    publicInputs: string[];
    proofHex: string;
    proofSize: number;
  }>) | null = null;

  // STARK transfer prover (circuit 5), injected by StarkProverProvider.
  // All u64 arguments are passed as decimal strings (so callers can stringify
  // bigints directly). Returns the proof plus the circuit-computed public
  // inputs: [nullifier_1, nullifier_2, oc1, oc2, public_amount, token_mint].
  private transferProver: ((
    spendingKey: string,
    tokenMint: string,
    inAmount1: string,
    inRand1: string,
    inAmount2: string,
    inRand2: string,
    outAmount1: string,
    outRand1: string,
    outRecipient1: string,
    outAmount2: string,
    outRand2: string,
    outRecipient2: string,
    publicAmount: string,
  ) => Promise<{
    circuitId: number;
    publicInputs: string[];
    proofHex: string;
    proofSize: number;
  }>) | null = null;

  // Backend prover removed — all proving is client-side (WebView WASM STARK).
  // Spending keys NEVER leave the device.


  /**
   * Set the STARK merkle_update prover (called by StarkProverProvider). Required
   * for shield() to bind the tree transition with a circuit 6 STARK proof.
   */
  setMerkleUpdateProver(
    prover: (
      oldLeaf: string,
      newLeaf: string,
      pathElements: string[],
      pathIndices: number[],
    ) => Promise<{
      circuitId: number;
      publicInputs: string[];
      proofHex: string;
      proofSize: number;
    }>,
  ): void {
    this.merkleUpdateProver = prover;
  }

  /**
   * Set the STARK transfer prover (called by StarkProverProvider). Required
   * for transfer() and unshield() to generate a circuit 5 STARK proof that
   * binds the nullifier/commitment derivation to the user's spending key.
   */
  setTransferProver(
    prover: (
      spendingKey: string,
      tokenMint: string,
      inAmount1: string,
      inRand1: string,
      inAmount2: string,
      inRand2: string,
      outAmount1: string,
      outRand1: string,
      outRecipient1: string,
      outAmount2: string,
      outRand2: string,
      outRecipient2: string,
      publicAmount: string,
    ) => Promise<{
      circuitId: number;
      publicInputs: string[];
      proofHex: string;
      proofSize: number;
    }>,
  ): void {
    this.transferProver = prover;
  }


  /**
   * Scan for incoming shielded notes.
   *
   * The shielded pool doesn't broadcast note plaintexts on-chain — receivers
   * either (a) get the note handed to them directly via `exportNote` /
   * `importNote`, or (b) receive a stealth payment via `scanStealthPayments`.
   * So the only thing this method can do passively is keep the local Merkle
   * tree in sync with on-chain commitments so existing notes' leaf indices
   * stay accurate.
   */
  async scanIncomingNotes(_afterSignature?: string): Promise<{
    found: number;
    newBalance: bigint;
  }> {
    if (!this.ownerPubkeyGl || !this.viewingKey) {
      throw new Error('ZK Service not initialized');
    }

    await this.syncMerkleTree();

    return {
      found: 0,
      newBalance: this.getShieldedBalance(),
    };
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

        // Filter notes: only keep Goldilocks notes that belong to the current key.
        // Legacy BN254 notes (commitment > 2^64) predate the task-#90 migration and
        // can't be spent by the new STARK pipeline — drop them so the user knows
        // to re-shield. The commitment for a Goldilocks note fits in a u64.
        const GOLDILOCKS_MAX = 1n << 64n;
        const validNotes = allNotes.filter((note: Note) => {
          if (note.commitment >= GOLDILOCKS_MAX) {
            console.warn('[ZK] Dropping legacy BN254 note (commitment > 2^64):', note.commitment.toString().slice(0, 20));
            return false;
          }
          return note.ownerPubkey === this.ownerPubkeyGl;
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

      // Verify stored commitment integrity against the circuit-5 Goldilocks layout.
      const tokenMintGl = bytesToGoldilocks(this.tokenMint.toBytes());
      const recomputedCommitment = computeGoldilocksCommitment(
        truncateToGoldilocks(note.amount),
        note.ownerPubkey,
        note.randomness,
        tokenMintGl,
      );
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
        currentHash = goldilocksHash2to1(subtrees[level], currentHash);
      } else {
        // Even index = left child: UPDATE subtree at this level, then hash with zero
        const zeroVal = this.merkleTree.getZeroValueForLevel(level);
        pathElements.push(zeroVal);
        pathIndices.push(0);
        subtrees[level] = currentHash;
        currentHash = goldilocksHash2to1(currentHash, zeroVal);
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
        ? goldilocksHash2to1(sibling, verifyRoot)
        : goldilocksHash2to1(verifyRoot, sibling);
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
    this.spendingKeyBytes = null;
    this.spendingKeyGl = null;
    this.ownerPubkeyGl = null;
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
      amount: truncateToGoldilocks(BigInt(noteData.a)),
      ownerPubkey: truncateToGoldilocks(BigInt(noteData.o)),
      randomness: truncateToGoldilocks(BigInt(noteData.r)),
      tokenMint: truncateToGoldilocks(BigInt(noteData.t)),
      commitment: BigInt(noteData.c),
      leafIndex: noteData.i,
    };

    // Verify the commitment matches the Goldilocks circuit-5 layout.
    const computedCommitment = computeGoldilocksCommitment(
      note.amount,
      note.ownerPubkey,
      note.randomness,
      note.tokenMint,
    );
    if (computedCommitment !== note.commitment) {
      throw new Error('Invalid note: commitment does not match');
    }

    // Verify this note belongs to us (recipient's Goldilocks owner pubkey).
    if (note.ownerPubkey !== this.ownerPubkeyGl) {
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
    if (this.ownerPubkeyGl) {
      const nullifier = computeNullifier(note.commitment, this.ownerPubkeyGl);
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
    if (!this.spendingKeyBytes || !this.viewingKey) {
      console.warn('[ZK] Stealth keys not initialized');
      return null;
    }

    // Derive spending public key from the 32-byte SHA-256 seed.
    const spendingKeypair = Keypair.fromSeed(this.spendingKeyBytes);
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
   * PRIVATE SEND — STARK unshield to a stealth address via an ephemeral
   * signer, so the on-chain record shows `ephemeral → stealth_address`
   * (no direct link to the depositor) and the recipient scans for it
   * with their viewing key.
   *
   * 1. Decode recipient stealth keys (spendingPub(32) || viewingPub(32) || viewingX25519Pub(32))
   * 2. Derive a one-time stealth address for this payment
   * 3. Resolve denomination to lamports
   * 4. unshieldViaRelay(stealthAddress, amount) — ephemeral pays all STARK txs
   * 5. Return stealth info so the recipient can locate + sweep the payment
   *
   * @param recipientStealthKeys - Recipient's encoded stealth keys (from getStealthKeys)
   * @param denominationIndex - 0=0.1 SOL, 1=1 SOL, 2=10 SOL, 3=100 SOL
   * @param walletPublicKey - User's wallet (funds the ephemeral)
   * @param signTransaction - Wallet signing function
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
    try {
      // 1. Decode and validate stealth keys. getStealthKeys() emits
      //    96 bytes base64: spendingPub(32) + viewingPub(32) + viewingX25519Pub(32).
      const decoded = Buffer.from(recipientStealthKeys, 'base64');
      if (decoded.length < 64) {
        return { success: false, error: 'Invalid stealth keys (expected ≥64 bytes, got ' + decoded.length + ')' };
      }
      const spendingPubBytes = new Uint8Array(decoded.subarray(0, 32));
      const viewingPubBytes = new Uint8Array(decoded.subarray(32, 64));

      // 2. Derive a one-time stealth address for this payment.
      const stealthData: StealthAddress = generateStealthAddress(
        spendingPubBytes,
        viewingPubBytes,
      );
      const stealthRecipient = new PublicKey(stealthData.address);

      // 3. Resolve denomination (lamports). Matches DENOMINATIONS.SOL
      //    in packages/privacy-sdk/src/constants.ts.
      const DENOM_LAMPORTS: bigint[] = [
        100_000_000n,    // 0.1 SOL
        1_000_000_000n,  // 1 SOL
        10_000_000_000n, // 10 SOL
        100_000_000_000n // 100 SOL
      ];
      const amountLamports = DENOM_LAMPORTS[denominationIndex];
      if (!amountLamports || amountLamports <= 0n) {
        return {
          success: false,
          error: `Invalid denomination index ${denominationIndex} (valid: 0..${DENOM_LAMPORTS.length - 1})`,
        };
      }

      // 4. Run the relayed unshield — ephemeral keypair drives the full
      //    STARK pipeline, user wallet only signs the one funding tx.
      const signature = await this.unshieldViaRelay(
        stealthRecipient,
        amountLamports,
        walletPublicKey,
        signTransaction,
      );

      return {
        success: true,
        txSignature: signature,
        stealthAddress: stealthData.address,
        ephemeralPublicKey: stealthData.ephemeralPublicKey,
        viewTag: stealthData.viewTag,
      };
    } catch (error: any) {
      console.error('[Private Send] Failed:', error);
      return {
        success: false,
        error: error?.message || 'Private send failed',
      };
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

      const { scanForPayments: sdkScanForPayments } = await import('@protocol-01/specter-sdk');

      const viewingKeyBytes = this.viewingKey!;
      const spendingKeyBytes = this.spendingKeyBytes!;

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
