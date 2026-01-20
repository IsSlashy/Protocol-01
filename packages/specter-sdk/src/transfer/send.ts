import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type {
  TransferRequest,
  TransferResult,
  PrivacyOptions,
  PrivacyLevel,
  StealthMetaAddress,
  WalletAdapter,
} from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import {
  generateStealthAddress,
  parseStealthMetaAddress,
  createStealthAnnouncement,
} from '../stealth/generate';
import {
  PRIVACY_CONFIG,
  DEFAULT_SPLIT_COUNT,
  MIN_SPLIT_AMOUNT,
  LAMPORTS_PER_SOL,
} from '../constants';
import {
  isValidPublicKey,
  isValidStealthMetaAddress,
  solToLamports,
  sleep,
  retry,
} from '../utils/helpers';

/**
 * Options for sending a private transfer
 */
export interface SendOptions {
  /** The wallet or keypair to send from */
  sender: Keypair | WalletAdapter;
  /** Solana connection */
  connection: Connection;
  /** Recipient's stealth meta-address or public key */
  recipient: string;
  /** Amount in SOL (or token units if tokenMint specified) */
  amount: number;
  /** Token mint for SPL token transfers (optional, defaults to SOL) */
  tokenMint?: PublicKey;
  /** Privacy options */
  privacyOptions?: PrivacyOptions;
  /** Program ID override */
  programId?: PublicKey;
  /** Skip preflight checks */
  skipPreflight?: boolean;
}

/**
 * Send a private transfer to a stealth address
 * @param options - Send options
 */
export async function sendPrivate(options: SendOptions): Promise<TransferResult> {
  const {
    sender,
    connection,
    recipient,
    amount,
    tokenMint,
    privacyOptions = {},
    skipPreflight = false,
  } = options;

  // Validate recipient
  let recipientMetaAddress: StealthMetaAddress;
  let isStealthRecipient = false;

  if (isValidStealthMetaAddress(recipient)) {
    recipientMetaAddress = parseStealthMetaAddress(recipient);
    isStealthRecipient = true;
  } else if (isValidPublicKey(recipient)) {
    // Regular public key - create a one-time stealth wrapper
    // This provides limited privacy (recipient address still visible)
    throw new SpecterError(
      SpecterErrorCode.INVALID_RECIPIENT,
      'Recipient must be a stealth meta-address for private transfers. Use sendPublic for regular transfers.'
    );
  } else {
    throw new SpecterError(
      SpecterErrorCode.INVALID_RECIPIENT,
      'Invalid recipient address format'
    );
  }

  // Get privacy level configuration
  const privacyLevel = privacyOptions.level || 'standard';
  const config = PRIVACY_CONFIG[privacyLevel];

  // Convert amount to lamports
  const amountLamports = tokenMint
    ? BigInt(Math.round(amount * 1e9)) // Assume 9 decimals, adjust based on mint
    : solToLamports(amount);

  // Get sender public key
  const senderPubKey =
    'publicKey' in sender ? sender.publicKey : sender.publicKey;

  // Check balance
  await validateBalance(connection, senderPubKey, amountLamports, tokenMint);

  // Determine if we need to split the transaction
  const splitCount = privacyOptions.splitCount || config.splitCount;
  const shouldSplit = splitCount > 1 && amountLamports >= MIN_SPLIT_AMOUNT * BigInt(splitCount);

  if (shouldSplit) {
    return sendSplitTransfer(
      connection,
      sender,
      recipientMetaAddress,
      amountLamports,
      tokenMint,
      splitCount,
      privacyOptions.splitDelay || (config.useDelay ? config.delayMs : 0),
      skipPreflight
    );
  }

  // Single transfer
  return sendSingleTransfer(
    connection,
    sender,
    recipientMetaAddress,
    amountLamports,
    tokenMint,
    skipPreflight
  );
}

/**
 * Send a single stealth transfer
 */
async function sendSingleTransfer(
  connection: Connection,
  sender: Keypair | WalletAdapter,
  recipientMetaAddress: StealthMetaAddress,
  amount: bigint,
  tokenMint: PublicKey | undefined,
  skipPreflight: boolean
): Promise<TransferResult> {
  // Generate stealth address for this transfer
  const stealth = generateStealthAddress(recipientMetaAddress);

  // Create transaction
  const transaction = new Transaction();

  // Add compute budget for complex operations
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })
  );

  if (tokenMint) {
    // SPL Token transfer
    const senderPubKey =
      'publicKey' in sender ? sender.publicKey : sender.publicKey;
    const senderAta = await getAssociatedTokenAddress(tokenMint, senderPubKey);
    const stealthAta = await getAssociatedTokenAddress(
      tokenMint,
      stealth.address
    );

    transaction.add(
      createTransferInstruction(
        senderAta,
        stealthAta,
        senderPubKey,
        amount,
        [],
        TOKEN_PROGRAM_ID
      )
    );
  } else {
    // SOL transfer
    const senderPubKey =
      'publicKey' in sender ? sender.publicKey : sender.publicKey;

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: senderPubKey,
        toPubkey: stealth.address,
        lamports: amount,
      })
    );
  }

  // Add stealth announcement memo
  const announcement = createStealthAnnouncement(
    stealth.address,
    stealth.ephemeralPubKey,
    stealth.viewTag
  );

  // Add memo instruction with announcement data
  transaction.add(
    createMemoInstruction(announcement)
  );

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer =
    'publicKey' in sender ? sender.publicKey : sender.publicKey;

  // Sign and send
  let signature: string;
  if ('secretKey' in sender) {
    signature = await sendAndConfirmTransaction(connection, transaction, [sender], {
      skipPreflight,
    });
  } else {
    const signedTx = await sender.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight,
    });
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });
  }

  return {
    signature,
    stealthAddress: stealth.address,
    ephemeralPubKey: stealth.ephemeralPubKey,
    confirmed: true,
    fee: 5000n, // Base fee, actual may vary
  };
}

/**
 * Send a split transfer for enhanced privacy
 */
async function sendSplitTransfer(
  connection: Connection,
  sender: Keypair | WalletAdapter,
  recipientMetaAddress: StealthMetaAddress,
  totalAmount: bigint,
  tokenMint: PublicKey | undefined,
  splitCount: number,
  delayMs: number,
  skipPreflight: boolean
): Promise<TransferResult> {
  const amountPerSplit = totalAmount / BigInt(splitCount);
  const remainder = totalAmount % BigInt(splitCount);

  const results: TransferResult[] = [];

  for (let i = 0; i < splitCount; i++) {
    // Last split gets the remainder
    const amount = i === splitCount - 1 ? amountPerSplit + remainder : amountPerSplit;

    const result = await retry(
      () =>
        sendSingleTransfer(
          connection,
          sender,
          recipientMetaAddress,
          amount,
          tokenMint,
          skipPreflight
        ),
      3,
      1000
    );

    results.push(result);

    // Delay between splits
    if (i < splitCount - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  // Return the last result with total info
  const lastResult = results[results.length - 1]!;
  return {
    ...lastResult,
    fee: results.reduce((sum, r) => sum + r.fee, 0n),
  };
}

/**
 * Send a regular (non-stealth) transfer
 */
export async function sendPublic(
  connection: Connection,
  sender: Keypair | WalletAdapter,
  recipient: string,
  amount: number,
  tokenMint?: PublicKey
): Promise<{ signature: string }> {
  if (!isValidPublicKey(recipient)) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_RECIPIENT,
      'Invalid recipient public key'
    );
  }

  const recipientPubKey = new PublicKey(recipient);
  const senderPubKey =
    'publicKey' in sender ? sender.publicKey : sender.publicKey;
  const amountLamports = tokenMint
    ? BigInt(Math.round(amount * 1e9))
    : solToLamports(amount);

  const transaction = new Transaction();

  if (tokenMint) {
    const senderAta = await getAssociatedTokenAddress(tokenMint, senderPubKey);
    const recipientAta = await getAssociatedTokenAddress(tokenMint, recipientPubKey);

    transaction.add(
      createTransferInstruction(
        senderAta,
        recipientAta,
        senderPubKey,
        amountLamports,
        [],
        TOKEN_PROGRAM_ID
      )
    );
  } else {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: senderPubKey,
        toPubkey: recipientPubKey,
        lamports: amountLamports,
      })
    );
  }

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

  return { signature };
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Validate sender has sufficient balance
 */
async function validateBalance(
  connection: Connection,
  sender: PublicKey,
  amount: bigint,
  tokenMint?: PublicKey
): Promise<void> {
  if (tokenMint) {
    const ata = await getAssociatedTokenAddress(tokenMint, sender);
    try {
      const account = await getAccount(connection, ata);
      if (account.amount < amount) {
        throw new SpecterError(
          SpecterErrorCode.INSUFFICIENT_BALANCE,
          `Insufficient token balance. Have: ${account.amount}, Need: ${amount}`
        );
      }
    } catch (error) {
      if (error instanceof SpecterError) throw error;
      throw new SpecterError(
        SpecterErrorCode.INSUFFICIENT_BALANCE,
        'Token account not found or has insufficient balance'
      );
    }
  } else {
    const balance = await connection.getBalance(sender);
    const requiredWithFee = amount + 10_000n; // Add buffer for fees
    if (BigInt(balance) < requiredWithFee) {
      throw new SpecterError(
        SpecterErrorCode.INSUFFICIENT_BALANCE,
        `Insufficient SOL balance. Have: ${balance}, Need: ${requiredWithFee}`
      );
    }
  }
}

/**
 * Create a memo instruction for stealth announcement
 */
function createMemoInstruction(data: Uint8Array): TransactionInstruction {
  const MEMO_PROGRAM_ID = new PublicKey(
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
  );

  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(data),
  });
}

/**
 * Estimate transfer fees
 */
export async function estimateTransferFee(
  connection: Connection,
  privacyLevel: PrivacyLevel = 'standard'
): Promise<bigint> {
  const config = PRIVACY_CONFIG[privacyLevel];
  const baseFee = 5000n; // Base transaction fee
  const splitMultiplier = BigInt(config.splitCount);

  // Account creation fee if needed
  const rentExemption = await connection.getMinimumBalanceForRentExemption(0);

  return baseFee * splitMultiplier + BigInt(rentExemption);
}
