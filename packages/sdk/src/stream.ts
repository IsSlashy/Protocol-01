import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import {
  Stream,
  StreamStatus,
  CreateStreamParams,
  P01Config,
  P01WalletProvider,
  StreamEvent,
  ClientOverrides,
} from './types';
import {
  STREAM_PROGRAM_ID_DEVNET,
  STREAM_PROGRAM_ID_MAINNET,
  MAINNET_DEPLOYED,
  RPC_ENDPOINTS,
  NATIVE_SOL_MINT,
  IX_DISCRIMINATOR_CREATE_STREAM,
  IX_DISCRIMINATOR_CANCEL_STREAM,
  IX_DISCRIMINATOR_WITHDRAW,
  STREAM_ACCOUNT_SIZE,
  STREAM_SENDER_OFFSET,
  STREAM_RECIPIENT_OFFSET,
} from './constants';
import {
  deriveStreamPDA,
  deriveEscrowPDA,
  calculateWithdrawableAmount,
  calculateRefundAmount,
} from './utils';

/**
 * Protocol 01 Stream SDK
 *
 * Main client for creating and managing continuous payment streams on Solana.
 * Streams lock funds in an escrow PDA and release them linearly over time,
 * allowing the recipient to withdraw at any point.
 *
 * @example
 * ```ts
 * const client = createDevnetClient();
 * client.connect(wallet);
 *
 * const sig = await client.createStream({
 *   recipient: new PublicKey('...'),
 *   mint: USDC_MINT_DEVNET,
 *   amountPerInterval: 1_000_000, // 1 USDC
 *   intervalSeconds: 2_592_000,   // 30 days
 *   totalIntervals: 12,
 *   streamName: 'Monthly Sub',
 * });
 * ```
 */
export class P01StreamClient {
  private connection: Connection;
  private programId: PublicKey;
  private wallet: P01WalletProvider | null = null;

  constructor(config: P01Config) {
    const rpcUrl = config.rpcUrl || RPC_ENDPOINTS[config.network];
    this.connection = new Connection(rpcUrl, config.commitment || 'confirmed');

    this.programId =
      config.programId ||
      (config.network === 'mainnet-beta'
        ? STREAM_PROGRAM_ID_MAINNET
        : STREAM_PROGRAM_ID_DEVNET);
  }

  /**
   * Connect a wallet provider.
   * The wallet must implement {@link P01WalletProvider} (compatible with
   * `@solana/wallet-adapter-base`).
   */
  connect(wallet: P01WalletProvider): void {
    this.wallet = wallet;
  }

  /**
   * Disconnect wallet and clear the internal reference.
   */
  disconnect(): void {
    this.wallet = null;
  }

  /**
   * Get the connected wallet's public key, or `null` if no wallet is connected.
   */
  get publicKey(): PublicKey | null {
    return this.wallet?.publicKey || null;
  }

  /**
   * Whether a wallet is currently connected.
   */
  get isConnected(): boolean {
    return this.wallet?.connected || false;
  }

  /**
   * Get the underlying Solana `Connection` instance.
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get the stream program ID this client is configured to use.
   */
  getProgramId(): PublicKey {
    return this.programId;
  }

  /**
   * Create a new payment stream (subscription).
   *
   * Locks `amountPerInterval * totalIntervals` tokens in an escrow PDA.
   * The recipient can withdraw unlocked funds at any time via
   * {@link withdrawFromStream}.
   *
   * @param params - Stream configuration (recipient, token, amounts, schedule).
   * @returns The transaction signature. Use `connection.confirmTransaction(sig)`
   *   to await finality beyond the default `confirmed` level.
   *
   * @throws {Error} "Wallet not connected" -- no wallet via {@link connect}.
   * @throws {Error} "createStream: amount must be positive" -- non-positive amount.
   * @throws {Error} "createStream: invalid recipient address" -- malformed pubkey.
   * @throws {Error} "createStream: intervalSeconds must be positive" -- zero/negative interval.
   * @throws {Error} "createStream: totalIntervals must be positive" -- zero/negative count.
   */
  async createStream(params: CreateStreamParams): Promise<string> {
    if (!this.wallet || !this.wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    // ── Input validation ───────────────────────────────────────────────
    const amount = typeof params.amountPerInterval === 'bigint'
      ? params.amountPerInterval
      : BigInt(params.amountPerInterval);

    if (amount <= 0n) {
      throw new Error('createStream: amount must be positive');
    }

    try {
      // Ensure recipient is a valid PublicKey (catches bad base58, wrong length, etc.)
      new PublicKey(params.recipient.toBuffer());
    } catch {
      throw new Error('createStream: invalid recipient address');
    }

    if (!params.intervalSeconds || params.intervalSeconds <= 0) {
      throw new Error('createStream: intervalSeconds must be positive');
    }

    if (!params.totalIntervals || params.totalIntervals <= 0) {
      throw new Error('createStream: totalIntervals must be positive');
    }
    // ───────────────────────────────────────────────────────────────────

    const sender = this.wallet.publicKey;
    const { recipient, mint, amountPerInterval, intervalSeconds, totalIntervals, streamName } = params;

    // Derive PDAs
    const [streamPDA] = deriveStreamPDA(this.programId, sender, recipient, mint);
    const [escrowPDA] = deriveEscrowPDA(this.programId, streamPDA);

    // Get or create token accounts
    const senderATA = await getAssociatedTokenAddress(mint, sender);

    // Build transaction
    const tx = new Transaction();

    // Check if sender ATA exists
    try {
      await getAccount(this.connection, senderATA);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          sender,
          senderATA,
          sender,
          mint
        )
      );
    }

    // Create stream instruction
    const createStreamIx = this.buildCreateStreamInstruction(
      sender,
      recipient,
      mint,
      streamPDA,
      senderATA,
      escrowPDA,
      amount,
      intervalSeconds,
      totalIntervals,
      streamName
    );
    tx.add(createStreamIx);

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = sender;

    // Sign and send
    const signedTx = await this.wallet.signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize());

    await this.connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    return signature;
  }

  /**
   * Cancel a stream and refund remaining balance to the sender.
   *
   * Only the original sender of the stream can cancel it. Any already-withdrawn
   * funds remain with the recipient; only the unstreamed remainder is returned.
   *
   * @param streamAddress - The on-chain address of the stream account.
   * @returns The transaction signature. Use `connection.confirmTransaction(sig)`
   *   to await finality beyond the default `confirmed` level.
   *
   * @throws {Error} "Wallet not connected" -- no wallet via {@link connect}.
   * @throws {Error} "Stream not found" -- no account at `streamAddress`.
   * @throws {Error} "Only the stream sender can cancel" -- connected wallet is not the sender.
   */
  async cancelStream(streamAddress: PublicKey): Promise<string> {
    if (!this.wallet || !this.wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    const sender = this.wallet.publicKey;
    const stream = await this.getStream(streamAddress);

    if (!stream) {
      throw new Error('Stream not found');
    }

    if (!stream.sender.equals(sender)) {
      throw new Error('Only the stream sender can cancel');
    }

    const [escrowPDA] = deriveEscrowPDA(this.programId, streamAddress);
    const senderATA = await getAssociatedTokenAddress(stream.mint, sender);

    const tx = new Transaction();
    const cancelIx = this.buildCancelStreamInstruction(
      sender,
      streamAddress,
      escrowPDA,
      senderATA
    );
    tx.add(cancelIx);

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = sender;

    const signedTx = await this.wallet.signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize());

    await this.connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    return signature;
  }

  /**
   * Withdraw unlocked funds from a stream (called by recipient).
   *
   * Calculates the number of elapsed intervals since the last withdrawal
   * and transfers the corresponding token amount from escrow to the
   * recipient's associated token account.
   *
   * @param streamAddress - The on-chain address of the stream account.
   * @returns The transaction signature. Use `connection.confirmTransaction(sig)`
   *   to await finality beyond the default `confirmed` level.
   *
   * @throws {Error} "Wallet not connected" -- no wallet via {@link connect}.
   * @throws {Error} "Stream not found" -- no account at `streamAddress`.
   * @throws {Error} "Only the stream recipient can withdraw" -- connected wallet
   *   is not the designated recipient.
   */
  async withdrawFromStream(streamAddress: PublicKey): Promise<string> {
    if (!this.wallet || !this.wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    const recipient = this.wallet.publicKey;
    const stream = await this.getStream(streamAddress);

    if (!stream) {
      throw new Error('Stream not found');
    }

    if (!stream.recipient.equals(recipient)) {
      throw new Error('Only the stream recipient can withdraw');
    }

    const [escrowPDA] = deriveEscrowPDA(this.programId, streamAddress);
    const recipientATA = await getAssociatedTokenAddress(stream.mint, recipient);

    const tx = new Transaction();

    // Check if recipient ATA exists
    try {
      await getAccount(this.connection, recipientATA);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          recipient,
          recipientATA,
          recipient,
          stream.mint
        )
      );
    }

    const withdrawIx = this.buildWithdrawInstruction(
      recipient,
      streamAddress,
      escrowPDA,
      recipientATA
    );
    tx.add(withdrawIx);

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = recipient;

    const signedTx = await this.wallet.signTransaction(tx);
    const signature = await this.connection.sendRawTransaction(signedTx.serialize());

    await this.connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    return signature;
  }

  /**
   * Fetch and parse a stream account by its on-chain address.
   *
   * @param address - The stream account's public key.
   * @returns The parsed {@link Stream} object, or `null` if the account does
   *   not exist or cannot be decoded.
   */
  async getStream(address: PublicKey): Promise<Stream | null> {
    const accountInfo = await this.connection.getAccountInfo(address);
    if (!accountInfo) return null;

    return this.parseStreamAccount(address, accountInfo.data);
  }

  /**
   * Get all streams where the given wallet is the sender (outgoing payments).
   *
   * @param sender - The sender's public key.
   * @returns Array of parsed {@link Stream} objects.
   */
  async getOutgoingStreams(sender: PublicKey): Promise<Stream[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: STREAM_ACCOUNT_SIZE },
        { memcmp: { offset: STREAM_SENDER_OFFSET, bytes: sender.toBase58() } },
      ],
    });

    return accounts
      .map(({ pubkey, account }) => this.parseStreamAccount(pubkey, account.data))
      .filter((s): s is Stream => s !== null);
  }

  /**
   * Get all streams where the given wallet is the recipient (incoming payments).
   *
   * @param recipient - The recipient's public key.
   * @returns Array of parsed {@link Stream} objects.
   */
  async getIncomingStreams(recipient: PublicKey): Promise<Stream[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: STREAM_ACCOUNT_SIZE },
        { memcmp: { offset: STREAM_RECIPIENT_OFFSET, bytes: recipient.toBase58() } },
      ],
    });

    return accounts
      .map(({ pubkey, account }) => this.parseStreamAccount(pubkey, account.data))
      .filter((s): s is Stream => s !== null);
  }

  /**
   * Get all streams for the connected wallet (both incoming and outgoing).
   *
   * @returns `{ incoming, outgoing }` -- two arrays of {@link Stream} objects.
   * @throws {Error} "Wallet not connected" if no wallet is connected.
   */
  async getMyStreams(): Promise<{ incoming: Stream[]; outgoing: Stream[] }> {
    if (!this.wallet?.publicKey) {
      throw new Error('Wallet not connected');
    }

    const [incoming, outgoing] = await Promise.all([
      this.getIncomingStreams(this.wallet.publicKey),
      this.getOutgoingStreams(this.wallet.publicKey),
    ]);

    return { incoming, outgoing };
  }

  /**
   * Calculate the token amount currently available for withdrawal.
   *
   * This is a local calculation based on the stream state and the current
   * clock -- it does not make an RPC call.
   *
   * @param stream - A {@link Stream} object (from {@link getStream} etc.).
   * @returns The withdrawable amount in base token units.
   */
  getWithdrawableAmount(stream: Stream): bigint {
    return calculateWithdrawableAmount(
      stream.amountPerInterval,
      stream.intervalSeconds,
      stream.totalIntervals,
      stream.intervalsPaid,
      stream.lastWithdrawalAt
    );
  }

  /**
   * Calculate how much the sender would receive if the stream were cancelled now.
   *
   * @param stream - A {@link Stream} object (from {@link getStream} etc.).
   * @returns The refund amount in base token units.
   */
  getRefundAmount(stream: Stream): bigint {
    return calculateRefundAmount(
      stream.amountPerInterval,
      stream.totalIntervals,
      stream.intervalsPaid
    );
  }

  // ── Private helper methods ───────────────────────────────────────────

  private buildCreateStreamInstruction(
    sender: PublicKey,
    recipient: PublicKey,
    mint: PublicKey,
    stream: PublicKey,
    senderATA: PublicKey,
    escrow: PublicKey,
    amountPerInterval: bigint,
    intervalSeconds: number,
    totalIntervals: number,
    streamName: string
  ): TransactionInstruction {
    // Serialize instruction data
    const nameBuffer = Buffer.alloc(36);
    nameBuffer.writeUInt32LE(streamName.length, 0);
    Buffer.from(streamName).copy(nameBuffer, 4);

    const data = Buffer.concat([
      IX_DISCRIMINATOR_CREATE_STREAM,
      Buffer.from(new BigUint64Array([amountPerInterval]).buffer),
      Buffer.from(new BigInt64Array([BigInt(intervalSeconds)]).buffer),
      Buffer.from(new BigUint64Array([BigInt(totalIntervals)]).buffer),
      nameBuffer,
    ]);

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: sender, isSigner: true, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: stream, isSigner: false, isWritable: true },
        { pubkey: senderATA, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  private buildCancelStreamInstruction(
    sender: PublicKey,
    stream: PublicKey,
    escrow: PublicKey,
    senderATA: PublicKey
  ): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: sender, isSigner: true, isWritable: true },
        { pubkey: stream, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: senderATA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: IX_DISCRIMINATOR_CANCEL_STREAM,
    });
  }

  private buildWithdrawInstruction(
    recipient: PublicKey,
    stream: PublicKey,
    escrow: PublicKey,
    recipientATA: PublicKey
  ): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: recipient, isSigner: true, isWritable: true },
        { pubkey: stream, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: recipientATA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: IX_DISCRIMINATOR_WITHDRAW,
    });
  }

  private parseStreamAccount(pubkey: PublicKey, data: Buffer): Stream | null {
    try {
      // Skip 8-byte discriminator
      let offset = 8;

      const sender = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;

      const recipient = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;

      const mint = new PublicKey(data.subarray(offset, offset + 32));
      offset += 32;

      const amountPerInterval = data.readBigUInt64LE(offset);
      offset += 8;

      const intervalSeconds = Number(data.readBigInt64LE(offset));
      offset += 8;

      const totalIntervals = Number(data.readBigUInt64LE(offset));
      offset += 8;

      const intervalsPaid = Number(data.readBigUInt64LE(offset));
      offset += 8;

      const createdAt = Number(data.readBigInt64LE(offset));
      offset += 8;

      const lastWithdrawalAt = Number(data.readBigInt64LE(offset));
      offset += 8;

      const statusByte = data.readUInt8(offset);
      offset += 1;

      const status = this.parseStatus(statusByte);

      const nameLen = data.readUInt32LE(offset);
      offset += 4;

      const streamName = data.subarray(offset, offset + nameLen).toString('utf8');

      return {
        publicKey: pubkey,
        sender,
        recipient,
        mint,
        amountPerInterval,
        intervalSeconds,
        totalIntervals,
        intervalsPaid,
        createdAt,
        lastWithdrawalAt,
        status,
        streamName,
      };
    } catch (e) {
      console.error('Failed to parse stream account:', e);
      return null;
    }
  }

  private parseStatus(byte: number): StreamStatus {
    switch (byte) {
      case 0:
        return StreamStatus.Active;
      case 1:
        return StreamStatus.Paused;
      case 2:
        return StreamStatus.Cancelled;
      case 3:
        return StreamStatus.Completed;
      default:
        return StreamStatus.Active;
    }
  }
}

/**
 * Create a pre-configured SDK client for devnet.
 *
 * @param overrides - Optional overrides for `programId` and/or `rpcUrl`.
 * @returns A {@link P01StreamClient} connected to Solana devnet.
 *
 * @example
 * ```ts
 * // Default devnet
 * const client = createDevnetClient();
 *
 * // Custom RPC (e.g. Helius)
 * const client = createDevnetClient({
 *   rpcUrl: 'https://devnet.helius-rpc.com/?api-key=...',
 * });
 *
 * // Custom program ID (local testing)
 * const client = createDevnetClient({
 *   programId: new PublicKey('YourProgram...'),
 * });
 * ```
 */
export function createDevnetClient(overrides?: ClientOverrides): P01StreamClient {
  return new P01StreamClient({
    network: 'devnet',
    rpcUrl: overrides?.rpcUrl ?? RPC_ENDPOINTS.devnet,
    programId: overrides?.programId,
  });
}

/**
 * Create a pre-configured SDK client for mainnet-beta.
 *
 * @param overrides - Optional overrides for `programId` and/or `rpcUrl`.
 * @returns A {@link P01StreamClient} connected to Solana mainnet-beta.
 *
 * @throws {Error} "Stream program is not yet deployed on mainnet-beta.
 *   Use createDevnetClient() for testing." -- thrown when no custom `programId`
 *   is provided and the mainnet program has not been deployed yet.
 *
 * @example
 * ```ts
 * // Once deployed on mainnet
 * const client = createMainnetClient();
 *
 * // Override with your own program (e.g. forked deployment)
 * const client = createMainnetClient({
 *   programId: new PublicKey('YourMainnetProgram...'),
 * });
 * ```
 */
export function createMainnetClient(overrides?: ClientOverrides): P01StreamClient {
  if (!MAINNET_DEPLOYED && !overrides?.programId) {
    throw new Error(
      'Stream program is not yet deployed on mainnet-beta. Use createDevnetClient() for testing.'
    );
  }

  return new P01StreamClient({
    network: 'mainnet-beta',
    rpcUrl: overrides?.rpcUrl ?? RPC_ENDPOINTS['mainnet-beta'],
    programId: overrides?.programId,
  });
}
