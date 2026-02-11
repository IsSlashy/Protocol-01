/**
 * ZK Private Subscription Module
 *
 * Enables fully untraceable subscription payments by composing:
 * 1. Stealth address generation (one-time address per payment)
 * 2. ZK Shielded Pool unshield (breaks link between depositor and recipient)
 * 3. Subscription stream creation
 *
 * Flow:
 *   User's ZK Pool → [ZK Proof] → Stealth Address → Merchant
 *   Neither the merchant nor on-chain observers can trace the payment source.
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import type {
  StealthMetaAddress,
  StealthAddress,
  WalletAdapter,
} from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import { generateStealthAddress, parseStealthMetaAddress } from '../stealth/generate';
import { isValidStealthMetaAddress, isValidPublicKey } from '../utils/helpers';

// ============================================================================
// Types
// ============================================================================

/** Subscription frequency */
export type SubscriptionFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';

/**
 * Parameters for creating a ZK private subscription
 */
export interface PrivateSubscriptionParams {
  /** Solana connection */
  connection: Connection;
  /** Subscriber's wallet (for signing ZK unshield transactions) */
  subscriber: Keypair | WalletAdapter;
  /** Merchant's stealth meta-address or public key */
  merchantAddress: string;
  /** Payment amount per interval in SOL */
  amount: number;
  /** Payment frequency */
  frequency: SubscriptionFrequency;
  /** Number of payments (0 = unlimited) */
  maxPayments?: number;
  /** Token mint for SPL token subscriptions (omit for SOL) */
  tokenMint?: PublicKey;
  /** Human-readable subscription name */
  name?: string;
}

/**
 * Result of creating a private subscription
 */
export interface PrivateSubscriptionResult {
  /** Unique subscription identifier */
  subscriptionId: string;
  /** Stealth address generated for the first payment */
  stealthAddress: PublicKey;
  /** Ephemeral public key (needed by merchant to detect payment) */
  ephemeralPubKey: Uint8Array;
  /** View tag for fast scanning */
  viewTag: number;
  /** Whether the merchant address was a stealth meta-address */
  isFullyStealth: boolean;
}

/**
 * Data for a single private payment within a subscription
 */
export interface PrivatePaymentData {
  /** One-time stealth address for this payment */
  stealthAddress: PublicKey;
  /** Ephemeral public key */
  ephemeralPubKey: Uint8Array;
  /** View tag */
  viewTag: number;
  /** Payment amount in lamports */
  amountLamports: bigint;
}

// ============================================================================
// Functions
// ============================================================================

/**
 * Prepare a private subscription.
 *
 * Generates the stealth address for the first payment and returns all
 * data needed to execute the ZK unshield + subscription creation flow.
 *
 * @param params - Subscription parameters
 * @returns Subscription result with stealth address data
 *
 * @example
 * ```typescript
 * const result = await createPrivateSubscription({
 *   connection,
 *   subscriber: keypair,
 *   merchantAddress: 'sp1:abc123...', // stealth meta-address
 *   amount: 0.15,
 *   frequency: 'monthly',
 *   name: 'Netflix',
 * });
 * // result.stealthAddress — send first payment here via ZK unshield
 * ```
 */
export async function createPrivateSubscription(
  params: PrivateSubscriptionParams
): Promise<PrivateSubscriptionResult> {
  const { merchantAddress, amount } = params;

  if (amount <= 0) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_AMOUNT,
      'Subscription amount must be greater than 0'
    );
  }

  // Determine if merchant has a stealth meta-address or plain public key
  const isStealthMeta = isValidStealthMetaAddress(merchantAddress);
  const isPlainKey = !isStealthMeta && isValidPublicKey(merchantAddress);

  if (!isStealthMeta && !isPlainKey) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_STEALTH_ADDRESS,
      'Invalid merchant address: must be a stealth meta-address or Solana public key'
    );
  }

  // Generate subscription ID
  const subscriptionId = generateSubscriptionId();

  if (isStealthMeta) {
    // Full stealth: generate a one-time address that only the merchant can spend
    const metaAddress = parseStealthMetaAddress(merchantAddress);
    const stealth = generateStealthAddress(metaAddress);

    return {
      subscriptionId,
      stealthAddress: stealth.address,
      ephemeralPubKey: stealth.ephemeralPubKey,
      viewTag: stealth.viewTag,
      isFullyStealth: true,
    };
  } else {
    // Partial privacy: sender is hidden (ZK proof), but merchant address is visible
    const merchantPubkey = new PublicKey(merchantAddress);

    return {
      subscriptionId,
      stealthAddress: merchantPubkey,
      ephemeralPubKey: new Uint8Array(32),
      viewTag: 0,
      isFullyStealth: false,
    };
  }
}

/**
 * Generate payment data for a recurring private payment.
 *
 * Each payment in a private subscription should use a fresh stealth address
 * so payments can't be linked to each other.
 *
 * @param merchantMetaAddress - Merchant's stealth meta-address
 * @param amountSol - Payment amount in SOL
 * @returns Payment data with fresh stealth address
 */
export function generatePrivatePaymentData(
  merchantMetaAddress: string | StealthMetaAddress,
  amountSol: number
): PrivatePaymentData {
  const metaAddress =
    typeof merchantMetaAddress === 'string'
      ? parseStealthMetaAddress(merchantMetaAddress)
      : merchantMetaAddress;

  const stealth = generateStealthAddress(metaAddress);

  return {
    stealthAddress: stealth.address,
    ephemeralPubKey: stealth.ephemeralPubKey,
    viewTag: stealth.viewTag,
    amountLamports: BigInt(Math.round(amountSol * 1e9)),
  };
}

/**
 * Generate a unique subscription ID
 */
function generateSubscriptionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `psub_${timestamp}_${random}`;
}
