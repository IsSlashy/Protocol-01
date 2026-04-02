import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { x25519 } from '@noble/curves/ed25519';
import nacl from 'tweetnacl';
import type {
  Network,
  ProgramIds,
  Signer,
  TokenInfo,
  TxResult,
  RelayJobParams,
  RelayerInfo,
  RelayJobReceipt,
  RelayJobStatus,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS } from '../constants';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default timeout for awaiting job completion (60 seconds) */
const DEFAULT_AWAIT_TIMEOUT_MS = 60_000;

/** Polling interval when waiting for job completion (2 seconds) */
const POLL_INTERVAL_MS = 2_000;

// ── Utility Functions ──────────────────────────────────────────────────────────

/**
 * Anchor-style 8-byte instruction discriminator: sha256("global:<name>")[0..8]
 */
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

/**
 * Encode a u64 as an 8-byte little-endian buffer.
 */
function u64ToLeBytes(value: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Read a little-endian u64 from a buffer slice.
 */
function u64FromLeBytes(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[offset + i]!);
  }
  return result;
}

/**
 * Decode a Borsh string from a buffer at the given offset.
 */
function decodeBorshString(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const len =
    buf[offset]! |
    (buf[offset + 1]! << 8) |
    (buf[offset + 2]! << 16) |
    (buf[offset + 3]! << 24);
  const value = Buffer.from(buf.subarray(offset + 4, offset + 4 + len)).toString('utf-8');
  return { value, bytesRead: 4 + len };
}

/**
 * Encode a byte array with a 4-byte Borsh length prefix.
 */
function encodeBorshBytes(data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  return Buffer.concat([len, Buffer.from(data)]);
}

/**
 * Generate a unique job ID from the current timestamp and random bytes.
 */
function generateJobId(): string {
  const timestamp = Date.now().toString(36);
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
  return `${timestamp}_${random}`;
}

/**
 * RelayModule wraps the p01_relayer on-chain program to submit
 * transactions through privacy relayers.
 *
 * Privacy relayers decouple the fee payer from the transaction sender,
 * preventing on-chain linkage between the user's wallet and their
 * shielded operations. Transactions are encrypted with the relayer's
 * x25519 public key before submission.
 *
 * The relay system is permissionless: relayers register with a stake
 * and earn fees for executing jobs. Anyone can become a relayer.
 */
export class RelayModule {
  private readonly connection: Connection;
  private readonly wallet: Signer;
  private readonly network: Network;
  private readonly programIds: ProgramIds;
  private readonly resolveToken: (symbol: string) => TokenInfo;

  constructor(
    connection: Connection,
    wallet: Signer,
    network: Network,
    programIds: ProgramIds,
    resolveToken: (symbol: string) => TokenInfo,
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = network;
    this.programIds = programIds;
    this.resolveToken = resolveToken;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Submit an encrypted transaction through a privacy relayer.
   *
   * Selects an active relayer from the on-chain registry, encrypts
   * the transaction data with the relayer's x25519 public key, and
   * submits the encrypted payload as a relay job.
   *
   * @param params - The encrypted transaction data to relay.
   * @returns Transaction result, job ID, job address, and relayer public key.
   */
  async submitJob(params: RelayJobParams): Promise<RelayJobReceipt> {
    try {
      const sender = this.walletPublicKey();

      // Select an active relayer
      const relayers = await this.listRelayers();
      if (relayers.length === 0) {
        throw new PrivacyError(
          PrivacyErrorCode.RELAY_NO_ACTIVE_RELAYERS,
          'No active relayers available on the network.',
        );
      }

      // Pick the relayer with the most completed jobs (most reliable)
      const relayer = relayers.sort((a, b) => b.jobsCompleted - a.jobsCompleted)[0];
      if (!relayer) {
        throw new PrivacyError(
          PrivacyErrorCode.RELAY_NO_ACTIVE_RELAYERS,
          'No active relayers available on the network.',
        );
      }

      // Encrypt the transaction data using x25519 box
      let encryptedPayload: Uint8Array;
      try {
        const ephemeralKeypair = nacl.box.keyPair();
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const encrypted = nacl.box(
          params.encryptedTx,
          nonce,
          relayer.encryptionKey,
          ephemeralKeypair.secretKey,
        );
        if (!encrypted) {
          throw new Error('nacl.box returned null');
        }
        // Payload format: [32-byte ephemeral pubkey] [24-byte nonce] [ciphertext]
        encryptedPayload = Buffer.concat([
          Buffer.from(ephemeralKeypair.publicKey),
          Buffer.from(nonce),
          Buffer.from(encrypted),
        ]);
      } catch (encErr) {
        throw new PrivacyError(
          PrivacyErrorCode.RELAY_ENCRYPTION_FAILED,
          `Failed to encrypt transaction for relayer: ${(encErr as Error).message}`,
          encErr as Error,
        );
      }

      const jobId = generateJobId();
      const [jobPDA] = this.deriveJobPDA(jobId);

      const disc = instructionDiscriminator('submit_job');
      const data = Buffer.concat([
        disc,
        encodeBorshBytes(Buffer.from(jobId, 'utf-8')),
        encodeBorshBytes(encryptedPayload),
      ]);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: sender, isSigner: true, isWritable: true },
            { pubkey: jobPDA, isSigner: false, isWritable: true },
            { pubkey: relayer.address, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.relayer,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);

      return {
        tx: txResult,
        jobId,
        jobAddress: jobPDA,
        relayer: relayer.operator,
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.RELAY_SUBMIT_FAILED,
        `Relay job submission failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Get the current status of a relay job.
   *
   * @param jobId - The job identifier returned from submitJob.
   * @returns Current job status (pending, completed, expired, or cancelled).
   */
  async getJobStatus(jobId: string): Promise<RelayJobStatus> {
    const [jobPDA] = this.deriveJobPDA(jobId);
    const accountInfo = await this.connection.getAccountInfo(jobPDA);

    if (!accountInfo || !accountInfo.data) {
      return { jobId, status: 'expired' };
    }

    return this.parseJobAccount(jobId, accountInfo.data);
  }

  /**
   * Cancel a pending relay job.
   *
   * Only the original submitter can cancel. Reclaims the rent-exempt
   * lamports from the job account.
   *
   * @param jobId - The job identifier to cancel.
   * @returns Transaction result.
   */
  async cancelJob(jobId: string): Promise<TxResult> {
    try {
      const sender = this.walletPublicKey();
      const [jobPDA] = this.deriveJobPDA(jobId);

      const disc = instructionDiscriminator('cancel_job');
      const data = Buffer.concat([
        disc,
        encodeBorshBytes(Buffer.from(jobId, 'utf-8')),
      ]);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: sender, isSigner: true, isWritable: true },
            { pubkey: jobPDA, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.relayer,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.RELAY_SUBMIT_FAILED,
        `Relay job cancellation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * List all registered relayers on the network.
   *
   * Fetches all relayer accounts from the program and filters for active ones.
   *
   * @returns Array of active relayer information.
   */
  async listRelayers(): Promise<RelayerInfo[]> {
    const accounts = await this.connection.getProgramAccounts(
      this.programIds.relayer,
      {
        filters: [
          // Filter by the relayer account discriminator (first 8 bytes)
          {
            memcmp: {
              offset: 0,
              bytes: Buffer.from(
                sha256('account:Relayer').slice(0, 8),
              ).toString('base64'),
            },
          },
        ],
      },
    );

    const relayers: RelayerInfo[] = [];

    for (const { pubkey, account } of accounts) {
      try {
        const info = this.parseRelayerAccount(pubkey, account.data);
        if (info.isActive) {
          relayers.push(info);
        }
      } catch {
        // Skip malformed accounts
      }
    }

    return relayers;
  }

  /**
   * Poll a relay job until it reaches a terminal state or times out.
   *
   * @param jobId - The job identifier to monitor.
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 60s).
   * @returns Final job status.
   */
  async awaitCompletion(
    jobId: string,
    timeoutMs: number = DEFAULT_AWAIT_TIMEOUT_MS,
  ): Promise<RelayJobStatus> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.getJobStatus(jobId);

      if (status.status !== 'pending') {
        return status;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new PrivacyError(
      PrivacyErrorCode.TIMEOUT,
      `Relay job ${jobId} did not complete within ${timeoutMs}ms.`,
    );
  }

  // ── PDA Derivation ──────────────────────────────────────────────────────────

  /**
   * Derive the job PDA for a given job ID.
   */
  private deriveJobPDA(jobId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.JOB), Buffer.from(jobId, 'utf-8')],
      this.programIds.relayer,
    );
  }

  /**
   * Derive the relayer PDA for a given operator public key.
   */
  private deriveRelayerPDA(operator: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.RELAYER), operator.toBuffer()],
      this.programIds.relayer,
    );
  }

  /**
   * Derive the global relayer config PDA.
   */
  private deriveConfigPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.RELAYER_CONFIG)],
      this.programIds.relayer,
    );
  }

  // ── Account Parsing ─────────────────────────────────────────────────────────

  /**
   * Parse raw relayer account data into a RelayerInfo object.
   *
   * Account layout:
   *   [0..8]     discriminator
   *   [8..40]    operator (Pubkey)
   *   [40..48]   stake (u64)
   *   [48..80]   encryption_key (32 bytes, x25519)
   *   [80]       has_kem_key (bool)
   *   [81..1265] kem_encryption_key (1184 bytes, if has_kem)
   *   [var]      is_active (bool)
   *   [var+1..+8] jobs_completed (u64)
   */
  private parseRelayerAccount(
    address: PublicKey,
    data: Buffer | Uint8Array,
  ): RelayerInfo {
    const operator = new PublicKey(data.subarray(8, 40));
    const stake = u64FromLeBytes(data, 40);
    const encryptionKey = new Uint8Array(data.subarray(48, 80));
    const hasKem = data[80] === 1;

    let offset = 81;
    let kemEncryptionKey: Uint8Array | undefined;

    if (hasKem) {
      kemEncryptionKey = new Uint8Array(data.subarray(offset, offset + 1184));
      offset += 1184;
    }

    const isActive = data[offset] === 1;
    offset += 1;
    const jobsCompleted = Number(u64FromLeBytes(data, offset));

    return {
      address,
      operator,
      stake,
      encryptionKey,
      kemEncryptionKey,
      isActive,
      jobsCompleted,
    };
  }

  /**
   * Parse raw job account data into a RelayJobStatus object.
   *
   * Account layout:
   *   [0..8]   discriminator
   *   [8..40]  submitter (Pubkey)
   *   [40..72] relayer (Pubkey)
   *   [72]     status: 0=pending, 1=completed, 2=expired, 3=cancelled
   *   [73..105] tx_signature (32 bytes, if completed)
   */
  private parseJobAccount(
    jobId: string,
    data: Buffer | Uint8Array,
  ): RelayJobStatus {
    const statusByte = data[72];
    const statusMap: Record<number, RelayJobStatus['status']> = {
      0: 'pending',
      1: 'completed',
      2: 'expired',
      3: 'cancelled',
    };
    const status = statusMap[statusByte ?? 0] ?? 'pending';

    let txSignature: string | undefined;
    if (status === 'completed') {
      // Read the 64-byte base58 tx signature stored as raw bytes
      const sigBytes = data.subarray(73, 137);
      txSignature = Buffer.from(sigBytes).toString('base64');
    }

    return { jobId, status, txSignature };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Sign and send a transaction. Handles both Keypair and WalletAdapter signers.
   */
  private async sendTx(tx: Transaction, signers?: Keypair[]): Promise<TxResult> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    let signature: string;
    if ('secretKey' in this.wallet) {
      const allSigners = [this.wallet as Keypair, ...(signers || [])];
      signature = await sendAndConfirmTransaction(this.connection, tx, allSigners);
    } else {
      if (signers?.length) signers.forEach((s) => tx.partialSign(s));
      const signed = await this.wallet.signTransaction(tx);
      signature = await this.connection.sendRawTransaction(signed.serialize());
      await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
    }
    return { signature };
  }
}
