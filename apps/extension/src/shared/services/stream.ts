/**
 * Stream Secure - Privacy-Enhanced Recurring Payments Service
 *
 * Core features:
 * - Amount noise: Vary payment amounts by +/- X% to avoid patterns
 * - Timing noise: Randomize payment times within a window
 * - Stealth addresses: Each payment to a different derived address
 */

import { Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getConnection, NetworkType } from './wallet';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

// ============ Types ============

export type SubscriptionInterval = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface PaymentRecord {
  id: string;
  subscriptionId: string;
  signature: string;
  amount: number;           // Actual amount paid (with noise applied)
  originalAmount: number;   // Base amount without noise
  recipient: string;        // Address paid to (may be stealth)
  timestamp: number;
  status: 'confirmed' | 'pending' | 'failed';
  wasStealthPayment: boolean;
  noise: {
    amountDelta: number;    // How much the amount was varied
    timingDelta: number;    // How much the timing was varied (seconds)
  };
}

export interface StreamSubscription {
  id: string;
  name: string;                    // "Netflix", "Spotify", etc.
  recipient: string;               // Merchant wallet address
  merchantLogo?: string;           // Logo URL
  amount: number;                  // Base amount in SOL (or token smallest unit)
  tokenMint?: string;              // Token mint (undefined = native SOL)
  tokenSymbol: string;             // "SOL", "USDC", etc.
  tokenDecimals: number;           // Token decimals
  interval: SubscriptionInterval;
  nextPayment: number;             // Unix timestamp
  status: 'active' | 'paused' | 'cancelled';
  createdAt: number;

  // Privacy features
  amountNoise: number;             // +/- X% variation on amount (0-20)
  timingNoise: number;             // +/- X hours variation on timing (0-24)
  useStealthAddress: boolean;      // Use stealth addresses for privacy

  // Limits
  maxPayments: number;             // 0 = unlimited
  paymentsMade: number;
  totalPaid: number;

  // History
  payments: PaymentRecord[];

  // dApp origin (if created via dApp)
  origin?: string;
  originIcon?: string;
}

export interface CreateSubscriptionParams {
  name: string;
  recipient: string;
  amount: number;
  tokenMint?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  interval: SubscriptionInterval;
  maxPayments?: number;
  amountNoise?: number;
  timingNoise?: number;
  useStealthAddress?: boolean;
  merchantLogo?: string;
  origin?: string;
  originIcon?: string;
  startDate?: Date;
}

export interface CalculatedPayment {
  amount: number;
  originalAmount: number;
  date: Date;
  recipient: string;
  isStealthAddress: boolean;
  noise: {
    amountDelta: number;
    timingDelta: number;
  };
}

// ============ Constants ============

const INTERVAL_SECONDS: Record<SubscriptionInterval, number> = {
  daily: 86400,           // 24 hours
  weekly: 604800,         // 7 days
  monthly: 2592000,       // 30 days
  yearly: 31536000,       // 365 days
};

const MAX_AMOUNT_NOISE = 20;     // Max 20% variation
const MAX_TIMING_NOISE = 24;    // Max 24 hours variation

// ============ Utility Functions ============

/**
 * Generate a cryptographically secure random number between min and max
 */
export function secureRandom(min: number, max: number): number {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const range = max - min;
  return min + (array[0] / 4294967295) * range;
}

/**
 * Generate a deterministic but unpredictable noise value based on subscription ID and payment index
 */
function generateDeterministicNoise(seed: string, paymentIndex: number): number {
  const data = `${seed}-${paymentIndex}`;
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hash = nacl.hash(buffer);
  // Convert first 4 bytes to number between 0 and 1
  return (hash[0] * 256 * 256 * 256 + hash[1] * 256 * 256 + hash[2] * 256 + hash[3]) / 4294967295;
}

/**
 * Apply amount noise to a base amount
 * Returns the noised amount and the delta
 */
function applyAmountNoise(
  baseAmount: number,
  noisePercent: number,
  seed: string,
  paymentIndex: number
): { amount: number; delta: number } {
  if (noisePercent <= 0) {
    return { amount: baseAmount, delta: 0 };
  }

  // Clamp noise percentage
  const clampedNoise = Math.min(noisePercent, MAX_AMOUNT_NOISE);

  // Generate noise value between -1 and 1
  const noiseValue = (generateDeterministicNoise(seed + '-amount', paymentIndex) * 2) - 1;

  // Calculate delta as percentage of base amount
  const maxDelta = baseAmount * (clampedNoise / 100);
  const delta = noiseValue * maxDelta;

  // Ensure amount is always positive
  const noisedAmount = Math.max(baseAmount + delta, baseAmount * 0.5);

  return {
    amount: Number(noisedAmount.toFixed(9)),
    delta: Number(delta.toFixed(9))
  };
}

/**
 * Apply timing noise to a base timestamp
 * Returns the noised timestamp and the delta in seconds
 */
function applyTimingNoise(
  baseTimestamp: number,
  noiseHours: number,
  seed: string,
  paymentIndex: number
): { timestamp: number; deltaSeconds: number } {
  if (noiseHours <= 0) {
    return { timestamp: baseTimestamp, deltaSeconds: 0 };
  }

  // Clamp noise hours
  const clampedNoise = Math.min(noiseHours, MAX_TIMING_NOISE);

  // Generate noise value between -1 and 1
  const noiseValue = (generateDeterministicNoise(seed + '-timing', paymentIndex) * 2) - 1;

  // Calculate delta in seconds
  const maxDeltaSeconds = clampedNoise * 3600;
  const deltaSeconds = Math.round(noiseValue * maxDeltaSeconds);

  return {
    timestamp: baseTimestamp + deltaSeconds * 1000,
    deltaSeconds
  };
}

/**
 * Derive a stealth address from recipient's public key
 * Uses a shared secret approach for privacy
 */
export function deriveStealthAddress(
  recipientPubkey: string,
  senderKeypair: Keypair,
  nonce: number
): { stealthAddress: string; ephemeralPubkey: string } {
  // Generate ephemeral keypair for this specific payment
  const nonceBuffer = Buffer.alloc(32);
  nonceBuffer.writeUInt32LE(nonce, 0);
  const ephemeralSeed = nacl.hash(
    Buffer.concat([
      senderKeypair.secretKey.slice(0, 32),
      nonceBuffer,
      Buffer.from(recipientPubkey)
    ])
  ).slice(0, 32);

  const ephemeralKeypair = nacl.sign.keyPair.fromSeed(ephemeralSeed);

  // Derive shared secret
  // In a full implementation, this would use X25519 key exchange
  // For now, we use a simplified hash-based derivation
  const sharedSecret = nacl.hash(
    Buffer.concat([
      ephemeralKeypair.secretKey.slice(0, 32),
      Buffer.from(recipientPubkey)
    ])
  ).slice(0, 32);

  // Derive stealth keypair from shared secret
  const stealthKeypair = nacl.sign.keyPair.fromSeed(sharedSecret);
  const stealthPubkey = new PublicKey(stealthKeypair.publicKey);

  return {
    stealthAddress: stealthPubkey.toBase58(),
    ephemeralPubkey: Buffer.from(ephemeralKeypair.publicKey).toString('hex')
  };
}

// ============ Core Functions ============

/**
 * Create a new subscription with privacy features
 */
export function createSubscription(params: CreateSubscriptionParams): StreamSubscription {
  const {
    name,
    recipient,
    amount,
    tokenMint,
    tokenSymbol = tokenMint ? 'TOKEN' : 'SOL',
    tokenDecimals = tokenMint ? 6 : 9,
    interval,
    maxPayments = 0,
    amountNoise = 5,      // Default 5% noise
    timingNoise = 2,      // Default 2 hours noise
    useStealthAddress = false,
    merchantLogo,
    origin,
    originIcon,
    startDate,
  } = params;

  const now = Date.now();
  const intervalSeconds = INTERVAL_SECONDS[interval];

  // Calculate first payment time
  let nextPayment: number;
  if (startDate) {
    nextPayment = startDate.getTime();
  } else {
    // Schedule first payment for next interval
    nextPayment = now + intervalSeconds * 1000;
  }

  const subscription: StreamSubscription = {
    id: crypto.randomUUID(),
    name,
    recipient,
    merchantLogo,
    amount,
    tokenMint,
    tokenSymbol,
    tokenDecimals,
    interval,
    nextPayment,
    status: 'active',
    createdAt: now,

    // Privacy features (clamped to safe ranges)
    amountNoise: Math.min(Math.max(amountNoise, 0), MAX_AMOUNT_NOISE),
    timingNoise: Math.min(Math.max(timingNoise, 0), MAX_TIMING_NOISE),
    useStealthAddress,

    // Limits
    maxPayments,
    paymentsMade: 0,
    totalPaid: 0,

    // History
    payments: [],

    // Origin
    origin,
    originIcon,
  };

  return subscription;
}

/**
 * Calculate the next payment with privacy noise applied
 */
export function calculateNextPayment(
  sub: StreamSubscription,
  senderKeypair?: Keypair
): CalculatedPayment {
  const paymentIndex = sub.paymentsMade;

  // Apply amount noise
  const { amount: noisedAmount, delta: amountDelta } = applyAmountNoise(
    sub.amount,
    sub.amountNoise,
    sub.id,
    paymentIndex
  );

  // Apply timing noise
  const { timestamp: noisedTimestamp, deltaSeconds: timingDelta } = applyTimingNoise(
    sub.nextPayment,
    sub.timingNoise,
    sub.id,
    paymentIndex
  );

  // Determine recipient address (stealth or regular)
  let recipient = sub.recipient;
  let isStealthAddress = false;

  if (sub.useStealthAddress && senderKeypair) {
    const { stealthAddress } = deriveStealthAddress(
      sub.recipient,
      senderKeypair,
      paymentIndex
    );
    recipient = stealthAddress;
    isStealthAddress = true;
  }

  return {
    amount: noisedAmount,
    originalAmount: sub.amount,
    date: new Date(noisedTimestamp),
    recipient,
    isStealthAddress,
    noise: {
      amountDelta,
      timingDelta,
    },
  };
}

/**
 * Execute a subscription payment
 */
export async function executeSubscriptionPayment(
  sub: StreamSubscription,
  keypair: Keypair,
  network: NetworkType
): Promise<{ signature: string; payment: PaymentRecord }> {
  // Check if subscription is active
  if (sub.status !== 'active') {
    throw new Error('Subscription is not active');
  }

  // Check if max payments reached
  if (sub.maxPayments > 0 && sub.paymentsMade >= sub.maxPayments) {
    throw new Error('Maximum payments reached');
  }

  // Calculate payment with noise
  const calculatedPayment = calculateNextPayment(sub, keypair);

  // Get connection
  const connection = getConnection(network);

  // Build transaction
  // For now, only supporting native SOL payments
  // TODO: Add SPL token support
  if (sub.tokenMint) {
    throw new Error('SPL token subscriptions not yet supported');
  }

  const recipientPubkey = new PublicKey(calculatedPayment.recipient);
  const lamports = Math.round(calculatedPayment.amount * LAMPORTS_PER_SOL);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: recipientPubkey,
      lamports,
    })
  );

  // Add memo for tracking (optional, can be disabled for more privacy)
  // In production, you might want to make this configurable

  // Sign and send transaction
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = keypair.publicKey;

  transaction.sign(keypair);

  const signature = await connection.sendRawTransaction(transaction.serialize());

  // Wait for confirmation
  await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  // Create payment record
  const payment: PaymentRecord = {
    id: crypto.randomUUID(),
    subscriptionId: sub.id,
    signature,
    amount: calculatedPayment.amount,
    originalAmount: calculatedPayment.originalAmount,
    recipient: calculatedPayment.recipient,
    timestamp: Date.now(),
    status: 'confirmed',
    wasStealthPayment: calculatedPayment.isStealthAddress,
    noise: calculatedPayment.noise,
  };

  return { signature, payment };
}

/**
 * Update subscription after successful payment
 */
export function updateSubscriptionAfterPayment(
  sub: StreamSubscription,
  payment: PaymentRecord
): StreamSubscription {
  const intervalSeconds = INTERVAL_SECONDS[sub.interval];

  return {
    ...sub,
    paymentsMade: sub.paymentsMade + 1,
    totalPaid: sub.totalPaid + payment.amount,
    nextPayment: sub.nextPayment + intervalSeconds * 1000,
    payments: [...sub.payments, payment],
    // Auto-cancel if max payments reached
    status: sub.maxPayments > 0 && sub.paymentsMade + 1 >= sub.maxPayments
      ? 'cancelled'
      : sub.status,
  };
}

/**
 * Pause a subscription
 */
export function pauseSubscription(sub: StreamSubscription): StreamSubscription {
  if (sub.status === 'cancelled') {
    throw new Error('Cannot pause a cancelled subscription');
  }

  return {
    ...sub,
    status: 'paused',
  };
}

/**
 * Resume a paused subscription
 */
export function resumeSubscription(sub: StreamSubscription): StreamSubscription {
  if (sub.status === 'cancelled') {
    throw new Error('Cannot resume a cancelled subscription');
  }

  if (sub.status !== 'paused') {
    return sub; // Already active
  }

  // Adjust next payment to be in the future if it passed while paused
  let nextPayment = sub.nextPayment;
  const now = Date.now();
  const intervalMs = INTERVAL_SECONDS[sub.interval] * 1000;

  while (nextPayment < now) {
    nextPayment += intervalMs;
  }

  return {
    ...sub,
    status: 'active',
    nextPayment,
  };
}

/**
 * Cancel a subscription permanently
 */
export function cancelSubscription(sub: StreamSubscription): StreamSubscription {
  return {
    ...sub,
    status: 'cancelled',
  };
}

/**
 * Update subscription settings
 */
export function updateSubscription(
  sub: StreamSubscription,
  updates: Partial<Pick<StreamSubscription, 'amount' | 'amountNoise' | 'timingNoise' | 'useStealthAddress'>>
): StreamSubscription {
  if (sub.status === 'cancelled') {
    throw new Error('Cannot update a cancelled subscription');
  }

  return {
    ...sub,
    ...updates,
    // Clamp noise values
    amountNoise: updates.amountNoise !== undefined
      ? Math.min(Math.max(updates.amountNoise, 0), MAX_AMOUNT_NOISE)
      : sub.amountNoise,
    timingNoise: updates.timingNoise !== undefined
      ? Math.min(Math.max(updates.timingNoise, 0), MAX_TIMING_NOISE)
      : sub.timingNoise,
  };
}

/**
 * Check if a subscription payment is due
 */
export function isPaymentDue(sub: StreamSubscription): boolean {
  if (sub.status !== 'active') {
    return false;
  }

  // Consider timing noise - payment is due if current time is within the noise window
  const now = Date.now();
  const noiseWindowMs = sub.timingNoise * 3600 * 1000;

  // Payment is due if we're past the scheduled time minus the noise window
  return now >= sub.nextPayment - noiseWindowMs;
}

/**
 * Get subscriptions that need payment processing
 */
export function getDueSubscriptions(subscriptions: StreamSubscription[]): StreamSubscription[] {
  return subscriptions.filter(isPaymentDue);
}

/**
 * Calculate monthly cost of subscriptions
 */
export function calculateMonthlyCost(subscriptions: StreamSubscription[]): number {
  return subscriptions
    .filter(s => s.status === 'active')
    .reduce((total, sub) => {
      // Convert to monthly equivalent
      const multiplier = {
        daily: 30,
        weekly: 4.33,
        monthly: 1,
        yearly: 1 / 12,
      }[sub.interval];

      return total + (sub.amount * multiplier);
    }, 0);
}

/**
 * Calculate yearly cost of subscriptions
 */
export function calculateYearlyCost(subscriptions: StreamSubscription[]): number {
  return subscriptions
    .filter(s => s.status === 'active')
    .reduce((total, sub) => {
      // Convert to yearly equivalent
      const multiplier = {
        daily: 365,
        weekly: 52,
        monthly: 12,
        yearly: 1,
      }[sub.interval];

      return total + (sub.amount * multiplier);
    }, 0);
}

/**
 * Format interval for display
 */
export function formatInterval(interval: SubscriptionInterval): string {
  const labels: Record<SubscriptionInterval, string> = {
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    yearly: 'Yearly',
  };
  return labels[interval];
}

/**
 * Get interval in seconds
 */
export function getIntervalSeconds(interval: SubscriptionInterval): number {
  return INTERVAL_SECONDS[interval];
}

/**
 * Validate a subscription recipient address
 */
export function validateRecipient(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}
