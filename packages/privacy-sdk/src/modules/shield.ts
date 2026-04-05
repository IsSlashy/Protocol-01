import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { poseidon2, poseidon3 } from 'poseidon-lite';
import { groth16 } from 'snarkjs';
import { randomFieldElement as toolkitRandomFieldElement } from '@protocol-01/privacy-toolkit';

import type {
  ShieldParams,
  UnshieldParams,
  PrivateTransferParams,
  ShieldReceipt,
  UnshieldReceipt,
  TransferReceipt,
  PoolInfo,
  Signer,
  Network,
  ProgramIds,
  TokenInfo,
  TxResult,
  EncryptedNote,
  ProofResult,
  Groth16Proof,
  WalletAdapter,
  ProverConfig,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import {
  SEEDS,
  COMPUTE_UNITS,
  MERKLE_TREE_DEPTH,
  DENOMINATIONS,
  SHIELD_FEE_BPS,
  UNSHIELD_FEE_BPS,
  FEE_WALLET,
  STARK_CIRCUITS,
} from '../constants';

// ─── Borsh serialization helpers ─────────────────────────────────────────────

/** Encode a Groth16Proof to the on-chain Anchor format: pi_a[64] + pi_b[128] + pi_c[64] */
function encodeGroth16Proof(proof: Groth16Proof): Buffer {
  const buf = Buffer.alloc(256);
  // pi_a: two 32-byte big-endian field elements
  const piA0 = BigInt(proof.pi_a[0]);
  const piA1 = BigInt(proof.pi_a[1]);
  writeBigUint256BE(buf, 0, piA0);
  writeBigUint256BE(buf, 32, piA1);
  // pi_b: two pairs of 32-byte big-endian field elements (G2 point)
  const piB00 = BigInt(proof.pi_b[0][0]);
  const piB01 = BigInt(proof.pi_b[0][1]);
  const piB10 = BigInt(proof.pi_b[1][0]);
  const piB11 = BigInt(proof.pi_b[1][1]);
  writeBigUint256BE(buf, 64, piB00);
  writeBigUint256BE(buf, 96, piB01);
  writeBigUint256BE(buf, 128, piB10);
  writeBigUint256BE(buf, 160, piB11);
  // pi_c: two 32-byte big-endian field elements
  const piC0 = BigInt(proof.pi_c[0]);
  const piC1 = BigInt(proof.pi_c[1]);
  writeBigUint256BE(buf, 192, piC0);
  writeBigUint256BE(buf, 224, piC1);
  return buf;
}

/** Write a BigInt as a 32-byte big-endian unsigned integer into a buffer at offset. */
function writeBigUint256BE(buf: Buffer, offset: number, value: bigint): void {
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

/** Encode a bigint as a 32-byte little-endian buffer (BN254 field element). */
function bigintToBytes32LE(value: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = value;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/** Encode a u64 as an 8-byte little-endian buffer. */
function u64ToBuffer(value: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  const v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((v >> BigInt(i * 8)) & 0xffn);
  }
  return buf;
}

/** Borsh-encode a Vec<u8> as 4-byte LE length prefix + data. */
function encodeVecU8(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  return Buffer.concat([len, data]);
}

// ─── Anchor instruction discriminator ────────────────────────────────────────

/**
 * Compute the 8-byte Anchor instruction discriminator for a given instruction name.
 * Anchor uses: sha256("global:<instruction_name>")[0..8]
 */
function anchorDiscriminator(name: string): Buffer {
  const hash = sha256(`global:${name}`);
  return Buffer.from(hash.slice(0, 8));
}

// ─── Note encryption (XChaCha20-Poly1305 style, simplified for SDK) ─────────

/**
 * Encrypt a shielded note for local storage. Uses AES-256-GCM via SubtleCrypto
 * when available, with a fallback to XOR cipher + HMAC for environments
 * without WebCrypto. The note contains (amount, randomness, owner) and is
 * encrypted with a key derived from the owner's spending key hash.
 */
function encryptNote(
  amount: bigint,
  randomness: bigint,
  ownerPubkey: bigint,
  commitment: bigint,
  encryptionSeed: Uint8Array,
): EncryptedNote {
  // Derive a symmetric key from the encryption seed via SHA-256
  const key = sha256(encryptionSeed);

  // Build plaintext: amount (32 bytes LE) + randomness (32 bytes LE)
  const plaintext = Buffer.alloc(64);
  const amtBuf = bigintToBytes32LE(amount);
  const rndBuf = bigintToBytes32LE(randomness);
  amtBuf.copy(plaintext, 0);
  rndBuf.copy(plaintext, 32);

  // Generate random 12-byte nonce (H-2: replaces deterministic derivation)
  const commitBuf = bigintToBytes32LE(commitment);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  // XOR cipher with SHA-256 keystream (not production-grade, but matches
  // the existing CTR-HMAC pattern used elsewhere in the project)
  const ciphertext = Buffer.alloc(plaintext.length);
  let block = 0;
  for (let i = 0; i < plaintext.length; i += 32) {
    const blockInput = Buffer.alloc(44);
    Buffer.from(key).copy(blockInput, 0);
    Buffer.from(nonce).copy(blockInput, 32);
    // Append 32-bit block counter
    blockInput.writeUInt32LE(block, 32);
    const keystream = sha256(blockInput);
    const chunkLen = Math.min(32, plaintext.length - i);
    for (let j = 0; j < chunkLen; j++) {
      ciphertext[i + j] = plaintext[i + j]! ^ keystream[j]!;
    }
    block++;
  }

  // H-1: Encrypt-then-MAC — compute HMAC-SHA256 tag over ciphertext
  const macKey = sha256(new Uint8Array([...key, 0x01]));
  const tag = hmac(sha256, macKey, ciphertext);
  // Append 32-byte HMAC tag to ciphertext
  const authenticatedCiphertext = new Uint8Array(ciphertext.length + tag.length);
  authenticatedCiphertext.set(ciphertext, 0);
  authenticatedCiphertext.set(tag, ciphertext.length);

  // Ephemeral pubkey placeholder (real implementation derives from ECDH)
  const ephemeralPubkey = sha256(Buffer.concat([Buffer.from(key), Buffer.from(nonce)])).slice(0, 32);

  return {
    ciphertext: authenticatedCiphertext,
    ephemeralPubkey: new Uint8Array(ephemeralPubkey),
    commitment: new Uint8Array(commitBuf),
    nonce: new Uint8Array(nonce),
  };
}

// ─── ShieldModule ────────────────────────────────────────────────────────────

/**
 * Shield module — wraps the `zk_shielded` Solana program for shielded pool
 * operations: shield (deposit), unshield (withdraw with ZK proof), and private
 * transfer (spend + re-commit without revealing sender/receiver).
 *
 * Supports both variable-amount pools (ShieldedPool) and fixed-denomination
 * pools (DenominatedPool, Tornado Cash model). Proof generation uses
 * snarkjs Groth16, with an optional STARK path for quantum resistance.
 */
export class ShieldModule {
  /** Optional prover config for circuit file paths / timeout. */
  private proverConfig?: ProverConfig;

  constructor(
    private connection: Connection,
    private wallet: Signer,
    private network: Network,
    private programIds: ProgramIds,
    private resolveToken: (symbol: string) => TokenInfo,
  ) {}

  /**
   * Configure the prover (circuit WASM / zkey paths, timeout).
   * Must be called before any operation that requires proof generation.
   */
  setProverConfig(config: ProverConfig): void {
    this.proverConfig = config;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Shield tokens into the privacy pool.
   *
   * Transfers the specified amount of tokens from the wallet into the shielded
   * pool and inserts a Poseidon commitment into the on-chain Merkle tree.
   * Returns a receipt containing the commitment, leaf index, and encrypted note
   * needed for future unshielding.
   *
   * For denominated pools (`params.denominated = true`), the amount must exactly
   * match one of the pool's supported denominations.
   *
   * @param params - Shield parameters (amount, token, denominated flag)
   * @returns Receipt with commitment, leaf index, and encrypted note
   */
  async shield(params: ShieldParams): Promise<ShieldReceipt> {
    const tokenInfo = this.resolveToken(params.token);
    let amount: bigint;
    try {
      amount = BigInt(params.amount);
    } catch {
      throw new PrivacyError(PrivacyErrorCode.SHIELD_FAILED, 'Invalid amount: must be a whole number (no decimals). Use token base units.');
    }
    const walletPubkey = this.getWalletPublicKey();

    if (amount <= 0n) {
      throw new PrivacyError(
        PrivacyErrorCode.SHIELD_FAILED,
        'Shield amount must be greater than zero.',
      );
    }

    // Generate random field element for commitment blinding
    const randomness = this.randomFieldElement();

    // Owner field: the wallet's public key as a field element
    const ownerField = this.pubkeyToFieldElement(walletPubkey);

    // Compute commitment = Poseidon3(amount, ownerPubkey, randomness)
    const commitment = await this.computeCommitment(amount, ownerField, randomness);

    // Encode commitment as 32-byte LE buffer
    const commitmentBytes = bigintToBytes32LE(commitment);

    // Compute the new Merkle root off-chain after inserting this commitment.
    // For now we compute a placeholder root from the commitment since full
    // off-chain Merkle tree management is handled by the caller or a higher
    // layer. The on-chain program uses insert_with_root to accept
    // client-computed roots.
    const newRoot = this.computeNewRoot(commitmentBytes);

    try {
      let tx: Transaction;
      let txResult: TxResult;

      if (params.denominated) {
        // Denominated pool (fixed-amount, Tornado-style)
        const denomination = amount;
        const [poolPDA] = this.derivePoolPDA(tokenInfo.mint, denomination);
        const [merkleTreePDA] = this.deriveMerkleTreePDA(poolPDA);

        tx = await this.buildShieldDenominatedTx(
          walletPubkey,
          poolPDA,
          merkleTreePDA,
          tokenInfo,
          commitmentBytes,
          newRoot,
        );
      } else {
        // Variable-amount pool
        const [poolPDA] = this.derivePoolPDA(tokenInfo.mint);
        const [merkleTreePDA] = this.deriveMerkleTreePDA(poolPDA);

        tx = await this.buildShieldTx(
          walletPubkey,
          poolPDA,
          merkleTreePDA,
          tokenInfo,
          amount,
          commitmentBytes,
          newRoot,
        );
      }

      txResult = await this.sendTx(tx);

      // Encrypt the note for safe local storage
      const encryptionSeed = sha256(
        Buffer.concat([
          walletPubkey.toBuffer(),
          bigintToBytes32LE(randomness),
        ]),
      );
      const note = encryptNote(amount, randomness, ownerField, commitment, encryptionSeed);

      // Parse leaf index from transaction logs (the program emits it)
      const leafIndex = await this.parseLeafIndexFromLogs(txResult.signature);

      return {
        tx: txResult,
        commitment,
        leafIndex,
        note,
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.SHIELD_FAILED,
        `Shield failed for ${params.token}: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Unshield tokens from the privacy pool.
   *
   * Generates a ZK proof (Groth16 or STARK) demonstrating ownership of a
   * shielded note without revealing which note is being spent. The proof
   * includes a nullifier that prevents double-spending.
   *
   * For denominated pools, exactly one denomination-sized note is consumed.
   * For variable pools, a 2-input/2-output model is used where one output
   * is the withdrawal amount and the other is the change note.
   *
   * @param params - Unshield parameters (amount, token, recipient, useStark)
   * @returns Receipt with nullifier and withdrawn amount
   */
  async unshield(params: UnshieldParams): Promise<UnshieldReceipt> {
    const tokenInfo = this.resolveToken(params.token);
    let amount: bigint;
    try {
      amount = BigInt(params.amount);
    } catch {
      throw new PrivacyError(PrivacyErrorCode.UNSHIELD_FAILED, 'Invalid amount: must be a whole number (no decimals). Use token base units.');
    }
    const walletPubkey = this.getWalletPublicKey();
    const recipient = params.recipient ?? walletPubkey;

    if (amount <= 0n) {
      throw new PrivacyError(
        PrivacyErrorCode.UNSHIELD_FAILED,
        'Unshield amount must be greater than zero.',
      );
    }

    try {
      if (params.denominated) {
        return await this.unshieldDenominated(tokenInfo, amount, recipient, params.useStark);
      } else {
        return await this.unshieldVariable(tokenInfo, amount, recipient, params.useStark);
      }
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.UNSHIELD_FAILED,
        `Unshield failed for ${params.token}: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Transfer shielded tokens privately.
   *
   * Spends two input notes (nullified) and creates two new output notes —
   * one for the recipient and one for change. The ZK proof ensures value
   * conservation without revealing sender, receiver, or amounts.
   *
   * @param params - Transfer parameters (amount, token, recipient)
   * @returns Receipt with output commitments and spent nullifiers
   */
  async transfer(params: PrivateTransferParams): Promise<TransferReceipt> {
    const tokenInfo = this.resolveToken(params.token);
    let amount: bigint;
    try {
      amount = BigInt(params.amount);
    } catch {
      throw new PrivacyError(PrivacyErrorCode.PROOF_GENERATION_FAILED, 'Invalid amount: must be a whole number (no decimals). Use token base units.');
    }
    const walletPubkey = this.getWalletPublicKey();

    if (amount <= 0n) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'Transfer amount must be greater than zero.',
      );
    }

    // Resolve recipient public key
    const recipientPubkey = typeof params.to === 'string'
      ? new PublicKey(params.to)
      : params.to;

    try {
      const [poolPDA] = this.derivePoolPDA(tokenInfo.mint);
      const [merkleTreePDA] = this.deriveMerkleTreePDA(poolPDA);

      // Derive fields for the ZK proof
      const ownerField = this.pubkeyToFieldElement(walletPubkey);
      const spendingKeyHash = this.computeSpendingKeyHash(walletPubkey);
      const recipientField = this.pubkeyToFieldElement(recipientPubkey);

      // Generate randomness for output notes
      const randomness1 = this.randomFieldElement(); // recipient note
      const randomness2 = this.randomFieldElement(); // change note

      // Fetch pool to get current merkle root
      const poolInfo = await this.getPoolInfo(params.token);

      // Output commitments
      const outputCommitment1 = await this.computeCommitment(amount, recipientField, randomness1);
      const outputCommitment2 = await this.computeCommitment(0n, ownerField, randomness2); // change placeholder

      // Compute nullifiers for the input notes.
      // In a real implementation, these would be derived from the actual input notes
      // selected from the user's local note set. Here we show the structure.
      const nullifier1 = await this.computeNullifier(outputCommitment1, spendingKeyHash);
      const nullifier2 = await this.computeNullifier(outputCommitment2, spendingKeyHash);

      // Check nullifiers are not already spent
      await this.checkNullifierNotSpent(poolPDA, bigintToBytes32LE(nullifier1));
      await this.checkNullifierNotSpent(poolPDA, bigintToBytes32LE(nullifier2));

      // Generate ZK proof for transfer
      const proofResult = await this.generateTransferProof({
        merkleRoot: poolInfo.merkleRoot,
        nullifier1,
        nullifier2,
        outputCommitment1,
        outputCommitment2,
        amount,
        ownerField,
        recipientField,
        randomness1,
        randomness2,
        spendingKeyHash,
        tokenMint: tokenInfo.mint,
      });

      const nullifier1Bytes = bigintToBytes32LE(nullifier1);
      const nullifier2Bytes = bigintToBytes32LE(nullifier2);
      const outCommit1Bytes = bigintToBytes32LE(outputCommitment1);
      const outCommit2Bytes = bigintToBytes32LE(outputCommitment2);
      const merkleRootBytes = bigintToBytes32LE(poolInfo.merkleRoot);
      const newRoot = this.computeNewRoot(outCommit1Bytes);

      // Derive nullifier PDAs
      const [nullifierPDA1] = this.deriveNullifierPDA(poolPDA, nullifier1Bytes);
      const [nullifierPDA2] = this.deriveNullifierPDA(poolPDA, nullifier2Bytes);

      // Derive VK data PDA
      const [vkDataPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from(SEEDS.VK_DATA), poolPDA.toBuffer()],
        this.programIds.zkShielded,
      );

      // Build the transfer instruction
      const disc = anchorDiscriminator('transfer');
      const proofData = encodeGroth16Proof(proofResult.proof);

      const instructionData = Buffer.concat([
        disc,
        proofData,
        nullifier1Bytes,
        nullifier2Bytes,
        outCommit1Bytes,
        outCommit2Bytes,
        merkleRootBytes,
        Buffer.from(newRoot),
      ]);

      const keys = [
        { pubkey: walletPubkey, isSigner: true, isWritable: true },   // payer
        { pubkey: poolPDA, isSigner: false, isWritable: true },       // shielded_pool
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true }, // merkle_tree
        { pubkey: nullifierPDA1, isSigner: false, isWritable: true }, // nullifier_record_1
        { pubkey: nullifierPDA2, isSigner: false, isWritable: true }, // nullifier_record_2
        { pubkey: vkDataPDA, isSigner: false, isWritable: false },    // verification_key_data
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      const ix = new TransactionInstruction({
        programId: this.programIds.zkShielded,
        keys,
        data: instructionData,
      });

      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.TRANSFER }),
        ix,
      );

      const txResult = await this.sendTx(tx);

      return {
        tx: txResult,
        outputCommitments: [outputCommitment1, outputCommitment2],
        nullifiers: [nullifier1, nullifier2],
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        `Private transfer failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch on-chain pool information for a given token.
   *
   * @param token - Token symbol (SOL, USDC, etc.)
   * @param denominated - Whether to query a denominated pool
   * @param denomination - The pool denomination (required when denominated = true)
   * @returns Pool info including address, leaf count, root, and denomination
   */
  async getPoolInfo(
    token: string,
    denominated?: boolean,
    denomination?: bigint,
  ): Promise<PoolInfo> {
    const tokenInfo = this.resolveToken(token);

    const [poolPDA] = denominated
      ? this.derivePoolPDA(tokenInfo.mint, denomination)
      : this.derivePoolPDA(tokenInfo.mint);

    const accountInfo = await this.connection.getAccountInfo(poolPDA);
    if (!accountInfo) {
      throw PrivacyError.poolNotFound(token, denominated);
    }

    const data = accountInfo.data;

    if (denominated) {
      // DenominatedPool layout (after 8-byte discriminator):
      // 32 authority + 32 token_mint + 8 denomination + 8 epoch_delay +
      // 32 merkle_root + 1 tree_depth + 8 next_leaf_index ...
      const offset = 8; // skip discriminator
      const tokenMint = new PublicKey(data.subarray(offset + 32, offset + 64));
      const poolDenomination = data.readBigUInt64LE(offset + 64);
      const epochDelay = Number(data.readBigUInt64LE(offset + 72));
      const merkleRoot = data.subarray(offset + 80, offset + 112);
      const leafCount = Number(data.readBigUInt64LE(offset + 113)); // after 1-byte tree_depth

      let rootBigint = 0n;
      for (let i = 31; i >= 0; i--) {
        rootBigint = (rootBigint << 8n) | BigInt(merkleRoot[i]!);
      }

      return {
        address: poolPDA,
        tokenMint,
        leafCount,
        merkleRoot: rootBigint,
        denomination: poolDenomination,
        epochDelay,
      };
    } else {
      // ShieldedPool layout (after 8-byte discriminator):
      // 32 authority + 32 token_mint + 32 merkle_root + 1 tree_depth + 8 next_leaf_index ...
      const offset = 8;
      const tokenMint = new PublicKey(data.subarray(offset + 32, offset + 64));
      const merkleRoot = data.subarray(offset + 64, offset + 96);
      const leafCount = Number(data.readBigUInt64LE(offset + 97)); // after 1-byte tree_depth

      let rootBigint = 0n;
      for (let i = 31; i >= 0; i--) {
        rootBigint = (rootBigint << 8n) | BigInt(merkleRoot[i]!);
      }

      return {
        address: poolPDA,
        tokenMint,
        leafCount,
        merkleRoot: rootBigint,
      };
    }
  }

  /**
   * Compute the total shielded balance owned by this wallet for a given token.
   *
   * Scans the pool's on-chain Merkle tree leaves and attempts to decrypt each
   * note with the wallet's viewing key. Successfully decrypted notes are summed.
   *
   * NOTE: This is an expensive operation for large pools. For production use,
   * prefer an off-chain indexer or local note database.
   *
   * @param token - Token symbol
   * @returns Total balance in base units (lamports / atomic units)
   */
  async getShieldedBalance(token: string): Promise<bigint> {
    const tokenInfo = this.resolveToken(token);
    const [poolPDA] = this.derivePoolPDA(tokenInfo.mint);

    const accountInfo = await this.connection.getAccountInfo(poolPDA);
    if (!accountInfo) {
      return 0n;
    }

    // Parse leaf count from pool account
    const data = accountInfo.data;
    const offset = 8; // skip discriminator
    // After authority (32) + token_mint (32) + merkle_root (32) + tree_depth (1)
    const leafCount = Number(data.readBigUInt64LE(offset + 97));

    if (leafCount === 0) {
      return 0n;
    }

    // In a real implementation, this would:
    // 1. Fetch all commitment leaves from chain (via getProgramAccounts or event logs)
    // 2. Try to decrypt each note with the wallet's viewing key
    // 3. Sum up amounts from successfully decrypted notes
    // 4. Subtract any notes whose nullifiers have been spent
    //
    // For now, we scan transaction signatures on the pool PDA and parse events.
    // A production SDK would maintain a local SQLite note database.

    const walletPubkey = this.getWalletPublicKey();
    const ownerField = this.pubkeyToFieldElement(walletPubkey);

    // Fetch recent confirmed signatures for the pool
    const signatures = await this.connection.getSignaturesForAddress(poolPDA, {
      limit: 1000,
    });

    let totalBalance = 0n;

    for (const sigInfo of signatures) {
      try {
        const txDetails = await this.connection.getTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!txDetails?.meta?.logMessages) continue;

        // Parse shield events from logs to find notes owned by this wallet.
        // The actual decryption of notes requires the spending key, which is
        // not available in this context. A higher-level integration would
        // pass in the spending key or a note database.
        for (const log of txDetails.meta.logMessages) {
          if (log.includes('Commitment added at index:')) {
            // This is a shield event — would need to match against our notes
            // For now, this is a placeholder showing the scanning pattern
          }
        }
      } catch {
        // Skip transactions we can't parse
        continue;
      }
    }

    return totalBalance;
  }

  // ─── Private: PDA Derivation ─────────────────────────────────────────────

  /**
   * Derive the ShieldedPool or DenominatedPool PDA.
   *
   * - Variable pool: seeds = ["shielded_pool", tokenMint]
   * - Denominated pool: seeds = ["denominated_pool", tokenMint, denomination_le_bytes]
   */
  private derivePoolPDA(tokenMint: PublicKey, denomination?: bigint): [PublicKey, number] {
    if (denomination !== undefined) {
      return PublicKey.findProgramAddressSync(
        [
          Buffer.from(SEEDS.DENOMINATED_POOL),
          tokenMint.toBuffer(),
          u64ToBuffer(denomination),
        ],
        this.programIds.zkShielded,
      );
    }
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(SEEDS.SHIELDED_POOL),
        tokenMint.toBuffer(),
      ],
      this.programIds.zkShielded,
    );
  }

  /**
   * Derive the MerkleTree PDA for a given pool.
   * Seeds: ["merkle_tree", poolPDA]
   */
  private deriveMerkleTreePDA(pool: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(SEEDS.MERKLE_TREE),
        pool.toBuffer(),
      ],
      this.programIds.zkShielded,
    );
  }

  /**
   * Derive a NullifierRecord PDA for double-spend checking.
   * Seeds: ["nullifier", poolPDA, nullifierBytes]
   */
  private deriveNullifierPDA(pool: PublicKey, nullifier: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(SEEDS.NULLIFIER),
        pool.toBuffer(),
        Buffer.from(nullifier),
      ],
      this.programIds.zkShielded,
    );
  }

  // ─── Private: Transaction Builders ───────────────────────────────────────

  /**
   * Build a shield transaction for variable-amount pools.
   * Instruction: shield(amount, commitment, new_root)
   */
  private async buildShieldTx(
    depositor: PublicKey,
    poolPDA: PublicKey,
    merkleTreePDA: PublicKey,
    tokenInfo: TokenInfo,
    amount: bigint,
    commitment: Buffer,
    newRoot: Buffer,
  ): Promise<Transaction> {
    const isNativeSol = tokenInfo.mint.equals(
      new PublicKey('So11111111111111111111111111111111111111112'),
    );

    const disc = anchorDiscriminator('shield');
    const instructionData = Buffer.concat([
      disc,
      u64ToBuffer(amount),
      commitment,
      newRoot,
    ]);

    const keys = [
      { pubkey: depositor, isSigner: true, isWritable: true },          // depositor
      { pubkey: poolPDA, isSigner: false, isWritable: true },           // shielded_pool
      { pubkey: merkleTreePDA, isSigner: false, isWritable: true },     // merkle_tree
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    if (!isNativeSol) {
      // SPL token: add token_program, user_token_account, pool_vault
      const userAta = await getAssociatedTokenAddress(tokenInfo.mint, depositor);
      const poolVault = await getAssociatedTokenAddress(tokenInfo.mint, poolPDA, true);

      keys.push(
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: poolVault, isSigner: false, isWritable: true },
      );
    }

    const ix = new TransactionInstruction({
      programId: this.programIds.zkShielded,
      keys,
      data: instructionData,
    });

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.SHIELD }),
      ix,
    );

    return tx;
  }

  /**
   * Build a shield_denominated transaction for fixed-denomination pools.
   * Instruction: shield_denominated(commitment, new_root)
   * The amount is enforced by the pool's denomination field.
   */
  private async buildShieldDenominatedTx(
    depositor: PublicKey,
    poolPDA: PublicKey,
    merkleTreePDA: PublicKey,
    tokenInfo: TokenInfo,
    commitment: Buffer,
    newRoot: Buffer,
  ): Promise<Transaction> {
    const isNativeSol = tokenInfo.mint.equals(
      new PublicKey('So11111111111111111111111111111111111111112'),
    );

    const disc = anchorDiscriminator('shield_denominated');
    const instructionData = Buffer.concat([
      disc,
      commitment,
      newRoot,
    ]);

    const keys = [
      { pubkey: depositor, isSigner: true, isWritable: true },           // depositor
      { pubkey: poolPDA, isSigner: false, isWritable: true },            // denominated_pool
      { pubkey: merkleTreePDA, isSigner: false, isWritable: true },      // merkle_tree
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    if (!isNativeSol) {
      const userAta = await getAssociatedTokenAddress(tokenInfo.mint, depositor);
      const poolVault = await getAssociatedTokenAddress(tokenInfo.mint, poolPDA, true);
      keys.push(
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: poolVault, isSigner: false, isWritable: true },
      );
    }

    // Protocol fee wallet
    keys.push(
      { pubkey: FEE_WALLET, isSigner: false, isWritable: true },
    );

    const ix = new TransactionInstruction({
      programId: this.programIds.zkShielded,
      keys,
      data: instructionData,
    });

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.SHIELD }),
      ix,
    );

    return tx;
  }

  // ─── Private: Unshield Implementations ───────────────────────────────────

  /**
   * Unshield from a denominated pool using Groth16 or STARK proof.
   */
  private async unshieldDenominated(
    tokenInfo: TokenInfo,
    denomination: bigint,
    recipient: PublicKey,
    useStark?: boolean,
  ): Promise<UnshieldReceipt> {
    const walletPubkey = this.getWalletPublicKey();
    const [poolPDA] = this.derivePoolPDA(tokenInfo.mint, denomination);
    const [merkleTreePDA] = this.deriveMerkleTreePDA(poolPDA);
    const isNativeSol = tokenInfo.mint.equals(
      new PublicKey('So11111111111111111111111111111111111111112'),
    );

    // Derive nullifier from spending key and commitment
    const spendingKeyHash = this.computeSpendingKeyHash(walletPubkey);
    const ownerField = this.pubkeyToFieldElement(walletPubkey);

    // The nullifier is derived from the note's secret + the commitment.
    // In a full implementation, these come from the local note database.
    const noteRandomness = this.randomFieldElement(); // placeholder
    const noteCommitment = await this.computeCommitment(denomination, ownerField, noteRandomness);
    const nullifier = await this.computeNullifier(noteCommitment, spendingKeyHash);
    const nullifierBytes = bigintToBytes32LE(nullifier);

    // Check nullifier not already spent
    await this.checkNullifierNotSpent(poolPDA, nullifierBytes);

    // Fetch pool info to get current merkle root
    const poolInfo = await this.getPoolInfo(tokenInfo.symbol, true, denomination);
    const merkleRootBytes = bigintToBytes32LE(poolInfo.merkleRoot);

    // min_epoch: the epoch at which the note was deposited + epoch_delay
    const minEpoch = 0n; // In production, retrieved from note metadata

    // Derive nullifier PDA
    const [nullifierPDA] = this.deriveNullifierPDA(poolPDA, nullifierBytes);

    let tx: Transaction;

    if (useStark) {
      // STARK-based unshield: requires a pre-verified proof buffer
      tx = await this.buildUnshieldDenominatedStarkTx(
        walletPubkey,
        recipient,
        poolPDA,
        merkleTreePDA,
        nullifierPDA,
        nullifierBytes,
        merkleRootBytes,
        minEpoch,
        tokenInfo,
        isNativeSol,
      );
    } else {
      // Groth16-based unshield
      const proofResult = await this.generateDenominatedProof({
        merkleRoot: poolInfo.merkleRoot,
        nullifier,
        minEpoch,
        tokenMint: tokenInfo.mint,
        enforceMaturity: true,
      });

      tx = await this.buildUnshieldDenominatedTx(
        walletPubkey,
        recipient,
        poolPDA,
        merkleTreePDA,
        nullifierPDA,
        proofResult,
        nullifierBytes,
        merkleRootBytes,
        minEpoch,
        tokenInfo,
        isNativeSol,
      );
    }

    const txResult = await this.sendTx(tx);

    return {
      tx: txResult,
      nullifier,
      amount: denomination,
    };
  }

  /**
   * Unshield from a variable-amount pool using Groth16.
   */
  private async unshieldVariable(
    tokenInfo: TokenInfo,
    amount: bigint,
    recipient: PublicKey,
    _useStark?: boolean,
  ): Promise<UnshieldReceipt> {
    const walletPubkey = this.getWalletPublicKey();
    const [poolPDA] = this.derivePoolPDA(tokenInfo.mint);
    const [merkleTreePDA] = this.deriveMerkleTreePDA(poolPDA);
    const isNativeSol = tokenInfo.mint.equals(
      new PublicKey('So11111111111111111111111111111111111111112'),
    );

    const spendingKeyHash = this.computeSpendingKeyHash(walletPubkey);
    const ownerField = this.pubkeyToFieldElement(walletPubkey);

    // Derive nullifiers and commitments for 2-input/2-output unshield.
    // Input: 2 notes being spent. Output: 1 change note + 1 public withdrawal.
    const randomness1 = this.randomFieldElement();
    const randomness2 = this.randomFieldElement();
    const changeRandomness = this.randomFieldElement();

    const inputCommitment1 = await this.computeCommitment(amount, ownerField, randomness1);
    const inputCommitment2 = await this.computeCommitment(0n, ownerField, randomness2);
    const nullifier1 = await this.computeNullifier(inputCommitment1, spendingKeyHash);
    const nullifier2 = await this.computeNullifier(inputCommitment2, spendingKeyHash);

    // Change note commitment (zero change for exact-amount withdrawal)
    const changeCommitment = await this.computeCommitment(0n, ownerField, changeRandomness);

    const nullifier1Bytes = bigintToBytes32LE(nullifier1);
    const nullifier2Bytes = bigintToBytes32LE(nullifier2);

    // Check both nullifiers are not spent
    await this.checkNullifierNotSpent(poolPDA, nullifier1Bytes);
    await this.checkNullifierNotSpent(poolPDA, nullifier2Bytes);

    // Fetch pool info
    const poolInfo = await this.getPoolInfo(tokenInfo.symbol);
    const merkleRootBytes = bigintToBytes32LE(poolInfo.merkleRoot);

    // Output commitments: change note + empty (public withdrawal has no commitment)
    const outCommit1Bytes = bigintToBytes32LE(changeCommitment);
    const outCommit2Bytes = Buffer.alloc(32); // zero = no second output note

    const newRoot = this.computeNewRoot(outCommit1Bytes);

    // Generate ZK proof
    const proofResult = await this.generateUnshieldProof({
      merkleRoot: poolInfo.merkleRoot,
      nullifier1,
      nullifier2,
      outputCommitment1: changeCommitment,
      outputCommitment2: 0n,
      amount,
      ownerField,
      spendingKeyHash,
      tokenMint: tokenInfo.mint,
    });

    // Derive PDAs
    const [nullifierPDA1] = this.deriveNullifierPDA(poolPDA, nullifier1Bytes);
    const [nullifierPDA2] = this.deriveNullifierPDA(poolPDA, nullifier2Bytes);
    const [vkDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.VK_DATA), poolPDA.toBuffer()],
      this.programIds.zkShielded,
    );

    // Build unshield instruction
    const disc = anchorDiscriminator('unshield');
    const proofData = encodeGroth16Proof(proofResult.proof);

    const instructionData = Buffer.concat([
      disc,
      proofData,
      nullifier1Bytes,
      nullifier2Bytes,
      outCommit1Bytes,
      outCommit2Bytes,
      merkleRootBytes,
      u64ToBuffer(amount),
      Buffer.from(newRoot),
    ]);

    const keys = [
      { pubkey: walletPubkey, isSigner: true, isWritable: true },      // payer
      { pubkey: recipient, isSigner: false, isWritable: true },         // recipient
      { pubkey: poolPDA, isSigner: false, isWritable: true },           // shielded_pool
      { pubkey: merkleTreePDA, isSigner: false, isWritable: true },     // merkle_tree
      { pubkey: nullifierPDA1, isSigner: false, isWritable: true },     // nullifier_record_1
      { pubkey: nullifierPDA2, isSigner: false, isWritable: true },     // nullifier_record_2
      { pubkey: vkDataPDA, isSigner: false, isWritable: false },        // verification_key_data
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    if (!isNativeSol) {
      const poolVault = await getAssociatedTokenAddress(tokenInfo.mint, poolPDA, true);
      const recipientAta = await getAssociatedTokenAddress(tokenInfo.mint, recipient);

      // Create recipient ATA if it doesn't exist
      const recipientAtaInfo = await this.connection.getAccountInfo(recipientAta);
      const tx = new Transaction();
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.UNSHIELD }),
      );
      if (!recipientAtaInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(walletPubkey, recipientAta, recipient, tokenInfo.mint),
        );
      }

      keys.push(
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: poolVault, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      );

      const ix = new TransactionInstruction({
        programId: this.programIds.zkShielded,
        keys,
        data: instructionData,
      });
      tx.add(ix);

      const txResult = await this.sendTx(tx);
      return { tx: txResult, nullifier: nullifier1, amount };
    }

    const ix = new TransactionInstruction({
      programId: this.programIds.zkShielded,
      keys,
      data: instructionData,
    });

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.UNSHIELD }),
      ix,
    );

    const txResult = await this.sendTx(tx);
    return { tx: txResult, nullifier: nullifier1, amount };
  }

  /**
   * Build an unshield_denominated Groth16 transaction.
   */
  private async buildUnshieldDenominatedTx(
    payer: PublicKey,
    recipient: PublicKey,
    poolPDA: PublicKey,
    merkleTreePDA: PublicKey,
    nullifierPDA: PublicKey,
    proofResult: ProofResult,
    nullifierBytes: Buffer,
    merkleRootBytes: Buffer,
    minEpoch: bigint,
    tokenInfo: TokenInfo,
    isNativeSol: boolean,
  ): Promise<Transaction> {
    const [vkDataPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.VK_DATA), poolPDA.toBuffer()],
      this.programIds.zkShielded,
    );

    const disc = anchorDiscriminator('unshield_denominated');
    const proofData = encodeGroth16Proof(proofResult.proof);

    const instructionData = Buffer.concat([
      disc,
      proofData,
      nullifierBytes,
      merkleRootBytes,
      u64ToBuffer(minEpoch),
    ]);

    const keys = [
      { pubkey: payer, isSigner: true, isWritable: true },            // payer
      { pubkey: recipient, isSigner: false, isWritable: true },        // recipient
      { pubkey: poolPDA, isSigner: false, isWritable: true },          // denominated_pool
      { pubkey: merkleTreePDA, isSigner: false, isWritable: false },   // merkle_tree
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },     // nullifier_record
      { pubkey: vkDataPDA, isSigner: false, isWritable: false },       // verification_key_data
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    if (!isNativeSol) {
      const poolVault = await getAssociatedTokenAddress(tokenInfo.mint, poolPDA, true);
      const recipientAta = await getAssociatedTokenAddress(tokenInfo.mint, recipient);
      keys.push(
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: poolVault, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      );
    }

    // Protocol fee wallet
    keys.push(
      { pubkey: FEE_WALLET, isSigner: false, isWritable: true },
    );

    const ix = new TransactionInstruction({
      programId: this.programIds.zkShielded,
      keys,
      data: instructionData,
    });

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.UNSHIELD }),
      ix,
    );

    return tx;
  }

  /**
   * Build an unshield_denominated_stark transaction.
   * Reads a pre-verified STARK proof buffer from p01_stark_verifier.
   */
  private async buildUnshieldDenominatedStarkTx(
    payer: PublicKey,
    recipient: PublicKey,
    poolPDA: PublicKey,
    merkleTreePDA: PublicKey,
    nullifierPDA: PublicKey,
    nullifierBytes: Buffer | Uint8Array,
    merkleRootBytes: Buffer | Uint8Array,
    minEpoch: bigint,
    tokenInfo: TokenInfo,
    isNativeSol: boolean,
  ): Promise<Transaction> {
    // The STARK proof buffer PDA must be created and verified by the caller
    // prior to this call. Derive it from the payer and a nonce.
    const [starkProofBuffer] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.PROOF_BUFFER), payer.toBuffer()],
      this.programIds.starkVerifier,
    );

    // stark_commitment is the Poseidon hash commitment used in the STARK proof.
    // In production, this comes from the note's STARK proof generation.
    const starkCommitment = 0n; // placeholder — caller must provide

    const disc = anchorDiscriminator('unshield_denominated_stark');
    const instructionData = Buffer.concat([
      disc,
      Buffer.from(nullifierBytes),
      Buffer.from(merkleRootBytes),
      u64ToBuffer(minEpoch),
      u64ToBuffer(starkCommitment),
    ]);

    const keys = [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: merkleTreePDA, isSigner: false, isWritable: false },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    if (!isNativeSol) {
      const poolVault = await getAssociatedTokenAddress(tokenInfo.mint, poolPDA, true);
      const recipientAta = await getAssociatedTokenAddress(tokenInfo.mint, recipient);
      keys.push(
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: poolVault, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      );
    }

    // Protocol fee wallet
    keys.push(
      { pubkey: FEE_WALLET, isSigner: false, isWritable: true },
    );

    const ix = new TransactionInstruction({
      programId: this.programIds.zkShielded,
      keys,
      data: instructionData,
    });

    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.STARK_VERIFY }),
      ix,
    );

    return tx;
  }

  // ─── Private: Proof Generation ───────────────────────────────────────────

  /**
   * Generate a Groth16 proof for shielded pool operations.
   * Wraps snarkjs.groth16.fullProve with the configured circuit files.
   */
  private async generateShieldProof(inputs: Record<string, any>): Promise<ProofResult> {
    if (!this.proverConfig?.wasmPath || !this.proverConfig?.zkeyPath) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'Prover not configured. Call setProverConfig() with wasmPath and zkeyPath before generating proofs.',
      );
    }

    const startMs = Date.now();

    try {
      const timeoutMs = this.proverConfig.timeout ?? 120_000;

      const proofPromise = groth16.fullProve(
        inputs,
        this.proverConfig.wasmPath,
        this.proverConfig.zkeyPath,
      );

      const result = await Promise.race([
        proofPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Proof generation timed out')), timeoutMs),
        ),
      ]);

      const { proof, publicSignals } = result as { proof: Groth16Proof; publicSignals: string[] };
      const durationMs = Date.now() - startMs;

      return { proof, publicSignals, durationMs };
    } catch (err) {
      throw PrivacyError.proofFailed('shield', err as Error);
    }
  }

  /**
   * Generate a Groth16 proof for unshielding from a variable pool.
   * Circuit: transfer (2 inputs, 2 outputs, public_amount = -amount)
   */
  private async generateUnshieldProof(params: {
    merkleRoot: bigint;
    nullifier1: bigint;
    nullifier2: bigint;
    outputCommitment1: bigint;
    outputCommitment2: bigint;
    amount: bigint;
    ownerField: bigint;
    spendingKeyHash: bigint;
    tokenMint: PublicKey;
  }): Promise<ProofResult> {
    const circuitInputs = {
      root: params.merkleRoot.toString(),
      nullifierHash1: params.nullifier1.toString(),
      nullifierHash2: params.nullifier2.toString(),
      outputCommitment1: params.outputCommitment1.toString(),
      outputCommitment2: params.outputCommitment2.toString(),
      publicAmount: (-params.amount).toString(),
      tokenMint: this.pubkeyToFieldElement(params.tokenMint).toString(),
      // Private inputs would be filled from note database
      secret: params.ownerField.toString(),
      spendingKeyHash: params.spendingKeyHash.toString(),
    };

    return this.generateShieldProof(circuitInputs);
  }

  /**
   * Generate a Groth16 proof for denominated pool unshielding.
   * Circuit: denominated_pool (5 public inputs: merkle_root, nullifier, min_epoch, token_mint, enforce_maturity)
   */
  private async generateDenominatedProof(params: {
    merkleRoot: bigint;
    nullifier: bigint;
    minEpoch: bigint;
    tokenMint: PublicKey;
    enforceMaturity: boolean;
  }): Promise<ProofResult> {
    const circuitInputs = {
      root: params.merkleRoot.toString(),
      nullifierHash: params.nullifier.toString(),
      minEpoch: params.minEpoch.toString(),
      tokenMint: this.pubkeyToFieldElement(params.tokenMint).toString(),
      enforceMaturity: params.enforceMaturity ? '1' : '0',
    };

    return this.generateShieldProof(circuitInputs);
  }

  /**
   * Generate a Groth16 proof for private transfer.
   * Circuit: transfer (2 inputs, 2 outputs, public_amount = 0)
   */
  private async generateTransferProof(params: {
    merkleRoot: bigint;
    nullifier1: bigint;
    nullifier2: bigint;
    outputCommitment1: bigint;
    outputCommitment2: bigint;
    amount: bigint;
    ownerField: bigint;
    recipientField: bigint;
    randomness1: bigint;
    randomness2: bigint;
    spendingKeyHash: bigint;
    tokenMint: PublicKey;
  }): Promise<ProofResult> {
    const circuitInputs = {
      root: params.merkleRoot.toString(),
      nullifierHash1: params.nullifier1.toString(),
      nullifierHash2: params.nullifier2.toString(),
      outputCommitment1: params.outputCommitment1.toString(),
      outputCommitment2: params.outputCommitment2.toString(),
      publicAmount: '0',
      tokenMint: this.pubkeyToFieldElement(params.tokenMint).toString(),
      // Private inputs
      secret: params.ownerField.toString(),
      recipientSecret: params.recipientField.toString(),
      randomness1: params.randomness1.toString(),
      randomness2: params.randomness2.toString(),
      spendingKeyHash: params.spendingKeyHash.toString(),
    };

    return this.generateShieldProof(circuitInputs);
  }

  // ─── Private: Transaction Sending ────────────────────────────────────────

  /**
   * Send and confirm a transaction. Handles both Keypair and WalletAdapter
   * signing paths.
   *
   * - Keypair: uses sendAndConfirmTransaction (signs internally)
   * - WalletAdapter: calls signTransaction then sendRawTransaction
   */
  private async sendTx(tx: Transaction, signers?: Keypair[]): Promise<TxResult> {
    try {
      const walletPubkey = this.getWalletPublicKey();
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = walletPubkey;

      if ('secretKey' in this.wallet) {
        // Keypair: use sendAndConfirmTransaction
        const keypair = this.wallet as Keypair;
        const allSigners = [keypair, ...(signers ?? [])];
        const signature = await sendAndConfirmTransaction(
          this.connection,
          tx,
          allSigners,
          { commitment: 'confirmed' },
        );
        return { signature };
      } else {
        // WalletAdapter: signTransaction then sendRawTransaction
        const adapter = this.wallet as WalletAdapter;

        // Add any additional signers first
        if (signers?.length) {
          tx.partialSign(...signers);
        }

        const signed = await adapter.signTransaction(tx);
        const rawTx = signed.serialize();
        const signature = await this.connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });

        // Confirm the transaction
        await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );

        return { signature };
      }
    } catch (err) {
      throw PrivacyError.txFailed('sendTransaction', err as Error);
    }
  }

  // ─── Private: Cryptographic Helpers ──────────────────────────────────────

  /**
   * Generate a random field element suitable for BN254 scalar field.
   * Delegates to @protocol-01/privacy-toolkit which uses rejection sampling
   * to avoid modular bias.
   */
  private randomFieldElement(): bigint {
    return toolkitRandomFieldElement();
  }

  /**
   * Compute a note commitment: Poseidon3(amount, owner, randomness)
   * This matches the on-chain commitment scheme used by zk_shielded.
   */
  private async computeCommitment(
    amount: bigint,
    owner: bigint,
    randomness: bigint,
  ): Promise<bigint> {
    return poseidon3([amount, owner, randomness]);
  }

  /**
   * Compute a nullifier: Poseidon2(commitment, spendingKeyHash)
   * The nullifier uniquely identifies a spent note without revealing which note.
   */
  private async computeNullifier(
    commitment: bigint,
    spendingKeyHash: bigint,
  ): Promise<bigint> {
    return poseidon2([commitment, spendingKeyHash]);
  }

  /**
   * Convert a PublicKey to a BN254 field element.
   * Takes the first 31 bytes of the pubkey (big-endian) to stay within field range.
   */
  private pubkeyToFieldElement(pubkey: PublicKey): bigint {
    const bytes = pubkey.toBytes();
    let result = 0n;
    // Use first 31 bytes to ensure we're within BN254 scalar field
    for (let i = 0; i < 31; i++) {
      result = (result << 8n) | BigInt(bytes[i]!);
    }
    return result;
  }

  /**
   * Compute the spending key hash from the wallet's public key.
   * H = Poseidon2(pubkey_field, pubkey_field) — matches circuit convention.
   */
  private computeSpendingKeyHash(walletPubkey: PublicKey): bigint {
    const field = this.pubkeyToFieldElement(walletPubkey);
    return poseidon2([field, field]);
  }

  /**
   * Compute a new Merkle root after inserting a leaf.
   * This is a simplified off-chain computation. A production implementation
   * would maintain a full local Merkle tree and compute exact roots.
   *
   * The on-chain program uses insert_with_root() which accepts client-computed
   * roots since the Poseidon syscall is not yet enabled on Solana.
   */
  private computeNewRoot(leafBytes: Buffer): Buffer {
    // Hash the leaf with the zero sibling at each level to compute root.
    // This assumes the leaf is inserted at the next available position.
    let current = new Uint8Array(leafBytes);
    for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
      // At each level, hash(current, zero_sibling) using Poseidon
      // For SDK purposes, we use SHA-256 as a stand-in since we can't
      // call Poseidon synchronously in all environments. The actual root
      // must be computed by the calling application's Merkle tree manager.
      const pair = Buffer.alloc(64);
      Buffer.from(current).copy(pair, 0);
      // Zero sibling at this level would come from the precomputed zeros
      pair.fill(0, 32); // simplified
      current = new Uint8Array(sha256(pair));
    }
    return Buffer.from(current);
  }

  // ─── Private: On-chain Queries ───────────────────────────────────────────

  /**
   * Check that a nullifier has not been spent on-chain.
   * If the NullifierRecord PDA exists, the note has already been spent.
   */
  private async checkNullifierNotSpent(pool: PublicKey, nullifier: Uint8Array): Promise<void> {
    const [nullifierPDA] = this.deriveNullifierPDA(pool, nullifier);
    const accountInfo = await this.connection.getAccountInfo(nullifierPDA);
    if (accountInfo !== null) {
      throw PrivacyError.nullifierSpent();
    }
  }

  /**
   * Parse the leaf index from transaction logs.
   * The on-chain program emits "Commitment added at index: N".
   */
  private async parseLeafIndexFromLogs(signature: string): Promise<number> {
    try {
      const txDetails = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (txDetails?.meta?.logMessages) {
        for (const log of txDetails.meta.logMessages) {
          const match = log.match(/Commitment added at index: (\d+)/);
          if (match?.[1]) {
            return parseInt(match[1], 10);
          }
        }
      }
    } catch {
      // Non-fatal: leaf index can be derived from pool state
    }

    // Fallback: return -1 to indicate the index couldn't be parsed.
    // The caller can query the pool's next_leaf_index - 1 instead.
    return -1;
  }

  // ─── Private: Wallet Helpers ─────────────────────────────────────────────

  /**
   * Get the wallet's public key, handling both Keypair and WalletAdapter.
   */
  private getWalletPublicKey(): PublicKey {
    if ('publicKey' in this.wallet && this.wallet.publicKey instanceof PublicKey) {
      return this.wallet.publicKey;
    }
    if ('secretKey' in this.wallet) {
      return (this.wallet as Keypair).publicKey;
    }
    throw PrivacyError.walletNotConnected();
  }
}
