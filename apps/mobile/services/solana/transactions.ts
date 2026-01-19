import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  TransactionSignature,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import { getConnection, getExplorerUrl } from './connection';
import { getKeypair } from './wallet';

export interface TransactionResult {
  signature: string;
  explorerUrl: string;
  success: boolean;
  error?: string;
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
 * Send SOL to another wallet
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

    // Create transaction
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey,
        lamports: Math.floor(amount * LAMPORTS_PER_SOL),
      })
    );

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
 */
export async function getTransactionHistory(
  publicKey: string,
  limit: number = 20
): Promise<TransactionHistory[]> {
  try {
    const connection = getConnection();
    const pubkey = new PublicKey(publicKey);

    // Get signatures
    const signatures = await connection.getSignaturesForAddress(pubkey, {
      limit,
    });

    if (signatures.length === 0) {
      return [];
    }

    // Get transaction details
    const transactions = await connection.getParsedTransactions(
      signatures.map((s) => s.signature),
      { maxSupportedTransactionVersion: 0 }
    );

    const history: TransactionHistory[] = [];

    for (let i = 0; i < signatures.length; i++) {
      const sig = signatures[i];
      const tx = transactions[i];

      if (!tx) continue;

      const parsed = parseTransaction(tx, publicKey);
      history.push({
        signature: sig.signature,
        timestamp: sig.blockTime,
        status: sig.err ? 'failed' : 'confirmed',
        ...parsed,
      });
    }

    return history;
  } catch (error: any) {
    // Silently handle rate limit errors - they're expected on public RPCs
    if (!error?.message?.includes('429')) {
      console.warn('Failed to fetch transaction history:', error?.message || error);
    }
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
  const instructions = tx.transaction.message.instructions;
  const walletPubkey = walletAddress;

  for (const instruction of instructions) {
    if ('parsed' in instruction) {
      const parsed = instruction.parsed;

      // System program transfer
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
