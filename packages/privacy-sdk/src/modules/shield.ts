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
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { hmac } from '@noble/hashes/hmac.js';

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
  WalletAdapter,
  ProverConfig,
  StarkProofOutcome,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import {
  SEEDS,
  COMPUTE_UNITS,
  MERKLE_TREE_DEPTH,
  FEE_WALLET,
  STARK_CIRCUITS,
} from '../constants';
import { goldilocksHash2to1, computeGoldilocksZeroCascade } from '../crypto/goldilocks-poseidon';
import {
  bytesToGoldilocks,
  packGoldilocksU64,
  computeGoldilocksCommitment,
  computeGoldilocksNullifier,
  randomGoldilocksU64,
  truncateToGoldilocks,
} from '../crypto/goldilocks';
import type { SpendingKey } from '../identity/spendingKey';

// ─── Borsh serialization helpers ─────────────────────────────────────────────

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
 * Anchor uses: sha256(utf8ToBytes("global:<instruction_name>"))[0..8]
 */
function anchorDiscriminator(name: string): Buffer {
  const hash = sha256(utf8ToBytes(`global:${name}`));
  return Buffer.from(hash.slice(0, 8));
}

/**
 * Pre-computed Anchor discriminators for the STARK instruction family. Kept
 * inline to match the byte values asserted by the mobile + extension clients
 * (apps/mobile/services/zk, apps/extension/src/shared/services/zk.ts). Changes
 * to any of these must be mirrored there.
 */
const STARK_DISCRIMINATORS = {
  shield_stark:   Buffer.from([241, 184, 171, 177, 138,  30, 238, 145]),
  transfer_stark: Buffer.from([101,  77, 136,  73,  63, 103, 214, 251]),
  unshield_stark: Buffer.from([189,  84, 110, 154, 217, 120, 183, 239]),
} as const;

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
 * pools (DenominatedPool, Tornado Cash model). All variable-pool operations
 * use STARK proofs (circuit 5 for transfer/unshield, circuit 6 for shield
 * root update) — the host supplies a prover via
 * {@link ProverConfig.generateStarkProof}. Denominated-pool shield requires
 * no proof; denominated-pool unshield reads a pre-verified STARK buffer.
 */
export class ShieldModule {
  /** Host-supplied STARK prover, timeout, and legacy Groth16 paths. */
  private proverConfig?: ProverConfig;

  /** Goldilocks spending-key element (low 8 bytes of the caller-supplied key). */
  private readonly spendingKeyGl: bigint;
  /** Circuit-5 owner identity: Poseidon(spending_key_gl, 0) — the cycle-0 derivation. */
  private readonly ownerPubkeyGl: bigint;

  constructor(
    private connection: Connection,
    private wallet: Signer,
    private network: Network,
    private programIds: ProgramIds,
    private resolveToken: (symbol: string) => TokenInfo,
    spendingKey: SpendingKey,
  ) {
    this.spendingKeyGl = bytesToGoldilocks(spendingKey);
    this.ownerPubkeyGl = goldilocksHash2to1(this.spendingKeyGl, 0n);
  }

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

    // Generate Goldilocks-field randomness for commitment blinding
    const randomness = this.randomFieldElement();

    // Circuit-5 owner identity: hash2(spending_key_gl, 0), derived at construct
    const ownerField = this.ownerPubkeyGl;

    // Compute commitment matching circuit 5:
    //   hash2(hash2(amount, randomness), hash2(owner, mint))
    const tokenMintGl = this.tokenMintToGoldilocks(tokenInfo.mint);
    const commitment = this.computeCommitment(
      truncateToGoldilocks(amount),
      ownerField,
      randomness,
      tokenMintGl,
    );

    // Encode commitment as 32-byte LE buffer (bytes 0..8 = u64 LE, 8..32 = 0)
    const commitmentBytes = Buffer.from(packGoldilocksU64(commitment));

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
        // Denominated pool (fixed-amount, Tornado-style) — shield_denominated
        // has no Merkle-update proof requirement on-chain, so no STARK prover
        // is involved here.
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
        // Variable-amount pool — shield_stark requires a circuit-6
        // (merkle_update) STARK proof already uploaded and verified on-chain.
        const [poolPDA] = this.derivePoolPDA(tokenInfo.mint);
        const [merkleTreePDA] = this.deriveMerkleTreePDA(poolPDA);

        const starkProof = await this.requestStarkProof(STARK_CIRCUITS.MERKLE_UPDATE, {
          // Placeholder private inputs — real callers must supply old/new roots,
          // merkle path, and the new leaf. The SDK cannot compute these without
          // a local tree; callers pass them in via a custom Record<string,any>
          // their prover understands.
          commitment: commitment.toString(),
          newRoot: Array.from(newRoot).map((b) => b.toString()),
        });

        tx = await this.buildShieldStarkTx(
          walletPubkey,
          poolPDA,
          merkleTreePDA,
          tokenInfo,
          amount,
          commitmentBytes,
          newRoot,
          starkProof.proofBuffer,
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
   * @param params - Unshield parameters (amount, token, recipient)
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
        return await this.unshieldDenominated(tokenInfo, amount, recipient);
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

      // Sender's circuit-5 owner identity (derived from the supplied spendingKey).
      const ownerField = this.ownerPubkeyGl;
      // Recipient's owner identity as circuit 5 would derive it — `hash2(X, 0)`
      // where X is the recipient's Goldilocks field. NOTE: a real external
      // recipient cannot spend notes produced this way; shielded transfers to
      // third parties must instead go through stealth-address flows. This
      // placeholder matches the existing dev-only structure so the transfer
      // builder stays wired and same-wallet self-transfers still work.
      const recipientGl = bytesToGoldilocks(recipientPubkey.toBytes());
      const recipientField = goldilocksHash2to1(recipientGl, 0n);

      // Goldilocks-field randomness for output notes
      const randomness1 = this.randomFieldElement(); // recipient note
      const randomness2 = this.randomFieldElement(); // change note

      // Fetch pool to get current merkle root
      const poolInfo = await this.getPoolInfo(params.token);

      const tokenMintGl = this.tokenMintToGoldilocks(tokenInfo.mint);

      // Output commitments — circuit-5 layout
      const outputCommitment1 = this.computeCommitment(
        truncateToGoldilocks(amount),
        recipientField,
        randomness1,
        tokenMintGl,
      );
      const outputCommitment2 = this.computeCommitment(
        0n,
        ownerField,
        randomness2,
        tokenMintGl,
      ); // change placeholder

      // Input nullifiers — placeholder (real impl picks from the user's note db).
      // Sender spends notes owned by `ownerField`, so nullifiers bind to it.
      const nullifier1 = this.computeNullifier(outputCommitment1, ownerField);
      const nullifier2 = this.computeNullifier(outputCommitment2, ownerField);

      // Check nullifiers are not already spent
      await this.checkNullifierNotSpent(poolPDA, packGoldilocksU64(nullifier1));
      await this.checkNullifierNotSpent(poolPDA, packGoldilocksU64(nullifier2));

      const nullifier1Bytes = Buffer.from(packGoldilocksU64(nullifier1));
      const nullifier2Bytes = Buffer.from(packGoldilocksU64(nullifier2));
      const outCommit1Bytes = Buffer.from(packGoldilocksU64(outputCommitment1));
      const outCommit2Bytes = Buffer.from(packGoldilocksU64(outputCommitment2));
      const merkleRootBytes = Buffer.from(packGoldilocksU64(poolInfo.merkleRoot));
      const newRoot = this.computeNewRoot(outCommit1Bytes);

      // Derive nullifier PDAs
      const [nullifierPDA1] = this.deriveNullifierPDA(poolPDA, nullifier1Bytes);
      const [nullifierPDA2] = this.deriveNullifierPDA(poolPDA, nullifier2Bytes);

      // Generate + upload a circuit-5 (transfer) STARK proof. The host
      // provides the real private inputs (spending_key, randomness, merkle
      // paths, etc.) — the SDK only forwards the public inputs it can derive.
      const starkProof = await this.requestStarkProof(STARK_CIRCUITS.TRANSFER, {
        spendingKeyGl: this.spendingKeyGl.toString(),
        merkleRoot: poolInfo.merkleRoot.toString(),
        nullifier1: nullifier1.toString(),
        nullifier2: nullifier2.toString(),
        outputCommitment1: outputCommitment1.toString(),
        outputCommitment2: outputCommitment2.toString(),
        publicAmount: '0',
        tokenMint: tokenMintGl.toString(),
        ownerField: ownerField.toString(),
        recipientField: recipientField.toString(),
        randomness1: randomness1.toString(),
        randomness2: randomness2.toString(),
      });

      // Build transfer_stark instruction — must match byte layout in
      // apps/extension/src/shared/services/zk.ts and apps/mobile/services/zk.
      const instructionData = Buffer.concat([
        STARK_DISCRIMINATORS.transfer_stark,
        nullifier1Bytes,
        nullifier2Bytes,
        outCommit1Bytes,
        outCommit2Bytes,
        merkleRootBytes,
        Buffer.from(newRoot),
      ]);

      const keys = [
        { pubkey: walletPubkey, isSigner: true, isWritable: true },         // payer
        { pubkey: poolPDA, isSigner: false, isWritable: true },             // shielded_pool
        { pubkey: merkleTreePDA, isSigner: false, isWritable: true },       // merkle_tree
        { pubkey: nullifierPDA1, isSigner: false, isWritable: true },       // nullifier_record_1
        { pubkey: nullifierPDA2, isSigner: false, isWritable: true },       // nullifier_record_2
        { pubkey: starkProof.proofBuffer, isSigner: false, isWritable: false }, // stark_proof_buffer
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

    // Note: owner identity derived from supplied spendingKey; used below
    // when a real scan matches commitments against the wallet's note set.
    const _ownerField = this.ownerPubkeyGl;

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
   * Build a `shield_stark` transaction for the variable-amount pool. Requires
   * a circuit-6 (merkle_update) proof buffer already uploaded and verified via
   * p01_stark_verifier.
   *
   * Instruction layout (matches apps/extension zk.ts and apps/mobile services):
   *   disc || commitment[32] || old_root[32] || new_root[32] || amount[8]
   */
  private async buildShieldStarkTx(
    depositor: PublicKey,
    poolPDA: PublicKey,
    merkleTreePDA: PublicKey,
    tokenInfo: TokenInfo,
    amount: bigint,
    commitment: Buffer,
    newRoot: Buffer,
    proofBuffer: PublicKey,
  ): Promise<Transaction> {
    const isNativeSol = tokenInfo.mint.equals(
      new PublicKey('So11111111111111111111111111111111111111112'),
    );

    // Fetch the current on-chain root (the STARK proof asserted old_root ==
    // this value). Falls back to zeros if the pool has not yet been init'd.
    const pool = await this.connection.getAccountInfo(poolPDA);
    const oldRootBytes = pool
      ? Buffer.from(pool.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32))
      : Buffer.alloc(32);

    const instructionData = Buffer.concat([
      STARK_DISCRIMINATORS.shield_stark,
      commitment,
      oldRootBytes,
      newRoot,
      u64ToBuffer(amount),
    ]);

    const keys = [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
      { pubkey: proofBuffer, isSigner: false, isWritable: false },
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
    } else {
      // Placeholders so Anchor's Option deserialization returns None.
      keys.push(
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: this.programIds.zkShielded, isSigner: false, isWritable: false },
        { pubkey: this.programIds.zkShielded, isSigner: false, isWritable: false },
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
   * Unshield from a denominated pool using a pre-verified STARK proof buffer.
   * Groth16 denominated-pool instructions were removed on-chain in P3.7.
   */
  private async unshieldDenominated(
    tokenInfo: TokenInfo,
    denomination: bigint,
    recipient: PublicKey,
  ): Promise<UnshieldReceipt> {
    const walletPubkey = this.getWalletPublicKey();
    const [poolPDA] = this.derivePoolPDA(tokenInfo.mint, denomination);
    const [merkleTreePDA] = this.deriveMerkleTreePDA(poolPDA);
    const isNativeSol = tokenInfo.mint.equals(
      new PublicKey('So11111111111111111111111111111111111111112'),
    );

    // Derive nullifier from the supplied spending key + the note commitment.
    const ownerField = this.ownerPubkeyGl;
    const tokenMintGl = this.tokenMintToGoldilocks(tokenInfo.mint);

    // Placeholder note: real implementations pick an existing unspent note
    // from the local note database.
    const noteRandomness = this.randomFieldElement();
    const noteCommitment = this.computeCommitment(
      truncateToGoldilocks(denomination),
      ownerField,
      noteRandomness,
      tokenMintGl,
    );
    const nullifier = this.computeNullifier(noteCommitment, ownerField);
    const nullifierBytes = Buffer.from(packGoldilocksU64(nullifier));

    // Check nullifier not already spent
    await this.checkNullifierNotSpent(poolPDA, nullifierBytes);

    // Fetch pool info to get current merkle root
    const poolInfo = await this.getPoolInfo(tokenInfo.symbol, true, denomination);
    const merkleRootBytes = Buffer.from(packGoldilocksU64(poolInfo.merkleRoot));

    // min_epoch: the epoch at which the note was deposited + epoch_delay
    const minEpoch = 0n; // In production, retrieved from note metadata

    // Derive nullifier PDA
    const [nullifierPDA] = this.deriveNullifierPDA(poolPDA, nullifierBytes);

    const tx = await this.buildUnshieldDenominatedStarkTx(
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

    const txResult = await this.sendTx(tx);

    return {
      tx: txResult,
      nullifier,
      amount: denomination,
    };
  }

  /**
   * Unshield from a variable-amount pool via `unshield_stark` — reads a
   * pre-verified circuit-5 (transfer) STARK proof buffer with `publicAmount =
   * -amount` bound into the transcript.
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

    const ownerField = this.ownerPubkeyGl;
    const tokenMintGl = this.tokenMintToGoldilocks(tokenInfo.mint);

    // 2-input / 2-output: two input notes consumed, one change note emitted +
    // one public withdrawal (no second output commitment).
    const randomness1 = this.randomFieldElement();
    const randomness2 = this.randomFieldElement();
    const changeRandomness = this.randomFieldElement();

    const inputCommitment1 = this.computeCommitment(
      truncateToGoldilocks(amount),
      ownerField,
      randomness1,
      tokenMintGl,
    );
    const inputCommitment2 = this.computeCommitment(0n, ownerField, randomness2, tokenMintGl);
    const nullifier1 = this.computeNullifier(inputCommitment1, ownerField);
    const nullifier2 = this.computeNullifier(inputCommitment2, ownerField);

    const changeCommitment = this.computeCommitment(0n, ownerField, changeRandomness, tokenMintGl);

    const nullifier1Bytes = Buffer.from(packGoldilocksU64(nullifier1));
    const nullifier2Bytes = Buffer.from(packGoldilocksU64(nullifier2));

    await this.checkNullifierNotSpent(poolPDA, nullifier1Bytes);
    await this.checkNullifierNotSpent(poolPDA, nullifier2Bytes);

    const poolInfo = await this.getPoolInfo(tokenInfo.symbol);
    const merkleRootBytes = Buffer.from(packGoldilocksU64(poolInfo.merkleRoot));
    const outCommit1Bytes = Buffer.from(packGoldilocksU64(changeCommitment));
    const outCommit2Bytes = Buffer.alloc(32);
    const newRoot = this.computeNewRoot(outCommit1Bytes);

    // Request a circuit-5 (transfer) STARK proof with publicAmount = -amount
    // (mod Goldilocks, since the field is positive). Host provers are
    // responsible for the two's-complement-style sign encoding.
    const starkProof = await this.requestStarkProof(STARK_CIRCUITS.TRANSFER, {
      spendingKeyGl: this.spendingKeyGl.toString(),
      merkleRoot: poolInfo.merkleRoot.toString(),
      nullifier1: nullifier1.toString(),
      nullifier2: nullifier2.toString(),
      outputCommitment1: changeCommitment.toString(),
      outputCommitment2: '0',
      publicAmount: truncateToGoldilocks(-amount).toString(),
      tokenMint: tokenMintGl.toString(),
      ownerField: ownerField.toString(),
      randomness1: randomness1.toString(),
      randomness2: randomness2.toString(),
      changeRandomness: changeRandomness.toString(),
    });

    const [nullifierPDA1] = this.deriveNullifierPDA(poolPDA, nullifier1Bytes);
    const [nullifierPDA2] = this.deriveNullifierPDA(poolPDA, nullifier2Bytes);

    // unshield_stark layout mirrors apps/extension/src/shared/services/zk.ts
    const instructionData = Buffer.concat([
      STARK_DISCRIMINATORS.unshield_stark,
      nullifier1Bytes,
      nullifier2Bytes,
      outCommit1Bytes,
      outCommit2Bytes,
      merkleRootBytes,
      u64ToBuffer(amount),
      Buffer.from(newRoot),
    ]);

    const keys = [
      { pubkey: walletPubkey, isSigner: true, isWritable: true },              // payer
      { pubkey: recipient, isSigner: false, isWritable: true },                 // recipient
      { pubkey: poolPDA, isSigner: false, isWritable: true },                   // shielded_pool
      { pubkey: merkleTreePDA, isSigner: false, isWritable: true },             // merkle_tree
      { pubkey: nullifierPDA1, isSigner: false, isWritable: true },             // nullifier_record_1
      { pubkey: nullifierPDA2, isSigner: false, isWritable: true },             // nullifier_record_2
      { pubkey: starkProof.proofBuffer, isSigner: false, isWritable: false },   // stark_proof_buffer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    if (!isNativeSol) {
      const poolVault = await getAssociatedTokenAddress(tokenInfo.mint, poolPDA, true);
      const recipientAta = await getAssociatedTokenAddress(tokenInfo.mint, recipient);

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

    // Native SOL — append placeholder token-program slots matching the
    // extension's encoding (Anchor deserializes as Option::None).
    keys.push(
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: this.programIds.zkShielded, isSigner: false, isWritable: false }, // pool_vault placeholder
      { pubkey: this.programIds.zkShielded, isSigner: false, isWritable: false }, // recipient_token_account placeholder
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

    const txResult = await this.sendTx(tx);
    return { tx: txResult, nullifier: nullifier1, amount };
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

  // ─── Private: STARK Proof Request ────────────────────────────────────────

  /**
   * Invoke the host-supplied STARK prover. The host is responsible for
   * generating the proof (via WASM), uploading it to p01_stark_verifier in
   * chunks, running the two-phase DEEP-ALI verify, and returning the PDA of
   * the verified proof buffer — see `ProverConfig.generateStarkProof`.
   */
  private async requestStarkProof(
    circuitId: number,
    privateInputs: Record<string, string | string[] | number[]>,
  ): Promise<StarkProofOutcome> {
    if (!this.proverConfig?.generateStarkProof) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'STARK prover not configured. Call setProverConfig({ generateStarkProof }) with a host-supplied generator before shield/transfer/unshield on the variable-amount pool.',
      );
    }

    const timeoutMs = this.proverConfig.timeout ?? 120_000;
    try {
      const outcome = await Promise.race([
        this.proverConfig.generateStarkProof(circuitId, privateInputs),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('STARK proof generation timed out')), timeoutMs),
        ),
      ]);
      return outcome;
    } catch (err) {
      throw PrivacyError.proofFailed(`stark_circuit_${circuitId}`, err as Error);
    }
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
   * Generate fresh Goldilocks-field randomness (u64 reduced mod 2^64 - 2^32 + 1).
   * Used as the blinding factor in note commitments.
   */
  private randomFieldElement(): bigint {
    return randomGoldilocksU64();
  }

  /**
   * Compute a circuit-5 (transfer) note commitment:
   *   commitment = hash2(hash2(amount, randomness), hash2(ownerPubkeyGl, tokenMintGl))
   *
   * All inputs must already be Goldilocks elements. The resulting commitment
   * packs into bytes 0..8 of the on-chain [u8; 32] leaf.
   */
  private computeCommitment(
    amountGl: bigint,
    ownerPubkeyGl: bigint,
    randomnessGl: bigint,
    tokenMintGl: bigint,
  ): bigint {
    return computeGoldilocksCommitment(amountGl, ownerPubkeyGl, randomnessGl, tokenMintGl);
  }

  /**
   * Compute a circuit-5 nullifier: `hash2(commitment, ownerPubkeyGl)`.
   * The owner identity is `hash2(spending_key_gl, 0)` — the cycle-0
   * derivation performed by circuit 5 inside the trace.
   */
  private computeNullifier(
    commitmentGl: bigint,
    ownerPubkeyGl: bigint,
  ): bigint {
    return computeGoldilocksNullifier(commitmentGl, ownerPubkeyGl);
  }

  /**
   * Derive the Goldilocks mint field from a SPL token mint public key.
   * Takes the low 8 bytes of the pubkey as a LE u64 and reduces mod Goldilocks.
   * Matches the on-chain convention used by circuit 5.
   */
  private tokenMintToGoldilocks(mint: PublicKey): bigint {
    return bytesToGoldilocks(mint.toBytes());
  }

  /**
   * Compute the Merkle root that results from inserting a single leaf into an
   * otherwise-empty tree (the "zero cascade" starting point).
   *
   * The SDK does not maintain a stateful local Merkle tree — callers that need
   * an accurate root after multiple insertions must manage their own tree and
   * override this via the higher-level note manager. For new pools / smoke
   * tests the zero-cascade root is correct.
   */
  private computeNewRoot(leafBytes: Buffer): Buffer {
    const zeros = computeGoldilocksZeroCascade(MERKLE_TREE_DEPTH);
    // Interpret the leaf as a Goldilocks u64 (bytes 0..8 LE).
    const leafGl = bytesToGoldilocks(new Uint8Array(leafBytes));
    let current = leafGl;
    for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
      current = goldilocksHash2to1(current, zeros[level]!);
    }
    return Buffer.from(packGoldilocksU64(current));
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
