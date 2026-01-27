/**
 * P-01 Fee Splitter Client
 * Client SDK to interact with the P-01 Fee Splitter Solana program
 *
 * This program automatically takes a 0.5% fee on transfers and sends it to the P-01 wallet.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { Buffer } from 'buffer';

// Program IDs - smart contract ready for deployment when funded
// Devnet: muCWm9ionWrwBavjsJudquiNSKzNEcTRm5XtKQMkWiD
// Mainnet: 7xwX64ZxMVyw7xWJPaPuy8WFcvvhJrDDWEkc64nUMDCu
// For now, using simple double-transfer method (no smart contract needed)
export const FEE_SPLITTER_PROGRAM_ID = new PublicKey(
  '7xwX64ZxMVyw7xWJPaPuy8WFcvvhJrDDWEkc64nUMDCu'
);

// Fee configuration
export const DEFAULT_FEE_BPS = 50; // 0.5%
export const FEE_WALLET = new PublicKey(
  process.env.EXPO_PUBLIC_FEE_WALLET || '3EwUAV44kvjL23emA2yHCwZvAfJbfG4MrhL6YHUrqVLi'
);

// Instruction discriminators (first 8 bytes of sha256 hash of instruction name)
const SPLIT_SOL_DIRECT_DISCRIMINATOR = Buffer.from([
  0x9d, 0x2e, 0x6e, 0x5a, 0x3c, 0x1f, 0x8b, 0x7c
]);

const SPLIT_SOL_DISCRIMINATOR = Buffer.from([
  0x5a, 0x3c, 0x1f, 0x8b, 0x7c, 0x9d, 0x2e, 0x6e
]);

/**
 * Calculate fee amount from total
 */
export function calculateFee(amount: number, feeBps: number = DEFAULT_FEE_BPS): number {
  return Math.floor((amount * feeBps) / 10000);
}

/**
 * Calculate amount after fee
 */
export function calculateNetAmount(amount: number, feeBps: number = DEFAULT_FEE_BPS): number {
  const fee = calculateFee(amount, feeBps);
  return amount - fee;
}

/**
 * Get the PDA for the fee config account
 */
export function getFeeConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('p01-fee-config')],
    FEE_SPLITTER_PROGRAM_ID
  );
}

/**
 * Build a SOL transfer instruction that goes through the fee splitter
 * Uses the "direct" method which doesn't require a config account
 */
export function buildSplitSolDirectInstruction(params: {
  sender: PublicKey;
  recipient: PublicKey;
  amount: number; // in lamports
  feeBps?: number;
  feeWallet?: PublicKey;
}): TransactionInstruction {
  const {
    sender,
    recipient,
    amount,
    feeBps = DEFAULT_FEE_BPS,
    feeWallet = FEE_WALLET,
  } = params;

  // Instruction data: discriminator + amount (u64) + fee_bps (u16)
  const data = Buffer.alloc(8 + 8 + 2);
  SPLIT_SOL_DIRECT_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(amount), 8);
  data.writeUInt16LE(feeBps, 16);

  return new TransactionInstruction({
    keys: [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: feeWallet, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: FEE_SPLITTER_PROGRAM_ID,
    data,
  });
}

/**
 * Build a complete transaction for SOL transfer with fee splitting
 */
export async function buildSplitSolTransaction(params: {
  connection: Connection;
  sender: PublicKey;
  recipient: PublicKey;
  amount: number; // in SOL (not lamports)
  feeBps?: number;
}): Promise<Transaction> {
  const { connection, sender, recipient, amount, feeBps = DEFAULT_FEE_BPS } = params;

  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

  const instruction = buildSplitSolDirectInstruction({
    sender,
    recipient,
    amount: lamports,
    feeBps,
  });

  const transaction = new Transaction().add(instruction);

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = sender;

  return transaction;
}

/**
 * Simple SOL transfer with fee (fallback if program not deployed)
 * This creates two separate transfers: one to recipient, one fee to P-01 wallet
 */
export async function buildSimpleSplitSolTransaction(params: {
  connection: Connection;
  sender: PublicKey;
  recipient: PublicKey;
  amount: number; // in SOL
  feeBps?: number;
}): Promise<Transaction> {
  const { connection, sender, recipient, amount, feeBps = DEFAULT_FEE_BPS } = params;

  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
  const feeAmount = calculateFee(lamports, feeBps);
  const recipientAmount = lamports - feeAmount;

  const transaction = new Transaction();

  // Transfer to recipient
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: sender,
      toPubkey: recipient,
      lamports: recipientAmount,
    })
  );

  // Transfer fee to P-01 wallet
  if (feeAmount > 0) {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: FEE_WALLET,
        lamports: feeAmount,
      })
    );
  }

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = sender;

  return transaction;
}

/**
 * Build SPL token transfer with fee splitting (simple version)
 * Creates two token transfers: one to recipient, one fee to P-01 wallet
 */
export async function buildSplitTokenTransaction(params: {
  connection: Connection;
  sender: PublicKey;
  recipient: PublicKey;
  tokenMint: PublicKey;
  amount: number; // in token base units
  feeBps?: number;
}): Promise<Transaction> {
  const { connection, sender, recipient, tokenMint, amount, feeBps = DEFAULT_FEE_BPS } = params;

  const feeAmount = calculateFee(amount, feeBps);
  const recipientAmount = amount - feeAmount;

  // Get token accounts
  const senderAta = await getAssociatedTokenAddress(tokenMint, sender);
  const recipientAta = await getAssociatedTokenAddress(tokenMint, recipient);
  const feeAta = await getAssociatedTokenAddress(tokenMint, FEE_WALLET);

  const transaction = new Transaction();

  // Check if recipient ATA exists, create if not
  const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
  if (!recipientAtaInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        sender, // payer
        recipientAta,
        recipient,
        tokenMint
      )
    );
  }

  // Check if fee ATA exists, create if not
  const feeAtaInfo = await connection.getAccountInfo(feeAta);
  if (!feeAtaInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        sender, // payer
        feeAta,
        FEE_WALLET,
        tokenMint
      )
    );
  }

  // Import token transfer instruction builder
  const { createTransferInstruction } = await import('@solana/spl-token');

  // Transfer to recipient
  transaction.add(
    createTransferInstruction(
      senderAta,
      recipientAta,
      sender,
      recipientAmount
    )
  );

  // Transfer fee to P-01 wallet
  if (feeAmount > 0) {
    transaction.add(
      createTransferInstruction(
        senderAta,
        feeAta,
        sender,
        feeAmount
      )
    );
  }

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = sender;

  return transaction;
}

/**
 * Format fee for display
 */
export function formatFeeDisplay(amount: number, feeBps: number = DEFAULT_FEE_BPS): string {
  const fee = calculateFee(amount, feeBps);
  const percentage = feeBps / 100;
  return `${percentage.toFixed(2)}% (${fee.toLocaleString()} units)`;
}

/**
 * Get fee breakdown for UI
 */
export function getFeeBreakdown(amount: number, feeBps: number = DEFAULT_FEE_BPS) {
  const fee = calculateFee(amount, feeBps);
  const net = amount - fee;
  const percentage = feeBps / 100;

  return {
    totalAmount: amount,
    feeAmount: fee,
    netAmount: net,
    feePercentage: percentage,
    feeWallet: FEE_WALLET.toBase58(),
  };
}

// Export types
export interface SplitResult {
  signature: string;
  totalAmount: number;
  feeAmount: number;
  recipientAmount: number;
  feeWallet: string;
}
