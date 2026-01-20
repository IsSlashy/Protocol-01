/**
 * On-Chain Subscription Sync Service
 *
 * Uses Solana Memo Program to store and retrieve subscription data on-chain.
 * This enables cross-device sync between extension and mobile without a centralized server.
 *
 * Memo format: P01_SUB_V1:{compact JSON}
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { getConnection, NetworkType } from './wallet';
import type { StreamSubscription, SubscriptionInterval } from './stream';

// ============ Constants ============

// Solana Memo Program ID
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Protocol prefix for identifying P01 subscription memos
const MEMO_PREFIX = 'P01_SUB_V1:';

// Maximum memo length (Solana limit)
const MAX_MEMO_LENGTH = 566;

// ============ Types ============

/**
 * Compact subscription format for on-chain storage
 * Minimizes data size while preserving essential information
 */
export interface OnChainSubscription {
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

// ============ Encoding/Decoding ============

const INTERVAL_MAP: Record<SubscriptionInterval, string> = {
  daily: 'd',
  weekly: 'w',
  monthly: 'm',
  yearly: 'y',
};

const INTERVAL_REVERSE: Record<string, SubscriptionInterval> = {
  d: 'daily',
  w: 'weekly',
  m: 'monthly',
  y: 'yearly',
};

const STATUS_MAP: Record<string, string> = {
  active: 'a',
  paused: 'p',
  cancelled: 'c',
};

const STATUS_REVERSE: Record<string, 'active' | 'paused' | 'cancelled'> = {
  a: 'active',
  p: 'paused',
  c: 'cancelled',
};

/**
 * Convert StreamSubscription to compact on-chain format
 */
export function encodeSubscription(sub: StreamSubscription): OnChainSubscription {
  const encoded: OnChainSubscription = {
    v: 1,
    id: sub.id,
    n: sub.name.substring(0, 32), // Limit name length
    r: sub.recipient,
    a: sub.amount,
    i: INTERVAL_MAP[sub.interval],
    s: STATUS_MAP[sub.status] || 'a',
    np: Math.floor(sub.nextPayment / 1000),
    mp: sub.maxPayments,
    pm: sub.paymentsMade,
    c: Math.floor(sub.createdAt / 1000),
  };

  // Only include optional fields if they have non-default values
  if (sub.tokenMint) encoded.t = sub.tokenMint;
  if (sub.amountNoise > 0) encoded.an = sub.amountNoise;
  if (sub.timingNoise > 0) encoded.tn = sub.timingNoise;
  if (sub.useStealthAddress) encoded.st = true;
  if (sub.origin) encoded.o = sub.origin.substring(0, 50);

  return encoded;
}

/**
 * Convert compact on-chain format to StreamSubscription
 */
export function decodeSubscription(encoded: OnChainSubscription, walletAddress: string): StreamSubscription {
  return {
    id: encoded.id,
    name: encoded.n,
    recipient: encoded.r,
    amount: encoded.a,
    tokenMint: encoded.t,
    tokenSymbol: encoded.t ? 'TOKEN' : 'SOL',
    tokenDecimals: encoded.t ? 6 : 9,
    interval: INTERVAL_REVERSE[encoded.i] || 'monthly',
    status: STATUS_REVERSE[encoded.s] || 'active',
    nextPayment: encoded.np * 1000,
    maxPayments: encoded.mp,
    paymentsMade: encoded.pm,
    totalPaid: 0, // Will be calculated from payment history
    createdAt: encoded.c * 1000,
    amountNoise: encoded.an || 0,
    timingNoise: encoded.tn || 0,
    useStealthAddress: encoded.st || false,
    origin: encoded.o,
    payments: [],
  };
}

/**
 * Create memo instruction with subscription data
 */
function createMemoInstruction(data: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(data, 'utf-8'),
  });
}

// ============ On-Chain Operations ============

/**
 * Publish subscription to blockchain via memo
 */
export async function publishSubscription(
  subscription: StreamSubscription,
  keypair: Keypair,
  network: NetworkType
): Promise<string> {
  const connection = getConnection(network);

  // Encode subscription
  const encoded = encodeSubscription(subscription);
  const memoData = MEMO_PREFIX + JSON.stringify(encoded);

  // Check memo size
  if (memoData.length > MAX_MEMO_LENGTH) {
    throw new Error(`Subscription data too large: ${memoData.length} bytes (max ${MAX_MEMO_LENGTH})`);
  }

  // Create transaction with memo
  const transaction = new Transaction();
  transaction.add(createMemoInstruction(memoData, keypair.publicKey));

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = keypair.publicKey;

  // Sign and send
  transaction.sign(keypair);
  const signature = await connection.sendRawTransaction(transaction.serialize());

  // Wait for confirmation
  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  console.log(`Published subscription ${subscription.id} to blockchain: ${signature}`);
  return signature;
}

/**
 * Publish subscription status update (pause/resume/cancel)
 */
export async function publishSubscriptionUpdate(
  subscriptionId: string,
  status: 'active' | 'paused' | 'cancelled',
  keypair: Keypair,
  network: NetworkType
): Promise<string> {
  const connection = getConnection(network);

  // Minimal update memo
  const updateData = {
    v: 1,
    id: subscriptionId,
    s: STATUS_MAP[status],
    u: Math.floor(Date.now() / 1000), // Update timestamp
  };

  const memoData = 'P01_SUB_UPD:' + JSON.stringify(updateData);

  const transaction = new Transaction();
  transaction.add(createMemoInstruction(memoData, keypair.publicKey));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = keypair.publicKey;

  transaction.sign(keypair);
  const signature = await connection.sendRawTransaction(transaction.serialize());

  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  return signature;
}

/**
 * Fetch subscriptions from blockchain for a wallet
 */
export async function fetchSubscriptionsFromChain(
  walletAddress: string,
  network: NetworkType,
  limit: number = 100
): Promise<StreamSubscription[]> {
  const connection = getConnection(network);
  const pubkey = new PublicKey(walletAddress);

  try {
    // Get transaction signatures
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit });

    if (signatures.length === 0) {
      return [];
    }

    const subscriptionMap = new Map<string, StreamSubscription>();
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
          // Check if it's a memo instruction
          if ('parsed' in instruction) continue;

          const rawInstruction = instruction as {
            programId: PublicKey;
            data: string;
          };

          if (!rawInstruction.programId.equals(MEMO_PROGRAM_ID)) continue;

          // Decode memo data
          let memoText: string;
          try {
            // Data is base58 encoded
            const dataBuffer = Buffer.from(rawInstruction.data, 'base64');
            memoText = dataBuffer.toString('utf-8');
          } catch {
            continue;
          }

          // Check for subscription memo
          if (memoText.startsWith(MEMO_PREFIX)) {
            try {
              const jsonStr = memoText.slice(MEMO_PREFIX.length);
              const encoded = JSON.parse(jsonStr) as OnChainSubscription;
              const subscription = decodeSubscription(encoded, walletAddress);

              // Store by ID (later entries override earlier ones)
              if (!subscriptionMap.has(subscription.id)) {
                subscriptionMap.set(subscription.id, subscription);
              }
            } catch (e) {
              console.warn('Failed to parse subscription memo:', e);
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
        console.warn(`Failed to parse tx ${sigInfo.signature}:`, error);
      }
    }

    // Apply updates in chronological order
    updates.sort((a, b) => a.timestamp - b.timestamp);
    for (const update of updates) {
      const sub = subscriptionMap.get(update.id);
      if (sub) {
        sub.status = STATUS_REVERSE[update.status] || sub.status;
      }
    }

    // Return subscriptions sorted by creation date
    return Array.from(subscriptionMap.values())
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.error('Failed to fetch subscriptions from chain:', error);
    return [];
  }
}

/**
 * Sync local subscriptions with on-chain data
 * Returns merged subscriptions with on-chain data taking precedence for status updates
 */
export function mergeSubscriptions(
  localSubs: StreamSubscription[],
  chainSubs: StreamSubscription[]
): StreamSubscription[] {
  const merged = new Map<string, StreamSubscription>();

  // Add local subscriptions first
  for (const sub of localSubs) {
    merged.set(sub.id, sub);
  }

  // Merge chain subscriptions
  for (const chainSub of chainSubs) {
    const localSub = merged.get(chainSub.id);

    if (!localSub) {
      // New subscription from chain
      merged.set(chainSub.id, chainSub);
    } else {
      // Merge: keep local payment history, use chain status if more recent
      merged.set(chainSub.id, {
        ...localSub,
        // Take chain status if it differs (chain is source of truth)
        status: chainSub.status,
        // Keep local payment data as it's not stored on-chain
        payments: localSub.payments,
        totalPaid: localSub.totalPaid,
        paymentsMade: Math.max(localSub.paymentsMade, chainSub.paymentsMade),
      });
    }
  }

  return Array.from(merged.values());
}

/**
 * Check if a subscription needs to be synced to chain
 */
export function needsChainSync(local: StreamSubscription, chain?: StreamSubscription): boolean {
  if (!chain) return true; // Not on chain yet

  // Check if local has updates that chain doesn't have
  if (local.status !== chain.status) return true;
  if (local.paymentsMade > chain.paymentsMade) return true;

  return false;
}
