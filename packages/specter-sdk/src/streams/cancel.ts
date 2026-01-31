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
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { Stream, WalletAdapter } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import { DEFAULT_PROGRAM_ID } from '../constants';
import { getStream } from './withdraw';
import { calculateWithdrawableAmount } from './create';

/**
 * Options for cancelling a stream
 */
export interface CancelOptions {
  /** Solana connection */
  connection: Connection;
  /** Stream ID (PDA) */
  streamId: PublicKey;
  /** Sender wallet (must be the stream creator) */
  sender: Keypair | WalletAdapter;
  /** Whether to refund remaining funds to sender */
  refundToSender?: boolean;
  /** Program ID override */
  programId?: PublicKey;
}

/**
 * Cancel a payment stream
 * Remaining unvested funds are returned to the sender
 * Already vested funds are sent to the recipient
 *
 * @param options - Cancellation options
 */
export async function cancelStream(options: CancelOptions): Promise<{
  signature: string;
  refundedToSender: bigint;
  sentToRecipient: bigint;
}> {
  const {
    connection,
    streamId,
    sender,
    refundToSender = true,
    programId = DEFAULT_PROGRAM_ID,
  } = options;

  // Get stream data
  const stream = await getStream(connection, streamId, programId);

  if (!stream) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_NOT_FOUND,
      'Stream not found'
    );
  }

  // Validate stream can be cancelled
  if (stream.status === 'cancelled') {
    throw new SpecterError(
      SpecterErrorCode.STREAM_ALREADY_CANCELLED,
      'Stream has already been cancelled'
    );
  }

  if (stream.status === 'completed') {
    throw new SpecterError(
      SpecterErrorCode.STREAM_ALREADY_CANCELLED,
      'Cannot cancel a completed stream'
    );
  }

  // Get sender public key
  const senderPubKey =
    sender.publicKey;

  // Verify sender is the stream creator
  if (!senderPubKey.equals(stream.sender)) {
    throw new SpecterError(
      SpecterErrorCode.UNAUTHORIZED_STREAM_ACTION,
      'Only the stream sender can cancel'
    );
  }

  // Calculate amounts
  const vestedAmount = calculateWithdrawableAmount(stream) + stream.withdrawnAmount;
  const unvestedAmount = stream.totalAmount - vestedAmount;
  const recipientOwed = vestedAmount - stream.withdrawnAmount;

  try {
    // Create transaction
    const transaction = new Transaction();

    // Add compute budget
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })
    );

    // Add cancel instruction
    transaction.add(
      createCancelInstruction(
        programId,
        streamId,
        senderPubKey,
        stream.recipient,
        stream.tokenMint,
        refundToSender
      )
    );

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = senderPubKey;

    // Sign and send
    let signature: string;
    if ('secretKey' in sender) {
      signature = await sendAndConfirmTransaction(connection, transaction, [
        sender,
      ]);
    } else {
      const signedTx = await sender.signTransaction(transaction);
      signature = await connection.sendRawTransaction(signedTx.serialize());
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
    }

    return {
      signature,
      refundedToSender: refundToSender ? unvestedAmount : 0n,
      sentToRecipient: recipientOwed,
    };
  } catch (error) {
    if (error instanceof SpecterError) {
      throw error;
    }
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      'Failed to cancel stream',
      error as Error
    );
  }
}

/**
 * Pause a payment stream (if pausable)
 */
export async function pauseStream(
  connection: Connection,
  streamId: PublicKey,
  sender: Keypair | WalletAdapter,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): Promise<string> {
  const stream = await getStream(connection, streamId, programId);

  if (!stream) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_NOT_FOUND,
      'Stream not found'
    );
  }

  if (stream.status !== 'active') {
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      `Cannot pause stream with status: ${stream.status}`
    );
  }

  const senderPubKey =
    sender.publicKey;

  if (!senderPubKey.equals(stream.sender)) {
    throw new SpecterError(
      SpecterErrorCode.UNAUTHORIZED_STREAM_ACTION,
      'Only the stream sender can pause'
    );
  }

  const transaction = new Transaction();

  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })
  );

  transaction.add(
    createPauseInstruction(programId, streamId, senderPubKey, true)
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = senderPubKey;

  let signature: string;
  if ('secretKey' in sender) {
    signature = await sendAndConfirmTransaction(connection, transaction, [sender]);
  } else {
    const signedTx = await sender.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });
  }

  return signature;
}

/**
 * Resume a paused payment stream
 */
export async function resumeStream(
  connection: Connection,
  streamId: PublicKey,
  sender: Keypair | WalletAdapter,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): Promise<string> {
  const stream = await getStream(connection, streamId, programId);

  if (!stream) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_NOT_FOUND,
      'Stream not found'
    );
  }

  if (stream.status !== 'paused') {
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      `Cannot resume stream with status: ${stream.status}`
    );
  }

  const senderPubKey =
    sender.publicKey;

  if (!senderPubKey.equals(stream.sender)) {
    throw new SpecterError(
      SpecterErrorCode.UNAUTHORIZED_STREAM_ACTION,
      'Only the stream sender can resume'
    );
  }

  const transaction = new Transaction();

  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })
  );

  transaction.add(
    createPauseInstruction(programId, streamId, senderPubKey, false)
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = senderPubKey;

  let signature: string;
  if ('secretKey' in sender) {
    signature = await sendAndConfirmTransaction(connection, transaction, [sender]);
  } else {
    const signedTx = await sender.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });
  }

  return signature;
}

// ============================================================================
// Instruction builders
// ============================================================================

/**
 * Create cancel stream instruction
 */
function createCancelInstruction(
  programId: PublicKey,
  streamPda: PublicKey,
  sender: PublicKey,
  recipient: PublicKey,
  tokenMint: PublicKey | null,
  refundToSender: boolean
): TransactionInstruction {
  // Instruction data layout:
  // [0]: instruction discriminator (2 = cancel)
  // [1]: refund_to_sender (bool)

  const data = Buffer.alloc(2);
  data.writeUInt8(2, 0); // discriminator
  data.writeUInt8(refundToSender ? 1 : 0, 1);

  const keys = [
    { pubkey: streamPda, isSigner: false, isWritable: true },
    { pubkey: sender, isSigner: true, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  if (tokenMint) {
    const senderAta = getAssociatedTokenAddress(tokenMint, sender);
    const recipientAta = getAssociatedTokenAddress(tokenMint, recipient);
    const streamAta = getAssociatedTokenAddress(tokenMint, streamPda, true);

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
 * Create pause/resume instruction
 */
function createPauseInstruction(
  programId: PublicKey,
  streamPda: PublicKey,
  sender: PublicKey,
  pause: boolean
): TransactionInstruction {
  // Instruction data layout:
  // [0]: instruction discriminator (3 = pause/resume)
  // [1]: pause (bool)

  const data = Buffer.alloc(2);
  data.writeUInt8(3, 0); // discriminator
  data.writeUInt8(pause ? 1 : 0, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: streamPda, isSigner: false, isWritable: true },
      { pubkey: sender, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Force close an expired stream and reclaim rent
 */
export async function closeExpiredStream(
  connection: Connection,
  streamId: PublicKey,
  closeAuthority: Keypair | WalletAdapter,
  programId: PublicKey = DEFAULT_PROGRAM_ID
): Promise<string> {
  const stream = await getStream(connection, streamId, programId);

  if (!stream) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_NOT_FOUND,
      'Stream not found'
    );
  }

  // Stream must be completed and fully withdrawn
  if (
    stream.status !== 'completed' ||
    stream.withdrawnAmount < stream.totalAmount
  ) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      'Stream must be completed and fully withdrawn to close'
    );
  }

  const authorityPubKey =
    closeAuthority.publicKey;

  const transaction = new Transaction();

  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })
  );

  // Add close instruction (discriminator = 4)
  const data = Buffer.alloc(1);
  data.writeUInt8(4, 0);

  transaction.add(
    new TransactionInstruction({
      keys: [
        { pubkey: streamId, isSigner: false, isWritable: true },
        { pubkey: authorityPubKey, isSigner: true, isWritable: true },
        { pubkey: stream.sender, isSigner: false, isWritable: true },
      ],
      programId,
      data,
    })
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = authorityPubKey;

  let signature: string;
  if ('secretKey' in closeAuthority) {
    signature = await sendAndConfirmTransaction(connection, transaction, [
      closeAuthority,
    ]);
  } else {
    const signedTx = await closeAuthority.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });
  }

  return signature;
}
