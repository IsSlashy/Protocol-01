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
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type {
  Stream,
  StreamCreateOptions,
  StreamStatus,
  PrivacyLevel,
  WalletAdapter,
  StealthMetaAddress,
} from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import {
  MIN_STREAM_DURATION,
  MAX_STREAM_DURATION,
  MIN_STREAM_AMOUNT,
  STREAM_SEED,
  DEFAULT_PROGRAM_ID,
} from '../constants';
import {
  solToLamports,
  daysToSeconds,
  isValidStealthMetaAddress,
  isValidPublicKey,
} from '../utils/helpers';
import { generateStealthAddress, parseStealthMetaAddress } from '../stealth/generate';

/**
 * Options for creating a payment stream
 */
export interface CreateStreamOptions {
  /** Solana connection */
  connection: Connection;
  /** Sender wallet */
  sender: Keypair | WalletAdapter;
  /** Recipient's stealth meta-address or public key */
  recipient: string;
  /** Total amount to stream in SOL (or token units) */
  totalAmount: number;
  /** Stream duration in days */
  durationDays: number;
  /** Token mint for SPL token streams (optional) */
  tokenMint?: PublicKey;
  /** Additional options */
  options?: StreamCreateOptions;
  /** Program ID override */
  programId?: PublicKey;
}

/**
 * Create a new payment stream
 * @param params - Stream creation parameters
 */
export async function createStream(params: CreateStreamOptions): Promise<Stream> {
  const {
    connection,
    sender,
    recipient,
    totalAmount,
    durationDays,
    tokenMint,
    options = {},
    programId = DEFAULT_PROGRAM_ID,
  } = params;

  // Validate duration
  const durationSeconds = daysToSeconds(durationDays);
  if (durationSeconds < MIN_STREAM_DURATION) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      `Stream duration must be at least ${MIN_STREAM_DURATION / 3600} hour(s)`
    );
  }
  if (durationSeconds > MAX_STREAM_DURATION) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      `Stream duration cannot exceed ${MAX_STREAM_DURATION / (365 * 24 * 3600)} years`
    );
  }

  // Convert amount
  const totalAmountLamports = tokenMint
    ? BigInt(Math.round(totalAmount * 1e9))
    : solToLamports(totalAmount);

  // Validate amount
  if (totalAmountLamports < MIN_STREAM_AMOUNT) {
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      `Stream amount must be at least ${Number(MIN_STREAM_AMOUNT) / 1e9} SOL`
    );
  }

  // Get sender public key
  const senderPubKey =
    'publicKey' in sender ? sender.publicKey : sender.publicKey;

  // Determine recipient address
  let recipientPubKey: PublicKey;
  let isStealthRecipient = false;

  if (isValidStealthMetaAddress(recipient)) {
    // Generate stealth address for the stream
    const metaAddress = parseStealthMetaAddress(recipient);
    const stealth = generateStealthAddress(metaAddress);
    recipientPubKey = stealth.address;
    isStealthRecipient = true;
  } else if (isValidPublicKey(recipient)) {
    recipientPubKey = new PublicKey(recipient);
  } else {
    throw new SpecterError(
      SpecterErrorCode.INVALID_RECIPIENT,
      'Invalid recipient address format'
    );
  }

  // Calculate timestamps
  const startTime = options.startTime || new Date();
  const startTimestamp = Math.floor(startTime.getTime() / 1000);
  const endTimestamp = startTimestamp + durationSeconds;

  // Derive stream PDA
  const [streamPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(STREAM_SEED),
      senderPubKey.toBuffer(),
      recipientPubKey.toBuffer(),
      Buffer.from(new BigUint64Array([BigInt(startTimestamp)]).buffer),
    ],
    programId
  );

  try {
    // Create transaction
    const transaction = new Transaction();

    // Add compute budget
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })
    );

    // Create stream instruction
    const createStreamIx = createStreamInstruction(
      programId,
      senderPubKey,
      recipientPubKey,
      streamPda,
      totalAmountLamports,
      startTimestamp,
      endTimestamp,
      tokenMint,
      options.cancellable ?? true,
      options.pausable ?? false,
      options.cliffPeriod ?? 0
    );

    transaction.add(createStreamIx);

    // If token stream, transfer tokens to stream PDA
    if (tokenMint) {
      const senderAta = await getAssociatedTokenAddress(tokenMint, senderPubKey);
      const streamAta = await getAssociatedTokenAddress(tokenMint, streamPda, true);

      // Create stream token account if needed
      // (would be done by the program)

      transaction.add(
        createTransferInstruction(
          senderAta,
          streamAta,
          senderPubKey,
          totalAmountLamports,
          [],
          TOKEN_PROGRAM_ID
        )
      );
    } else {
      // Transfer SOL to stream PDA
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: senderPubKey,
          toPubkey: streamPda,
          lamports: totalAmountLamports,
        })
      );
    }

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = senderPubKey;

    // Sign and send
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

    // Return stream object
    const stream: Stream = {
      id: streamPda,
      sender: senderPubKey,
      recipient: recipientPubKey,
      totalAmount: totalAmountLamports,
      withdrawnAmount: 0n,
      startTime,
      endTime: new Date(endTimestamp * 1000),
      tokenMint: tokenMint || null,
      status: startTime <= new Date() ? 'active' : 'pending',
      withdrawableAmount: 0n,
      privacyLevel: isStealthRecipient ? 'standard' : 'standard',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return stream;
  } catch (error) {
    if (error instanceof SpecterError) {
      throw error;
    }
    throw new SpecterError(
      SpecterErrorCode.STREAM_CREATION_FAILED,
      'Failed to create payment stream',
      error as Error
    );
  }
}

/**
 * Create stream instruction data
 */
function createStreamInstruction(
  programId: PublicKey,
  sender: PublicKey,
  recipient: PublicKey,
  streamPda: PublicKey,
  amount: bigint,
  startTime: number,
  endTime: number,
  tokenMint: PublicKey | undefined,
  cancellable: boolean,
  pausable: boolean,
  cliffPeriod: number
): TransactionInstruction {
  // Instruction data layout:
  // [0]: instruction discriminator (0 = create_stream)
  // [1-8]: amount (u64)
  // [9-16]: start_time (i64)
  // [17-24]: end_time (i64)
  // [25]: cancellable (bool)
  // [26]: pausable (bool)
  // [27-30]: cliff_period (u32)

  const data = Buffer.alloc(31);
  data.writeUInt8(0, 0); // discriminator
  data.writeBigUInt64LE(amount, 1);
  data.writeBigInt64LE(BigInt(startTime), 9);
  data.writeBigInt64LE(BigInt(endTime), 17);
  data.writeUInt8(cancellable ? 1 : 0, 25);
  data.writeUInt8(pausable ? 1 : 0, 26);
  data.writeUInt32LE(cliffPeriod, 27);

  const keys = [
    { pubkey: sender, isSigner: true, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: false },
    { pubkey: streamPda, isSigner: false, isWritable: true },
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
 * Calculate stream rate (amount per second)
 */
export function calculateStreamRate(
  totalAmount: bigint,
  durationSeconds: number
): bigint {
  return totalAmount / BigInt(durationSeconds);
}

/**
 * Calculate currently streamable amount
 */
export function calculateWithdrawableAmount(stream: Stream): bigint {
  const now = new Date();

  if (now < stream.startTime) {
    return 0n;
  }

  if (now >= stream.endTime) {
    return stream.totalAmount - stream.withdrawnAmount;
  }

  const elapsed = Math.floor((now.getTime() - stream.startTime.getTime()) / 1000);
  const totalDuration = Math.floor(
    (stream.endTime.getTime() - stream.startTime.getTime()) / 1000
  );

  const streamedAmount =
    (stream.totalAmount * BigInt(elapsed)) / BigInt(totalDuration);

  return streamedAmount - stream.withdrawnAmount;
}

/**
 * Get stream progress percentage
 */
export function getStreamProgress(stream: Stream): number {
  const now = new Date();

  if (now < stream.startTime) {
    return 0;
  }

  if (now >= stream.endTime) {
    return 100;
  }

  const elapsed = now.getTime() - stream.startTime.getTime();
  const total = stream.endTime.getTime() - stream.startTime.getTime();

  return Math.min(100, Math.max(0, (elapsed / total) * 100));
}

/**
 * Estimate stream creation fee
 */
export async function estimateStreamCreationFee(
  connection: Connection,
  tokenMint?: PublicKey
): Promise<bigint> {
  const baseFee = 5000n;
  const rentExemption = await connection.getMinimumBalanceForRentExemption(
    tokenMint ? 200 : 100 // Approximate account size
  );

  return baseFee + BigInt(rentExemption);
}
