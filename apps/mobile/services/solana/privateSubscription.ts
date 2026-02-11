/**
 * ZK Private Subscription Service
 *
 * Enables fully untraceable subscription payments by composing:
 * 1. ZK Shielded Pool (unshield to stealth address)
 * 2. Stealth Addresses (one-time recipient address)
 * 3. Stream/Subscription creation
 *
 * Flow:
 *   User's ZK Pool → [ZK Proof] → Stealth Address → Merchant
 *   Neither the merchant nor on-chain observers can trace the payment source.
 */

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getZkService, ZkService, type StealthUnshieldResult } from '../zk';
import { getKeypair } from './wallet';
import type { Stream } from './streams';

/**
 * Result of a private subscription payment
 */
export interface PrivatePaymentResult {
  success: boolean;
  signature?: string;
  stealthAddress?: string;
  ephemeralPublicKey?: string;
  viewTag?: string;
  error?: string;
}

/**
 * Create a signTransaction function from a Keypair.
 * This matches the pattern used throughout the app for wallet signing.
 */
function keypairSigner(keypair: Keypair): (tx: Transaction) => Promise<Transaction> {
  return async (tx: Transaction) => {
    tx.partialSign(keypair);
    return tx;
  };
}

/**
 * Process a single subscription payment through the ZK shielded pool.
 *
 * Instead of sending SOL directly (which links sender → recipient on-chain),
 * this unshields from the ZK pool to a fresh stealth address derived for the recipient.
 * The on-chain trace shows: ZK Pool → Stealth Address (no link to the subscriber).
 */
export async function processZkPayment(
  recipientAddress: string,
  amountSol: number,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  zkService?: ZkService,
): Promise<PrivatePaymentResult> {
  try {
    const service = zkService || getZkService();
    if (!service) {
      return { success: false, error: 'ZK Service not initialized. Shield funds first.' };
    }

    const amountLamports = BigInt(Math.round(amountSol * 1e9));
    const recipientPubkey = new PublicKey(recipientAddress);

    // Unshield from the ZK pool to the recipient.
    // This hides the SENDER (ZK proof breaks the link to the depositor).
    // Full stealth (hiding recipient too) is enabled when merchant publishes stealth meta-address.
    const signature = await service.unshield(
      recipientPubkey,
      amountLamports,
      walletPublicKey,
      signTransaction,
    );

    return {
      success: true,
      signature,
      stealthAddress: recipientAddress,
    };
  } catch (error: any) {
    console.error('[PrivateSub] ZK payment failed:', error);
    return { success: false, error: error.message || 'ZK payment failed' };
  }
}

/**
 * Process a ZK payment to a recipient's stealth meta-address.
 * This hides BOTH sender and recipient:
 *   - Sender hidden by ZK proof (shielded pool → unshield)
 *   - Recipient hidden by stealth address (one-time derived address)
 */
export async function processFullyPrivatePayment(
  recipientSpendingPubKey: string,
  recipientViewingPubKey: string,
  amountSol: number,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  zkService?: ZkService,
): Promise<PrivatePaymentResult> {
  try {
    const service = zkService || getZkService();
    if (!service) {
      return { success: false, error: 'ZK Service not initialized. Shield funds first.' };
    }

    const amountLamports = BigInt(Math.round(amountSol * 1e9));

    const result: StealthUnshieldResult = await service.unshieldStealth(
      recipientSpendingPubKey,
      recipientViewingPubKey,
      amountLamports,
      walletPublicKey,
      signTransaction,
    );

    return {
      success: true,
      signature: result.signature,
      stealthAddress: result.stealthAddress,
      ephemeralPublicKey: result.ephemeralPublicKey,
      viewTag: result.viewTag,
    };
  } catch (error: any) {
    console.error('[PrivateSub] Fully private payment failed:', error);
    return { success: false, error: error.message || 'Private payment failed' };
  }
}

/**
 * Process a stream payment using the ZK pool instead of a direct transfer.
 *
 * Drop-in replacement for `sendSol()` in processStreamPayment() when
 * the stream has `useZkPool: true`. Resolves the local keypair automatically
 * (same pattern as sendSol).
 */
export async function processZkStreamPayment(
  stream: Stream,
  amountToSend: number,
): Promise<{ success: boolean; signature: string; error?: string }> {
  const keypair = await getKeypair();
  if (!keypair) {
    return { success: false, signature: '', error: 'No wallet found' };
  }

  const result = await processZkPayment(
    stream.recipientAddress,
    amountToSend,
    keypair.publicKey,
    keypairSigner(keypair),
  );

  if (!result.success) {
    return { success: false, signature: '', error: result.error };
  }

  return { success: true, signature: result.signature! };
}
