/**
 * Transaction building and signing utilities for Protocol 01
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  SendOptions,
  TransactionSignature,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { getConnection, getRecentBlockhash } from './connection';

export interface TransactionResult {
  signature: TransactionSignature;
  success: boolean;
  error?: string;
}

export interface TransferParams {
  from: Keypair;
  to: PublicKey | string;
  lamports: number;
  memo?: string;
}

export interface TransactionOptions {
  skipPreflight?: boolean;
  preflightCommitment?: 'processed' | 'confirmed' | 'finalized';
  maxRetries?: number;
  computeUnitPrice?: number;
  computeUnitLimit?: number;
}

/**
 * Build a SOL transfer transaction
 */
export async function buildTransferTransaction(
  params: TransferParams,
  connection?: Connection
): Promise<Transaction> {
  const conn = connection || getConnection();
  const { from, to, lamports, memo } = params;

  const toPubkey = typeof to === 'string' ? new PublicKey(to) : to;

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(conn);

  // Create transfer instruction
  const transferInstruction = SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey,
    lamports,
  });

  // Build transaction
  const transaction = new Transaction({
    feePayer: from.publicKey,
    blockhash,
    lastValidBlockHeight,
  });

  transaction.add(transferInstruction);

  // Add memo if provided
  if (memo) {
    const memoInstruction = createMemoInstruction(memo, from.publicKey);
    transaction.add(memoInstruction);
  }

  return transaction;
}

/**
 * Build transaction with custom instructions
 */
export async function buildTransaction(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  connection?: Connection,
  options?: TransactionOptions
): Promise<Transaction> {
  const conn = connection || getConnection();
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(conn);

  const transaction = new Transaction({
    feePayer: payer,
    blockhash,
    lastValidBlockHeight,
  });

  // Add compute budget instructions if specified
  if (options?.computeUnitPrice) {
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: options.computeUnitPrice,
      })
    );
  }

  if (options?.computeUnitLimit) {
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: options.computeUnitLimit,
      })
    );
  }

  // Add all instructions
  for (const instruction of instructions) {
    transaction.add(instruction);
  }

  return transaction;
}

/**
 * Build versioned transaction (v0)
 */
export async function buildVersionedTransaction(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  connection?: Connection,
  addressLookupTables?: PublicKey[]
): Promise<VersionedTransaction> {
  const conn = connection || getConnection();
  const { blockhash } = await getRecentBlockhash(conn);

  // Load address lookup tables if provided
  let lookupTableAccounts: any[] = [];
  if (addressLookupTables && addressLookupTables.length > 0) {
    const lookupTablePromises = addressLookupTables.map(address =>
      conn.getAddressLookupTable(address)
    );
    const results = await Promise.all(lookupTablePromises);
    lookupTableAccounts = results
      .filter(result => result.value !== null)
      .map(result => result.value!);
  }

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTableAccounts);

  return new VersionedTransaction(messageV0);
}

/**
 * Sign transaction
 */
export function signTransaction(
  transaction: Transaction,
  signers: Keypair[]
): Transaction {
  transaction.sign(...signers);
  return transaction;
}

/**
 * Sign versioned transaction
 */
export function signVersionedTransaction(
  transaction: VersionedTransaction,
  signers: Keypair[]
): VersionedTransaction {
  transaction.sign(signers);
  return transaction;
}

/**
 * Send and confirm transaction
 */
export async function sendAndConfirmTransaction(
  transaction: Transaction,
  signers: Keypair[],
  connection?: Connection,
  options?: TransactionOptions
): Promise<TransactionResult> {
  const conn = connection || getConnection();

  try {
    // Sign transaction
    transaction.sign(...signers);

    // Send options
    const sendOptions: SendOptions = {
      skipPreflight: options?.skipPreflight ?? false,
      preflightCommitment: options?.preflightCommitment ?? 'confirmed',
      maxRetries: options?.maxRetries ?? 3,
    };

    // Send transaction
    const signature = await conn.sendRawTransaction(
      transaction.serialize(),
      sendOptions
    );

    // Confirm transaction
    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(conn);
    await conn.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    return {
      signature,
      success: true,
    };
  } catch (error) {
    return {
      signature: '',
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Send versioned transaction
 */
export async function sendVersionedTransaction(
  transaction: VersionedTransaction,
  connection?: Connection,
  options?: TransactionOptions
): Promise<TransactionResult> {
  const conn = connection || getConnection();

  try {
    const sendOptions: SendOptions = {
      skipPreflight: options?.skipPreflight ?? false,
      preflightCommitment: options?.preflightCommitment ?? 'confirmed',
      maxRetries: options?.maxRetries ?? 3,
    };

    const signature = await conn.sendRawTransaction(
      transaction.serialize(),
      sendOptions
    );

    // Confirm transaction
    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(conn);
    await conn.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    return {
      signature,
      success: true,
    };
  } catch (error) {
    return {
      signature: '',
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Transfer SOL (convenience function)
 */
export async function transferSOL(
  params: TransferParams,
  connection?: Connection,
  options?: TransactionOptions
): Promise<TransactionResult> {
  const conn = connection || getConnection();
  const transaction = await buildTransferTransaction(params, conn);
  return sendAndConfirmTransaction(transaction, [params.from], conn, options);
}

/**
 * Create memo instruction
 */
export function createMemoInstruction(
  memo: string,
  signer: PublicKey
): TransactionInstruction {
  const MEMO_PROGRAM_ID = new PublicKey(
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
  );

  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(memo, 'utf-8'),
  });
}

/**
 * Simulate transaction
 */
export async function simulateTransaction(
  transaction: Transaction,
  signers: Keypair[],
  connection?: Connection
): Promise<{
  success: boolean;
  logs: string[];
  unitsConsumed?: number;
  error?: string;
}> {
  const conn = connection || getConnection();

  try {
    transaction.sign(...signers);
    const result = await conn.simulateTransaction(transaction);

    return {
      success: result.value.err === null,
      logs: result.value.logs || [],
      unitsConsumed: result.value.unitsConsumed,
      error: result.value.err ? JSON.stringify(result.value.err) : undefined,
    };
  } catch (error) {
    return {
      success: false,
      logs: [],
      error: (error as Error).message,
    };
  }
}

/**
 * Get transaction status
 */
export async function getTransactionStatus(
  signature: string,
  connection?: Connection
): Promise<'confirmed' | 'finalized' | 'pending' | 'failed' | null> {
  const conn = connection || getConnection();

  try {
    const status = await conn.getSignatureStatus(signature);

    if (!status.value) {
      return null;
    }

    if (status.value.err) {
      return 'failed';
    }

    if (status.value.confirmationStatus === 'finalized') {
      return 'finalized';
    }

    if (status.value.confirmationStatus === 'confirmed') {
      return 'confirmed';
    }

    return 'pending';
  } catch {
    return null;
  }
}

/**
 * Wait for transaction confirmation
 */
export async function waitForConfirmation(
  signature: string,
  connection?: Connection,
  timeout: number = 60000
): Promise<boolean> {
  const conn = connection || getConnection();
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const status = await getTransactionStatus(signature, conn);

    if (status === 'confirmed' || status === 'finalized') {
      return true;
    }

    if (status === 'failed') {
      return false;
    }

    // Wait 1 second before checking again
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return false;
}

/**
 * Convert SOL to lamports
 */
export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}

/**
 * Convert lamports to SOL
 */
export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}
