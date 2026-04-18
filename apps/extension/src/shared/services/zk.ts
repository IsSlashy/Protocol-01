/**
 * ZK Service for Chrome Extension
 * Integrates with P-01 ZK SDK for real shielded transactions
 *
 * Uses Web Worker for proof generation when available,
 * falls back to backend prover service otherwise.
 */

import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';

// Goldilocks-Poseidon: matches stark/src/poseidon/mod.rs byte-for-byte.
// Drives the MerkleTree + shield_stark flow so roots agree with circuit 6.
import {
  GOLDILOCKS_MODULUS,
  goldilocksHash2to1,
  computeGoldilocksZeroCascade,
} from './goldilocks-poseidon';

// STARK prover singleton (Web Worker) + on-chain verifier helpers.
import { starkProver } from './starkProver';
import {
  submitAndVerifyStarkProof,
  closeStarkProofBuffer,
  type GenericStarkProof,
  type WalletSigner,
} from './stark';

// Constants
const ZK_SHIELDED_PROGRAM_ID = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';
// STARK migration: tree depth canonicalized to 15 (matches circuit 6 CANONICAL_DEPTH
// and ShieldedPool::DEFAULT_TREE_DEPTH). Changing this invalidates all prior deposits.
const MERKLE_TREE_DEPTH = 15;

// PDA seeds
const PDA_SEEDS = {
  SHIELDED_POOL: new TextEncoder().encode('shielded_pool'),
  MERKLE_TREE: new TextEncoder().encode('merkle_tree'),
};

/**
 * Note structure
 */
export interface Note {
  amount: bigint;
  ownerPubkey: bigint;
  randomness: bigint;
  tokenMint: bigint;
  commitment: bigint;
  leafIndex?: number;
  merklePathElements?: bigint[];
  merklePathIndices?: number[];
  merkleRoot?: bigint;
}

/**
 * ZK Address
 */
export interface ZkAddress {
  receivingPubkey: bigint;
  viewingKey: Uint8Array;
  encoded: string;
}

/**
 * Recipient note data for sharing after transfer
 */
export interface RecipientNoteData {
  amount: string;
  ownerPubkey: string;
  randomness: string;
  tokenMint: string;
  commitment: string;
  leafIndex: number;
}

/**
 * Encode note to p01note format (compatible with mobile app)
 * Format: p01note:base64({a, o, r, t, c, i})
 */
export function encodeP01Note(note: RecipientNoteData): string {
  const compact = {
    a: note.amount,
    o: note.ownerPubkey,
    r: note.randomness,
    t: note.tokenMint,
    c: note.commitment,
    i: note.leafIndex,
  };
  const json = JSON.stringify(compact);
  const base64 = btoa(json);
  return `p01note:${base64}`;
}

/**
 * Decode p01note format to RecipientNoteData
 */
export function decodeP01Note(encoded: string): RecipientNoteData {
  if (!encoded.startsWith('p01note:')) {
    throw new Error('Invalid p01note format');
  }
  const base64 = encoded.slice(8); // Remove 'p01note:' prefix
  const json = atob(base64);
  const compact = JSON.parse(json);
  return {
    amount: compact.a,
    ownerPubkey: compact.o,
    randomness: compact.r,
    tokenMint: compact.t,
    commitment: compact.c,
    leafIndex: compact.i,
  };
}

/**
 * Convert bigint to 32-byte little-endian buffer (viewingKey + note I/O).
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

// -----------------------------------------------------------------------
// Goldilocks field helpers (used by STARK circuits 5 + 6)
// -----------------------------------------------------------------------

function truncateToGoldilocks(value: bigint): bigint {
  const r = value % GOLDILOCKS_MODULUS;
  return r < 0n ? r + GOLDILOCKS_MODULUS : r;
}

/**
 * Hash a 32-byte buffer down into the Goldilocks field. Takes the low 8 bytes
 * as u64 LE, then reduces. Matches the on-chain layout for pubkeys/mints
 * (bytes 0..8 = u64 LE, 8..32 = 0).
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
 * Canonical on-chain Goldilocks commitment/root layout.
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
 * Fresh Goldilocks-field randomness (u64 reduced mod the Goldilocks modulus).
 */
function randomGoldilocksU64(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let v = 0n;
  for (let i = 7; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]);
  }
  return truncateToGoldilocks(v);
}

/**
 * Circuit 5 (transfer) commitment layout:
 *   commitment = hash2(hash2(amount, rand), hash2(owner, mint))
 * Inputs MUST already be Goldilocks elements.
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
 * Build a Goldilocks-field note. Commitment follows circuit 5 layout and
 * can later be spent via transfer_stark. ownerPubkeyGl MUST be
 * `hash2(spending_key_gl, 0)` — exactly what circuit 5 derives in cycle 0.
 */
async function createGoldilocksNote(
  amount: bigint,
  ownerPubkeyGl: bigint,
  tokenMintGl: bigint,
): Promise<Note> {
  const randomness = randomGoldilocksU64();
  const amountGl = truncateToGoldilocks(amount);
  const commitment = computeGoldilocksCommitment(amountGl, ownerPubkeyGl, randomness, tokenMintGl);
  return { amount: amountGl, ownerPubkey: ownerPubkeyGl, randomness, tokenMint: tokenMintGl, commitment };
}

/**
 * Derive spending key pair from seed phrase.
 *
 * Returns the 32-byte SHA-256 seed (used as Ed25519 seed for stealth scanning)
 * plus Goldilocks variants driving STARK circuit 5. `spendingKeyGl` is the
 * low 8 bytes of the same seed; `ownerPubkeyGl = hash2(spending_key_gl, 0)`
 * using Goldilocks-Poseidon — exactly what circuit 5 derives in cycle 0.
 */
async function deriveSpendingKey(seedPhrase: string): Promise<{
  spendingKeyBytes: Uint8Array;
  spendingKeyGl: bigint;
  ownerPubkeyGl: bigint;
}> {
  const encoder = new TextEncoder();
  const data = encoder.encode(seedPhrase + ':spending_key');

  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const spendingKeyBytes = new Uint8Array(hashBuffer);

  let spendingKeyGl = 0n;
  for (let i = 7; i >= 0; i--) {
    spendingKeyGl = (spendingKeyGl << 8n) | BigInt(spendingKeyBytes[i] ?? 0);
  }
  spendingKeyGl = truncateToGoldilocks(spendingKeyGl);
  const ownerPubkeyGl = goldilocksHash2to1(spendingKeyGl, 0n);

  return { spendingKeyBytes, spendingKeyGl, ownerPubkeyGl };
}

/**
 * Client-side Merkle tree (matches on-chain structure).
 *
 * Hash: Goldilocks-Poseidon (width=3, hash2-to-1) — binary-identical to
 *   `stark/src/poseidon/mod.rs` and the circuit 6 AIR.
 * Leaves: Goldilocks field elements (u64 packed into bytes 0..8 of the
 *   on-chain [u8; 32] commitment, zeros 8..32).
 * Empty tree: `computeGoldilocksZeroCascade(depth)` starts at 0n and folds
 *   upward with `hash(0,0), hash(h1,h1), …` — matches circuit 6's empty-tree zeros.
 */
class MerkleTree {
  private depth: number;
  private leaves: bigint[] = [];
  private nodes: Map<string, bigint> = new Map();
  private _root: bigint | null = null;
  private _zeroValues: bigint[] | null = null;

  constructor(depth: number = MERKLE_TREE_DEPTH) {
    this.depth = depth;
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

  getZeroValueForLevel(level: number): bigint {
    return this.getZeroValue(level);
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
   * Extract filledSubtrees from current tree state. Replays inserts tracking
   * subtrees (same algorithm as on-chain insert). Used to bootstrap correct
   * subtrees after a full tree rebuild.
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

  /**
   * Get all leaves in the tree (for serialization)
   */
  getAllLeaves(): bigint[] {
    return [...this.leaves];
  }
}

/**
 * ZK Service for Extension
 */
export class ZkServiceExtension {
  private connection: Connection | null = null;
  private programId: PublicKey;
  private merkleTree: MerkleTree;
  private notes: Note[] = [];
  // 32-byte SHA-256 seed — Ed25519 seed for stealth scanning.
  private spendingKeyBytes: Uint8Array | null = null;
  // Goldilocks variants drive circuit 5 (transfer) + circuit 6 (merkle_update).
  private spendingKeyGl: bigint | null = null;
  private ownerPubkeyGl: bigint | null = null;
  private viewingKey: Uint8Array | null = null;
  private tokenMint: PublicKey;
  private isInitialized: boolean = false;

  constructor() {
    this.programId = new PublicKey(ZK_SHIELDED_PROGRAM_ID);
    this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
    this.tokenMint = SystemProgram.programId; // SOL
  }

  /**
   * Set connection
   */
  setConnection(connection: Connection): void {
    this.connection = connection;
  }

  /**
   * Initialize with seed phrase
   */
  async initialize(seedPhrase: string): Promise<void> {
    const keys = await deriveSpendingKey(seedPhrase);
    this.spendingKeyBytes = keys.spendingKeyBytes;
    this.spendingKeyGl = keys.spendingKeyGl;
    this.ownerPubkeyGl = keys.ownerPubkeyGl;
    this.viewingKey = packGoldilocksU64(keys.ownerPubkeyGl);

    // Warm up the STARK prover worker (Web Worker + WASM). Safe to ignore errors
    // here — shield() will re-throw with context if the worker is unavailable.
    try {
      await starkProver.start();
    } catch (error) {
      console.warn('[ZK] STARK prover worker init failed; shield/transfer/unshield will fail until fixed:', error);
    }

    // Load stored notes
    await this.loadNotes();

    this.isInitialized = true;
  }

  /**
   * Get ZK address
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

    const encoded = `zk:${btoa(String.fromCharCode(...combined))}`;

    return {
      receivingPubkey: this.ownerPubkeyGl,
      viewingKey: this.viewingKey,
      encoded,
    };
  }

  /**
   * Get stealth keys for scanning stealth payments
   * Returns viewing and spending keys in format needed for stealth address derivation
   */
  getStealthKeys(): { viewingKey: Uint8Array; spendingKey: Uint8Array } | null {
    if (!this.viewingKey || !this.spendingKeyBytes) {
      return null;
    }

    return {
      viewingKey: this.viewingKey,
      spendingKey: this.spendingKeyBytes,
    };
  }

  // Cached filledSubtrees for fast shield/unshield
  private _cachedSubtrees: bigint[] | null = null;

  /**
   * Read on-chain Merkle tree state (root, leafCount, depth, filledSubtrees)
   */
  private async readOnChainFilledSubtrees(): Promise<{
    root: bigint;
    leafCount: number;
    depth: number;
    filledSubtrees: bigint[];
  }> {
    if (!this.connection) throw new Error('Connection not set');

    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );
    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    const account = await this.connection.getAccountInfo(merkleTreePDA);
    if (!account) throw new Error('MerkleTree account not found on-chain');

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
   * Compute new Merkle root from filledSubtrees after inserting a leaf.
   * Also returns the Merkle proof for the inserted leaf and updated subtrees.
   */
  private computeNewRootFromSubtrees(
    filledSubtrees: bigint[],
    leafCount: number,
    newLeaf: bigint,
    depth: number = MERKLE_TREE_DEPTH
  ): { newRoot: bigint; updatedSubtrees: bigint[]; pathElements: bigint[]; pathIndices: number[] } {
    const subtrees = [...filledSubtrees];
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
        // Even index = left child: UPDATE subtree, hash with zero
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
   * Reconstruct Merkle proof from cached subtrees for a saved note.
   */
  private reconstructProofFromSubtrees(note: Note): { pathElements: bigint[]; pathIndices: number[] } {
    if (note.leafIndex === undefined) {
      throw new Error('Cannot reconstruct proof: note has no leafIndex');
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
        pathElements.push(raw[level]);
        pathIndices.push(1);
      } else {
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
      throw new Error('Cannot reconstruct valid Merkle proof for this note');
    }

    return { pathElements, pathIndices };
  }

  /**
   * Save/load cached subtrees to/from chrome.storage
   */
  private async saveLocalSubtrees(subtrees: bigint[], leafCount: number): Promise<void> {
    this._cachedSubtrees = subtrees;
    try {
      await chrome.storage.local.set({
        'zk_local_subtrees': JSON.stringify({
          subtrees: subtrees.map(s => s.toString()),
          leafCount,
        }),
      });
    } catch (e) {
      console.warn('[ZK] Failed to save local subtrees:', e);
    }
  }

  private async loadLocalSubtrees(expectedLeafCount: number): Promise<bigint[] | null> {
    try {
      const result = await chrome.storage.local.get('zk_local_subtrees');
      if (result.zk_local_subtrees) {
        const data = JSON.parse(result.zk_local_subtrees);
        if (data.leafCount === expectedLeafCount) {
          const subtrees = data.subtrees.map((s: string) => BigInt(s));
          this._cachedSubtrees = subtrees;
          return subtrees;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Get shielded balance
   */
  getShieldedBalance(): bigint {
    return this.notes.reduce((sum, note) => sum + note.amount, BigInt(0));
  }

  /**
   * Shield SOL into the pool via circuit 6 (merkle_update) STARK proof.
   *
   * Flow:
   *   1. Read on-chain subtrees + current root (pool.merkle_root).
   *   2. Create a Goldilocks-field note for the depositor.
   *   3. Compute (old_root, new_root, path) from filled subtrees.
   *   4. Generate a circuit 6 (merkle_update) STARK proof in the Web Worker.
   *   5. Upload + verify the proof on-chain (phase 1 + DEEP-ALI phase 2),
   *      leaving the proof buffer open.
   *   6. Call zk_shielded::shield_stark (consumes the proof buffer, performs
   *      the deposit, inserts the commitment, updates pool root).
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
    if (!this.ownerPubkeyGl || !this.connection) {
      throw new Error('ZK Service not initialized');
    }

    // -----------------------------------------------------------------
    // 1. Read on-chain state.
    // -----------------------------------------------------------------
    console.log('[ZK Shield] Reading on-chain state...');
    const onChainState = await this.readOnChainFilledSubtrees();

    // Prefer locally-stored correct subtrees over on-chain ones (levels > 0
    // may be stale on-chain in historical states).
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
    // 2. Create Goldilocks note. Commitment uses circuit 5's layout so this
    //    note can later be spent via transfer_stark.
    // -----------------------------------------------------------------
    const tokenMintGl = bytesToGoldilocks(this.tokenMint.toBytes());
    const note = await createGoldilocksNote(amount, this.ownerPubkeyGl, tokenMintGl);

    // -----------------------------------------------------------------
    // 3. Compute (old_root, new_root, path) from subtrees.
    // -----------------------------------------------------------------
    const leafIndexBeforeInsert = onChainState.leafCount;

    const { newRoot: computedOldRoot } = this.computeNewRootFromSubtrees(
      useSubtrees,
      onChainState.leafCount,
      0n,
      onChainState.depth,
    );

    const { newRoot, updatedSubtrees, pathElements, pathIndices } = this.computeNewRootFromSubtrees(
      useSubtrees,
      onChainState.leafCount,
      note.commitment,
      onChainState.depth,
    );

    if (computedOldRoot !== onChainState.root) {
      throw new Error(
        `Shield aborted: client merkle state is out of sync with on-chain pool. ` +
        `Expected root ${onChainState.root.toString()} but local subtrees produce ${computedOldRoot.toString()}. ` +
        `Reset the local tree and retry.`,
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

    // -----------------------------------------------------------------
    // 4. Generate circuit 6 STARK proof in the Web Worker.
    // -----------------------------------------------------------------
    console.log('[ZK Shield] Generating circuit 6 (merkle_update) STARK proof...');
    const starkResult = await starkProver.generateMerkleUpdateProof(
      '0',                              // old_leaf (empty slot)
      note.commitment.toString(),       // new_leaf = commitment (Goldilocks u64)
      pathElements.map((e) => e.toString()),
      pathIndices,
    );
    console.log(
      '[ZK Shield] STARK proof generated in %dms (%d bytes)',
      starkResult.durationMs,
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
    const starkUploadFees = 120_000; // ~13 chunks + init + verify + deep-ali + close
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
      this.connection,
      (step) => console.log('[ZK Shield][STARK]', step),
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
    // Local Merkle tree mirror (Goldilocks) for later proofs.
    this.merkleTree.insert(note.commitment);

    await this.saveLocalSubtrees(updatedSubtrees, onChainState.leafCount + 1);

    this.notes.push(note);
    await this.saveNotes();

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
   * Returns { signature, recipientNote } — recipientNote is emitted in the
   * p01note-compatible shape so the sender can hand it off out-of-band.
   */
  async transfer(
    recipient: ZkAddress,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<{ signature: string; recipientNote: RecipientNoteData }> {
    if (!this.spendingKeyGl || !this.ownerPubkeyGl || !this.connection) {
      throw new Error('ZK Service not initialized');
    }

    // -----------------------------------------------------------------
    // 1. Select notes covering the amount. Post-migration they are
    //    Goldilocks-native commitments.
    // -----------------------------------------------------------------
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

    const outRand1 = randomGoldilocksU64();
    const outRand2 = randomGoldilocksU64();

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
    //    nullifier is unique.
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
      inRand2 = randomGoldilocksU64();
    }

    // -----------------------------------------------------------------
    // 4. Generate circuit 5 STARK proof in the Web Worker.
    // -----------------------------------------------------------------
    console.log('[ZK Transfer] Generating circuit 5 (transfer) STARK proof...');
    const starkResult = await starkProver.generateTransferProof(
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
      starkResult.durationMs,
      starkResult.proofSize,
    );

    const publicInputs = starkResult.publicInputs.map((s) => BigInt(s));
    const n1Gl = publicInputs[0];
    const n2Gl = publicInputs[1];
    const oc1Gl = publicInputs[2];
    const oc2Gl = publicInputs[3];

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
        `Transfer aborted: client merkle state is out of sync with on-chain pool. ` +
        `Expected root ${onChainState.root.toString()} but local subtrees produce ${computedCurrentRoot.toString()}. ` +
        `Reset the local tree and retry.`,
      );
    }

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
      this.connection,
      (step) => console.log('[ZK Transfer][STARK]', step),
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
    // 11. Post-confirmation bookkeeping: drop spent inputs, keep change
    //     locally (if any), mirror into local tree, export recipient note.
    // -----------------------------------------------------------------
    this.merkleTree.insert(oc1Gl);
    this.merkleTree.insert(oc2Gl);
    await this.saveLocalSubtrees(finalSubtrees, changeLeafIndex + 1);

    this.removeSpentNotes(notesToSpend);

    if (changeAmount > 0n) {
      const changeNote: Note = {
        amount: changeAmountGl,
        ownerPubkey: this.ownerPubkeyGl,
        randomness: outRand2,
        tokenMint: tokenMintGl,
        commitment: oc2Gl,
        leafIndex: changeLeafIndex,
        merkleRoot: finalNewRoot,
      };
      this.notes.push(changeNote);
    }
    await this.saveNotes();

    const recipientNoteData: RecipientNoteData = {
      amount: amountGl.toString(),
      ownerPubkey: recipient.receivingPubkey.toString(),
      randomness: outRand1.toString(),
      tokenMint: tokenMintGl.toString(),
      commitment: oc1Gl.toString(),
      leafIndex: recipientLeafIndex,
    };

    console.log('[ZK Transfer] STARK transfer complete');
    return { signature, recipientNote: recipientNoteData };
  }

  /**
   * Unshield tokens (instant path using saved Merkle proofs)
   */
  async unshield(
    recipient: PublicKey,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    if (!this.spendingKeyGl || !this.ownerPubkeyGl || !this.connection) {
      throw new Error('ZK Service not initialized');
    }
    if (amount <= 0n) {
      throw new Error('Unshield amount must be > 0');
    }

    const unshieldStart = Date.now();
    console.log('[ZK Unshield] Starting STARK unshield of', Number(amount) / 1e9, 'SOL...');

    // -----------------------------------------------------------------
    // 1. Sync + select notes.
    // -----------------------------------------------------------------
    try {
      await this.syncFromBlockchain();
    } catch (syncErr) {
      console.warn('[ZK Unshield] Tree sync failed (continuing):', syncErr);
    }

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

    const outRand1 = randomGoldilocksU64();
    const outRand2 = randomGoldilocksU64();
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
      inRand2 = randomGoldilocksU64();
    }

    // public_amount = -amount reinterpreted as u64 via two's complement.
    // This must match `amount.wrapping_neg()` on-chain, which is what the
    // verifier uses when reconstructing the public-inputs hash.
    const publicAmountField = (1n << 64n) - amount;

    // -----------------------------------------------------------------
    // 4. Generate circuit 5 STARK proof.
    // -----------------------------------------------------------------
    console.log('[ZK Unshield] Generating circuit 5 (transfer) STARK proof with negative public_amount...');
    const starkResult = await starkProver.generateTransferProof(
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
      starkResult.durationMs ?? 0,
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
        `Call syncFromBlockchain() or reset the local tree.`,
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
    // 7. Upload + verify STARK proof on-chain (buffer left open).
    // -----------------------------------------------------------------
    const walletSigner: WalletSigner = {
      publicKey: walletPublicKey,
      signTransaction,
    };

    console.log('[ZK Unshield] Uploading + verifying STARK proof on-chain...');
    const { proofBuffer } = await submitAndVerifyStarkProof(
      starkProof,
      walletSigner,
      this.connection,
      (step) => console.log('[ZK Unshield][STARK]', step),
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
      [new TextEncoder().encode('nullifier'), poolPDA.toBytes(), n1Bytes],
      this.programId,
    );
    const [nullifierRecord2PDA] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('nullifier'), poolPDA.toBytes(), n2Bytes],
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
    this.merkleTree.insert(oc1Gl);
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
      };
      this.notes.push(changeNote);
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
   * Select notes for spending
   */
  private selectNotes(amount: bigint): { notesToSpend: Note[]; totalValue: bigint } {
    const sortedNotes = [...this.notes].sort((a, b) =>
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
   * Remove spent notes
   */
  private removeSpentNotes(spent: Note[]): void {
    const spentCommitments = new Set(spent.map(n => n.commitment.toString()));
    this.notes = this.notes.filter(n => !spentCommitments.has(n.commitment.toString()));
  }

  /**
   * Save notes AND tree state to chrome storage
   */
  private async saveNotes(): Promise<void> {
    try {
      // Save our notes (including saved Merkle proofs for instant unshield)
      const serializedNotes = this.notes.map(note => ({
        amount: note.amount.toString(),
        ownerPubkey: note.ownerPubkey.toString(),
        randomness: note.randomness.toString(),
        tokenMint: note.tokenMint.toString(),
        commitment: note.commitment.toString(),
        leafIndex: note.leafIndex,
        merklePathElements: note.merklePathElements?.map(e => e.toString()),
        merklePathIndices: note.merklePathIndices,
        merkleRoot: note.merkleRoot?.toString(),
      }));

      // Save ALL tree leaves (commitments) to reconstruct the full tree
      const treeLeaves = this.merkleTree.getAllLeaves().map(leaf => leaf.toString());

      await chrome.storage.local.set({
        'zk_notes': JSON.stringify(serializedNotes),
        'zk_tree_leaves': JSON.stringify(treeLeaves),
      });

    } catch (error) {
      console.error('[ZK] Failed to save notes:', error);
    }
  }

  /**
   * Load notes and tree state from chrome storage
   */
  private async loadNotes(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(['zk_notes', 'zk_tree_leaves']);

      // First, rebuild the full Merkle tree from saved leaves. Legacy BN254
      // leaves (> 2^64) are dropped — the on-chain format is Goldilocks u64
      // since the STARK migration and any pre-migration notes cannot be spent.
      if (result.zk_tree_leaves) {
        const rawTreeLeaves = JSON.parse(result.zk_tree_leaves) as string[];
        const U64_MAX = 1n << 64n;
        const treeLeaves = rawTreeLeaves.filter((s) => {
          const v = BigInt(s);
          if (v >= U64_MAX) {
            console.warn('[ZK] Dropping legacy BN254 tree leaf (re-shield required):', s);
            return false;
          }
          return true;
        });

        for (const leafStr of treeLeaves) {
          this.merkleTree.insert(BigInt(leafStr));
        }

        // DEBUG: Log computed root from stored leaves

        // Store tree leaves for note index validation
        const treeLeavesSet = new Map<string, number>();
        for (let i = 0; i < treeLeaves.length; i++) {
          treeLeavesSet.set(treeLeaves[i], i);
        }

        // Then load our notes (they reference positions in the tree).
        // Legacy BN254 notes (commitment ≥ 2^64) are dropped — they can't
        // be spent under the new Goldilocks circuit and must be re-shielded.
        if (result.zk_notes) {
          const parsed = JSON.parse(result.zk_notes);
          const U64_MAX = 1n << 64n;

          this.notes = parsed
            .map((noteData: any): Note => ({
              amount: BigInt(noteData.amount),
              ownerPubkey: BigInt(noteData.ownerPubkey),
              randomness: BigInt(noteData.randomness),
              tokenMint: BigInt(noteData.tokenMint),
              commitment: BigInt(noteData.commitment),
              leafIndex: noteData.leafIndex,
              merklePathElements: noteData.merklePathElements?.map((e: string) => BigInt(e)),
              merklePathIndices: noteData.merklePathIndices,
              merkleRoot: noteData.merkleRoot ? BigInt(noteData.merkleRoot) : undefined,
            }))
            .filter((note: Note) => {
              if (note.commitment >= U64_MAX) {
                console.warn('[ZK] Dropping legacy BN254 note (re-shield required):', note.commitment.toString());
                return false;
              }
              return true;
            })
            .map((note: Note) => {
              // Only correct leaf index from local tree if note has NO saved proof.
              // Notes with saved merklePathElements have proofs consistent with their
              // original leafIndex — overwriting it would break the proof.
              if (!note.merklePathElements) {
                const commitmentStr = note.commitment.toString();
                const correctIndex = treeLeavesSet.get(commitmentStr);
                if (correctIndex !== undefined && correctIndex !== note.leafIndex) {
                  console.warn(`[ZK] Correcting note leaf index: ${note.leafIndex} -> ${correctIndex}`);
                  note.leafIndex = correctIndex;
                }
              }
              return note;
            });
        }
      } else {
        // No tree leaves stored — just load notes, filtering legacy BN254.
        if (result.zk_notes) {
          const parsed = JSON.parse(result.zk_notes);
          const U64_MAX = 1n << 64n;

          this.notes = parsed
            .map((noteData: any): Note => ({
              amount: BigInt(noteData.amount),
              ownerPubkey: BigInt(noteData.ownerPubkey),
              randomness: BigInt(noteData.randomness),
              tokenMint: BigInt(noteData.tokenMint),
              commitment: BigInt(noteData.commitment),
              leafIndex: noteData.leafIndex,
              merklePathElements: noteData.merklePathElements?.map((e: string) => BigInt(e)),
              merklePathIndices: noteData.merklePathIndices,
              merkleRoot: noteData.merkleRoot ? BigInt(noteData.merkleRoot) : undefined,
            }))
            .filter((note: Note) => {
              if (note.commitment >= U64_MAX) {
                console.warn('[ZK] Dropping legacy BN254 note (re-shield required):', note.commitment.toString());
                return false;
              }
              return true;
            });
        }
      }

    } catch (error) {
      console.error('[ZK] Failed to load notes:', error);
      this.notes = [];
    }
  }

  /**
   * Sync Merkle tree from blockchain (like mobile does)
   * This rebuilds the local tree from on-chain transaction data
   * to ensure it matches the actual on-chain state.
   */
  async syncFromBlockchain(): Promise<{ success: boolean; localRoot: string; onChainRoot: string }> {
    if (!this.connection) {
      throw new Error('Connection not set');
    }


    // Get PDAs
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );

    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    // Fetch on-chain Merkle tree state
    const merkleTreeAccount = await this.connection.getAccountInfo(merkleTreePDA);
    if (!merkleTreeAccount) {
      throw new Error('Merkle tree account not found - pool may not be initialized');
    }

    // Parse on-chain root and leaf count
    // Layout: 8 (discriminator) + 32 (pool) + 32 (root) + 8 (leaf_count) + 1 (depth) + ...
    const discriminator = merkleTreeAccount.data.slice(0, 8);
    const poolBytes = merkleTreeAccount.data.slice(8, 8 + 32);
    const rootBytes = merkleTreeAccount.data.slice(8 + 32, 8 + 32 + 32);
    const leafCountOffset = 8 + 32 + 32;
    const onChainLeafCount = Number(merkleTreeAccount.data.readBigUInt64LE(leafCountOffset));
    const depthOffset = leafCountOffset + 8;
    const onChainDepth = merkleTreeAccount.data[depthOffset];

    // Log raw bytes for debugging

    // Convert on-chain root to bigint (little-endian)
    let onChainRoot = BigInt(0);
    for (let i = 31; i >= 0; i--) {
      onChainRoot = (onChainRoot << BigInt(8)) | BigInt(rootBytes[i]);
    }


    // Also fetch pool's merkle_root for comparison
    try {
      const poolAccount = await this.connection.getAccountInfo(poolPDA);
      if (poolAccount) {
        // Pool layout: 8 (disc) + 32 (authority) + 32 (token_mint) + 32 (merkle_root)
        const poolRootBytes = poolAccount.data.slice(8 + 32 + 32, 8 + 32 + 32 + 32);
        let poolRoot = BigInt(0);
        for (let i = 31; i >= 0; i--) {
          poolRoot = (poolRoot << BigInt(8)) | BigInt(poolRootBytes[i]);
        }
      }
    } catch (e) {
      console.warn('[ZK Sync] Could not read pool root:', e);
    }

    // Fetch all transaction signatures
    let signatures: Array<{signature: string; slot: number}> = [];
    let lastSig: string | undefined;

    while (true) {
      const batch = await this.connection.getSignaturesForAddress(
        merkleTreePDA,
        { limit: 100, before: lastSig }
      );
      if (batch.length === 0) break;

      signatures.push(...batch.filter(s => !s.err).map(s => ({ signature: s.signature, slot: s.slot })));
      lastSig = batch[batch.length - 1].signature;

      if (signatures.length > 500) break;
    }


    // Process in chronological order (oldest first)
    signatures.sort((a, b) => a.slot - b.slot);

    // Extract commitments from transactions
    const commitmentMap = new Map<number, bigint>();

    // Throttle helper to avoid devnet rate limits
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    // Retry wrapper for transaction fetches
    const conn = this.connection!;
    const fetchTxWithRetry = async (sig: string, maxRetries = 3): Promise<any> => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // Add small delay between requests to avoid rate limiting
          if (attempt > 0) await delay(1000 * attempt);
          return await conn.getTransaction(sig, {
            maxSupportedTransactionVersion: 0,
          });
        } catch (error: any) {
          if (error?.message?.includes('429') || error?.toString?.()?.includes('429')) {
            await delay(2000 * (attempt + 1));
          } else {
            throw error;
          }
        }
      }
      return null;
    };

    let requestCount = 0;

    for (const { signature } of signatures) {
      try {
        // Throttle: pause every 3 requests to avoid 429
        requestCount++;
        if (requestCount % 3 === 0) {
          await delay(300);
        }

        const tx = await fetchTxWithRetry(signature);

        if (!tx?.meta?.logMessages) continue;

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

        // Extract instruction data
        const txMessage = tx.transaction.message as any;
        const hasCompiled = 'compiledInstructions' in txMessage;

        // Find our program's instruction
        let ixData: Uint8Array | null = null;
        if (hasCompiled) {
          const programIndex = txMessage.staticAccountKeys.findIndex(
            (k: PublicKey) => k.equals(this.programId)
          );
          if (programIndex !== -1) {
            for (const ix of txMessage.compiledInstructions) {
              if (ix.programIdIndex === programIndex && ix.data.length >= 48) {
                ixData = ix.data;
                break;
              }
            }
          }
        } else if (txMessage.instructions) {
          // Fallback for legacy instruction format
          for (const ix of txMessage.instructions) {
            // Check if this instruction is for our program
            const ixProgramId = ix.programId || (ix.programIdIndex !== undefined ? txMessage.accountKeys?.[ix.programIdIndex] : null);
            if (!ixProgramId) continue;

            const programIdStr = typeof ixProgramId === 'string' ? ixProgramId : ixProgramId.toBase58?.() || ixProgramId.toString();
            if (programIdStr === this.programId.toBase58()) {
              // ix.data might be base58 string or Uint8Array
              let data: Uint8Array;
              if (typeof ix.data === 'string') {
                // Base58 decode
                const bs58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
                const bs58Map = new Map<string, number>();
                for (let i = 0; i < bs58Chars.length; i++) {
                  bs58Map.set(bs58Chars[i], i);
                }
                let num = BigInt(0);
                for (const c of ix.data) {
                  num = num * BigInt(58) + BigInt(bs58Map.get(c) || 0);
                }
                const bytes: number[] = [];
                while (num > 0) {
                  bytes.unshift(Number(num % BigInt(256)));
                  num = num / BigInt(256);
                }
                // Add leading zeros for leading '1's in base58
                for (const c of ix.data) {
                  if (c === '1') bytes.unshift(0);
                  else break;
                }
                data = new Uint8Array(bytes);
              } else {
                data = ix.data;
              }

              if (data.length >= 48) {
                ixData = data;
                break;
              }
            }
          }
        }

        if (!ixData) {
          if (isShield || isUnshield || isTransfer) {
            console.warn('[ZK Sync] Failed to extract ix data for',
              isShield ? 'Shield' : isUnshield ? 'Unshield' : 'Transfer',
              'tx:', signature.slice(0, 16) + '...',
              'leafIndex:', leafIndex, 'transferIndices:', transferIndices);
          }
          continue;
        }

        // Extract commitments based on transaction type
        if (isShield && leafIndex !== null && ixData.length >= 48) {
          // Shield: discriminator(8) + amount(8) + commitment(32)
          const commitmentBytes = ixData.slice(16, 48);
          let commitment = BigInt(0);
          for (let i = 31; i >= 0; i--) {
            commitment = (commitment << BigInt(8)) | BigInt(commitmentBytes[i]);
          }
          commitmentMap.set(leafIndex, commitment);
        }

        if (isUnshield && leafIndex !== null && ixData.length > 400) {
          // Unshield: discriminator(8) + proof(256) + nullifiers(64) + output_commitment_1(32)
          const OFFSET = 8 + 256 + 32 + 32; // 328
          const commitmentBytes = ixData.slice(OFFSET, OFFSET + 32);
          let commitment = BigInt(0);
          for (let i = 31; i >= 0; i--) {
            commitment = (commitment << BigInt(8)) | BigInt(commitmentBytes[i]);
          }
          commitmentMap.set(leafIndex, commitment);
        }

        if (isTransfer && transferIndices && ixData.length > 400) {
          // Transfer: discriminator(8) + proof(256) + nullifiers(64) + commitment_1(32) + commitment_2(32)
          const OFFSET_1 = 8 + 256 + 32 + 32; // 328
          const OFFSET_2 = OFFSET_1 + 32; // 360

          for (let i = 0; i < 2; i++) {
            const offset = i === 0 ? OFFSET_1 : OFFSET_2;
            const commitmentBytes = ixData.slice(offset, offset + 32);
            let commitment = BigInt(0);
            for (let j = 31; j >= 0; j--) {
              commitment = (commitment << BigInt(8)) | BigInt(commitmentBytes[j]);
            }
            commitmentMap.set(transferIndices[i], commitment);
          }
        }
      } catch (error) {
        console.warn('[ZK Sync] Failed to parse transaction:', error);
      }
    }


    // Build ordered commitment array
    const commitments: bigint[] = [];
    for (let i = 0; i < onChainLeafCount; i++) {
      const commitment = commitmentMap.get(i);
      if (!commitment) {
        throw new Error(`Missing commitment at index ${i} - cannot rebuild tree`);
      }
      commitments.push(commitment);
    }

    // DEBUG: Dump extracted commitments for comparison
    for (let i = 0; i < commitments.length; i++) {
    }

    // DEBUG: Compare stored vs extracted commitments
    try {
      const storedResult = await chrome.storage.local.get('zk_tree_leaves');
      if (storedResult.zk_tree_leaves) {
        const storedLeaves = JSON.parse(storedResult.zk_tree_leaves);

        const minLen = Math.min(storedLeaves.length, commitments.length);
        let firstMismatch = -1;
        for (let i = 0; i < minLen; i++) {
          const stored = storedLeaves[i];
          const extracted = commitments[i].toString();
          if (stored !== extracted) {
            if (firstMismatch === -1) firstMismatch = i;
          }
        }
        if (firstMismatch === -1) {
        } else {
        }
      }
    } catch (e) {
      console.warn('[ZK Sync] Could not compare commitments:', e);
    }

    // Rebuild Merkle tree
    const newTree = new MerkleTree(MERKLE_TREE_DEPTH);
    for (const commitment of commitments) {
      newTree.insert(commitment);
    }


    const rootMatches = newTree.root === onChainRoot;

    if (rootMatches) {
    } else {
      console.warn('[ZK Sync] ⚠️ Root mismatch detected - on-chain root is stale');
      console.warn('[ZK Sync] Correct tree root:', newTree.root.toString());
      console.warn('[ZK Sync] Stale on-chain root:', onChainRoot.toString());
      console.warn('[ZK Sync] Updating local tree with correct data');
      console.warn('[ZK Sync] 💡 To fix on-chain root: Shield a small amount (0.001 SOL)');
      console.warn('[ZK Sync] This will update on-chain root to the correct value');
    }

    // ALWAYS update local state with extracted commitments - they are the source of truth
    // Even if on-chain root is stale/wrong, the extracted commitments are correct
    this.merkleTree = newTree;

    // Save the new tree leaves
    const treeLeaves = newTree.getAllLeaves().map(leaf => leaf.toString());
    await chrome.storage.local.set({ 'zk_tree_leaves': JSON.stringify(treeLeaves) });

    // Update leaf indices for our notes - find their actual on-chain positions
    let notesUpdated = 0;
    for (const note of this.notes) {
      const noteCommitmentStr = note.commitment.toString();
      const onChainIndex = commitments.findIndex(c => c.toString() === noteCommitmentStr);
      if (onChainIndex !== -1 && note.leafIndex !== onChainIndex) {
        note.leafIndex = onChainIndex;
        notesUpdated++;
      }
    }

    if (notesUpdated > 0) {
    }

    await this.saveNotes();


    return {
      success: true, // Always succeed if we extracted all commitments
      localRoot: newTree.root.toString(),
      onChainRoot: onChainRoot.toString(),
    };
  }

  /**
   * Sync the local Merkle tree from the chain. The shielded pool never
   * publishes note plaintexts on-chain — incoming notes arrive via
   * `importNotes` or stealth-payment scanning. This is a thin wrapper over
   * `syncFromBlockchain` so legacy call sites keep working.
   */
  async scanIncomingNotes(_fromSignature?: string): Promise<{ found: number; newBalance: bigint }> {
    if (!this.connection || !this.ownerPubkeyGl) {
      throw new Error('ZK Service not initialized');
    }
    await this.syncFromBlockchain();
    return { found: 0, newBalance: this.getShieldedBalance() };
  }

  /**
   * Get last scanned signature for resuming scans
   */
  async getLastScannedSignature(): Promise<string | undefined> {
    try {
      const result = await chrome.storage.local.get('zk_last_scan_signature');
      return result.zk_last_scan_signature;
    } catch {
      return undefined;
    }
  }

  /**
   * Save last scanned signature
   */
  async setLastScannedSignature(signature: string): Promise<void> {
    await chrome.storage.local.set({ 'zk_last_scan_signature': signature });
  }

  /**
   * Export notes for backup
   * Returns a JSON string containing all notes and metadata
   */
  exportNotes(): string {
    if (!this.ownerPubkeyGl) {
      throw new Error('ZK Service not initialized');
    }

    const exportData = {
      version: 1,
      zkAddress: this.getZkAddress().encoded,
      tokenMint: this.tokenMint.toBase58(),
      exportedAt: Date.now(),
      notes: this.notes.map(note => ({
        amount: note.amount.toString(),
        ownerPubkey: note.ownerPubkey.toString(),
        randomness: note.randomness.toString(),
        tokenMint: note.tokenMint.toString(),
        commitment: note.commitment.toString(),
        leafIndex: note.leafIndex,
      })),
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import notes from backup, recipient note JSON, or p01note format
   * Merges imported notes with existing notes, skipping duplicates
   */
  async importNotes(data: string): Promise<{ imported: number; skipped: number }> {
    if (!this.ownerPubkeyGl) {
      throw new Error('ZK Service not initialized');
    }

    const trimmedData = data.trim();

    // Handle p01note: format (mobile app compatible)
    if (trimmedData.startsWith('p01note:')) {
      try {
        const noteData = decodeP01Note(trimmedData);
        return this.processNoteImport({
          version: 1,
          notes: [noteData],
        });
      } catch (error) {
        throw new Error('Invalid p01note format: ' + (error as Error).message);
      }
    }

    // Handle JSON formats
    let parsedData: any;

    try {
      parsedData = JSON.parse(trimmedData);
    } catch {
      throw new Error('Invalid format. Expected p01note:... or JSON');
    }

    // Handle single recipient note format (extension format)
    if (parsedData.type === 'recipient_note' && parsedData.note) {
      const noteData = parsedData.note;

      // Convert to array format
      const importData = {
        version: parsedData.version || 1,
        notes: [noteData],
      };

      return this.processNoteImport(importData);
    }

    // Handle full backup format
    if (!parsedData.version || !parsedData.notes || !Array.isArray(parsedData.notes)) {
      throw new Error('Invalid export format: missing required fields');
    }

    return this.processNoteImport(parsedData);
  }

  /**
   * Process note import from normalized format
   */
  private async processNoteImport(importData: {
    version: number;
    zkAddress?: string;
    notes: Array<{
      amount: string;
      ownerPubkey: string;
      randomness: string;
      tokenMint: string;
      commitment: string;
      leafIndex?: number;
    }>;
  }): Promise<{ imported: number; skipped: number }> {

    // Warn if different ZK address (notes from different wallet)
    const currentZkAddress = this.getZkAddress().encoded;
    if (importData.zkAddress && importData.zkAddress !== currentZkAddress) {
      console.warn('[ZK Import] Notes were exported from a different ZK address');
      // Still allow import - user might be restoring from backup
    }

    // Check if any note has a leafIndex beyond our current tree
    const maxLeafIndex = Math.max(...importData.notes.map(n => n.leafIndex ?? -1));

    // If we need more leaves, sync from blockchain first
    if (maxLeafIndex >= this.merkleTree.leafCount) {
      try {
        await this.syncFromBlockchain();
      } catch (error) {
        console.error('[ZK Import] Failed to sync from blockchain:', error);
        // Continue anyway - we'll verify the commitment below
      }
    }

    // Track existing commitments
    const existingCommitments = new Set(this.notes.map(n => n.commitment.toString()));
    let imported = 0;
    let skipped = 0;

    for (const noteData of importData.notes) {
      try {
        // Parse note
        const note: Note = {
          amount: BigInt(noteData.amount),
          ownerPubkey: BigInt(noteData.ownerPubkey),
          randomness: BigInt(noteData.randomness),
          tokenMint: BigInt(noteData.tokenMint),
          commitment: BigInt(noteData.commitment),
          leafIndex: noteData.leafIndex,
        };

        // Verify commitment matches circuit-5 Goldilocks layout:
        //   commitment = hash2(hash2(amount, rand), hash2(owner, mint))
        const computedCommitment = computeGoldilocksCommitment(
          truncateToGoldilocks(note.amount),
          truncateToGoldilocks(note.ownerPubkey),
          truncateToGoldilocks(note.randomness),
          truncateToGoldilocks(note.tokenMint),
        );

        if (computedCommitment !== note.commitment) {
          console.warn('[ZK Import] Skipping note with invalid commitment');
          skipped++;
          continue;
        }

        // Skip duplicates
        if (existingCommitments.has(note.commitment.toString())) {
          skipped++;
          continue;
        }

        // Get all leaves for verification
        const allLeaves = this.merkleTree.getAllLeaves();

        // Verify the commitment is in the tree
        // First try the claimed index, then search the whole tree as fallback
        let foundIndex: number = -1;

        if (note.leafIndex !== undefined && note.leafIndex < this.merkleTree.leafCount) {
          const treeCommitment = allLeaves[note.leafIndex];
          if (treeCommitment === note.commitment) {
            foundIndex = note.leafIndex;
          } else {
            console.warn(`[ZK Import] Commitment mismatch at claimed index ${note.leafIndex}, searching tree...`);
            console.warn(`[ZK Import] Claimed: ${note.commitment}`);
            console.warn(`[ZK Import] At idx:  ${treeCommitment}`);
          }
        }

        // If claimed index didn't work, search the entire tree
        if (foundIndex === -1) {
          foundIndex = allLeaves.findIndex(l => l === note.commitment);
          if (foundIndex >= 0) {
            note.leafIndex = foundIndex;
          }
        }

        // If still not found, skip this note
        if (foundIndex === -1) {
          console.error(`[ZK Import] Commitment not found anywhere in tree (${this.merkleTree.leafCount} leaves), skipping`);
          skipped++;
          continue;
        }

        note.leafIndex = foundIndex;

        // Add note
        this.notes.push(note);
        existingCommitments.add(note.commitment.toString());
        imported++;
      } catch (error) {
        console.warn('[ZK Import] Failed to import note:', error);
        skipped++;
      }
    }

    // Save updated notes
    await this.saveNotes();

    return { imported, skipped };
  }

  /**
   * Get all notes (for UI display)
   */
  getNotes(): Note[] {
    return [...this.notes];
  }

  /**
   * Clear all notes but keep the Merkle tree intact
   * Use this when notes are unrecoverable (wrong indices, etc.)
   */
  async clearNotes(): Promise<void> {
    this.notes = [];
    await chrome.storage.local.remove('zk_notes');
  }

  /**
   * Reset service
   */
  async reset(): Promise<void> {
    this.spendingKeyBytes = null;
    this.spendingKeyGl = null;
    this.ownerPubkeyGl = null;
    this.viewingKey = null;
    this.notes = [];
    this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
    this.isInitialized = false;

    this._cachedSubtrees = null;
    await chrome.storage.local.remove(['zk_notes', 'zk_tree_leaves', 'zk_last_scan_signature', 'zk_local_subtrees']);
  }
}

// Singleton
let zkServiceInstance: ZkServiceExtension | null = null;

export function getZkServiceExtension(): ZkServiceExtension {
  if (!zkServiceInstance) {
    zkServiceInstance = new ZkServiceExtension();
  }
  return zkServiceInstance;
}
