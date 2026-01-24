/**
 * x402 Payment Protocol Service for Specter Extension
 *
 * x402 is an internet-native payment protocol that uses HTTP 402 "Payment Required"
 * to enable automatic micropayments for APIs and services.
 *
 * How it works:
 * 1. Client requests a resource
 * 2. Server returns 402 with payment requirements in header
 * 3. Client signs and pays
 * 4. Server verifies and returns resource
 *
 * @see https://x402.org
 * @see https://solana.com/x402
 */

import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// x402 Protocol Constants
const X402_HEADER_REQUIRED = 'x-payment-required';
const X402_HEADER_SIGNATURE = 'x-payment';
const X402_HEADER_RESPONSE = 'x-payment-response';
const X402_VERSION = '2';

// Supported networks
export type X402Network = 'solana:devnet' | 'solana:mainnet-beta';

// Payment requirement from server
export interface PaymentRequirement {
  version: string;
  network: X402Network;
  recipient: string;
  amount: string; // In lamports for Solana
  token?: string; // Token mint (undefined = SOL)
  memo?: string;
  expiresAt?: number;
  resource?: string;
}

// Payment payload to send
export interface PaymentPayload {
  version: string;
  network: X402Network;
  signature: string; // Transaction signature
  payer: string;
}

// Payment response from server
export interface PaymentResponse {
  success: boolean;
  transactionId?: string;
  error?: string;
}

// x402 fetch options
export interface X402FetchOptions extends RequestInit {
  // Keypair for signing transactions
  keypair?: Keypair;
  // Auto-pay if 402 received (default: true)
  autoPay?: boolean;
  // Max amount willing to pay (in lamports)
  maxAmount?: number;
  // Custom RPC endpoint
  rpcEndpoint?: string;
  // Callback when payment is required
  onPaymentRequired?: (requirement: PaymentRequirement) => Promise<boolean>;
  // Callback when payment is made
  onPaymentMade?: (payload: PaymentPayload) => void;
}

/**
 * x402-enabled fetch that automatically handles 402 payments
 *
 * @example
 * ```typescript
 * const response = await x402Fetch('https://api.example.com/data', {
 *   keypair: myKeypair,
 *   maxAmount: 1000000, // Max 0.001 SOL
 * });
 * const data = await response.json();
 * ```
 */
export async function x402Fetch(
  url: string,
  options: X402FetchOptions = {}
): Promise<Response> {
  const {
    keypair,
    autoPay = true,
    maxAmount = 100_000_000, // Default max 0.1 SOL
    rpcEndpoint = 'https://api.devnet.solana.com',
    onPaymentRequired,
    onPaymentMade,
    ...fetchOptions
  } = options;

  // First request - may return 402
  const response = await fetch(url, fetchOptions);

  // If not 402, return as-is
  if (response.status !== 402) {
    return response;
  }

  // Parse payment requirement
  const requirementHeader = response.headers.get(X402_HEADER_REQUIRED);
  if (!requirementHeader) {
    console.warn('[x402] 402 response but no payment requirement header');
    return response;
  }

  let requirement: PaymentRequirement;
  try {
    requirement = JSON.parse(atob(requirementHeader));
  } catch (e) {
    console.error('[x402] Failed to parse payment requirement:', e);
    return response;
  }

  console.log('[x402] Payment required:', requirement);

  // Check if we should auto-pay
  if (!autoPay) {
    return response;
  }

  // Check if we have a keypair
  if (!keypair) {
    console.warn('[x402] No keypair provided, cannot auto-pay');
    return response;
  }

  // Check amount limit
  const amountLamports = parseInt(requirement.amount);
  if (amountLamports > maxAmount) {
    console.warn('[x402] Payment amount exceeds max:', amountLamports, '>', maxAmount);
    return response;
  }

  // Callback to confirm payment
  if (onPaymentRequired) {
    const shouldPay = await onPaymentRequired(requirement);
    if (!shouldPay) {
      return response;
    }
  }

  // Create and sign payment transaction
  const paymentPayload = await createPayment(requirement, keypair, rpcEndpoint);
  if (!paymentPayload) {
    console.error('[x402] Failed to create payment');
    return response;
  }

  // Notify payment made
  if (onPaymentMade) {
    onPaymentMade(paymentPayload);
  }

  // Retry request with payment header
  const paymentHeader = btoa(JSON.stringify(paymentPayload));
  const paidResponse = await fetch(url, {
    ...fetchOptions,
    headers: {
      ...fetchOptions.headers,
      [X402_HEADER_SIGNATURE]: paymentHeader,
    },
  });

  return paidResponse;
}

/**
 * Create a payment transaction for x402
 */
async function createPayment(
  requirement: PaymentRequirement,
  keypair: Keypair,
  rpcEndpoint: string
): Promise<PaymentPayload | null> {
  try {
    const connection = new Connection(rpcEndpoint, 'confirmed');

    // Parse network
    const [chain, network] = requirement.network.split(':');
    if (chain !== 'solana') {
      console.error('[x402] Unsupported chain:', chain);
      return null;
    }

    // Create transfer transaction
    const recipientPubkey = new PublicKey(requirement.recipient);
    const amountLamports = parseInt(requirement.amount);

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: recipientPubkey,
        lamports: amountLamports,
      })
    );

    // Add memo if provided
    if (requirement.memo) {
      const { createMemoInstruction } = await import('@solana/spl-memo');
      transaction.add(
        createMemoInstruction(requirement.memo, [keypair.publicKey])
      );
    }

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;

    // Sign transaction
    transaction.sign(keypair);

    // Send transaction
    const signature = await connection.sendRawTransaction(transaction.serialize());

    // Wait for confirmation
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    console.log('[x402] Payment sent:', signature);

    return {
      version: X402_VERSION,
      network: requirement.network,
      signature,
      payer: keypair.publicKey.toBase58(),
    };
  } catch (error) {
    console.error('[x402] Payment error:', error);
    return null;
  }
}

/**
 * Parse x402 payment response header
 */
export function parsePaymentResponse(response: Response): PaymentResponse | null {
  const responseHeader = response.headers.get(X402_HEADER_RESPONSE);
  if (!responseHeader) return null;

  try {
    return JSON.parse(atob(responseHeader));
  } catch {
    return null;
  }
}

/**
 * Verify a payment transaction on-chain
 */
async function verifyPaymentOnChain(
  signature: string,
  expectedRecipient: string,
  expectedAmount: number,
  rpcEndpoint: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    const connection = new Connection(rpcEndpoint, 'confirmed');

    // Get transaction details
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) {
      return { valid: false, error: 'Transaction not found' };
    }

    // Check if transaction succeeded
    if (tx.meta?.err) {
      return { valid: false, error: 'Transaction failed on-chain' };
    }

    // Look for the transfer to the expected recipient
    const instructions = tx.transaction.message.instructions;
    let foundValidTransfer = false;

    for (const ix of instructions) {
      // Check parsed SystemProgram transfer
      if ('parsed' in ix && ix.program === 'system' && ix.parsed?.type === 'transfer') {
        const { destination, lamports } = ix.parsed.info;
        if (destination === expectedRecipient && lamports >= expectedAmount) {
          foundValidTransfer = true;
          break;
        }
      }
    }

    // Also check post-balances for the recipient
    if (!foundValidTransfer && tx.meta) {
      const accountKeys = tx.transaction.message.accountKeys;
      const recipientIndex = accountKeys.findIndex(
        (key) => key.pubkey.toBase58() === expectedRecipient
      );

      if (recipientIndex !== -1) {
        const preBalance = tx.meta.preBalances[recipientIndex] || 0;
        const postBalance = tx.meta.postBalances[recipientIndex] || 0;
        const received = postBalance - preBalance;

        if (received >= expectedAmount) {
          foundValidTransfer = true;
        }
      }
    }

    if (!foundValidTransfer) {
      return { valid: false, error: 'Payment not found in transaction' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: `Verification error: ${(error as Error).message}` };
  }
}

/**
 * Create x402 middleware for Express-style servers
 * (For server-side usage, e.g., in a backend service)
 */
export function createX402Middleware(config: {
  recipient: string;
  network: X402Network;
  pricing: Record<string, number>; // Route pattern -> lamports
  rpcEndpoint?: string;
}) {
  const rpcEndpoint = config.rpcEndpoint || (
    config.network === 'solana:mainnet-beta'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com'
  );

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Check if this route requires payment
    let price: number | undefined;
    for (const [pattern, amount] of Object.entries(config.pricing)) {
      if (path.match(new RegExp(pattern))) {
        price = amount;
        break;
      }
    }

    if (!price) {
      return null; // No payment required
    }

    // Check for payment header
    const paymentHeader = req.headers.get(X402_HEADER_SIGNATURE);
    if (!paymentHeader) {
      // Return 402 with requirements
      const requirement: PaymentRequirement = {
        version: X402_VERSION,
        network: config.network,
        recipient: config.recipient,
        amount: price.toString(),
        resource: path,
        expiresAt: Date.now() + 60000, // 1 minute
      };

      return new Response(null, {
        status: 402,
        headers: {
          [X402_HEADER_REQUIRED]: btoa(JSON.stringify(requirement)),
        },
      });
    }

    // Verify payment
    try {
      const payload: PaymentPayload = JSON.parse(atob(paymentHeader));

      if (!payload.signature) {
        throw new Error('Missing signature');
      }

      // Verify transaction on-chain
      const verification = await verifyPaymentOnChain(
        payload.signature,
        config.recipient,
        price,
        rpcEndpoint
      );

      if (!verification.valid) {
        console.error('[x402] Payment verification failed:', verification.error);
        return new Response(JSON.stringify({ error: verification.error }), {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }

      console.log('[x402] Payment verified on-chain:', payload.signature);
      return null; // Payment OK, continue to handler
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Invalid payment' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }
  };
}

/**
 * Utility to format lamports as SOL for display
 */
export function formatX402Amount(lamports: string | number): string {
  const sol = parseInt(lamports.toString()) / LAMPORTS_PER_SOL;
  return `${sol.toFixed(6)} SOL`;
}

/**
 * Check if a response is an x402 payment required
 */
export function isPaymentRequired(response: Response): boolean {
  return response.status === 402 && response.headers.has(X402_HEADER_REQUIRED);
}
