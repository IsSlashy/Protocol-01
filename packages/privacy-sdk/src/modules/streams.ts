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
import type {
  Network,
  ProgramIds,
  Signer,
  TokenInfo,
  TokenSymbol,
  TxResult,
  CreateStreamParams,
  StreamInfo,
  StreamReceipt,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS, COMPUTE_UNITS } from '../constants';

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
 * Read a little-endian i64 (signed) from a buffer slice.
 */
function i64FromLeBytes(buf: Uint8Array, offset: number): number {
  const raw = u64FromLeBytes(buf, offset);
  return Number(raw);
}

/**
 * StreamsModule wraps the on-chain stream program to provide
 * time-locked payment streaming between two parties.
 *
 * A stream escrows tokens on creation and linearly unlocks them
 * over the configured duration. The recipient can withdraw accrued
 * funds at any time; the sender can cancel to reclaim the remainder.
 */
export class StreamsModule {
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
   * Create a new payment stream.
   *
   * Escrows `totalAmount` of the specified token and streams it linearly
   * to the recipient over `duration` seconds.
   *
   * @param params - Stream configuration (recipient, amount, duration, token).
   * @returns The transaction result and the newly-created stream PDA address.
   */
  async create(params: CreateStreamParams): Promise<StreamReceipt> {
    try {
      const token = this.resolveToken(params.token ?? 'SOL');
      const totalAmount = BigInt(params.totalAmount);
      const duration = params.duration;
      const sender = this.walletPublicKey();
      const recipient = params.recipient;
      const mint = token.mint;

      const [streamPDA] = this.deriveStreamPDA(sender, recipient, mint);

      // amount_per_interval = totalAmount (streamed continuously; interval = 1s)
      const amountPerInterval = totalAmount / BigInt(duration);

      const disc = instructionDiscriminator('create_stream');
      const data = Buffer.concat([
        disc,
        u64ToLeBytes(totalAmount),
        u64ToLeBytes(duration),
        u64ToLeBytes(amountPerInterval > 0n ? amountPerInterval : 1n),
        Buffer.from([params.private ? 1 : 0]),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.STREAM_CREATE }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: sender, isSigner: true, isWritable: true },
            { pubkey: recipient, isSigner: false, isWritable: false },
            { pubkey: streamPDA, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.stream,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);
      return { tx: txResult, streamAddress: streamPDA };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.STREAM_CREATE_FAILED,
        `Stream creation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Withdraw accrued funds from a stream.
   *
   * Only the stream recipient can call this. The amount withdrawn is
   * the linearly-vested portion since the last withdrawal.
   *
   * @param streamAddress - Public key of the stream account.
   * @returns Transaction result.
   */
  async withdraw(streamAddress: PublicKey): Promise<TxResult> {
    try {
      const recipient = this.walletPublicKey();

      const disc = instructionDiscriminator('withdraw_from_stream');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: recipient, isSigner: true, isWritable: true },
            { pubkey: streamAddress, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.stream,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.STREAM_WITHDRAW_FAILED,
        `Stream withdrawal failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Cancel a stream.
   *
   * Returns remaining (unstreamed) tokens to the sender and releases
   * any accrued-but-unclaimed tokens to the recipient.
   * Only the sender can cancel.
   *
   * @param streamAddress - Public key of the stream account.
   * @returns Transaction result.
   */
  async cancel(streamAddress: PublicKey): Promise<TxResult> {
    try {
      const sender = this.walletPublicKey();

      const disc = instructionDiscriminator('cancel_stream');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: sender, isSigner: true, isWritable: true },
            { pubkey: streamAddress, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.stream,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.STREAM_CANCEL_FAILED,
        `Stream cancellation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch a single stream's on-chain state.
   *
   * Includes the claimable amount computed from the current block timestamp.
   *
   * @param streamAddress - Public key of the stream account.
   * @returns Parsed stream information.
   */
  async getStream(streamAddress: PublicKey): Promise<StreamInfo> {
    const accountInfo = await this.connection.getAccountInfo(streamAddress);

    if (!accountInfo || !accountInfo.data) {
      throw new PrivacyError(
        PrivacyErrorCode.STREAM_NOT_FOUND,
        `Stream account ${streamAddress.toBase58()} not found.`,
      );
    }

    return this.parseStreamAccount(streamAddress, accountInfo.data);
  }

  /**
   * List all streams where the connected wallet is sender or recipient.
   *
   * @param role - Filter by 'sender' or 'recipient'.
   * @returns Array of parsed stream information.
   */
  async listStreams(role: 'sender' | 'recipient'): Promise<StreamInfo[]> {
    const wallet = this.walletPublicKey();

    // Filter by the wallet pubkey at the correct offset in the account data.
    // Account layout: 8-byte discriminator, then sender (32 bytes), then recipient (32 bytes).
    const offset = role === 'sender' ? 8 : 40;

    const accounts = await this.connection.getProgramAccounts(this.programIds.stream, {
      filters: [
        { memcmp: { offset, bytes: wallet.toBase58() } },
      ],
    });

    return accounts.map((a) => this.parseStreamAccount(a.pubkey, a.account.data));
  }

  // ── PDA Derivation ──────────────────────────────────────────────────────────

  /**
   * Derive the stream PDA for a sender-recipient-mint tuple.
   */
  private deriveStreamPDA(
    sender: PublicKey,
    recipient: PublicKey,
    mint: PublicKey,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(SEEDS.STREAM),
        sender.toBuffer(),
        recipient.toBuffer(),
        mint.toBuffer(),
      ],
      this.programIds.stream,
    );
  }

  // ── Account Parsing ─────────────────────────────────────────────────────────

  /**
   * Parse raw stream account data into a StreamInfo object.
   *
   * Account layout (expected):
   *   [0..8]    discriminator
   *   [8..40]   sender (Pubkey)
   *   [40..72]  recipient (Pubkey)
   *   [72..80]  total_amount (u64)
   *   [80..88]  withdrawn_amount (u64)
   *   [88..96]  start_time (i64)
   *   [96..104] end_time (i64)
   *   [104..136] token_mint (Pubkey)
   *   [136]     is_private (bool)
   */
  private parseStreamAccount(address: PublicKey, data: Buffer | Uint8Array): StreamInfo {
    const sender = new PublicKey(data.subarray(8, 40));
    const recipient = new PublicKey(data.subarray(40, 72));
    const totalAmount = u64FromLeBytes(data, 72);
    const withdrawnAmount = u64FromLeBytes(data, 80);
    const startTime = i64FromLeBytes(data, 88);
    const endTime = i64FromLeBytes(data, 96);
    const tokenMint = new PublicKey(data.subarray(104, 136));
    const isPrivate = data[136] === 1;

    // Calculate claimable amount based on elapsed time
    const now = Math.floor(Date.now() / 1000);
    let claimable = 0n;
    if (now >= endTime) {
      claimable = totalAmount - withdrawnAmount;
    } else if (now > startTime) {
      const elapsed = BigInt(now - startTime);
      const duration = BigInt(endTime - startTime);
      const vested = (totalAmount * elapsed) / duration;
      claimable = vested > withdrawnAmount ? vested - withdrawnAmount : 0n;
    }

    return {
      address,
      sender,
      recipient,
      totalAmount,
      withdrawnAmount,
      startTime,
      endTime,
      claimable,
      tokenMint,
      isPrivate,
    };
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
