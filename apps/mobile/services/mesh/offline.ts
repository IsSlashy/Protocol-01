/**
 * Protocol 01 - Offline Transaction Service
 *
 * Handles:
 * - Offline transaction creation and signing
 * - Transaction queue for delayed broadcast
 * - Mesh relay for transaction propagation
 * - Finalization when network is available
 */

import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';

// Storage keys
const PENDING_TX_KEY = '@p01_pending_transactions';
const TX_HISTORY_KEY = '@p01_offline_tx_history';

// Transaction status
export enum OfflineTxStatus {
  CREATED = 'CREATED',           // Just created, not signed
  SIGNED = 'SIGNED',             // Signed locally
  QUEUED = 'QUEUED',             // In queue for broadcast
  RELAYING = 'RELAYING',         // Being relayed through mesh
  BROADCASTING = 'BROADCASTING', // Being sent to network
  CONFIRMED = 'CONFIRMED',       // Confirmed on chain
  FAILED = 'FAILED',             // Failed to confirm
  EXPIRED = 'EXPIRED',           // Expired before confirmation
}

// Transaction types
export enum OfflineTxType {
  TRANSFER = 'TRANSFER',  // SOL transfer
  TOKEN = 'TOKEN',        // SPL token transfer
  SWAP = 'SWAP',          // Token swap
  NFT = 'NFT',            // NFT transfer
}

// Offline transaction
export interface OfflineTransaction {
  id: string;
  type: OfflineTxType;
  status: OfflineTxStatus;

  // Transaction details
  fromAddress: string;
  toAddress: string;
  amount: number;
  currency: string;
  mint?: string;  // For SPL tokens

  // For swaps
  swapFromCurrency?: string;
  swapToCurrency?: string;
  swapFromAmount?: number;
  swapToAmount?: number;

  // Serialized transaction
  serializedTx?: string;
  signature?: string;

  // Metadata
  memo?: string;
  createdAt: number;
  signedAt?: number;
  broadcastAt?: number;
  confirmedAt?: number;
  expiresAt: number;

  // Mesh relay info
  relayedVia?: string[];    // Node IDs that relayed
  relayCount: number;
  lastRelayAt?: number;

  // Error info
  error?: string;
  retryCount: number;
}

// Generate transaction ID
async function generateTxId(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(16);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Create offline transfer transaction
export async function createOfflineTransfer(
  fromAddress: string,
  toAddress: string,
  amount: number,
  currency: string,
  memo?: string
): Promise<OfflineTransaction> {
  const id = await generateTxId();

  const tx: OfflineTransaction = {
    id,
    type: currency === 'SOL' ? OfflineTxType.TRANSFER : OfflineTxType.TOKEN,
    status: OfflineTxStatus.CREATED,
    fromAddress,
    toAddress,
    amount,
    currency,
    memo,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    relayCount: 0,
    retryCount: 0,
  };

  await savePendingTx(tx);
  return tx;
}

// Create offline swap transaction
export async function createOfflineSwap(
  fromAddress: string,
  fromCurrency: string,
  fromAmount: number,
  toCurrency: string,
  toAmount: number
): Promise<OfflineTransaction> {
  const id = await generateTxId();

  const tx: OfflineTransaction = {
    id,
    type: OfflineTxType.SWAP,
    status: OfflineTxStatus.CREATED,
    fromAddress,
    toAddress: fromAddress, // Swap is to self
    amount: fromAmount,
    currency: fromCurrency,
    swapFromCurrency: fromCurrency,
    swapToCurrency: toCurrency,
    swapFromAmount: fromAmount,
    swapToAmount: toAmount,
    createdAt: Date.now(),
    expiresAt: Date.now() + 1 * 60 * 60 * 1000, // 1 hour for swaps
    relayCount: 0,
    retryCount: 0,
  };

  await savePendingTx(tx);
  return tx;
}

// Sign transaction offline
export async function signTransactionOffline(
  txId: string,
  privateKeyHash: string
): Promise<OfflineTransaction> {
  // Validate inputs
  if (!txId || typeof txId !== 'string') {
    throw new Error('Transaction ID is required');
  }
  if (!privateKeyHash || typeof privateKeyHash !== 'string') {
    throw new Error('Private key hash is required');
  }

  const tx = await getPendingTx(txId);
  if (!tx) throw new Error('Transaction not found');

  if (tx.status !== OfflineTxStatus.CREATED) {
    throw new Error('Transaction already signed or processed');
  }

  // In production, this would create a real Solana transaction
  // and sign it with the private key using @solana/web3.js

  // Create serialized transaction placeholder
  const txData = {
    from: tx.fromAddress,
    to: tx.toAddress,
    amount: tx.amount,
    currency: tx.currency,
    type: tx.type,
    timestamp: Date.now(),
    nonce: await generateTxId(), // Add nonce for replay protection
  };

  // Create signature using HMAC-like construction
  // Never concatenate raw private key - use derived key instead
  const txDataString = JSON.stringify(txData);
  const signatureInput = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    txDataString
  );

  // Sign with derived key (privateKeyHash should already be hashed)
  const signature = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    signatureInput + privateKeyHash + tx.id
  );

  // Serialize transaction (do not include signing key material)
  const serialized = Buffer.from(txDataString).toString('base64');

  tx.serializedTx = serialized;
  tx.signature = signature;
  tx.status = OfflineTxStatus.SIGNED;
  tx.signedAt = Date.now();

  await savePendingTx(tx);
  return tx;
}

// Queue transaction for broadcast
export async function queueForBroadcast(txId: string): Promise<OfflineTransaction> {
  const tx = await getPendingTx(txId);
  if (!tx) throw new Error('Transaction not found');

  if (tx.status !== OfflineTxStatus.SIGNED) {
    throw new Error('Transaction must be signed before queueing');
  }

  tx.status = OfflineTxStatus.QUEUED;
  await savePendingTx(tx);
  return tx;
}

// Mark transaction as being relayed
export async function markAsRelaying(
  txId: string,
  relayNodeId: string
): Promise<OfflineTransaction> {
  const tx = await getPendingTx(txId);
  if (!tx) throw new Error('Transaction not found');

  tx.status = OfflineTxStatus.RELAYING;
  tx.relayedVia = [...(tx.relayedVia || []), relayNodeId];
  tx.relayCount += 1;
  tx.lastRelayAt = Date.now();

  await savePendingTx(tx);
  return tx;
}

// Broadcast transaction to network
export async function broadcastTransaction(
  txId: string
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const tx = await getPendingTx(txId);
  if (!tx) throw new Error('Transaction not found');

  if (!tx.serializedTx) {
    throw new Error('Transaction not serialized');
  }

  tx.status = OfflineTxStatus.BROADCASTING;
  tx.broadcastAt = Date.now();
  await savePendingTx(tx);

  try {
    // In production, this would:
    // 1. Deserialize the transaction
    // 2. Submit to Solana RPC
    // 3. Wait for confirmation

    // Simulate broadcast delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // For demo, simulate success
    tx.status = OfflineTxStatus.CONFIRMED;
    tx.confirmedAt = Date.now();
    await savePendingTx(tx);

    // Move to history
    await moveToHistory(tx);

    return { success: true, signature: tx.signature };
  } catch (error: any) {
    tx.status = OfflineTxStatus.FAILED;
    tx.error = error.message;
    tx.retryCount += 1;
    await savePendingTx(tx);

    return { success: false, error: error.message };
  }
}

// Get pending transactions
export async function getPendingTransactions(): Promise<OfflineTransaction[]> {
  try {
    const stored = await AsyncStorage.getItem(PENDING_TX_KEY);
    const txs: OfflineTransaction[] = stored ? JSON.parse(stored) : [];

    // Check for expired transactions
    const now = Date.now();
    let hasChanges = false;

    for (const tx of txs) {
      if (tx.expiresAt < now && tx.status !== OfflineTxStatus.CONFIRMED) {
        tx.status = OfflineTxStatus.EXPIRED;
        hasChanges = true;
      }
    }

    if (hasChanges) {
      await AsyncStorage.setItem(PENDING_TX_KEY, JSON.stringify(txs));
    }

    return txs;
  } catch (error) {
    console.error('Failed to get pending transactions:', error);
    return [];
  }
}

// Get pending transaction by ID
async function getPendingTx(txId: string): Promise<OfflineTransaction | null> {
  const txs = await getPendingTransactions();
  return txs.find(tx => tx.id === txId) || null;
}

// Save pending transaction
async function savePendingTx(tx: OfflineTransaction): Promise<void> {
  try {
    const txs = await getPendingTransactions();
    const index = txs.findIndex(t => t.id === tx.id);

    if (index >= 0) {
      txs[index] = tx;
    } else {
      txs.push(tx);
    }

    await AsyncStorage.setItem(PENDING_TX_KEY, JSON.stringify(txs));
  } catch (error) {
    console.error('Failed to save pending transaction:', error);
  }
}

// Move transaction to history
async function moveToHistory(tx: OfflineTransaction): Promise<void> {
  try {
    // Remove from pending
    const pending = await getPendingTransactions();
    const filtered = pending.filter(t => t.id !== tx.id);
    await AsyncStorage.setItem(PENDING_TX_KEY, JSON.stringify(filtered));

    // Add to history
    const stored = await AsyncStorage.getItem(TX_HISTORY_KEY);
    const history: OfflineTransaction[] = stored ? JSON.parse(stored) : [];
    history.unshift(tx);

    // Keep only last 100 transactions
    const trimmed = history.slice(0, 100);
    await AsyncStorage.setItem(TX_HISTORY_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.error('Failed to move transaction to history:', error);
  }
}

// Get transaction history
export async function getTransactionHistory(): Promise<OfflineTransaction[]> {
  try {
    const stored = await AsyncStorage.getItem(TX_HISTORY_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Failed to get transaction history:', error);
    return [];
  }
}

// Clear expired transactions
export async function clearExpiredTransactions(): Promise<number> {
  const txs = await getPendingTransactions();
  const now = Date.now();
  const expired = txs.filter(tx => tx.expiresAt < now);

  const active = txs.filter(tx => tx.expiresAt >= now);
  await AsyncStorage.setItem(PENDING_TX_KEY, JSON.stringify(active));

  return expired.length;
}

// Get queue statistics
export async function getQueueStats() {
  const txs = await getPendingTransactions();

  return {
    total: txs.length,
    created: txs.filter(tx => tx.status === OfflineTxStatus.CREATED).length,
    signed: txs.filter(tx => tx.status === OfflineTxStatus.SIGNED).length,
    queued: txs.filter(tx => tx.status === OfflineTxStatus.QUEUED).length,
    relaying: txs.filter(tx => tx.status === OfflineTxStatus.RELAYING).length,
    broadcasting: txs.filter(tx => tx.status === OfflineTxStatus.BROADCASTING).length,
    failed: txs.filter(tx => tx.status === OfflineTxStatus.FAILED).length,
    expired: txs.filter(tx => tx.status === OfflineTxStatus.EXPIRED).length,
  };
}

// Retry failed transaction
export async function retryTransaction(txId: string): Promise<OfflineTransaction> {
  const tx = await getPendingTx(txId);
  if (!tx) throw new Error('Transaction not found');

  if (tx.status !== OfflineTxStatus.FAILED) {
    throw new Error('Only failed transactions can be retried');
  }

  if (tx.retryCount >= 3) {
    throw new Error('Maximum retry attempts reached');
  }

  tx.status = OfflineTxStatus.QUEUED;
  tx.error = undefined;
  await savePendingTx(tx);

  return tx;
}

// Cancel transaction
export async function cancelTransaction(txId: string): Promise<void> {
  const txs = await getPendingTransactions();
  const tx = txs.find(t => t.id === txId);

  if (!tx) throw new Error('Transaction not found');

  if (tx.status === OfflineTxStatus.CONFIRMED) {
    throw new Error('Cannot cancel confirmed transaction');
  }

  if (tx.status === OfflineTxStatus.BROADCASTING) {
    throw new Error('Cannot cancel transaction being broadcast');
  }

  const filtered = txs.filter(t => t.id !== txId);
  await AsyncStorage.setItem(PENDING_TX_KEY, JSON.stringify(filtered));
}

// Get relay-ready transactions
export function getRelayReadyTransactions(
  txs: OfflineTransaction[]
): OfflineTransaction[] {
  return txs.filter(tx =>
    (tx.status === OfflineTxStatus.QUEUED || tx.status === OfflineTxStatus.RELAYING) &&
    tx.expiresAt > Date.now()
  );
}

// Format transaction for display
export function formatTransaction(tx: OfflineTransaction) {
  return {
    id: tx.id.slice(0, 8) + '...',
    type: tx.type,
    status: tx.status,
    amount: `${tx.amount} ${tx.currency}`,
    to: tx.toAddress.slice(0, 4) + '...' + tx.toAddress.slice(-4),
    age: formatAge(tx.createdAt),
    relays: tx.relayCount,
    isExpired: tx.expiresAt < Date.now(),
    canRetry: tx.status === OfflineTxStatus.FAILED && tx.retryCount < 3,
    canCancel: ![OfflineTxStatus.CONFIRMED, OfflineTxStatus.BROADCASTING].includes(tx.status),
  };
}

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}
