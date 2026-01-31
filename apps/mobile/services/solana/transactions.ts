import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  TransactionSignature,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getConnection, getExplorerUrl, isMainnet } from './connection';
import { getKeypair } from './wallet';

const TX_CACHE_KEY = 'p01_tx_cache_';

// P-01 Network Fee Configuration
const P01_FEE_BPS = parseInt(process.env.EXPO_PUBLIC_PLATFORM_FEE_BPS || '25', 10); // 0.25% default
const P01_FEE_WALLET = process.env.EXPO_PUBLIC_FEE_WALLET || '3EwUAV44kvjL23emA2yHCwZvAfJbfG4MrhL6YHUrqVLi';

export interface TransactionResult {
  signature: string;
  explorerUrl: string;
  success: boolean;
  error?: string;
}

export interface FeeBreakdown {
  totalAmount: number; // What user enters
  recipientAmount: number; // What recipient receives
  feeAmount: number; // P-01 fee
  feePercentage: number; // As decimal (0.0025 = 0.25%)
  feeWallet: string;
  isMainnet: boolean;
}

/**
 * Get fee breakdown for a transfer amount
 * Useful for showing the user what they'll pay before confirming
 */
export function getTransferFeeBreakdown(amountInSol: number): FeeBreakdown {
  const lamports = Math.floor(amountInSol * LAMPORTS_PER_SOL);
  const onMainnet = isMainnet();
  const feeAmount = onMainnet ? Math.floor((lamports * P01_FEE_BPS) / 10000) : 0;
  const recipientAmount = lamports - feeAmount;

  return {
    totalAmount: amountInSol,
    recipientAmount: recipientAmount / LAMPORTS_PER_SOL,
    feeAmount: feeAmount / LAMPORTS_PER_SOL,
    feePercentage: P01_FEE_BPS / 10000,
    feeWallet: P01_FEE_WALLET,
    isMainnet: onMainnet,
  };
}

export interface TransactionHistory {
  signature: string;
  timestamp: number | null;
  type: 'send' | 'receive' | 'swap' | 'unknown';
  amount?: number;
  token?: string;
  from?: string;
  to?: string;
  status: 'confirmed' | 'failed' | 'pending';
}

/**
 * Get cached transactions (instant, from local storage)
 */
export async function getCachedTransactions(publicKey: string): Promise<TransactionHistory[]> {
  try {
    const cached = await AsyncStorage.getItem(TX_CACHE_KEY + publicKey);
    if (cached) {
      const data = JSON.parse(cached);
      return data;
    } else {
    }
  } catch (error) {
    console.warn('[Transactions] Failed to load cache:', error);
  }
  return [];
}

/**
 * Save transactions to local cache
 */
async function cacheTransactions(publicKey: string, transactions: TransactionHistory[]): Promise<void> {
  try {
    await AsyncStorage.setItem(TX_CACHE_KEY + publicKey, JSON.stringify(transactions));
  } catch (error) {
    console.warn('[Transactions] Failed to cache:', error);
  }
}

/**
 * Clear transaction cache for a wallet (used when importing new wallet)
 */
export async function clearTransactionCache(publicKey: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(TX_CACHE_KEY + publicKey);
  } catch (error) {
    console.warn('[Transactions] Failed to clear cache:', error);
  }
}

/**
 * Calculate P-01 network fee
 */
function calculateP01Fee(lamports: number): number {
  // Only charge fee on mainnet
  if (!isMainnet()) {
    return 0;
  }
  return Math.floor((lamports * P01_FEE_BPS) / 10000);
}

/**
 * Send SOL with external signer (for Privy wallets)
 * Automatically includes P-01 Network fee (0.25%) on mainnet
 */
export async function sendSolWithSigner(
  toAddress: string,
  amount: number,
  fromPubkey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>
): Promise<TransactionResult> {
  try {
    const connection = getConnection();
    const toPubkey = new PublicKey(toAddress);
    const totalLamports = Math.floor(amount * LAMPORTS_PER_SOL);

    // Calculate P-01 fee (only on mainnet)
    const feeAmount = calculateP01Fee(totalLamports);
    const recipientAmount = totalLamports - feeAmount;

    // Create transaction
    const transaction = new Transaction();

    // Main transfer to recipient
    transaction.add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports: recipientAmount,
      })
    );

    // P-01 Network fee transfer (only if > 0)
    if (feeAmount > 0) {
      const feeWallet = new PublicKey(P01_FEE_WALLET);
      transaction.add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey: feeWallet,
          lamports: feeAmount,
        })
      );
    }

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromPubkey;

    // Sign transaction with provided signer
    const signedTransaction = await signTransaction(transaction);

    // Send and confirm
    const signature = await connection.sendRawTransaction(signedTransaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');


    return {
      signature,
      explorerUrl: getExplorerUrl(signature, 'tx'),
      success: true,
    };
  } catch (error: any) {
    console.error('Failed to send SOL with signer:', error);
    return {
      signature: '',
      explorerUrl: '',
      success: false,
      error: error.message || 'Transaction failed',
    };
  }
}

/**
 * Send SOL to another wallet (uses local keypair)
 * Automatically includes P-01 Network fee (0.25%) on mainnet
 */
export async function sendSol(
  toAddress: string,
  amount: number
): Promise<TransactionResult> {
  try {
    const keypair = await getKeypair();
    if (!keypair) {
      throw new Error('No wallet found');
    }

    const connection = getConnection();
    const toPubkey = new PublicKey(toAddress);
    const totalLamports = Math.floor(amount * LAMPORTS_PER_SOL);

    // Calculate P-01 fee (only on mainnet)
    const feeAmount = calculateP01Fee(totalLamports);
    const recipientAmount = totalLamports - feeAmount;

    // Create transaction
    const transaction = new Transaction();

    // Main transfer to recipient
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey,
        lamports: recipientAmount,
      })
    );

    // P-01 Network fee transfer (only if > 0)
    if (feeAmount > 0) {
      const feeWallet = new PublicKey(P01_FEE_WALLET);
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: feeWallet,
          lamports: feeAmount,
        })
      );
    }

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;

    // Sign and send
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [keypair],
      { commitment: 'confirmed' }
    );


    return {
      signature,
      explorerUrl: getExplorerUrl(signature, 'tx'),
      success: true,
    };
  } catch (error: any) {
    console.error('Failed to send SOL:', error);
    return {
      signature: '',
      explorerUrl: '',
      success: false,
      error: error.message || 'Transaction failed',
    };
  }
}

/**
 * Get transaction history for a wallet
 * Fetches transactions one by one to avoid rate limits
 */
export async function getTransactionHistory(
  publicKey: string,
  limit: number = 20 // Need 20 to include older SOL transfers past memo transactions
): Promise<TransactionHistory[]> {
  try {
    const connection = getConnection();
    const pubkey = new PublicKey(publicKey);

    // Get signatures with retry for server errors
    let signatures;
    let retries = 2;
    while (retries > 0) {
      try {
        signatures = await connection.getSignaturesForAddress(pubkey, { limit });
        break;
      } catch (sigError: any) {
        const errMsg = sigError?.message || String(sigError);
        if (errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503') || errMsg.includes('429')) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          retries--;
          if (retries === 0) throw sigError;
        } else {
          throw sigError;
        }
      }
    }

    if (!signatures) {
      return [];
    }


    if (signatures.length === 0) {
      return [];
    }

    const history: TransactionHistory[] = [];

    // Fetch transactions one by one with delay to avoid rate limits
    for (let i = 0; i < signatures.length; i++) {
      const sig = signatures[i];

      try {
        // Add delay between requests to avoid rate limits (1.5 seconds)
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }

        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
          continue;
        }

        const parsed = parseTransaction(tx, publicKey);

        // Include all transactions with SOL changes (skip memo-only)
        if (parsed.type !== 'unknown' && parsed.amount && parsed.amount > 0) {
          history.push({
            signature: sig.signature,
            timestamp: sig.blockTime,
            status: sig.err ? 'failed' : 'confirmed',
            ...parsed,
          });
        }
      } catch (txError: any) {
        // Skip this transaction on error, continue with others
        const msg = txError?.message || String(txError);
        const isRateLimit = msg.includes('429');
        const isServerError = msg.includes('500') || msg.includes('502') || msg.includes('503');

        if (isRateLimit || isServerError) {
          const errorType = isRateLimit ? 'Rate limited' : 'Server error';
          await new Promise(resolve => setTimeout(resolve, 5000));
          // Retry this transaction once
          try {
            const tx = await connection.getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            });
            if (tx) {
              const parsed = parseTransaction(tx, publicKey);
              if (parsed.type !== 'unknown' && parsed.amount && parsed.amount > 0) {
                history.push({
                  signature: sig.signature,
                  timestamp: sig.blockTime,
                  status: sig.err ? 'failed' : 'confirmed',
                  ...parsed,
                });
              }
            }
          } catch {
          }
        }
      }
    }


    // Cache the results for instant loading next time
    if (history.length > 0) {
      await cacheTransactions(publicKey, history);
    }

    return history;
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    console.warn('[Transactions] Error fetching history:', errMsg.slice(0, 100));
    return [];
  }
}

/**
 * Parse transaction to determine type and details
 */
function parseTransaction(
  tx: ParsedTransactionWithMeta,
  walletAddress: string
): Partial<TransactionHistory> {
  const walletPubkey = walletAddress;

  // FIRST: Check pre/post balances for SOL changes (catches airdrops and all transfers)
  const accountKeys = tx.transaction.message.accountKeys;
  const preBalances = tx.meta?.preBalances || [];
  const postBalances = tx.meta?.postBalances || [];

  // Find wallet in account keys
  let walletIndex = -1;
  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys[i];
    const keyStr = typeof key === 'object' && 'pubkey' in key
      ? key.pubkey.toString()
      : String(key);
    if (keyStr === walletPubkey) {
      walletIndex = i;
      break;
    }
  }

  if (walletIndex !== -1) {
    const preBal = preBalances[walletIndex] || 0;
    const postBal = postBalances[walletIndex] || 0;
    const diff = postBal - preBal;

    // If there's a significant SOL change (> 0.0001 SOL = 100000 lamports)
    if (Math.abs(diff) > 100000) {
      const amount = Math.abs(diff) / LAMPORTS_PER_SOL;
      const isReceive = diff > 0;

      // Try to find the counterparty
      let counterparty: string | undefined;
      for (let i = 0; i < accountKeys.length; i++) {
        if (i !== walletIndex) {
          const otherPre = preBalances[i] || 0;
          const otherPost = postBalances[i] || 0;
          const otherDiff = otherPost - otherPre;
          // If this account had an opposite change, it's likely the counterparty
          if ((isReceive && otherDiff < -100000) || (!isReceive && otherDiff > 100000)) {
            const key = accountKeys[i];
            counterparty = typeof key === 'object' && 'pubkey' in key
              ? key.pubkey.toString()
              : String(key);
            break;
          }
        }
      }

      // For airdrops, counterparty might be the system program
      if (!counterparty && isReceive) {
        counterparty = 'Airdrop/Faucet';
      }

      return {
        type: isReceive ? 'receive' : 'send',
        amount,
        token: 'SOL',
        from: isReceive ? counterparty : walletPubkey,
        to: isReceive ? walletPubkey : counterparty,
      };
    }
  }

  // SECOND: Fall back to instruction parsing
  const instructions = tx.transaction.message.instructions;
  for (const instruction of instructions) {
    if ('parsed' in instruction) {
      const parsed = instruction.parsed;

      // System program transfer
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        if (parsed.type === 'transfer' && parsed.info) {
          const { source, destination, lamports } = parsed.info;
          const amount = lamports / LAMPORTS_PER_SOL;
          const isSend = source === walletPubkey;

          return {
            type: isSend ? 'send' : 'receive',
            amount,
            token: 'SOL',
            from: source,
            to: destination,
          };
        }

        // SPL Token transfer
        if (parsed.type === 'transferChecked' && parsed.info) {
          const { source, destination, tokenAmount } = parsed.info;
          const isSend = source === walletPubkey;

          return {
            type: isSend ? 'send' : 'receive',
            amount: tokenAmount?.uiAmount,
            token: 'Token',
            from: source,
            to: destination,
          };
        }
      }
    }
  }

  return { type: 'unknown' };
}

/**
 * Estimate transaction fee
 */
export async function estimateFee(): Promise<number> {
  const connection = getConnection();
  const { feeCalculator } = await connection.getRecentBlockhash();
  // Approximate fee for a simple transfer
  return (feeCalculator?.lamportsPerSignature || 5000) / LAMPORTS_PER_SOL;
}

/**
 * Validate Solana address
 */
export function isValidAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format transaction date
 */
export function formatTxDate(timestamp: number | null): string {
  if (!timestamp) return 'Pending';
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
