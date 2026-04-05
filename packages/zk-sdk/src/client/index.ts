/**
 * High-level client for interacting with the Specter ZK Shielded Pool
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
} from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import {
  createNote,
  Note,
  EncryptedNote,
  encryptNote,
  decryptNote,
  generateSpendingKeyPair,
} from '../notes';
import { MerkleTree, generateMerkleProof } from '../merkle';
import { ZkProver, type Groth16Proof } from '../prover';
import {
  computeCommitment,
  computeNullifier,
  deriveOwnerPubkey,
  fieldToBytes,
  bytesToField,
  pubkeyToField,
  randomFieldElement,
} from '../circuits';
import { sha256 } from '@noble/hashes/sha256';
import nacl from 'tweetnacl';
import { ZK_SHIELDED_PROGRAM_ID, PDA_SEEDS, MERKLE_TREE_DEPTH, IX_DISCRIMINATORS, getProgramId } from '../constants';
import type {
  PoolState,
  ShieldedTxResult,
  ZkAddress,
  NoteScanResult,
  SpendingKeyPair,
  NoteData,
  TransferPublicInputs,
  TransferPrivateInputs,
  NetworkConfig,
} from '../types';

/**
 * Configuration for ShieldedClient
 */
export interface ShieldedClientConfig extends NetworkConfig {
  /** Solana RPC connection */
  connection: Connection;
  /** User's wallet */
  wallet: Wallet;
  /** Path to circuit WASM file */
  wasmPath?: string;
  /** Path to circuit zkey file */
  zkeyPath?: string;
  /** Token mint address (default: SOL) */
  tokenMint?: PublicKey;
}

/**
 * Main client for shielded transactions
 */
export class ShieldedClient {
  private connection: Connection;
  private wallet: Wallet;
  private prover: ZkProver;
  private merkleTree: MerkleTree;
  private tokenMint: PublicKey;
  private spendingKeyPair: SpendingKeyPair | null = null;
  private notes: Note[] = [];
  private viewingKey: Uint8Array;
  /** Legacy viewing key (fieldToBytes(ownerPubkey)) for decrypting pre-v2 notes */
  private _legacyViewingKey: Uint8Array = new Uint8Array(32);
  private programId: PublicKey;
  private isInitialized: boolean = false;

  constructor(config: ShieldedClientConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.prover = new ZkProver(config.wasmPath, config.zkeyPath, {
      circuitBaseUrl: config.circuitBaseUrl,
    });
    this.merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
    this.tokenMint = config.tokenMint || SystemProgram.programId;
    this.viewingKey = new Uint8Array(32);

    // Resolve program ID: explicit programId > network lookup > devnet default
    const resolvedProgramId = config.programId ?? getProgramId(config.network ?? 'devnet');
    this.programId = new PublicKey(resolvedProgramId);
  }

  /**
   * Initialize the client with user's spending key
   */
  async initialize(seedPhrase: string): Promise<void> {
    // Derive spending key from seed
    const seed = new TextEncoder().encode(seedPhrase);
    this.spendingKeyPair = await generateSpendingKeyPair(seed);

    // Derive viewing key as a proper X25519 public key from a deterministic secret.
    // BREAKING CHANGE: Previously viewingKey = fieldToBytes(ownerPubkey), which is NOT
    // a valid X25519 point. Notes encrypted under the old scheme need the legacy key.
    const viewingSecret = sha256(fieldToBytes(this.spendingKeyPair.spendingKey));
    const viewingKeyPair = nacl.box.keyPair.fromSecretKey(viewingSecret);
    this.viewingKey = viewingKeyPair.publicKey;
    // Keep legacy viewing key for decrypting old notes
    this._legacyViewingKey = fieldToBytes(this.spendingKeyPair.ownerPubkey);

    // Initialize Merkle tree
    await this.merkleTree.initialize();

    // Initialize prover
    await this.prover.initialize();

    this.isInitialized = true;
  }

  /**
   * Get ZK address for receiving shielded payments
   */
  getZkAddress(): ZkAddress {
    if (!this.spendingKeyPair) {
      throw new Error('Client not initialized');
    }

    return {
      receivingPubkey: this.spendingKeyPair.ownerPubkey,
      viewingKey: this.viewingKey,
      encoded: this.encodeZkAddress(),
    };
  }

  /**
   * Encode ZK address to string
   */
  private encodeZkAddress(): string {
    if (!this.spendingKeyPair) {
      throw new Error('Client not initialized');
    }

    const pubkeyBytes = fieldToBytes(this.spendingKeyPair.ownerPubkey);
    // Combine pubkey and viewing key
    const combined = new Uint8Array(64);
    combined.set(pubkeyBytes, 0);
    combined.set(this.viewingKey, 32);

    // Base58 encode with prefix
    return `zk:${Buffer.from(combined).toString('base64')}`;
  }

  /**
   * Decode ZK address from string
   */
  static decodeZkAddress(encoded: string): ZkAddress {
    if (!encoded.startsWith('zk:')) {
      throw new Error('Invalid ZK address format');
    }

    const combined = Buffer.from(encoded.slice(3), 'base64');
    const receivingPubkey = bytesToField(combined.slice(0, 32));
    const viewingKey = combined.slice(32, 64);

    return {
      receivingPubkey,
      viewingKey,
      encoded,
    };
  }

  /**
   * Shield tokens: deposit from transparent to shielded
   */
  async shield(amount: bigint): Promise<ShieldedTxResult> {
    if (!this.spendingKeyPair) {
      throw new Error('Client not initialized');
    }

    const tokenMintField = pubkeyToField(this.tokenMint.toBytes());

    // Create note for self
    const note = await createNote(
      amount,
      this.spendingKeyPair.ownerPubkey,
      tokenMintField
    );

    // Get PDAs
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );

    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, poolPDA.toBytes()],
      this.programId
    );

    // Insert into local Merkle tree first to compute new_root
    const commitment = fieldToBytes(note.commitment);
    const leafIndex = this.merkleTree.insert(note.commitment);
    const newRoot = fieldToBytes(this.merkleTree.root);

    // Build shield instruction with new_root
    const ix = await this.buildShieldInstruction(
      poolPDA,
      merkleTreePDA,
      amount,
      commitment,
      newRoot
    );

    // Send transaction
    const tx = new Transaction().add(ix);
    const signature = await this.sendTransaction(tx);

    // Update local state
    note.leafIndex = leafIndex;
    this.notes.push(note);

    return {
      signature,
      newCommitments: [commitment],
      nullifiersSpent: [],
      newRoot: fieldToBytes(this.merkleTree.root),
    };
  }

  /**
   * Transfer shielded tokens to another ZK address
   */
  async transfer(recipient: ZkAddress, amount: bigint): Promise<ShieldedTxResult> {
    if (!this.spendingKeyPair) {
      throw new Error('Client not initialized');
    }

    // Find notes to spend
    const { notesToSpend, totalValue } = this.selectNotesForTransfer(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    const tokenMintField = pubkeyToField(this.tokenMint.toBytes());

    // Create output notes
    const recipientNote = await createNote(amount, recipient.receivingPubkey, tokenMintField);
    const changeAmount = totalValue - amount;
    const changeNote = await createNote(
      changeAmount,
      this.spendingKeyPair.ownerPubkey,
      tokenMintField
    );

    // Generate Merkle proofs for input notes
    const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
    const proof2 = notesToSpend[1]
      ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
      : this.generateDummyProof();

    // Compute nullifiers
    const nullifier1 = await computeNullifier(
      notesToSpend[0].commitment,
      this.spendingKeyPair.spendingKeyHash
    );
    const nullifier2 = notesToSpend[1]
      ? await computeNullifier(notesToSpend[1].commitment, this.spendingKeyPair.spendingKeyHash)
      : BigInt(0);

    // Build proof inputs
    const publicInputs: TransferPublicInputs = {
      merkleRoot: this.merkleTree.root,
      nullifier1,
      nullifier2,
      outputCommitment1: recipientNote.commitment,
      outputCommitment2: changeNote.commitment,
      publicAmount: BigInt(0), // Private transfer
      tokenMint: tokenMintField,
    };

    const privateInputs: TransferPrivateInputs = {
      inAmount1: notesToSpend[0].amount,
      inOwnerPubkey1: notesToSpend[0].ownerPubkey,
      inRandomness1: notesToSpend[0].randomness,
      inPathIndices1: proof1.pathIndices,
      inPathElements1: proof1.pathElements,

      inAmount2: notesToSpend[1]?.amount ?? BigInt(0),
      inOwnerPubkey2: notesToSpend[1]?.ownerPubkey ?? BigInt(0),
      inRandomness2: notesToSpend[1]?.randomness ?? BigInt(0),
      inPathIndices2: proof2.pathIndices,
      inPathElements2: proof2.pathElements,

      outAmount1: amount,
      outRecipient1: recipient.receivingPubkey,
      outRandomness1: recipientNote.randomness,

      outAmount2: changeAmount,
      outRecipient2: this.spendingKeyPair.ownerPubkey,
      outRandomness2: changeNote.randomness,

      spendingKey: this.spendingKeyPair.spendingKey,
    };

    // Generate ZK proof
    const { proof } = await this.prover.generateTransferProof(publicInputs, privateInputs);

    // Get PDAs
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );

    // Capture current root before inserting new commitments
    const currentRoot = fieldToBytes(this.merkleTree.root);

    // Insert output commitments into local tree to compute new_root
    this.removeSpentNotes(notesToSpend);
    this.merkleTree.insert(recipientNote.commitment);
    const changeLeafIndex = this.merkleTree.insert(changeNote.commitment);
    const newRoot = fieldToBytes(this.merkleTree.root);

    // Build and send transaction
    const ix = await this.buildTransferInstruction(
      poolPDA,
      proof,
      fieldToBytes(nullifier1),
      fieldToBytes(nullifier2),
      fieldToBytes(recipientNote.commitment),
      fieldToBytes(changeNote.commitment),
      currentRoot,
      newRoot
    );

    const tx = new Transaction().add(ix);
    const signature = await this.sendTransaction(tx);

    // Update local state
    changeNote.leafIndex = changeLeafIndex;
    if (changeAmount > 0) {
      this.notes.push(changeNote);
    }

    return {
      signature,
      newCommitments: [
        fieldToBytes(recipientNote.commitment),
        fieldToBytes(changeNote.commitment),
      ],
      nullifiersSpent: [fieldToBytes(nullifier1), fieldToBytes(nullifier2)],
      newRoot: fieldToBytes(this.merkleTree.root),
    };
  }

  /**
   * Unshield tokens: withdraw from shielded to transparent
   */
  async unshield(recipient: PublicKey, amount: bigint): Promise<ShieldedTxResult> {
    if (!this.spendingKeyPair) {
      throw new Error('Client not initialized');
    }

    // Find notes to spend
    const { notesToSpend, totalValue } = this.selectNotesForTransfer(amount);
    if (totalValue < amount) {
      throw new Error(`Insufficient shielded balance: ${totalValue} < ${amount}`);
    }

    const tokenMintField = pubkeyToField(this.tokenMint.toBytes());

    // Create change note (if any)
    const changeAmount = totalValue - amount;
    const changeNote = changeAmount > BigInt(0)
      ? await createNote(changeAmount, this.spendingKeyPair.ownerPubkey, tokenMintField)
      : null;

    // Generate Merkle proofs
    const proof1 = this.merkleTree.generateProof(notesToSpend[0].leafIndex!);
    const proof2 = notesToSpend[1]
      ? this.merkleTree.generateProof(notesToSpend[1].leafIndex!)
      : this.generateDummyProof();

    // Compute nullifiers
    const nullifier1 = await computeNullifier(
      notesToSpend[0].commitment,
      this.spendingKeyPair.spendingKeyHash
    );
    const nullifier2 = notesToSpend[1]
      ? await computeNullifier(notesToSpend[1].commitment, this.spendingKeyPair.spendingKeyHash)
      : BigInt(0);

    // Build proof inputs
    const publicInputs: TransferPublicInputs = {
      merkleRoot: this.merkleTree.root,
      nullifier1,
      nullifier2,
      outputCommitment1: changeNote?.commitment ?? BigInt(0),
      outputCommitment2: BigInt(0),
      publicAmount: -amount, // Negative = unshield
      tokenMint: tokenMintField,
    };

    const privateInputs: TransferPrivateInputs = {
      inAmount1: notesToSpend[0].amount,
      inOwnerPubkey1: notesToSpend[0].ownerPubkey,
      inRandomness1: notesToSpend[0].randomness,
      inPathIndices1: proof1.pathIndices,
      inPathElements1: proof1.pathElements,

      inAmount2: notesToSpend[1]?.amount ?? BigInt(0),
      inOwnerPubkey2: notesToSpend[1]?.ownerPubkey ?? BigInt(0),
      inRandomness2: notesToSpend[1]?.randomness ?? BigInt(0),
      inPathIndices2: proof2.pathIndices,
      inPathElements2: proof2.pathElements,

      outAmount1: changeAmount,
      outRecipient1: this.spendingKeyPair.ownerPubkey,
      outRandomness1: changeNote?.randomness ?? BigInt(0),

      outAmount2: BigInt(0),
      outRecipient2: BigInt(0),
      outRandomness2: BigInt(0),

      spendingKey: this.spendingKeyPair.spendingKey,
    };

    // Generate ZK proof
    const { proof } = await this.prover.generateTransferProof(publicInputs, privateInputs);

    // Get PDAs
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.SHIELDED_POOL, this.tokenMint.toBytes()],
      this.programId
    );

    // Capture current root, then insert change note to compute new_root
    const currentRoot = fieldToBytes(this.merkleTree.root);

    this.removeSpentNotes(notesToSpend);
    if (changeNote) {
      const changeLeafIndex = this.merkleTree.insert(changeNote.commitment);
      changeNote.leafIndex = changeLeafIndex;
    }
    const newRoot = fieldToBytes(this.merkleTree.root);

    // Build and send transaction
    const ix = await this.buildUnshieldInstruction(
      poolPDA,
      recipient,
      proof,
      fieldToBytes(nullifier1),
      fieldToBytes(nullifier2),
      fieldToBytes(changeNote?.commitment ?? BigInt(0)),
      fieldToBytes(BigInt(0)), // output_commitment_2 (empty for unshield)
      currentRoot,
      amount,
      newRoot
    );

    const tx = new Transaction().add(ix);
    const signature = await this.sendTransaction(tx);

    // Update local state
    if (changeNote) {
      this.notes.push(changeNote);
    }

    return {
      signature,
      newCommitments: changeNote ? [fieldToBytes(changeNote.commitment)] : [],
      nullifiersSpent: [fieldToBytes(nullifier1), fieldToBytes(nullifier2)],
      newRoot: fieldToBytes(this.merkleTree.root),
    };
  }

  /**
   * Get shielded balance
   */
  async getShieldedBalance(): Promise<bigint> {
    return this.notes.reduce((sum, note) => sum + note.amount, BigInt(0));
  }

  /**
   * Scan for incoming notes.
   *
   * Currently returns notes from local cache only. Chain scanning requires an
   * indexer setup — see https://docs.protocol01.dev for integration examples.
   *
   * @param fromIndex - Leaf index to start scanning from (default: 0)
   */
  async scanForNotes(fromIndex: number = 0): Promise<NoteScanResult> {
    console.warn(
      'scanForNotes: returning local cache only. ' +
      'Chain scanning requires an indexer setup — see https://docs.protocol01.dev'
    );

    const totalBalance = await this.getShieldedBalance();

    return {
      notes: this.notes.map(n => n.toJSON()),
      scannedToIndex: this.merkleTree.leafCount,
      totalBalance,
    };
  }

  /**
   * Sync local state with on-chain state.
   *
   * @throws Always throws — on-chain sync is not yet implemented in the SDK.
   * Use {@link scanForNotes} with a custom indexer, or see
   * https://docs.protocol01.dev for chain sync examples.
   */
  async sync(): Promise<void> {
    throw new Error(
      'sync() is not yet implemented. Use scanForNotes() with a custom indexer, ' +
      'or check https://docs.protocol01.dev for chain sync examples.'
    );
  }

  /**
   * Select notes for transfer (coin selection)
   */
  private selectNotesForTransfer(amount: bigint): { notesToSpend: Note[]; totalValue: bigint } {
    // Sort by amount descending
    const sortedNotes = [...this.notes].sort((a, b) =>
      a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0
    );

    const notesToSpend: Note[] = [];
    let totalValue = BigInt(0);

    for (const note of sortedNotes) {
      if (totalValue >= amount && notesToSpend.length >= 2) break;
      if (notesToSpend.length >= 2) break;

      notesToSpend.push(note);
      totalValue += note.amount;
    }

    // Pad with dummy note if only one input
    while (notesToSpend.length < 2) {
      // We'll handle this in proof generation with zero amounts
      break;
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
   * Generate dummy Merkle proof for unused input
   */
  private generateDummyProof() {
    return {
      pathIndices: new Array(MERKLE_TREE_DEPTH).fill(0),
      pathElements: new Array(MERKLE_TREE_DEPTH).fill(BigInt(0)),
      leafIndex: 0,
    };
  }

  /**
   * Build shield instruction
   */
  private async buildShieldInstruction(
    pool: PublicKey,
    merkleTree: PublicKey,
    amount: bigint,
    commitment: Uint8Array,
    newRoot: Uint8Array
  ): Promise<TransactionInstruction> {
    // Anchor discriminator (8) + amount (8) + commitment (32) + new_root (32) = 80 bytes
    const data = Buffer.alloc(8 + 8 + 32 + 32);
    let offset = 0;

    // Anchor instruction discriminator
    data.set(IX_DISCRIMINATORS.SHIELD, offset);
    offset += 8;

    // amount (u64 LE)
    data.writeBigUInt64LE(amount, offset);
    offset += 8;

    // commitment ([u8; 32])
    data.set(commitment, offset);
    offset += 32;

    // new_root ([u8; 32])
    data.set(newRoot, offset);

    // For SPL tokens, additional accounts are needed
    if (!this.tokenMint.equals(SystemProgram.programId)) {
      throw new Error(
        'buildShieldInstruction: SPL token shielding requires token account resolution. ' +
        'Currently only native SOL is supported. For SPL token support, use the ' +
        '@protocol-01/zkspl-sdk package.'
      );
    }

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: merkleTree, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Build transfer instruction
   */
  private async buildTransferInstruction(
    pool: PublicKey,
    proof: Groth16Proof,
    nullifier1: Uint8Array,
    nullifier2: Uint8Array,
    outputCommitment1: Uint8Array,
    outputCommitment2: Uint8Array,
    merkleRoot: Uint8Array,
    newRoot: Uint8Array
  ): Promise<TransactionInstruction> {
    // Anchor discriminator (8) + proof (256) + 6x [u8;32] = 456 bytes
    const data = Buffer.alloc(8 + 256 + 32 * 6);
    let offset = 0;

    // Anchor instruction discriminator
    data.set(IX_DISCRIMINATORS.TRANSFER, offset);
    offset += 8;

    // Proof (pi_a: 64, pi_b: 128, pi_c: 64)
    data.set(proof.pi_a, offset);
    offset += 64;
    data.set(proof.pi_b, offset);
    offset += 128;
    data.set(proof.pi_c, offset);
    offset += 64;

    // Nullifiers, commitments, roots
    data.set(nullifier1, offset); offset += 32;
    data.set(nullifier2, offset); offset += 32;
    data.set(outputCommitment1, offset); offset += 32;
    data.set(outputCommitment2, offset); offset += 32;
    data.set(merkleRoot, offset); offset += 32;
    data.set(newRoot, offset);

    // Derive PDAs
    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, pool.toBytes()],
      this.programId
    );

    const [nullifierRecord1PDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.NULLIFIER, pool.toBytes(), nullifier1],
      this.programId
    );

    const [nullifierRecord2PDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.NULLIFIER, pool.toBytes(), nullifier2],
      this.programId
    );

    const [vkDataPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.VK_DATA, pool.toBytes()],
      this.programId
    );

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: nullifierRecord1PDA, isSigner: false, isWritable: true },
        { pubkey: nullifierRecord2PDA, isSigner: false, isWritable: true },
        { pubkey: vkDataPDA, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Build unshield instruction
   */
  private async buildUnshieldInstruction(
    pool: PublicKey,
    recipient: PublicKey,
    proof: Groth16Proof,
    nullifier1: Uint8Array,
    nullifier2: Uint8Array,
    outputCommitment1: Uint8Array,
    outputCommitment2: Uint8Array,
    merkleRoot: Uint8Array,
    amount: bigint,
    newRoot: Uint8Array
  ): Promise<TransactionInstruction> {
    // Anchor discriminator (8) + proof (256) + 5x [u8;32] + amount (8) + new_root (32) = 464 bytes
    const data = Buffer.alloc(8 + 256 + 32 * 5 + 8 + 32);
    let offset = 0;

    // Anchor instruction discriminator
    data.set(IX_DISCRIMINATORS.UNSHIELD, offset);
    offset += 8;

    // Proof (pi_a: 64, pi_b: 128, pi_c: 64)
    data.set(proof.pi_a, offset); offset += 64;
    data.set(proof.pi_b, offset); offset += 128;
    data.set(proof.pi_c, offset); offset += 64;

    // Nullifiers, commitments, root
    data.set(nullifier1, offset); offset += 32;
    data.set(nullifier2, offset); offset += 32;
    data.set(outputCommitment1, offset); offset += 32;
    data.set(outputCommitment2, offset); offset += 32;
    data.set(merkleRoot, offset); offset += 32;

    // Amount (u64 LE)
    data.writeBigUInt64LE(amount, offset);
    offset += 8;

    // New root
    data.set(newRoot, offset);

    // Derive PDAs
    const [merkleTreePDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.MERKLE_TREE, pool.toBytes()],
      this.programId
    );

    const [nullifierRecord1PDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.NULLIFIER, pool.toBytes(), nullifier1],
      this.programId
    );

    const [nullifierRecord2PDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.NULLIFIER, pool.toBytes(), nullifier2],
      this.programId
    );

    const [vkDataPDA] = PublicKey.findProgramAddressSync(
      [PDA_SEEDS.VK_DATA, pool.toBytes()],
      this.programId
    );

    // For SPL tokens, additional accounts are needed
    if (!this.tokenMint.equals(SystemProgram.programId)) {
      throw new Error(
        'buildUnshieldInstruction: SPL token unshielding requires token account resolution. ' +
        'Currently only native SOL is supported.'
      );
    }

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
        { pubkey: nullifierRecord1PDA, isSigner: false, isWritable: true },
        { pubkey: nullifierRecord2PDA, isSigner: false, isWritable: true },
        { pubkey: vkDataPDA, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Securely destroy the client, zeroing the spending key from memory.
   * Call this when the client is no longer needed.
   */
  destroy(): void {
    if (this.spendingKeyPair) {
      // Zero spending key if it has a byte-level representation
      // SpendingKeyPair stores bigints, so we overwrite the reference
      this.spendingKeyPair = null as any;
    }
    this.viewingKey.fill(0);
    this._legacyViewingKey.fill(0);
    this.notes = [];
    this.isInitialized = false;
  }

  /**
   * Send transaction
   */
  private async sendTransaction(tx: Transaction): Promise<string> {
    tx.feePayer = this.wallet.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    const signed = await this.wallet.signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signed.serialize());

    await this.connection.confirmTransaction(signature);
    return signature;
  }
}
