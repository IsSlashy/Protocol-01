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
} from './types';
import {
  STREAM_PROGRAM_ID_DEVNET,
  STREAM_PROGRAM_ID_MAINNET,
  RPC_ENDPOINTS,
  NATIVE_SOL_MINT,
} from './constants';
import {
  deriveStreamPDA,
  deriveEscrowPDA,
  calculateWithdrawableAmount,
  calculateRefundAmount,
} from './utils';

/**
 * Protocol 01 Stream SDK
 * Main client for creating and managing payment streams
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
   * Connect a wallet provider
   */
  connect(wallet: P01WalletProvider): void {
    this.wallet = wallet;
  }

  /**
   * Disconnect wallet
   */
  disconnect(): void {
    this.wallet = null;
  }

  /**
   * Get the connected wallet's public key
   */
  get publicKey(): PublicKey | null {
    return this.wallet?.publicKey || null;
  }

  /**
   * Check if wallet is connected
   */
  get isConnected(): boolean {
    return this.wallet?.connected || false;
  }

  /**
   * Get the Solana connection
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get the program ID
   */
  getProgramId(): PublicKey {
    return this.programId;
  }

  /**
   * Create a new payment stream (subscription)
   */
  async createStream(params: CreateStreamParams): Promise<string> {
    if (!this.wallet || !this.wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

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
      BigInt(amountPerInterval),
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
   * Cancel a stream and get refund
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
   * Withdraw from a stream (called by recipient)
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
   * Get a stream by address
   */
  async getStream(address: PublicKey): Promise<Stream | null> {
    const accountInfo = await this.connection.getAccountInfo(address);
    if (!accountInfo) return null;

    return this.parseStreamAccount(address, accountInfo.data);
  }

  /**
   * Get all streams where the user is the sender
   */
  async getOutgoingStreams(sender: PublicKey): Promise<Stream[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: 200 }, // Approximate stream account size
        { memcmp: { offset: 8, bytes: sender.toBase58() } },
      ],
    });

    return accounts
      .map(({ pubkey, account }) => this.parseStreamAccount(pubkey, account.data))
      .filter((s): s is Stream => s !== null);
  }

  /**
   * Get all streams where the user is the recipient
   */
  async getIncomingStreams(recipient: PublicKey): Promise<Stream[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: 200 },
        { memcmp: { offset: 40, bytes: recipient.toBase58() } }, // recipient offset
      ],
    });

    return accounts
      .map(({ pubkey, account }) => this.parseStreamAccount(pubkey, account.data))
      .filter((s): s is Stream => s !== null);
  }

  /**
   * Get all streams for the connected wallet (both incoming and outgoing)
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
   * Calculate withdrawable amount for a stream
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
   * Calculate refund amount for a stream
   */
  getRefundAmount(stream: Stream): bigint {
    return calculateRefundAmount(
      stream.amountPerInterval,
      stream.totalIntervals,
      stream.intervalsPaid
    );
  }

  // Private helper methods

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
    // Instruction discriminator for create_stream (Anchor format)
    const discriminator = Buffer.from([0x2e, 0x83, 0x64, 0x35, 0x9e, 0x1b, 0x4c, 0x5b]);

    // Serialize instruction data
    const nameBuffer = Buffer.alloc(36);
    nameBuffer.writeUInt32LE(streamName.length, 0);
    Buffer.from(streamName).copy(nameBuffer, 4);

    const data = Buffer.concat([
      discriminator,
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
    const discriminator = Buffer.from([0x24, 0x9b, 0x9b, 0x88, 0x45, 0x3e, 0x8a, 0x2c]);

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: sender, isSigner: true, isWritable: true },
        { pubkey: stream, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: senderATA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: discriminator,
    });
  }

  private buildWithdrawInstruction(
    recipient: PublicKey,
    stream: PublicKey,
    escrow: PublicKey,
    recipientATA: PublicKey
  ): TransactionInstruction {
    const discriminator = Buffer.from([0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22]);

    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: recipient, isSigner: true, isWritable: true },
        { pubkey: stream, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: recipientATA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: discriminator,
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
 * Create a pre-configured SDK client for devnet
 */
export function createDevnetClient(): P01StreamClient {
  return new P01StreamClient({
    network: 'devnet',
    rpcUrl: RPC_ENDPOINTS.devnet,
  });
}

/**
 * Create a pre-configured SDK client for mainnet
 */
export function createMainnetClient(): P01StreamClient {
  return new P01StreamClient({
    network: 'mainnet-beta',
    rpcUrl: RPC_ENDPOINTS['mainnet-beta'],
  });
}
