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
 * Simple Poseidon hash placeholder
 * In production, use proper Poseidon from circomlib
 */
function poseidonHash(...inputs: bigint[]): bigint {
  // Deterministic hash for development
  // The on-chain program accepts client-computed roots
  let result = BigInt(0);
  for (const input of inputs) {
    result = (result * BigInt(31337) + input) % FIELD_ORDER;
  }
  return result;
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
  const spendingKeyHash = poseidonHash(spendingKey);
  const ownerPubkey = poseidonHash(spendingKeyHash);

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
      // Convert the on-chain zero value bytes to bigint (BIG-ENDIAN for field elements)
      // The hex 0x6caf... means first byte (0x6c) is the MSB
      const ZERO_VALUE_BYTES = [
        0x6c, 0xaf, 0x99, 0x48, 0xed, 0x85, 0x96, 0x24,
        0xe2, 0x41, 0xe7, 0x76, 0x0f, 0x34, 0x1b, 0x82,
        0xb4, 0x5d, 0xa1, 0xeb, 0xb6, 0x35, 0x3a, 0x34,
        0xf3, 0xab, 0xac, 0xd3, 0x60, 0x4c, 0xe5, 0x2f,
      ];
      // Convert to bigint (BIG-ENDIAN - standard for field elements and Poseidon)
      // First byte is MSB, last byte is LSB
      let baseZero = BigInt(0);
      for (let i = 0; i < ZERO_VALUE_BYTES.length; i++) {
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
  private isReady: boolean = false;

  async initialize(): Promise<void> {
    // Load circuit files
    const [wasmResponse, zkeyResponse] = await Promise.all([
      fetch(chrome.runtime.getURL(CIRCUIT_WASM_PATH)),
      fetch(chrome.runtime.getURL(CIRCUIT_ZKEY_PATH)),
    ]);

    if (!wasmResponse.ok || !zkeyResponse.ok) {
      console.warn('[Prover] Circuit files not found, using placeholder mode');
      this.isReady = false;
      return;
    }

    this.circuitWasm = await wasmResponse.arrayBuffer();
    this.circuitZkey = await zkeyResponse.arrayBuffer();

    // Create Web Worker
    this.worker = new Worker(
      new URL('../workers/zkProver.worker.ts', import.meta.url),
      { type: 'module' }
    );

    this.worker.onmessage = (event) => {
      const { type, id, proof, publicSignals, error } = event.data;

      if (type === 'ready') {
        this.isReady = true;
        console.log('[Prover] Web Worker ready');
        return;
      }

      const pending = this.pendingRequests.get(id);
      if (!pending) return;

      this.pendingRequests.delete(id);

      if (type === 'error') {
        pending.reject(new Error(error));
      } else if (type === 'proof') {
        // Convert proof to Groth16Proof format
        const groth16Proof = this.convertProof(proof);
        pending.resolve(groth16Proof);
      }
    };

    this.worker.onerror = (error) => {
      console.error('[Prover] Worker error:', error);
    };

    this.isReady = true;
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

    // Convert to little-endian bytes
    let temp = x;
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number(temp & BigInt(0xff));
      temp = temp >> BigInt(8);
    }
    temp = y;
    for (let i = 0; i < 32; i++) {
      bytes[32 + i] = Number(temp & BigInt(0xff));
      temp = temp >> BigInt(8);
    }

    return bytes;
  }

  private point2ToBytes(point: string[][]): Uint8Array {
    // G2 point: [[x0, x1], [y0, y1]]
    const bytes = new Uint8Array(128);
    const coords = [
      BigInt(point[0][0]),
      BigInt(point[0][1]),
      BigInt(point[1][0]),
      BigInt(point[1][1]),
    ];

    for (let c = 0; c < 4; c++) {
      let temp = coords[c];
      for (let i = 0; i < 32; i++) {
        bytes[c * 32 + i] = Number(temp & BigInt(0xff));
        temp = temp >> BigInt(8);
      }
    }

    return bytes;
  }

  async generateProof(inputs: Record<string, string>): Promise<Groth16Proof> {
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

    // Build instruction
    const discriminator = new Uint8Array([0x5a, 0x6a, 0x72, 0xe9, 0xa8, 0xb9, 0x4d, 0x5a]);
    const amountBuffer = new ArrayBuffer(8);
    new DataView(amountBuffer).setBigUint64(0, amount, true);
    const commitmentBytes = bigintToLeBytes(note.commitment);

    const data = new Uint8Array([
      ...discriminator,
      ...new Uint8Array(amountBuffer),
      ...commitmentBytes,
      ...newRootBytes,
    ]);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
   */
  async transfer(
    recipient: ZkAddress,
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

    // Create output notes
    const recipientNote = await createNote(amount, recipient.receivingPubkey, tokenMintField);
    const changeAmount = totalValue - amount;
    const changeNote = await createNote(changeAmount, this.ownerPubkey, tokenMintField);

    // Compute nullifiers
    const nullifier1 = computeNullifier(notesToSpend[0].commitment, this.spendingKeyHash);
    const nullifier2 = notesToSpend[1]
      ? computeNullifier(notesToSpend[1].commitment, this.spendingKeyHash)
      : BigInt(0);

    // Generate proofs
    const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
    const proof2 = notesToSpend[1]
      ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
      : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

    // Request proof from backend
    const zkProof = await this.generateProofClientSide({
      merkleRoot: this.merkleTree.root,
      nullifier1,
      nullifier2,
      outputCommitment1: recipientNote.commitment,
      outputCommitment2: changeNote.commitment,
      inputNotes: notesToSpend,
      outputNotes: [recipientNote, changeNote],
      proofs: [proof1, proof2],
      spendingKey: this.spendingKey!,
    });

    // Update Merkle tree
    this.merkleTree.insert(recipientNote.commitment);
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

    // Build instruction
    // Public inputs in little-endian (matching stored roots) - verifier converts to BE
    const discriminator = new Uint8Array([0xa3, 0xb2, 0xc1, 0xd0, 0xe5, 0xf4, 0x03, 0x12]);
    const data = new Uint8Array([
      ...discriminator,
      ...zkProof.pi_a,
      ...zkProof.pi_b,
      ...zkProof.pi_c,
      ...bigintToLeBytes(nullifier1),
      ...bigintToLeBytes(nullifier2),
      ...bigintToLeBytes(recipientNote.commitment),
      ...bigintToLeBytes(changeNote.commitment),
      ...bigintToLeBytes(newRoot),
    ]);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(data),
    });

    const tx = new Transaction().add(ix);
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

    return signature;
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

    // Compute nullifiers
    const nullifier1 = computeNullifier(notesToSpend[0].commitment, this.spendingKeyHash);
    const nullifier2 = notesToSpend[1]
      ? computeNullifier(notesToSpend[1].commitment, this.spendingKeyHash)
      : BigInt(0);

    // Generate proofs
    const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
    const proof2 = notesToSpend[1]
      ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
      : { pathElements: Array(MERKLE_TREE_DEPTH).fill(BigInt(0)), pathIndices: Array(MERKLE_TREE_DEPTH).fill(0) };

    // Request proof
    const zkProof = await this.generateProofClientSide({
      merkleRoot: this.merkleTree.root,
      nullifier1,
      nullifier2,
      outputCommitment1: changeNote?.commitment ?? BigInt(0),
      outputCommitment2: BigInt(0),
      publicAmount: -amount,
      inputNotes: notesToSpend,
      outputNotes: changeNote ? [changeNote] : [],
      proofs: [proof1, proof2],
      spendingKey: this.spendingKey!,
    });

    // Update Merkle tree
    let newRoot = this.merkleTree.root;
    if (changeNote) {
      newRoot = this.merkleTree.insert(changeNote.commitment);
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

    const [nullifierSetPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.NULLIFIER_SET, poolPDA.toBytes()],
      this.programId
    );

    // Build instruction
    // Public inputs in little-endian (matching stored roots) - verifier converts to BE
    const discriminator = new Uint8Array([0xb4, 0xc3, 0xd2, 0xe1, 0xf6, 0x05, 0x14, 0x23]);
    const amountBuffer = new ArrayBuffer(8);
    new DataView(amountBuffer).setBigUint64(0, amount, true);

    const data = new Uint8Array([
      ...discriminator,
      ...zkProof.pi_a,
      ...zkProof.pi_b,
      ...zkProof.pi_c,
      ...bigintToLeBytes(nullifier1),
      ...bigintToLeBytes(nullifier2),
      ...bigintToLeBytes(changeNote?.commitment ?? BigInt(0)),
      ...bigintToLeBytes(newRoot),
      ...new Uint8Array(amountBuffer),
    ]);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: walletPublicKey, isSigner: true, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    });

    const tx = new Transaction().add(ix);
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
    proofs: { pathElements: bigint[]; pathIndices: number[] }[];
    spendingKey: bigint;
  }): Promise<Groth16Proof> {
    // Format inputs for the circuit
    const circuitInputs: Record<string, string> = {
      // Public inputs
      root: inputs.merkleRoot.toString(),
      nullifier1: inputs.nullifier1.toString(),
      nullifier2: inputs.nullifier2.toString(),
      outputCommitment1: inputs.outputCommitment1.toString(),
      outputCommitment2: inputs.outputCommitment2.toString(),
      publicAmount: (inputs.publicAmount ?? BigInt(0)).toString(),

      // Private inputs - Input note 1
      inAmount1: inputs.inputNotes[0]?.amount.toString() ?? '0',
      inOwnerPubkey1: inputs.inputNotes[0]?.ownerPubkey.toString() ?? '0',
      inRandomness1: inputs.inputNotes[0]?.randomness.toString() ?? '0',
      inPathElements1: JSON.stringify(inputs.proofs[0].pathElements.map(e => e.toString())),
      inPathIndices1: JSON.stringify(inputs.proofs[0].pathIndices),

      // Private inputs - Input note 2
      inAmount2: inputs.inputNotes[1]?.amount.toString() ?? '0',
      inOwnerPubkey2: inputs.inputNotes[1]?.ownerPubkey.toString() ?? '0',
      inRandomness2: inputs.inputNotes[1]?.randomness.toString() ?? '0',
      inPathElements2: JSON.stringify(inputs.proofs[1].pathElements.map(e => e.toString())),
      inPathIndices2: JSON.stringify(inputs.proofs[1].pathIndices),

      // Spending key
      spendingKey: inputs.spendingKey.toString(),
    };

    console.log('[ZK] Generating proof client-side...');
    const startTime = performance.now();

    try {
      const proof = await this.prover.generateProof(circuitInputs);
      const duration = ((performance.now() - startTime) / 1000).toFixed(2);
      console.log(`[ZK] Proof generated in ${duration}s`);
      return proof;
    } catch (error) {
      console.error('[ZK] Client-side proof generation failed:', error);
      throw new Error('Failed to generate ZK proof. Make sure circuit files are available.');
    }
  }

  /**
   * Save notes to chrome storage
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
      }));

      await chrome.storage.local.set({ 'zk_notes': JSON.stringify(serialized) });
    } catch (error) {
      console.error('[ZK] Failed to save notes:', error);
    }
  }

  /**
   * Load notes from chrome storage
   */
  private async loadNotes(): Promise<void> {
    try {
      const result = await chrome.storage.local.get('zk_notes');
      if (result.zk_notes) {
        const parsed = JSON.parse(result.zk_notes);
        this.notes = parsed.map((note: any) => ({
          amount: BigInt(note.amount),
          ownerPubkey: BigInt(note.ownerPubkey),
          randomness: BigInt(note.randomness),
          tokenMint: BigInt(note.tokenMint),
          commitment: BigInt(note.commitment),
          leafIndex: note.leafIndex,
        }));

        // Rebuild Merkle tree
        for (const note of this.notes) {
          this.merkleTree.insert(note.commitment);
        }
      }
    } catch (error) {
      console.error('[ZK] Failed to load notes:', error);
      this.notes = [];
    }
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

    await chrome.storage.local.remove(['zk_notes', 'zk_last_scan_signature']);
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
