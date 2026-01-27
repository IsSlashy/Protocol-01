/**
 * Transaction service for fetching and parsing Solana transactions
 */

import {
  PublicKey,
  LAMPORTS_PER_SOL,
  ParsedTransactionWithMeta,
  ParsedInstruction,
} from '@solana/web3.js';
import { getConnection, NetworkType } from './wallet';
import type { TransactionRecord } from '../types';

// Rate limit handling
const MAX_RETRIES = 2;
const RETRY_DELAY = 2000; // 2 seconds

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const errorMsg = error?.message || '';
    const shouldRetry = errorMsg.includes('429') ||
                        errorMsg.includes('rate') ||
                        errorMsg.includes('503') ||
                        errorMsg.includes('timeout');

    if (retries > 0 && shouldRetry) {
      console.log(`[Transactions] RPC rate limit, retrying in ${RETRY_DELAY}ms...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return withRetry(fn, retries - 1);
    }
    throw error;
  }
}

/**
 * Process items in batches with delay between batches to avoid rate limiting
 */
async function batchProcess<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  batchSize: number = 3,
  delayMs: number = 500
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);

    // Add delay between batches (but not after the last one)
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Parse a Solana transaction to extract relevant info
 */
function parseTransaction(
  tx: ParsedTransactionWithMeta,
  signature: string,
  blockTime: number | null,
  walletAddress: string
): TransactionRecord | null {
  try {
    if (!tx?.meta || !tx.transaction?.message?.instructions) {
      return null;
    }

    const instructions = tx.transaction.message.instructions;
    const accountKeys = tx.transaction.message.accountKeys;

    // Find the first relevant instruction
    for (const instruction of instructions) {
      const parsed = instruction as ParsedInstruction;

      // Handle System Program transfers (SOL)
      if (parsed.program === 'system' && parsed.parsed?.type === 'transfer') {
        const { source, destination, lamports } = parsed.parsed.info;
        const amount = lamports / LAMPORTS_PER_SOL;

        const isSend = source === walletAddress;
        const isReceive = destination === walletAddress;

        if (!isSend && !isReceive) continue;

        return {
          signature,
          type: isSend ? 'send' : 'receive',
          amount,
          tokenSymbol: 'SOL',
          tokenMint: 'So11111111111111111111111111111111111111112',
          counterparty: isSend ? destination : source,
          timestamp: blockTime ? blockTime * 1000 : Date.now(),
          status: tx.meta.err ? 'failed' : 'confirmed',
          isPrivate: false,
          fee: (tx.meta.fee || 0) / LAMPORTS_PER_SOL,
        };
      }

      // Handle SPL Token transfers
      if (parsed.program === 'spl-token') {
        const parsedType = parsed.parsed?.type;

        if (parsedType === 'transfer' || parsedType === 'transferChecked') {
          const info = parsed.parsed.info;
          const amount = info.tokenAmount?.uiAmount ||
                        Number(info.amount) / Math.pow(10, info.tokenAmount?.decimals || 9);

          // Check pre/post token balances to determine direction
          const preBalances = tx.meta.preTokenBalances || [];
          const postBalances = tx.meta.postTokenBalances || [];

          let isSend = false;
          let isReceive = false;
          let counterparty = '';
          let tokenMint = info.mint || '';

          // Check if wallet owns source or destination
          for (const bal of preBalances) {
            if (bal.owner === walletAddress) {
              // Wallet has a balance, check if it decreased
              const postBal = postBalances.find(
                (pb) => pb.accountIndex === bal.accountIndex
              );
              if (postBal && Number(postBal.uiTokenAmount.uiAmount) < Number(bal.uiTokenAmount.uiAmount)) {
                isSend = true;
                tokenMint = bal.mint;
              }
            }
          }

          for (const bal of postBalances) {
            if (bal.owner === walletAddress) {
              const preBal = preBalances.find(
                (pb) => pb.accountIndex === bal.accountIndex
              );
              if (!preBal || Number(bal.uiTokenAmount.uiAmount) > Number(preBal.uiTokenAmount.uiAmount || 0)) {
                isReceive = true;
                tokenMint = bal.mint;
              }
            }
          }

          if (!isSend && !isReceive) continue;

          // Find counterparty
          for (const bal of isSend ? postBalances : preBalances) {
            if (bal.owner !== walletAddress && bal.mint === tokenMint) {
              counterparty = bal.owner || '';
              break;
            }
          }

          return {
            signature,
            type: isSend ? 'send' : 'receive',
            amount,
            tokenSymbol: getTokenSymbol(tokenMint),
            tokenMint,
            counterparty,
            timestamp: blockTime ? blockTime * 1000 : Date.now(),
            status: tx.meta.err ? 'failed' : 'confirmed',
            isPrivate: false,
            fee: (tx.meta.fee || 0) / LAMPORTS_PER_SOL,
          };
        }
      }
    }

    // Fallback: Check if it's an incoming SOL transfer based on balance changes
    const preBalance = tx.meta.preBalances[0];
    const postBalance = tx.meta.postBalances[0];
    const fee = tx.meta.fee || 0;

    if (postBalance !== undefined && preBalance !== undefined) {
      const balanceChange = postBalance - preBalance + fee;

      if (balanceChange !== 0) {
        const isSend = balanceChange < 0;
        const amount = Math.abs(balanceChange) / LAMPORTS_PER_SOL;

        // Find counterparty from account keys
        let counterparty = '';
        if (accountKeys.length > 1) {
          const otherAccount = accountKeys.find(
            (acc) => acc.pubkey.toBase58() !== walletAddress
          );
          counterparty = otherAccount?.pubkey.toBase58() || '';
        }

        return {
          signature,
          type: isSend ? 'send' : 'receive',
          amount,
          tokenSymbol: 'SOL',
          tokenMint: 'So11111111111111111111111111111111111111112',
          counterparty,
          timestamp: blockTime ? blockTime * 1000 : Date.now(),
          status: tx.meta.err ? 'failed' : 'confirmed',
          isPrivate: false,
          fee: fee / LAMPORTS_PER_SOL,
        };
      }
    }

    return null;
  } catch (error) {
    console.error('Error parsing transaction:', error);
    return null;
  }
}

/**
 * Get token symbol from mint address
 */
function getTokenSymbol(mint: string): string {
  // Common token mints on Solana
  const knownTokens: Record<string, string> = {
    'So11111111111111111111111111111111111111112': 'SOL',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
    'DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ': 'DUST',
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
    'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE': 'ORCA',
    'RaydiumBPair111111111111111111111111111111': 'RAY',
  };

  return knownTokens[mint] || 'SPL';
}

/**
 * Fetch recent transactions for a wallet
 */
export async function getRecentTransactions(
  publicKey: string,
  network: NetworkType,
  limit: number = 10
): Promise<TransactionRecord[]> {
  const connection = getConnection(network);
  const pubkey = new PublicKey(publicKey);

  try {
    // Get recent signatures with retry for rate limits
    const signatures = await withRetry(() =>
      connection.getSignaturesForAddress(pubkey, { limit })
    );

    if (signatures.length === 0) {
      return [];
    }

    // Fetch transactions in batches to avoid rate limiting
    // Using smaller batches (3) and longer delays (800ms) for devnet rate limits
    const transactions = await batchProcess(
      signatures,
      async (sig) => {
        try {
          const tx = await withRetry(() =>
            connection.getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            })
          );

          if (!tx) return null;

          return parseTransaction(tx, sig.signature, sig.blockTime ?? null, publicKey);
        } catch (error) {
          console.error(`Error fetching tx ${sig.signature}:`, error);
          return null;
        }
      },
      3, // batch size (reduced from 5)
      800 // delay between batches (ms) - increased for devnet rate limits
    );

    // Filter out nulls and sort by timestamp (newest first)
    return transactions
      .filter((tx): tx is TransactionRecord => tx !== null)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    console.error('Error fetching recent transactions:', error);
    return [];
  }
}

/**
 * Get transaction details by signature
 */
export async function getTransactionDetails(
  signature: string,
  network: NetworkType
): Promise<TransactionRecord | null> {
  const connection = getConnection(network);

  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) return null;

    const blockTime = tx.blockTime || null;

    // We need wallet address to parse, return basic info
    return {
      signature,
      type: 'send', // Default, would need wallet context to determine
      amount: 0,
      tokenSymbol: 'SOL',
      tokenMint: 'So11111111111111111111111111111111111111112',
      timestamp: blockTime ? blockTime * 1000 : Date.now(),
      status: tx.meta?.err ? 'failed' : 'confirmed',
      isPrivate: false,
      fee: (tx.meta?.fee || 0) / LAMPORTS_PER_SOL,
    };
  } catch (error) {
    console.error('Error fetching transaction details:', error);
    return null;
  }
}

/**
 * Get Solscan URL for a transaction or address
 */
export function getSolscanUrl(
  type: 'tx' | 'account',
  value: string,
  network: NetworkType
): string {
  const cluster = network === 'mainnet-beta' ? '' : `?cluster=${network}`;
  return `https://solscan.io/${type}/${value}${cluster}`;
}
