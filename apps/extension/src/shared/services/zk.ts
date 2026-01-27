/**
 * ZK Service for Chrome Extension
 * Integrates with P-01 ZK SDK for real shielded transactions
 *
 * Uses Web Worker for proof generation when available,
 * falls back to backend prover service otherwise.
 */

import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';

// Constants
const ZK_SHIELDED_PROGRAM_ID = '8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY';
const MERKLE_TREE_DEPTH = 20;

// Circuit files (bundled with extension in public/circuits/)
const CIRCUIT_WASM_PATH = 'circuits/transfer.wasm';
const CIRCUIT_ZKEY_PATH = 'circuits/transfer_final.zkey';

// PDA seeds
const PDA_SEEDS = {
  SHIELDED_POOL: new TextEncoder().encode('shielded_pool'),
  MERKLE_TREE: new TextEncoder().encode('merkle_tree'),
  NULLIFIER_SET: new TextEncoder().encode('nullifier_set'),
};

// BN254 field order
const FIELD_ORDER = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

// Import poseidon-lite for circom-compatible Poseidon hash
import { poseidon1, poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';

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
 * Groth16 proof
 */
export interface Groth16Proof {
  pi_a: Uint8Array;
  pi_b: Uint8Array;
  pi_c: Uint8Array;
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
    console.error('[ZK] Poseidon hash error:', error);
    throw error;
  }
}

/**
 * Convert bigint to 32-byte little-endian buffer
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
 * Convert bigint to 32-byte big-endian buffer (for ZK public inputs)
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
 * Convert LE bytes to bigint
 */
function leBytesToBigint(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) + BigInt(bytes[i]);
  }
  return result;
}

/**
 * Generate random field element
 */
function randomFieldElement(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return leBytesToBigint(bytes) % FIELD_ORDER;
}

/**
 * Derive spending key from seed phrase
 */
async function deriveSpendingKey(seedPhrase: string): Promise<{
  spendingKey: bigint;
  spendingKeyHash: bigint;
  ownerPubkey: bigint;
}> {
  const encoder = new TextEncoder();
  const data = encoder.encode(seedPhrase + ':spending_key');

  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);

  const spendingKey = leBytesToBigint(hashArray) % FIELD_ORDER;
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
  const randomness = randomFieldElement();
  const commitment = poseidonHash(amount, ownerPubkey, randomness, tokenMint);

  return {
    amount,
    ownerPubkey,
    randomness,
    tokenMint,
    commitment,
  };
}

/**
 * Compute nullifier
 */
function computeNullifier(commitment: bigint, spendingKeyHash: bigint): bigint {
  return poseidonHash(commitment, spendingKeyHash);
}

/**
 * Merkle tree implementation
 */
class MerkleTree {
  private depth: number;
  private leaves: bigint[] = [];
  private nodes: Map<string, bigint> = new Map();
  private _root: bigint;
  private _zeroValues: bigint[] | null = null;

  constructor(depth: number = MERKLE_TREE_DEPTH) {
    this.depth = depth;
    this._root = this.getZeroValue(depth);
  }

  get root(): bigint {
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
 * Client-side ZK Prover using Web Worker
 */
class ClientProver {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, {
    resolve: (proof: Groth16Proof) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private circuitWasm: ArrayBuffer | null = null;
  private circuitZkey: ArrayBuffer | null = null;
  private _isReady: boolean = false;

  get isReady(): boolean {
    return this._isReady;
  }

  async initialize(): Promise<void> {
    // Load circuit files
    console.log('[Prover] Loading circuit files...');
    const wasmUrl = chrome.runtime.getURL(CIRCUIT_WASM_PATH);
    const zkeyUrl = chrome.runtime.getURL(CIRCUIT_ZKEY_PATH);
    console.log('[Prover] WASM URL:', wasmUrl);
    console.log('[Prover] ZKEY URL:', zkeyUrl);

    try {
      const [wasmResponse, zkeyResponse] = await Promise.all([
        fetch(wasmUrl),
        fetch(zkeyUrl),
      ]);

      if (!wasmResponse.ok) {
        console.error('[Prover] Failed to load WASM:', wasmResponse.status, wasmResponse.statusText);
        this._isReady = false;
        return;
      }
      if (!zkeyResponse.ok) {
        console.error('[Prover] Failed to load ZKEY:', zkeyResponse.status, zkeyResponse.statusText);
        this._isReady = false;
        return;
      }

      console.log('[Prover] Circuit files loaded, reading buffers...');
      this.circuitWasm = await wasmResponse.arrayBuffer();
      this.circuitZkey = await zkeyResponse.arrayBuffer();
      console.log('[Prover] WASM size:', this.circuitWasm.byteLength, 'ZKEY size:', this.circuitZkey.byteLength);

      // Create Web Worker
      console.log('[Prover] Creating Web Worker...');
      this.worker = new Worker(
        new URL('../workers/zkProver.worker.ts', import.meta.url),
        { type: 'module' }
      );

      // Wait for worker to be ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Worker initialization timeout'));
        }, 10000);

        this.worker!.onmessage = (event) => {
          const { type, id, proof, error } = event.data;

          if (type === 'ready') {
            clearTimeout(timeout);
            this._isReady = true;
            console.log('[Prover] Web Worker ready');
            resolve();
            return;
          }

          const pending = this.pendingRequests.get(id);
          if (!pending) return;

          this.pendingRequests.delete(id);

          if (type === 'error') {
            console.error('[Prover] Proof error:', error);
            pending.reject(new Error(error));
          } else if (type === 'proof') {
            // Convert proof to Groth16Proof format
            const groth16Proof = this.convertProof(proof);
            pending.resolve(groth16Proof);
          }
        };

        this.worker!.onerror = (error) => {
          clearTimeout(timeout);
          console.error('[Prover] Worker error:', error);
          reject(error);
        };
      });
    } catch (error) {
      console.error('[Prover] Initialization failed:', error);
      this._isReady = false;
      throw error;
    }
  }

  private convertProof(snarkjsProof: any): Groth16Proof {
    // Convert snarkjs proof format to our byte format
    // snarkjs returns strings, we need Uint8Array
    const pi_a = this.pointToBytes(snarkjsProof.pi_a.slice(0, 2));
    const pi_b = this.point2ToBytes(snarkjsProof.pi_b.slice(0, 2));
    const pi_c = this.pointToBytes(snarkjsProof.pi_c.slice(0, 2));

    return { pi_a, pi_b, pi_c };
  }

  private pointToBytes(point: string[]): Uint8Array {
    const bytes = new Uint8Array(64);
    const x = BigInt(point[0]);
    const y = BigInt(point[1]);

    // Convert to BIG-ENDIAN bytes (alt_bn128 precompile expects big-endian)
    let temp = x;
    for (let i = 31; i >= 0; i--) {
      bytes[i] = Number(temp & BigInt(0xff));
      temp = temp >> BigInt(8);
    }
    temp = y;
    for (let i = 31; i >= 0; i--) {
      bytes[32 + i] = Number(temp & BigInt(0xff));
      temp = temp >> BigInt(8);
    }

    return bytes;
  }

  private point2ToBytes(point: string[][]): Uint8Array {
    // G2 point: [[x0, x1], [y0, y1]] - alt_bn128 expects big-endian
    // Note: snarkjs returns G2 as [[x_c1, x_c0], [y_c1, y_c0]] (c1 first, then c0)
    // alt_bn128 expects: x_c0 | x_c1 | y_c0 | y_c1 (each 32 bytes, big-endian)
    const bytes = new Uint8Array(128);

    // Reorder: snarkjs [x1, x0], [y1, y0] -> alt_bn128 [x0, x1, y0, y1]
    const coords = [
      BigInt(point[0][1]), // x_c0
      BigInt(point[0][0]), // x_c1
      BigInt(point[1][1]), // y_c0
      BigInt(point[1][0]), // y_c1
    ];

    for (let c = 0; c < 4; c++) {
      let temp = coords[c];
      // Big-endian encoding
      for (let i = 31; i >= 0; i--) {
        bytes[c * 32 + i] = Number(temp & BigInt(0xff));
        temp = temp >> BigInt(8);
      }
    }

    return bytes;
  }

  async generateProof(inputs: Record<string, string | string[]>): Promise<Groth16Proof> {
    if (!this.isReady || !this.worker || !this.circuitWasm || !this.circuitZkey) {
      throw new Error('Prover not initialized. Circuit files may be missing.');
    }

    const id = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      this.worker!.postMessage({
        type: 'prove',
        id,
        circuitWasm: this.circuitWasm,
        circuitZkey: this.circuitZkey,
        inputs,
      });

      // Timeout after 2 minutes
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Proof generation timed out'));
        }
      }, 120000);
    });
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
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
  private spendingKey: bigint | null = null;
  private spendingKeyHash: bigint | null = null;
  private ownerPubkey: bigint | null = null;
  private viewingKey: Uint8Array | null = null;
  private tokenMint: PublicKey;
  private isInitialized: boolean = false;
  private prover: ClientProver;

  constructor() {
    this.programId = new PublicKey(ZK_SHIELDED_PROGRAM_ID);
    this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
    this.tokenMint = SystemProgram.programId; // SOL
    this.prover = new ClientProver();
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
    this.spendingKey = keys.spendingKey;
    this.spendingKeyHash = keys.spendingKeyHash;
    this.ownerPubkey = keys.ownerPubkey;
    this.viewingKey = bigintToLeBytes(keys.ownerPubkey);

    // Initialize client-side prover (Web Worker)
    try {
      await this.prover.initialize();
      console.log('[ZK] Client-side prover initialized');
    } catch (error) {
      console.warn('[ZK] Prover initialization failed, transfer/unshield will be unavailable:', error);
    }

    // Load stored notes
    await this.loadNotes();

    this.isInitialized = true;
  }

  /**
   * Get ZK address
   */
  getZkAddress(): ZkAddress {
    if (!this.ownerPubkey || !this.viewingKey) {
      throw new Error('ZK Service not initialized');
    }

    const pubkeyBytes = bigintToLeBytes(this.ownerPubkey);
    const combined = new Uint8Array(64);
    combined.set(pubkeyBytes, 0);
    combined.set(this.viewingKey, 32);

    const encoded = `zk:${btoa(String.fromCharCode(...combined))}`;

    return {
      receivingPubkey: this.ownerPubkey,
      viewingKey: this.viewingKey,
      encoded,
    };
  }

  /**
   * Get stealth keys for scanning stealth payments
   * Returns viewing and spending keys in format needed for stealth address derivation
   */
  getStealthKeys(): { viewingKey: Uint8Array; spendingKey: Uint8Array } | null {
    if (!this.viewingKey || !this.spendingKey) {
      return null;
    }

    return {
      viewingKey: this.viewingKey,
      spendingKey: bigintToLeBytes(this.spendingKey),
    };
  }

  /**
   * Get shielded balance
   */
  getShieldedBalance(): bigint {
    return this.notes.reduce((sum, note) => sum + note.amount, BigInt(0));
  }

  /**
   * Shield tokens
   */
  async shield(
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    if (!this.ownerPubkey || !this.connection) {
      throw new Error('ZK Service not initialized');
    }

    const tokenMintField = leBytesToBigint(this.tokenMint.toBytes());

    // Create note
    const note = await createNote(amount, this.ownerPubkey, tokenMintField);

    // Update Merkle tree
    const newRoot = this.merkleTree.insert(note.commitment);
    const newRootBytes = bigintToLeBytes(newRoot);

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
    const discriminator = new Uint8Array([0xdc, 0xc6, 0xfd, 0xf6, 0xe7, 0x54, 0x93, 0x62]);
    const amountBuffer = new ArrayBuffer(8);
    new DataView(amountBuffer).setBigUint64(0, amount, true);
    const commitmentBytes = bigintToLeBytes(note.commitment);

    const data = new Uint8Array([
      ...discriminator,
      ...new Uint8Array(amountBuffer),
      ...commitmentBytes,
      ...newRootBytes,
    ]);

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
      data: Buffer.from(data),
    });

    // Build and sign transaction
    const tx = new Transaction().add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signedTx = await signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize());

    await this.connection.confirmTransaction(signature, 'confirmed');

    // Store note
    note.leafIndex = this.merkleTree.leafCount - 1;
    this.notes.push(note);
    await this.saveNotes();

    return signature;
  }

  /**
   * Transfer shielded tokens
   * Returns signature and recipient note data for sharing
   */
  async transfer(
    recipient: ZkAddress,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<{ signature: string; recipientNote: RecipientNoteData }> {
    if (!this.spendingKeyHash || !this.ownerPubkey || !this.connection) {
      throw new Error('ZK Service not initialized');
    }

    // Select notes
    const { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    const tokenMintField = leBytesToBigint(this.tokenMint.toBytes());

    // Create output notes
    const recipientNote = await createNote(amount, recipient.receivingPubkey, tokenMintField);
    const changeAmount = totalValue - amount;
    const changeNote = await createNote(changeAmount, this.ownerPubkey, tokenMintField);

    // Compute nullifiers and handle dummy input note for single-note spends
    const nullifier1 = computeNullifier(notesToSpend[0].commitment, this.spendingKeyHash);
    let nullifier2: bigint;
    let dummyInputNote: Note | undefined;

    if (notesToSpend[1]) {
      nullifier2 = computeNullifier(notesToSpend[1].commitment, this.spendingKeyHash);
    } else {
      // IMPORTANT: For dummy input note, we must use UNIQUE randomness each time!
      const dummyRandomness = randomFieldElement();
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), dummyRandomness, tokenMintField);
      nullifier2 = computeNullifier(dummyCommitment, this.spendingKeyHash);

      dummyInputNote = {
        amount: BigInt(0),
        ownerPubkey: BigInt(0),
        randomness: dummyRandomness,
        tokenMint: tokenMintField,
        commitment: dummyCommitment,
      };
      console.log('[ZK Transfer] Created dummy input note with randomness:', dummyRandomness.toString().slice(0, 20) + '...');
    }

    // Generate proofs
    const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
    const proof2 = notesToSpend[1]
      ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
      : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

    // Save the current merkle root BEFORE inserting new commitments
    // This is the root that will be used in the proof and validated on-chain
    const merkleRoot = this.merkleTree.root;

    // Build input notes array - use dummy for second slot if only one note
    const inputNotesForProof = notesToSpend[1]
      ? notesToSpend
      : [notesToSpend[0], dummyInputNote!];

    // Verify Merkle proofs locally before sending to circuit
    console.log('[ZK Transfer] Verifying Merkle proof locally...');
    console.log('[ZK Transfer] Note 1 commitment:', notesToSpend[0].commitment.toString().slice(0, 20) + '...');
    console.log('[ZK Transfer] Note 1 leafIndex:', notesToSpend[0].leafIndex);
    console.log('[ZK Transfer] Merkle root:', merkleRoot.toString().slice(0, 20) + '...');

    // Verify proof1 locally
    let computedRoot = notesToSpend[0].commitment;
    for (let i = 0; i < proof1.pathElements.length; i++) {
      const sibling = proof1.pathElements[i];
      const isRight = proof1.pathIndices[i] === 1;
      if (isRight) {
        computedRoot = poseidonHash(sibling, computedRoot);
      } else {
        computedRoot = poseidonHash(computedRoot, sibling);
      }
    }
    console.log('[ZK Transfer] Computed root from proof1:', computedRoot.toString().slice(0, 20) + '...');
    console.log('[ZK Transfer] Roots match:', computedRoot === merkleRoot);

    if (computedRoot !== merkleRoot) {
      console.error('[ZK Transfer] Local Merkle proof verification FAILED!');
      console.error('[ZK Transfer] This indicates the local Merkle tree state is inconsistent');
      // Try to dump tree state for debugging
      console.log('[ZK Transfer] Tree leaf count:', this.merkleTree.leafCount);
      console.log('[ZK Transfer] Note count:', this.notes.length);
    }

    // Request proof from client-side prover
    const zkProof = await this.generateProofClientSide({
      merkleRoot: merkleRoot,
      nullifier1,
      nullifier2,
      outputCommitment1: recipientNote.commitment,
      outputCommitment2: changeNote.commitment,
      inputNotes: inputNotesForProof,
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
      [new TextEncoder().encode('vk_data'), poolPDA.toBytes()],
      this.programId
    );

    // Build transfer instruction - Anchor discriminator: sha256("global:transfer")[0..8]
    // merkle_root = old root used in the ZK proof (for validation)
    // new_root = root after inserting both commitments (for merkle tree update)
    const discriminator = new Uint8Array([0xa3, 0x34, 0xc8, 0xe7, 0x8c, 0x03, 0x45, 0xba]);
    const data = new Uint8Array([
      ...discriminator,
      ...zkProof.pi_a,
      ...zkProof.pi_b,
      ...zkProof.pi_c,
      ...bigintToLeBytes(nullifier1),
      ...bigintToLeBytes(nullifier2),
      ...bigintToLeBytes(recipientNote.commitment),
      ...bigintToLeBytes(changeNote.commitment),
      ...bigintToLeBytes(merkleRoot),  // Old merkle root for proof validation
      ...bigintToLeBytes(newRoot),     // New merkle root for tree update
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
      data: Buffer.from(data),
    });

    // Add compute budget instruction for Groth16 verification
    const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');

    // SetComputeUnitLimit instruction (discriminator = 2)
    const computeLimitData = new Uint8Array(5);
    computeLimitData[0] = 2;
    new DataView(computeLimitData.buffer).setUint32(1, 1_800_000, true); // 1.8M compute units

    // SetComputeUnitPrice instruction (discriminator = 3) - priority fee
    const computePriceData = new Uint8Array(9);
    computePriceData[0] = 3;
    new DataView(computePriceData.buffer).setBigUint64(1, BigInt(1000), true); // 1000 microlamports per CU

    const computeLimitIx = new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: Buffer.from(computeLimitData),
    });

    const computePriceIx = new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: Buffer.from(computePriceData),
    });

    const tx = new Transaction().add(computeLimitIx).add(computePriceIx).add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signedTx = await signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize());

    await this.connection.confirmTransaction(signature, 'confirmed');

    // Update notes
    this.removeSpentNotes(notesToSpend);
    if (changeAmount > BigInt(0)) {
      changeNote.leafIndex = this.merkleTree.leafCount - 1;
      this.notes.push(changeNote);
    }
    await this.saveNotes();

    // Return signature and recipient note data for sharing
    const recipientNoteData: RecipientNoteData = {
      amount: recipientNote.amount.toString(),
      ownerPubkey: recipientNote.ownerPubkey.toString(),
      randomness: recipientNote.randomness.toString(),
      tokenMint: recipientNote.tokenMint.toString(),
      commitment: recipientNote.commitment.toString(),
      leafIndex: this.merkleTree.leafCount - 2, // Recipient note was inserted before change note
    };

    return { signature, recipientNote: recipientNoteData };
  }

  /**
   * Unshield tokens
   */
  async unshield(
    recipient: PublicKey,
    amount: bigint,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ): Promise<string> {
    if (!this.spendingKeyHash || !this.ownerPubkey || !this.connection) {
      throw new Error('ZK Service not initialized');
    }

    // Select notes
    const { notesToSpend, totalValue } = this.selectNotes(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    const tokenMintField = leBytesToBigint(this.tokenMint.toBytes());

    // Create change note
    const changeAmount = totalValue - amount;
    const changeNote = changeAmount > BigInt(0)
      ? await createNote(changeAmount, this.ownerPubkey, tokenMintField)
      : null;

    // Compute nullifiers and handle dummy input note for single-note spends
    const nullifier1 = computeNullifier(notesToSpend[0].commitment, this.spendingKeyHash);
    let nullifier2: bigint;
    let dummyInputNote: Note | undefined;

    if (notesToSpend[1]) {
      nullifier2 = computeNullifier(notesToSpend[1].commitment, this.spendingKeyHash);
    } else {
      // IMPORTANT: For dummy input note, we must use UNIQUE randomness each time!
      // The circuit computes nullifier from the commitment, so we need a proper dummy note
      const dummyRandomness = randomFieldElement();
      const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), dummyRandomness, tokenMintField);
      nullifier2 = computeNullifier(dummyCommitment, this.spendingKeyHash);

      dummyInputNote = {
        amount: BigInt(0),
        ownerPubkey: BigInt(0),
        randomness: dummyRandomness,
        tokenMint: tokenMintField,
        commitment: dummyCommitment,
      };
      console.log('[ZK Unshield] Created dummy input note with randomness:', dummyRandomness.toString().slice(0, 20) + '...');
    }

    // Generate proofs
    const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
    const proof2 = notesToSpend[1]
      ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
      : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

    // Save the current merkle root BEFORE inserting new commitments
    const merkleRoot = this.merkleTree.root;

    // Create dummy note for the second output slot (unshield only has change, not two outputs)
    const dummyOutputRandomness = randomFieldElement();
    const dummyOutputNote: Note = {
      amount: BigInt(0),
      ownerPubkey: BigInt(0),
      randomness: dummyOutputRandomness,
      tokenMint: tokenMintField,
      commitment: poseidonHash(BigInt(0), BigInt(0), dummyOutputRandomness, tokenMintField),
    };

    // Create proper change note or dummy for first output
    let outputNote1: Note;
    if (changeNote) {
      outputNote1 = changeNote;
    } else {
      const dummyOutput1Randomness = randomFieldElement();
      outputNote1 = {
        amount: BigInt(0),
        ownerPubkey: BigInt(0),
        randomness: dummyOutput1Randomness,
        tokenMint: tokenMintField,
        commitment: poseidonHash(BigInt(0), BigInt(0), dummyOutput1Randomness, tokenMintField),
      };
    }

    // Build input notes array - use dummy for second slot if only one note
    const inputNotesForProof = notesToSpend[1]
      ? notesToSpend
      : [notesToSpend[0], dummyInputNote!];

    // Request proof
    const zkProof = await this.generateProofClientSide({
      merkleRoot: merkleRoot,
      nullifier1,
      nullifier2,
      outputCommitment1: outputNote1.commitment,
      outputCommitment2: dummyOutputNote.commitment,
      publicAmount: -amount,
      inputNotes: inputNotesForProof,
      outputNotes: [outputNote1, dummyOutputNote],
      proofs: [proof1, proof2],
      spendingKey: this.spendingKey!,
    });

    // Update Merkle tree - ALWAYS insert outputNote1.commitment since on-chain will insert it
    // The on-chain program only skips insertion if output_commitment_1 == [0u8; 32],
    // but our dummy note has a Poseidon hash commitment which is NOT zero bytes.
    // This ensures our local tree stays in sync with on-chain state.
    const newRoot = this.merkleTree.insert(outputNote1.commitment);

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
      [new TextEncoder().encode('vk_data'), poolPDA.toBytes()],
      this.programId
    );

    // Build unshield instruction - Anchor discriminator: sha256("global:unshield")[0..8]
    const discriminator = new Uint8Array([0x15, 0xe4, 0x37, 0x18, 0xc2, 0x0a, 0x15, 0x16]);
    const amountBuffer = new ArrayBuffer(8);
    new DataView(amountBuffer).setBigUint64(0, amount, true);

    const data = new Uint8Array([
      ...discriminator,
      ...zkProof.pi_a,
      ...zkProof.pi_b,
      ...zkProof.pi_c,
      ...bigintToLeBytes(nullifier1),
      ...bigintToLeBytes(nullifier2),
      ...bigintToLeBytes(outputNote1.commitment),  // output_commitment_1 (change note or dummy)
      ...bigintToLeBytes(dummyOutputNote.commitment),    // output_commitment_2 (always dummy for unshield)
      ...bigintToLeBytes(merkleRoot),            // Old merkle root for proof validation
      ...new Uint8Array(amountBuffer),
      ...bigintToLeBytes(newRoot),               // New merkle root for tree update
    ]);

    console.log('[ZK Unshield] Building tx with merkle_root:', merkleRoot.toString().slice(0, 20) + '...');
    console.log('[ZK Unshield] Recipient:', recipient.toBase58());
    console.log('[ZK Unshield] Amount:', amount.toString(), 'lamports');

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
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // token_program
        { pubkey: this.programId, isSigner: false, isWritable: false },    // pool_vault (None placeholder)
        { pubkey: this.programId, isSigner: false, isWritable: false },    // recipient_token_account (None placeholder)
      ],
      data: Buffer.from(data),
    });

    // Add compute budget instruction for Groth16 verification
    const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');

    const computeLimitData = new Uint8Array(5);
    computeLimitData[0] = 2;
    new DataView(computeLimitData.buffer).setUint32(1, 1_400_000, true); // 1.4M compute units

    const computeLimitIx = new TransactionInstruction({
      programId: COMPUTE_BUDGET_PROGRAM_ID,
      keys: [],
      data: Buffer.from(computeLimitData),
    });

    const tx = new Transaction().add(computeLimitIx).add(ix);
    tx.feePayer = walletPublicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signedTx = await signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize());

    await this.connection.confirmTransaction(signature, 'confirmed');

    // Update notes
    this.removeSpentNotes(notesToSpend);
    if (changeNote) {
      changeNote.leafIndex = this.merkleTree.leafCount - 1;
      this.notes.push(changeNote);
    }
    await this.saveNotes();

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
   * Generate proof using client-side Web Worker (no backend needed)
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
    // Get token mint field
    const tokenMintField = leBytesToBigint(this.tokenMint.toBytes());

    // BN254 field modulus (for negative amount handling)
    const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

    // Handle negative amounts (for unshield)
    let publicAmountField = inputs.publicAmount ?? BigInt(0);
    if (publicAmountField < BigInt(0)) {
      publicAmountField = FIELD_MODULUS + publicAmountField;
    }

    // Format inputs for the circuit (snake_case names to match circuit)
    // snarkjs expects arrays as actual arrays, not JSON strings
    const circuitInputs: Record<string, string | string[]> = {
      // Public inputs
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
      in_path_elements_1: inputs.proofs[0].pathElements.map(e => e.toString()),
      in_path_indices_1: inputs.proofs[0].pathIndices.map(i => i.toString()),

      // Private inputs - Input note 2
      in_amount_2: inputs.inputNotes[1]?.amount.toString() ?? '0',
      in_owner_pubkey_2: inputs.inputNotes[1]?.ownerPubkey.toString() ?? '0',
      in_randomness_2: inputs.inputNotes[1]?.randomness.toString() ?? '0',
      in_path_elements_2: inputs.proofs[1].pathElements.map(e => e.toString()),
      in_path_indices_2: inputs.proofs[1].pathIndices.map(i => i.toString()),

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

    console.log('[ZK] Generating proof client-side...');
    const startTime = performance.now();

    try {
      // Check if prover is ready
      if (!this.prover.isReady) {
        console.error('[ZK] Prover not ready - circuit files may not be loaded');
        throw new Error('ZK prover not initialized. Please reload the extension.');
      }

      const proof = await this.prover.generateProof(circuitInputs);
      const duration = ((performance.now() - startTime) / 1000).toFixed(2);
      console.log(`[ZK] Proof generated in ${duration}s`);
      return proof;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[ZK] Client-side proof generation failed:', errorMsg);
      throw new Error(`ZK proof failed: ${errorMsg}`);
    }
  }

  /**
   * Save notes AND tree state to chrome storage
   */
  private async saveNotes(): Promise<void> {
    try {
      // Save our notes
      const serializedNotes = this.notes.map(note => ({
        amount: note.amount.toString(),
        ownerPubkey: note.ownerPubkey.toString(),
        randomness: note.randomness.toString(),
        tokenMint: note.tokenMint.toString(),
        commitment: note.commitment.toString(),
        leafIndex: note.leafIndex,
      }));

      // Save ALL tree leaves (commitments) to reconstruct the full tree
      const treeLeaves = this.merkleTree.getAllLeaves().map(leaf => leaf.toString());

      await chrome.storage.local.set({
        'zk_notes': JSON.stringify(serializedNotes),
        'zk_tree_leaves': JSON.stringify(treeLeaves),
      });

      console.log('[ZK] Saved', this.notes.length, 'notes and', treeLeaves.length, 'tree leaves');
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

      // First, rebuild the full Merkle tree from saved leaves
      if (result.zk_tree_leaves) {
        const treeLeaves = JSON.parse(result.zk_tree_leaves);
        console.log('[ZK] Restoring Merkle tree with', treeLeaves.length, 'leaves');

        // DEBUG: Dump all commitments for comparison with mobile
        console.log('[ZK] ======= EXTENSION COMMITMENT DUMP START =======');
        for (let i = 0; i < treeLeaves.length; i++) {
          console.log(`[ZK] C[${i.toString().padStart(2, '0')}]: ${treeLeaves[i]}`);
        }
        console.log('[ZK] ======= EXTENSION COMMITMENT DUMP END =======');

        for (const leafStr of treeLeaves) {
          this.merkleTree.insert(BigInt(leafStr));
        }

        // DEBUG: Log computed root from stored leaves
        console.log('[ZK] Computed root from stored leaves:', this.merkleTree.root.toString());

        // Store tree leaves for note index validation
        const treeLeavesSet = new Map<string, number>();
        for (let i = 0; i < treeLeaves.length; i++) {
          treeLeavesSet.set(treeLeaves[i], i);
        }

        // Then load our notes (they reference positions in the tree)
        if (result.zk_notes) {
          const parsed = JSON.parse(result.zk_notes);

          this.notes = parsed.map((noteData: any) => {
            const note = {
              amount: BigInt(noteData.amount),
              ownerPubkey: BigInt(noteData.ownerPubkey),
              randomness: BigInt(noteData.randomness),
              tokenMint: BigInt(noteData.tokenMint),
              commitment: BigInt(noteData.commitment),
              leafIndex: noteData.leafIndex,
            };

            // Validate and correct leaf index if needed
            const commitmentStr = note.commitment.toString();
            const correctIndex = treeLeavesSet.get(commitmentStr);
            if (correctIndex !== undefined && correctIndex !== note.leafIndex) {
              console.warn(`[ZK] Correcting note leaf index: ${note.leafIndex} -> ${correctIndex}`);
              note.leafIndex = correctIndex;
            }

            return note;
          });
        }
      } else {
        // No tree leaves stored - just load notes
        if (result.zk_notes) {
          const parsed = JSON.parse(result.zk_notes);

          this.notes = parsed.map((noteData: any) => ({
            amount: BigInt(noteData.amount),
            ownerPubkey: BigInt(noteData.ownerPubkey),
            randomness: BigInt(noteData.randomness),
            tokenMint: BigInt(noteData.tokenMint),
            commitment: BigInt(noteData.commitment),
            leafIndex: noteData.leafIndex,
          }));
        }
      }

      console.log('[ZK] Loaded', this.notes.length, 'notes, tree has', this.merkleTree.leafCount, 'leaves');
      console.log('[ZK] Current Merkle root:', this.merkleTree.root.toString().slice(0, 20) + '...');
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

    console.log('[ZK Sync] Starting blockchain sync...');

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
    console.log('[ZK Sync] Account data length:', merkleTreeAccount.data.length);
    console.log('[ZK Sync] Discriminator (hex):', Buffer.from(discriminator).toString('hex'));
    console.log('[ZK Sync] Pool pubkey:', new PublicKey(poolBytes).toBase58());
    console.log('[ZK Sync] Root bytes (first 8, hex):', Buffer.from(rootBytes.slice(0, 8)).toString('hex'));
    console.log('[ZK Sync] On-chain depth:', onChainDepth);

    // Convert on-chain root to bigint (little-endian)
    let onChainRoot = BigInt(0);
    for (let i = 31; i >= 0; i--) {
      onChainRoot = (onChainRoot << BigInt(8)) | BigInt(rootBytes[i]);
    }

    console.log('[ZK Sync] On-chain leaf count:', onChainLeafCount);
    console.log('[ZK Sync] On-chain root (full):', onChainRoot.toString());

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
        console.log('[ZK Sync] Pool merkle_root:', poolRoot.toString());
        console.log('[ZK Sync] Tree root == Pool root:', onChainRoot === poolRoot);
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

    console.log('[ZK Sync] Found', signatures.length, 'transactions to process');

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
            console.log(`[ZK Sync] Rate limited (attempt ${attempt + 1}/${maxRetries}), waiting...`);
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
          console.log('[ZK Sync] Using legacy instructions path');
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
          console.log('[ZK Sync] Shield commitment at index', leafIndex);
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
          console.log('[ZK Sync] Unshield commitment at index', leafIndex);
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
            console.log('[ZK Sync] Transfer commitment', i + 1, 'at index', transferIndices[i]);
          }
        }
      } catch (error) {
        console.warn('[ZK Sync] Failed to parse transaction:', error);
      }
    }

    console.log('[ZK Sync] Extracted', commitmentMap.size, 'commitments');

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
    console.log('[ZK Sync] ======= EXTRACTED COMMITMENTS DUMP START =======');
    for (let i = 0; i < commitments.length; i++) {
      console.log(`[ZK Sync] C[${i.toString().padStart(2, '0')}]: ${commitments[i].toString()}`);
    }
    console.log('[ZK Sync] ======= EXTRACTED COMMITMENTS DUMP END =======');

    // DEBUG: Compare stored vs extracted commitments
    try {
      const storedResult = await chrome.storage.local.get('zk_tree_leaves');
      if (storedResult.zk_tree_leaves) {
        const storedLeaves = JSON.parse(storedResult.zk_tree_leaves);
        console.log('[ZK Sync] ======= COMMITMENT COMPARISON START =======');
        console.log('[ZK Sync] Stored leaf count:', storedLeaves.length);
        console.log('[ZK Sync] Extracted leaf count:', commitments.length);

        const minLen = Math.min(storedLeaves.length, commitments.length);
        let firstMismatch = -1;
        for (let i = 0; i < minLen; i++) {
          const stored = storedLeaves[i];
          const extracted = commitments[i].toString();
          if (stored !== extracted) {
            if (firstMismatch === -1) firstMismatch = i;
            console.log(`[ZK Sync] MISMATCH at [${i}]:`);
            console.log(`[ZK Sync]   Stored:    ${stored}`);
            console.log(`[ZK Sync]   Extracted: ${extracted}`);
          }
        }
        if (firstMismatch === -1) {
          console.log('[ZK Sync] First', minLen, 'commitments MATCH!');
        } else {
          console.log('[ZK Sync] First mismatch at index:', firstMismatch);
        }
        console.log('[ZK Sync] ======= COMMITMENT COMPARISON END =======');
      }
    } catch (e) {
      console.warn('[ZK Sync] Could not compare commitments:', e);
    }

    // Rebuild Merkle tree
    const newTree = new MerkleTree(MERKLE_TREE_DEPTH);
    for (const commitment of commitments) {
      newTree.insert(commitment);
    }

    console.log('[ZK Sync] Rebuilt tree with', newTree.leafCount, 'leaves');
    console.log('[ZK Sync] Local root:', newTree.root.toString().slice(0, 20) + '...');

    const rootMatches = newTree.root === onChainRoot;

    if (rootMatches) {
      console.log('[ZK Sync] SUCCESS! Root matches on-chain');
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
        console.log(`[ZK Sync] Correcting note index: ${note.leafIndex} -> ${onChainIndex}`);
        note.leafIndex = onChainIndex;
        notesUpdated++;
      }
    }

    if (notesUpdated > 0) {
      console.log(`[ZK Sync] Updated ${notesUpdated} note indices`);
    }

    await this.saveNotes();

    console.log('[ZK Sync] Local tree updated with', newTree.leafCount, 'commitments');
    console.log('[ZK Sync] New local root:', newTree.root.toString().slice(0, 20) + '...');

    return {
      success: true, // Always succeed if we extracted all commitments
      localRoot: newTree.root.toString(),
      onChainRoot: onChainRoot.toString(),
    };
  }

  /**
   * Scan blockchain for incoming shielded notes
   * Looks for ShieldEvent logs that contain commitments we can decrypt
   */
  async scanIncomingNotes(fromSignature?: string): Promise<{ found: number; newBalance: bigint }> {
    if (!this.connection || !this.ownerPubkey || !this.spendingKeyHash) {
      throw new Error('ZK Service not initialized');
    }

    console.log('[ZK] Scanning for incoming notes...');

    // Get the pool PDA to find relevant transactions
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );

    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    try {
      // Fetch recent signatures for the merkle tree account
      const signatures = await this.connection.getSignaturesForAddress(
        merkleTreePDA,
        {
          limit: 100,
          until: fromSignature,
        }
      );

      console.log(`[ZK] Found ${signatures.length} transactions to scan`);

      let foundCount = 0;
      const existingCommitments = new Set(this.notes.map(n => n.commitment.toString()));

      for (const sigInfo of signatures) {
        if (sigInfo.err) continue;

        try {
          // Get transaction details
          const tx = await this.connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!tx?.meta?.logMessages) continue;

          // Look for ShieldEvent in logs
          for (const log of tx.meta.logMessages) {
            // Parse shield event: "Program log: ShieldEvent { commitment: <hex>, leaf_index: <num>, amount: <num> }"
            const shieldMatch = log.match(/ShieldEvent\s*\{\s*commitment:\s*([0-9a-fA-Fx]+),\s*leaf_index:\s*(\d+),\s*amount:\s*(\d+)/);

            if (shieldMatch) {
              const commitmentHex = shieldMatch[1];
              const leafIndex = parseInt(shieldMatch[2]);
              const amount = BigInt(shieldMatch[3]);

              // Convert hex to bigint
              const commitment = BigInt(commitmentHex);

              // Skip if we already have this note
              if (existingCommitments.has(commitment.toString())) {
                continue;
              }

              // Try to determine if this note is ours
              // For encrypted notes, we would decrypt using viewing key
              // For now, check if commitment matches any of our expected commitments
              const isOurNote = await this.tryDecryptNote(commitment, amount, leafIndex);

              if (isOurNote) {
                console.log(`[ZK] Found incoming note: ${amount} lamports at index ${leafIndex}`);
                foundCount++;
                existingCommitments.add(commitment.toString());
              }
            }

            // Also look for transfer events with output commitments
            const transferMatch = log.match(/TransferEvent\s*\{\s*.*output_commitment_1:\s*([0-9a-fA-Fx]+).*output_commitment_2:\s*([0-9a-fA-Fx]+)/);

            if (transferMatch) {
              for (let i = 1; i <= 2; i++) {
                const commitmentHex = transferMatch[i];
                if (commitmentHex === '0x0' || commitmentHex === '0') continue;

                const commitment = BigInt(commitmentHex);

                if (existingCommitments.has(commitment.toString())) {
                  continue;
                }

                // Check if this output is for us
                const isOurNote = await this.checkOutputCommitment(commitment);

                if (isOurNote) {
                  console.log(`[ZK] Found incoming transfer note`);
                  foundCount++;
                  existingCommitments.add(commitment.toString());
                }
              }
            }
          }
        } catch (error) {
          console.debug('[ZK] Error parsing transaction:', error);
        }
      }

      // Save updated notes
      if (foundCount > 0) {
        await this.saveNotes();
      }

      const newBalance = this.getShieldedBalance();
      console.log(`[ZK] Scan complete: found ${foundCount} new notes, balance: ${newBalance}`);

      return { found: foundCount, newBalance };
    } catch (error) {
      console.error('[ZK] Scan error:', error);
      throw error;
    }
  }

  /**
   * Try to decrypt a note commitment to see if it belongs to us
   * In a full implementation, notes would be encrypted with viewing key
   */
  private async tryDecryptNote(
    commitment: bigint,
    amount: bigint,
    leafIndex: number
  ): Promise<boolean> {
    if (!this.ownerPubkey) return false;

    // In the current implementation, shield events include the amount publicly
    // We need to check if we can derive the same commitment
    // This requires knowing the randomness, which would be encrypted

    // For now, we assume any shield to the pool *might* be ours
    // In production, the note data would be encrypted with our viewing key

    // Check if we can reconstruct the commitment with our pubkey
    // Try common randomness values (for testing) or scan encrypted note data
    const tokenMintField = leBytesToBigint(this.tokenMint.toBytes());

    // In a real implementation, the randomness would be encrypted in the tx data
    // For now, we store notes we create ourselves and can't detect external ones
    // without proper note encryption

    // This is a placeholder that returns false - proper implementation would:
    // 1. Find encrypted note data in transaction
    // 2. Decrypt using viewing key
    // 3. Verify commitment matches

    return false;
  }

  /**
   * Check if an output commitment from a transfer belongs to us
   */
  private async checkOutputCommitment(commitment: bigint): Promise<boolean> {
    // Similar to tryDecryptNote - would need encrypted note data
    // For now, return false as we can't determine ownership without encryption
    return false;
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
    if (!this.ownerPubkey) {
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
    if (!this.ownerPubkey) {
      throw new Error('ZK Service not initialized');
    }

    const trimmedData = data.trim();

    // Handle p01note: format (mobile app compatible)
    if (trimmedData.startsWith('p01note:')) {
      console.log('[ZK Import] Importing p01note format');
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
      console.log('[ZK Import] Importing single recipient note (extension format)');
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
    console.log(`[ZK Import] Max leaf index in import: ${maxLeafIndex}, current tree size: ${this.merkleTree.leafCount}`);

    // If we need more leaves, sync from blockchain first
    if (maxLeafIndex >= this.merkleTree.leafCount) {
      console.log('[ZK Import] Need to sync from blockchain to get commitments up to index', maxLeafIndex);
      try {
        await this.syncFromBlockchain();
        console.log('[ZK Import] Sync complete, tree now has', this.merkleTree.leafCount, 'leaves');
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

        // Verify commitment matches computed value
        const computedCommitment = poseidonHash(
          note.amount,
          note.ownerPubkey,
          note.randomness,
          note.tokenMint
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
            console.log(`[ZK Import] Verified commitment at claimed index ${note.leafIndex}`);
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
            console.log(`[ZK Import] Found commitment in tree at index ${foundIndex} (claimed: ${note.leafIndex})`);
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

    console.log(`[ZK Import] Imported ${imported} notes, skipped ${skipped}`);
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
    console.log('[ZK] Cleared all notes. Tree remains with', this.merkleTree.leafCount, 'leaves');
  }

  /**
   * Reset service
   */
  async reset(): Promise<void> {
    this.spendingKey = null;
    this.spendingKeyHash = null;
    this.ownerPubkey = null;
    this.viewingKey = null;
    this.notes = [];
    this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
    this.isInitialized = false;

    // Clean up prover
    this.prover.terminate();
    this.prover = new ClientProver();

    await chrome.storage.local.remove(['zk_notes', 'zk_tree_leaves', 'zk_last_scan_signature']);
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
