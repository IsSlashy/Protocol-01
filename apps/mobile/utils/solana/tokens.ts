/**
 * SPL Token helpers for Protocol 01
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getMint,
  TokenAccountNotFoundError,
  Account as TokenAccount,
  Mint,
} from '@solana/spl-token';
import { getConnection, getRecentBlockhash } from './connection';
import { sendAndConfirmTransaction, TransactionResult, TransactionOptions } from './transaction';

export interface TokenInfo {
  mint: string;
  owner: string;
  amount: bigint;
  decimals: number;
  address: string;
}

export interface TokenTransferParams {
  from: Keypair;
  to: PublicKey | string;
  mint: PublicKey | string;
  amount: number | bigint;
  decimals?: number;
  createAta?: boolean;
}

export interface TokenBalance {
  mint: string;
  balance: number;
  decimals: number;
  uiAmount: number;
}

/**
 * Get associated token address
 */
export function getAssociatedTokenAddress(
  mint: PublicKey | string,
  owner: PublicKey | string,
  allowOwnerOffCurve: boolean = false
): PublicKey {
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;

  return getAssociatedTokenAddressSync(
    mintPubkey,
    ownerPubkey,
    allowOwnerOffCurve
  );
}

/**
 * Get token account info
 */
export async function getTokenAccount(
  address: PublicKey | string,
  connection?: Connection
): Promise<TokenAccount | null> {
  const conn = connection || getConnection();
  const accountAddress = typeof address === 'string' ? new PublicKey(address) : address;

  try {
    return await getAccount(conn, accountAddress);
  } catch (error) {
    if (error instanceof TokenAccountNotFoundError) {
      return null;
    }
    throw error;
  }
}

/**
 * Get mint info
 */
export async function getMintInfo(
  mint: PublicKey | string,
  connection?: Connection
): Promise<Mint> {
  const conn = connection || getConnection();
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  return getMint(conn, mintPubkey);
}

/**
 * Get token balance
 */
export async function getTokenBalance(
  mint: PublicKey | string,
  owner: PublicKey | string,
  connection?: Connection
): Promise<TokenBalance | null> {
  const conn = connection || getConnection();
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;

  const ata = getAssociatedTokenAddress(mintPubkey, owner);

  try {
    const account = await getAccount(conn, ata);
    const mintInfo = await getMint(conn, mintPubkey);

    const balance = Number(account.amount);
    const uiAmount = balance / Math.pow(10, mintInfo.decimals);

    return {
      mint: mintPubkey.toBase58(),
      balance,
      decimals: mintInfo.decimals,
      uiAmount,
    };
  } catch (error) {
    if (error instanceof TokenAccountNotFoundError) {
      return null;
    }
    throw error;
  }
}

/**
 * Get all token accounts for an owner
 */
export async function getTokenAccounts(
  owner: PublicKey | string,
  connection?: Connection
): Promise<TokenInfo[]> {
  const conn = connection || getConnection();
  const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;

  const accounts = await conn.getParsedTokenAccountsByOwner(ownerPubkey, {
    programId: TOKEN_PROGRAM_ID,
  });

  return accounts.value.map(({ pubkey, account }) => {
    const parsed = account.data.parsed.info;
    return {
      mint: parsed.mint,
      owner: parsed.owner,
      amount: BigInt(parsed.tokenAmount.amount),
      decimals: parsed.tokenAmount.decimals,
      address: pubkey.toBase58(),
    };
  });
}

/**
 * Check if ATA exists
 */
export async function ataExists(
  mint: PublicKey | string,
  owner: PublicKey | string,
  connection?: Connection
): Promise<boolean> {
  const ata = getAssociatedTokenAddress(mint, owner);
  const account = await getTokenAccount(ata, connection);
  return account !== null;
}

/**
 * Create ATA instruction
 */
export function createAtaInstruction(
  mint: PublicKey | string,
  owner: PublicKey | string,
  payer: PublicKey
): TransactionInstruction {
  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const ownerPubkey = typeof owner === 'string' ? new PublicKey(owner) : owner;
  const ata = getAssociatedTokenAddress(mintPubkey, ownerPubkey);

  return createAssociatedTokenAccountInstruction(
    payer,
    ata,
    ownerPubkey,
    mintPubkey
  );
}

/**
 * Build token transfer transaction
 */
export async function buildTokenTransferTransaction(
  params: TokenTransferParams,
  connection?: Connection
): Promise<Transaction> {
  const conn = connection || getConnection();
  const { from, to, mint, amount, decimals, createAta = true } = params;

  const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const toPubkey = typeof to === 'string' ? new PublicKey(to) : to;

  // Get ATAs
  const fromAta = getAssociatedTokenAddress(mintPubkey, from.publicKey);
  const toAta = getAssociatedTokenAddress(mintPubkey, toPubkey);

  // Get blockhash
  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(conn);

  const transaction = new Transaction({
    feePayer: from.publicKey,
    blockhash,
    lastValidBlockHeight,
  });

  // Check if destination ATA exists
  if (createAta) {
    const destAccount = await getTokenAccount(toAta, conn);
    if (!destAccount) {
      transaction.add(createAtaInstruction(mintPubkey, toPubkey, from.publicKey));
    }
  }

  // Add transfer instruction
  const amountBigInt = typeof amount === 'bigint' ? amount : BigInt(amount);

  if (decimals !== undefined) {
    // Use checked transfer
    transaction.add(
      createTransferCheckedInstruction(
        fromAta,
        mintPubkey,
        toAta,
        from.publicKey,
        amountBigInt,
        decimals
      )
    );
  } else {
    // Use standard transfer
    transaction.add(
      createTransferInstruction(
        fromAta,
        toAta,
        from.publicKey,
        amountBigInt
      )
    );
  }

  return transaction;
}

/**
 * Transfer tokens (convenience function)
 */
export async function transferTokens(
  params: TokenTransferParams,
  connection?: Connection,
  options?: TransactionOptions
): Promise<TransactionResult> {
  const conn = connection || getConnection();
  const transaction = await buildTokenTransferTransaction(params, conn);
  return sendAndConfirmTransaction(transaction, [params.from], conn, options);
}

/**
 * Get token metadata (basic)
 */
export async function getTokenMetadata(
  mint: PublicKey | string,
  connection?: Connection
): Promise<{
  mint: string;
  decimals: number;
  supply: bigint;
  isInitialized: boolean;
  freezeAuthority: string | null;
  mintAuthority: string | null;
}> {
  const mintInfo = await getMintInfo(mint, connection);

  return {
    mint: typeof mint === 'string' ? mint : mint.toBase58(),
    decimals: mintInfo.decimals,
    supply: mintInfo.supply,
    isInitialized: mintInfo.isInitialized,
    freezeAuthority: mintInfo.freezeAuthority?.toBase58() || null,
    mintAuthority: mintInfo.mintAuthority?.toBase58() || null,
  };
}

/**
 * Parse token amount with decimals
 */
export function parseTokenAmount(amount: string | number, decimals: number): bigint {
  const value = typeof amount === 'string' ? parseFloat(amount) : amount;
  return BigInt(Math.floor(value * Math.pow(10, decimals)));
}

/**
 * Format token amount for display
 */
export function formatTokenAmount(amount: bigint | number, decimals: number): number {
  const value = typeof amount === 'bigint' ? Number(amount) : amount;
  return value / Math.pow(10, decimals);
}

/**
 * Get native SOL as wrapped token info
 */
export function getWrappedSolInfo(): {
  mint: string;
  decimals: number;
  symbol: string;
  name: string;
} {
  return {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'SOL',
    name: 'Wrapped SOL',
  };
}

/**
 * Check if mint is wrapped SOL
 */
export function isWrappedSol(mint: string): boolean {
  return mint === 'So11111111111111111111111111111111111111112';
}

/**
 * Close token account (to reclaim rent)
 */
export async function closeTokenAccountInstruction(
  account: PublicKey | string,
  destination: PublicKey,
  owner: PublicKey
): Promise<TransactionInstruction> {
  const { createCloseAccountInstruction } = await import('@solana/spl-token');
  const accountPubkey = typeof account === 'string' ? new PublicKey(account) : account;

  return createCloseAccountInstruction(accountPubkey, destination, owner);
}
