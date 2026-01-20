import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { Stream, StreamWithdrawOptions, WalletAdapter } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import { DEFAULT_PROGRAM_ID } from '../constants';
import { calculateWithdrawableAmount } from './create';

/**
 * Options for withdrawing from a stream
 */
export interface WithdrawOptions {
  /** Solana connection */
  connection: Connection;
  /** Stream ID (PDA) */
  streamId: PublicKey;
  /** Recipient wallet (must match stream recipient or have derived key) */
  recipient: Keypair | WalletAdapter;
  /** Amount to withdraw (defaults to all available) */
  amount?: bigint;
  /** Destination address (defaults to recipient's main wallet) */
  destination?: PublicKey;
  /** Program ID override */
  programId?: PublicKey;
}

/**
 * Withdraw available funds from a payment stream
 * @param options - Withdrawal options
 */
export async function withdrawStream(options: WithdrawOptions): Promise<{
  signature: string;
  amountWithdrawn: bigint;
  remainingBalance: bigint;
}> {
  const {
    connection,
    streamId,
    recipient,
    amount,
    destination,
    programId = DEFAULT_PROGRAM_ID,
  } = options;

  // Get stream data
  const stream = await fetchStreamData(connection, streamId, programId);

  if (!stream) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_NOT_FOUND,
      'Stream not found'
    );
  }

  // Validate stream status
  if (stream.status === 'cancelled') {
    throw new SpecterError(
      SpecterErrorCode.STREAM_ALREADY_CANCELLED,
      'Stream has been cancelled'
    );
  }

  if (stream.status === 'completed') {
    throw new SpecterError(
      SpecterErrorCode.NOTHING_TO_WITHDRAW,
      'Stream has been fully withdrawn'
    );
  }

  // Get recipient public key
  const recipientPubKey =
    'publicKey' in recipient ? recipient.publicKey : recipient.publicKey;

  // Verify recipient matches stream
  if (!recipientPubKey.equals(stream.recipient)) {
    throw new SpecterError(
      SpecterErrorCode.UNAUTHORIZED_STREAM_ACTION,
      'Only the stream recipient can withdraw'
    );
  }

  // Calculate withdrawable amount
  const withdrawableAmount = calculateWithdrawableAmount(stream);

  if (withdrawableAmount <= 0n) {
    throw new SpecterError(
      SpecterErrorCode.NOTHING_TO_WITHDRAW,
      'No funds available to withdraw yet'
    );
  }

  // Determine amount to withdraw
  const amountToWithdraw = amount
    ? amount > withdrawableAmount
      ? withdrawableAmount
      : amount
    : withdrawableAmount;

  // Determine destination
  const destinationPubKey = destination || recipientPubKey;

  try {
    // Create transaction
    const transaction = new Transaction();

    // Add compute budget
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 })
    );

    if (stream.tokenMint) {
      // Token withdrawal
      await addTokenWithdrawInstructions(
        connection,
        transaction,
        programId,
        streamId,
        stream.tokenMint,
        recipientPubKey,
        destinationPubKey,
        amountToWithdraw
      );
    } else {
      // SOL withdrawal
      transaction.add(
        createWithdrawInstruction(
          programId,
          streamId,
          recipientPubKey,
          destinationPubKey,
          amountToWithdraw,
          null
        )
      );
    }

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = recipientPubKey;

    // Sign and send
    let signature: string;
    if ('secretKey' in recipient) {
      signature = await sendAndConfirmTransaction(connection, transaction, [
        recipient,
      ]);
    } else {
      const signedTx = await recipient.signTransaction(transaction);
      signature = await connection.sendRawTransaction(signedTx.serialize());
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
    }

    const remainingBalance =
      stream.totalAmount - stream.withdrawnAmount - amountToWithdraw;

    return {
      signature,
      amountWithdrawn: amountToWithdraw,
      remainingBalance,
    };
  } catch (error) {
    if (error instanceof SpecterError) {
      throw error;
    }
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      'Failed to withdraw from stream',
      error as Error
    );
  }
}

/**
 * Withdraw all available funds from multiple streams
 */
export async function withdrawAllStreams(
  connection: Connection,
  recipient: Keypair | WalletAdapter,
  streamIds: PublicKey[],
  destination?: PublicKey,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): Promise<
  Array<{
    streamId: PublicKey;
    signature?: string;
    amountWithdrawn?: bigint;
    error?: string;
  }>
> {
  const results: Array<{
    streamId: PublicKey;
    signature?: string;
    amountWithdrawn?: bigint;
    error?: string;
  }> = [];

  for (const streamId of streamIds) {
    try {
      const result = await withdrawStream({
        connection,
        streamId,
        recipient,
        destination,
        programId,
      });

      results.push({
        streamId,
        signature: result.signature,
        amountWithdrawn: result.amountWithdrawn,
      });
    } catch (error) {
      results.push({
        streamId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Create withdraw instruction
 */
function createWithdrawInstruction(
  programId: PublicKey,
  streamPda: PublicKey,
  recipient: PublicKey,
  destination: PublicKey,
  amount: bigint,
  tokenMint: PublicKey | null
): TransactionInstruction {
  // Instruction data layout:
  // [0]: instruction discriminator (1 = withdraw)
  // [1-8]: amount (u64)

  const data = Buffer.alloc(9);
  data.writeUInt8(1, 0); // discriminator
  data.writeBigUInt64LE(amount, 1);

  const keys = [
    { pubkey: streamPda, isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: true, isWritable: false },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  if (tokenMint) {
    keys.push(
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    );
  }

  return new TransactionInstruction({
    keys,
    programId,
    data,
  });
}

/**
 * Add token withdrawal instructions
 */
async function addTokenWithdrawInstructions(
  connection: Connection,
  transaction: Transaction,
  programId: PublicKey,
  streamPda: PublicKey,
  tokenMint: PublicKey,
  recipient: PublicKey,
  destination: PublicKey,
  amount: bigint
): Promise<void> {
  const destinationAta = await getAssociatedTokenAddress(tokenMint, destination);

  // Check if destination ATA exists
  try {
    await getAccount(connection, destinationAta);
  } catch {
    // Create destination ATA
    transaction.add(
      createAssociatedTokenAccountInstruction(
        recipient, // payer
        destinationAta,
        destination,
        tokenMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Add withdraw instruction
  transaction.add(
    createWithdrawInstruction(
      programId,
      streamPda,
      recipient,
      destination,
      amount,
      tokenMint
    )
  );
}

/**
 * Fetch stream data from chain
 */
async function fetchStreamData(
  connection: Connection,
  streamId: PublicKey,
  programId: PublicKey
): Promise<Stream | null> {
  try {
    const accountInfo = await connection.getAccountInfo(streamId);

    if (!accountInfo || accountInfo.owner.toBase58() !== programId.toBase58()) {
      return null;
    }

    // Parse account data
    // This is a simplified implementation - actual parsing depends on program structure
    const data = accountInfo.data;

    if (data.length < 100) {
      return null;
    }

    // Parse stream data (simplified)
    const sender = new PublicKey(data.slice(8, 40));
    const recipient = new PublicKey(data.slice(40, 72));
    const totalAmount = data.readBigUInt64LE(72);
    const withdrawnAmount = data.readBigUInt64LE(80);
    const startTime = new Date(Number(data.readBigInt64LE(88)) * 1000);
    const endTime = new Date(Number(data.readBigInt64LE(96)) * 1000);
    const statusByte = data[104];

    let status: Stream['status'];
    switch (statusByte) {
      case 0:
        status = 'pending';
        break;
      case 1:
        status = 'active';
        break;
      case 2:
        status = 'paused';
        break;
      case 3:
        status = 'completed';
        break;
      case 4:
        status = 'cancelled';
        break;
      default:
        status = 'active';
    }

    const stream: Stream = {
      id: streamId,
      sender,
      recipient,
      totalAmount,
      withdrawnAmount,
      startTime,
      endTime,
      tokenMint: null, // Would need additional parsing
      status,
      withdrawableAmount: 0n, // Calculated separately
      privacyLevel: 'standard',
      createdAt: startTime,
      updatedAt: new Date(),
    };

    stream.withdrawableAmount = calculateWithdrawableAmount(stream);

    return stream;
  } catch (error) {
    console.error('Failed to fetch stream data:', error);
    return null;
  }
}

/**
 * Get stream info
 */
export async function getStream(
  connection: Connection,
  streamId: PublicKey,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): Promise<Stream | null> {
  return fetchStreamData(connection, streamId, programId);
}

/**
 * Get all streams for a user (as sender or recipient)
 */
export async function getUserStreams(
  connection: Connection,
  userPubKey: PublicKey,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): Promise<Stream[]> {
  // This would use getProgramAccounts with filters
  // Simplified implementation returns empty array
  // In production, filter by sender or recipient field

  try {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        {
          memcmp: {
            offset: 8, // After discriminator
            bytes: userPubKey.toBase58(),
          },
        },
      ],
    });

    const streams: Stream[] = [];

    for (const { pubkey, account } of accounts) {
      const stream = await fetchStreamData(connection, pubkey, programId);
      if (stream) {
        streams.push(stream);
      }
    }

    // Also check as recipient
    const recipientAccounts = await connection.getProgramAccounts(programId, {
      filters: [
        {
          memcmp: {
            offset: 40, // After sender field
            bytes: userPubKey.toBase58(),
          },
        },
      ],
    });

    for (const { pubkey, account } of recipientAccounts) {
      const stream = await fetchStreamData(connection, pubkey, programId);
      if (stream && !streams.find((s) => s.id.equals(stream.id))) {
        streams.push(stream);
      }
    }

    return streams;
  } catch (error) {
    console.error('Failed to fetch user streams:', error);
    return [];
  }
}
