/**
 * On-Chain Subscription Sync Service for Mobile
 *
 * Reads subscription data from Solana Memo transactions.
 * This enables cross-device sync between extension and mobile.
 *
 * Memo format: P01_SUB_V1:{compact JSON}
 */

import { PublicKey } from '@solana/web3.js';
import { getConnection } from './connection';
import type { Stream, StreamFrequency, StreamStatus } from './streams';

// ============ Constants ============

// Solana Memo Program ID
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Protocol prefix for identifying P01 subscription memos
const MEMO_PREFIX = 'P01_SUB_V1:';

// ============ Types ============

/**
 * Compact subscription format from on-chain storage
 */
interface OnChainSubscription {
  v: 1;                      // Version
  id: string;                // Subscription ID
  n: string;                 // Name
  r: string;                 // Recipient address
  a: number;                 // Amount (in token smallest unit)
  t?: string;                // Token mint (undefined = SOL)
  i: string;                 // Interval: 'd' | 'w' | 'm' | 'y'
  s: string;                 // Status: 'a' | 'p' | 'c' (active/paused/cancelled)
  np: number;                // Next payment timestamp (seconds)
  mp: number;                // Max payments (0 = unlimited)
  pm: number;                // Payments made
  c: number;                 // Created at timestamp (seconds)
  // Privacy settings
  an?: number;               // Amount noise %
  tn?: number;               // Timing noise hours
  st?: boolean;              // Use stealth address
  // Origin info
  o?: string;                // Origin URL
}

// ============ Conversion Maps ============

const INTERVAL_MAP: Record<string, StreamFrequency> = {
  d: 'daily',
  w: 'weekly',
  m: 'monthly',
  y: 'monthly', // Map yearly to monthly for mobile (mobile doesn't have yearly)
};

const STATUS_MAP: Record<string, StreamStatus> = {
  a: 'active',
  p: 'paused',
  c: 'cancelled',
};

// ============ Conversion Functions ============

/**
 * Convert on-chain subscription to mobile Stream format
 */
function convertToStream(sub: OnChainSubscription, walletAddress: string): Stream {
  // Calculate interval in milliseconds
  const DAY_MS = 24 * 60 * 60 * 1000;
  const intervalMs: Record<string, number> = {
    d: DAY_MS,
    w: 7 * DAY_MS,
    m: 30 * DAY_MS,
    y: 365 * DAY_MS,
  };

  const frequency = INTERVAL_MAP[sub.i] || 'monthly';
  const status = STATUS_MAP[sub.s] || 'active';
  const nextPaymentDate = sub.np * 1000;
  const createdAt = sub.c * 1000;

  // Mobile uses different amount handling
  // Extension stores in lamports/smallest unit, mobile stores in SOL
  const decimals = sub.t ? 6 : 9; // USDC = 6, SOL = 9
  const amountInToken = sub.a / Math.pow(10, decimals);

  return {
    id: sub.id,
    name: sub.n,
    description: sub.o ? `Subscription from ${sub.o}` : undefined,
    recipientAddress: sub.r,
    recipientName: sub.n,
    totalAmount: sub.mp > 0 ? amountInToken * sub.mp : amountInToken * 12, // Default to 12 periods
    amountPerPayment: amountInToken,
    frequency,
    startDate: createdAt,
    endDate: sub.mp > 0 ? createdAt + (intervalMs[sub.i] || DAY_MS * 30) * sub.mp : undefined,
    nextPaymentDate,
    amountStreamed: amountInToken * sub.pm,
    paymentsCompleted: sub.pm,
    totalPayments: sub.mp > 0 ? sub.mp : undefined,
    status,
    direction: 'outgoing',
    // Service info from origin
    serviceName: sub.n,
    createdAt,
    updatedAt: Date.now(),
    paymentHistory: [],
  };
}

// ============ Sync Functions ============

/**
 * Fetch subscriptions from blockchain for a wallet
 */
export async function fetchSubscriptionsFromChain(
  walletAddress: string,
  limit: number = 100
): Promise<Stream[]> {
  const connection = getConnection();

  try {
    const pubkey = new PublicKey(walletAddress);

    // Get transaction signatures
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit });

    if (signatures.length === 0) {
      console.log('[OnChainSync] No transactions found');
      return [];
    }

    console.log(`[OnChainSync] Found ${signatures.length} transactions, scanning for subscriptions...`);

    const subscriptionMap = new Map<string, OnChainSubscription>();
    const updates: { id: string; status: string; timestamp: number }[] = [];

    // Fetch and parse transactions
    for (const sigInfo of signatures) {
      try {
        const tx = await connection.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx?.transaction?.message?.instructions) continue;

        // Look for memo instructions
        for (const instruction of tx.transaction.message.instructions) {
          // Skip parsed instructions (we need raw data)
          if ('parsed' in instruction) continue;

          const rawInstruction = instruction as {
            programId: PublicKey;
            data: string;
          };

          // Check if it's a memo program instruction
          if (!rawInstruction.programId.equals(MEMO_PROGRAM_ID)) continue;

          // Decode memo data
          let memoText: string;
          try {
            // Data is base58 encoded in getParsedTransaction
            const bs58 = await import('bs58');
            const dataBuffer = Buffer.from(bs58.default.decode(rawInstruction.data));
            memoText = dataBuffer.toString('utf-8');
          } catch {
            // Try base64 as fallback
            try {
              const dataBuffer = Buffer.from(rawInstruction.data, 'base64');
              memoText = dataBuffer.toString('utf-8');
            } catch {
              continue;
            }
          }

          // Check for subscription memo
          if (memoText.startsWith(MEMO_PREFIX)) {
            try {
              const jsonStr = memoText.slice(MEMO_PREFIX.length);
              const encoded = JSON.parse(jsonStr) as OnChainSubscription;

              // Store by ID (earlier entries are more recent in the signatures list)
              if (!subscriptionMap.has(encoded.id)) {
                subscriptionMap.set(encoded.id, encoded);
                console.log(`[OnChainSync] Found subscription: ${encoded.n}`);
              }
            } catch (e) {
              console.warn('[OnChainSync] Failed to parse subscription memo:', e);
            }
          }

          // Check for update memo
          if (memoText.startsWith('P01_SUB_UPD:')) {
            try {
              const jsonStr = memoText.slice('P01_SUB_UPD:'.length);
              const update = JSON.parse(jsonStr);
              updates.push({
                id: update.id,
                status: update.s,
                timestamp: update.u,
              });
            } catch {
              // Ignore malformed updates
            }
          }
        }
      } catch (error) {
        console.warn(`[OnChainSync] Failed to parse tx ${sigInfo.signature}:`, error);
      }
    }

    // Apply updates in chronological order (oldest first)
    updates.sort((a, b) => a.timestamp - b.timestamp);
    for (const update of updates) {
      const sub = subscriptionMap.get(update.id);
      if (sub) {
        sub.s = update.status;
      }
    }

    // Convert to Stream format
    const streams = Array.from(subscriptionMap.values())
      .map(sub => convertToStream(sub, walletAddress))
      .sort((a, b) => b.createdAt - a.createdAt);

    console.log(`[OnChainSync] Found ${streams.length} subscriptions on-chain`);
    return streams;
  } catch (error) {
    console.error('[OnChainSync] Failed to fetch subscriptions from chain:', error);
    return [];
  }
}

/**
 * Sync local streams with on-chain data
 * Returns merged streams with on-chain data taking precedence
 */
export function mergeStreams(localStreams: Stream[], chainStreams: Stream[]): Stream[] {
  const merged = new Map<string, Stream>();

  // Add local streams first
  for (const stream of localStreams) {
    merged.set(stream.id, stream);
  }

  // Merge chain streams
  for (const chainStream of chainStreams) {
    const localStream = merged.get(chainStream.id);

    if (!localStream) {
      // New stream from chain
      merged.set(chainStream.id, chainStream);
    } else {
      // Merge: keep local payment history, use chain status
      merged.set(chainStream.id, {
        ...localStream,
        status: chainStream.status,
        // Keep local payment data
        paymentHistory: localStream.paymentHistory,
        amountStreamed: Math.max(localStream.amountStreamed, chainStream.amountStreamed),
        paymentsCompleted: Math.max(localStream.paymentsCompleted, chainStream.paymentsCompleted),
      });
    }
  }

  return Array.from(merged.values());
}

/**
 * Check if streams need to be refreshed from chain
 */
export function shouldRefreshFromChain(lastSyncTime: number | null): boolean {
  if (!lastSyncTime) return true;

  // Refresh every 5 minutes
  const REFRESH_INTERVAL = 5 * 60 * 1000;
  return Date.now() - lastSyncTime > REFRESH_INTERVAL;
}
