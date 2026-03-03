/**
 * ZK Private Subscription Service
 *
 * Enables fully untraceable subscription payments using denomination pool notes.
 * Flow:
 *   Denomination Pool Note → [ZK Proof] → Recipient
 *   On-chain trace shows: Pool → Recipient (no link to the subscriber/depositor).
 *
 * For recurring payments (processZkStreamPayment), this uses the denomination pool store
 * to find a suitable mature note and unshield it on-chain.
 *
 * NOTE: This requires a proofGenerator function to be passed in, since ZK proof generation
 * happens in a WebView context (DenominatedPoolProver). For automatic background payments,
 * the caller must provide the generateProof function from the prover context.
 */

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getKeypair } from './wallet';
import type { Stream } from './streams';

/**
 * Result of a private subscription payment
 */
export interface PrivatePaymentResult {
  success: boolean;
  signature?: string;
  denomination?: number;
  error?: string;
}

/**
 * Process a ZK stream payment using denomination pool notes.
 *
 * Finds a suitable mature note from the denomination pool, unshields it on-chain
 * to the stream's recipient address. Returns the real on-chain transaction signature.
 *
 * @param stream - The stream to pay
 * @param amountToSend - The amount needed (used to find a suitable note)
 * @param proofGenerator - The generateProof function from DenominatedPoolProver context.
 *                         If not provided, payment will fail (proof generation requires WebView).
 */
export async function processZkStreamPayment(
  stream: Stream,
  amountToSend: number,
  proofGenerator?: (inputs: any, circuit?: string) => Promise<any>,
): Promise<{ success: boolean; signature: string; error?: string }> {
  try {
    // Dynamic import to avoid circular dependencies
    const { useDenominatedPoolStore } = await import('../../stores/denominatedPoolStore');
    const poolStore = useDenominatedPoolStore.getState();

    // Find a mature SOL note that covers the payment amount
    const matureNotes = poolStore.getActiveNotes()
      .filter((n: any) => n.token === 'SOL' && n.status === 'mature')
      .sort((a: any, b: any) => a.denomination - b.denomination);

    const availableNote = matureNotes.find((n: any) => n.denomination >= amountToSend);

    if (!availableNote) {
      return {
        success: false,
        signature: '',
        error: 'Insufficient private balance — no mature shielded notes available for this payment amount.',
      };
    }

    if (!proofGenerator) {
      return {
        success: false,
        signature: '',
        error: 'ZK proof generator not available. Manual "Pay Now" required (needs WebView prover context).',
      };
    }

    console.log(
      `[PrivateSub] Unshielding ${availableNote.denomination} SOL note for stream "${stream.name}" ` +
      `(needed: ${amountToSend} SOL) to ${stream.recipientAddress.slice(0, 8)}...`
    );

    // Unshield the note on-chain — this generates a ZK proof and sends a real Solana transaction
    const signature = await poolStore.unshieldNote(
      availableNote.id,
      stream.recipientAddress,
      proofGenerator,
    );

    console.log(`[PrivateSub] ZK payment successful: ${signature}`);

    return {
      success: true,
      signature,
    };
  } catch (error: any) {
    console.error('[PrivateSub] ZK stream payment failed:', error);
    return {
      success: false,
      signature: '',
      error: error.message || 'ZK payment failed',
    };
  }
}
