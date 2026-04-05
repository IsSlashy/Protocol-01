/**
 * UC8: Mugen P2P Exchange -- Encrypted Order Matching via Arcium MPC
 *
 * Privacy Layer 8: Even the Solana program cannot see trade terms.
 * Orders are encrypted in MPC persistent state. Matching is blind.
 * Only the match result (amounts + anonymous nonces) is revealed
 * on-chain for escrow creation.
 *
 * **Inputs**: Encrypted offer/take parameters (crypto amount, fiat price,
 * currency hash, payment methods bitmask, anonymous nonce).
 * **Output**: Match result with revealed trade terms, or "no match" with
 * nothing leaked.
 *
 * @module mugen
 */

import * as anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import type { ArciumClient } from '../client';

// ─── Circuit names (must match encrypted-ixs function names) ────────────────

/** Circuit names for the Mugen P2P exchange MPC operations. */
export const MUGEN_CIRCUITS = {
  /** Encrypted sell offer submission into MPC persistent state. */
  SUBMIT_OFFER: 'mugen_submit_offer',
  /** Blind buy-side match attempt against encrypted offers. */
  BLIND_TAKE: 'mugen_blind_take',
  /** Cancel an existing encrypted offer (requires maker nonce proof). */
  CANCEL_OFFER: 'mugen_cancel_offer',
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Parameters for submitting an encrypted sell offer. */
export interface EncryptedOfferParams {
  /** Crypto amount in lamports (e.g., 100_000_000n for 0.1 SOL). */
  cryptoAmount: bigint;
  /** Fiat amount in cents (e.g., 1500n for $15.00). */
  fiatAmount: bigint;
  /** ISO 4217 fiat currency code ("USD", "EUR", "GBP"). Hashed to u64 for MPC. */
  currency: string;
  /** Bitmask of accepted payment methods (app-defined bit positions). */
  paymentMethods: number;
  /** Random anonymous nonce linking this offer to its escrow (use {@link generateNonce}). */
  makerNonce: bigint;
}

/** Parameters for a blind buy-side match attempt. */
export interface BlindTakeParams {
  /** Desired crypto amount in lamports. */
  desiredCrypto: bigint;
  /** Maximum fiat willing to pay (in cents). */
  maxFiat: bigint;
  /** Required ISO 4217 currency code. */
  currency: string;
  /** Bitmask of buyer's accepted payment methods. */
  paymentMethods: number;
  /** Random anonymous taker nonce for escrow linkage (use {@link generateNonce}). */
  takerNonce: bigint;
}

/** Receipt returned after submitting an encrypted offer. */
export interface OfferReceipt {
  /** Computation offset for tracking this MPC job. */
  computationOffset: anchor.BN;
  /** The maker nonce used (for later cancellation or escrow lookup). */
  makerNonce: bigint;
  /** Transaction signature of the offer submission. */
  signature: string;
}

/** Result of a blind take attempt -- either a match or no match. */
export interface MatchResult {
  /** Whether the buyer's query matched an existing offer. */
  matched: boolean;
  /** Matched crypto amount (0n if no match). */
  cryptoAmount: bigint;
  /** Matched fiat amount (0n if no match). */
  fiatAmount: bigint;
  /** Maker's anonymous nonce (0n if no match). */
  makerNonce: bigint;
  /** Taker's anonymous nonce (0n if no match). */
  takerNonce: bigint;
  /** Currency hash used for matching (0n if no match). */
  currencyHash: bigint;
  /** Finalization callback transaction signature. */
  signature: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Hash a currency code to u64 for constant-time MPC comparison.
 * SHA256("USD") → first 8 bytes → u64 LE.
 */
export function currencyToHash(currency: string): bigint {
  const hash = createHash('sha256').update(currency.toUpperCase()).digest();
  return hash.readBigUInt64LE(0);
}

/**
 * Generate a random anonymous nonce (u64).
 * Used as maker_nonce or taker_nonce — links to escrow without
 * revealing wallet identity.
 */
export function generateNonce(): bigint {
  const buf = Buffer.alloc(8);
  crypto.getRandomValues(buf);
  return buf.readBigUInt64LE(0);
}

// ─── SDK Functions ──────────────────────────────────────────────────────────

/**
 * Submit an encrypted sell offer into MPC persistent state.
 *
 * The offer terms (crypto amount, fiat price, currency, payment methods)
 * are encrypted with the client's ephemeral key. Only the MPC cluster
 * (threshold N-of-M) can access them during a matching computation.
 *
 * @returns Receipt with computation offset and maker nonce.
 */
export async function submitEncryptedOffer(
  client: ArciumClient,
  program: anchor.Program,
  params: EncryptedOfferParams,
): Promise<OfferReceipt> {
  const currHash = currencyToHash(params.currency);

  // Encrypt 5 u64 values → 2 ciphertext blocks (3+2 packing)
  const payload = client.encrypt([
    params.cryptoAmount,
    params.fiatAmount,
    currHash,
    BigInt(params.paymentMethods),
    params.makerNonce,
  ]);

  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(
    MUGEN_CIRCUITS.SUBMIT_OFFER,
    computationOffset,
  );

  let sig: string;
  try {
    sig = await program.methods
      .mugenSubmitOffer(
        computationOffset,
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.ciphertexts[1]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce),
      )
      .accountsPartial({ ...accounts })
      .rpc({ commitment: 'confirmed' });
  } catch (err) {
    throw new Error(
      `Mugen MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  return {
    computationOffset,
    makerNonce: params.makerNonce,
    signature: sig,
  };
}

/**
 * Blindly match against an encrypted offer.
 *
 * The buyer's query and the seller's offer are both decrypted only
 * inside the MPC computation. 4 compatibility checks run in constant-time:
 *   1. Currency match
 *   2. Amount check (buyer wants ≤ offer)
 *   3. Price check (offer price ≤ buyer's max)
 *   4. Payment method overlap
 *
 * If all pass: trade terms revealed. If not: "MugenNoMatch", nothing leaked.
 *
 * @returns Match result with revealed trade terms (or matched=false).
 */
export async function blindTakeOrder(
  client: ArciumClient,
  program: anchor.Program,
  params: BlindTakeParams,
): Promise<MatchResult> {
  const currHash = currencyToHash(params.currency);

  const payload = client.encrypt([
    params.desiredCrypto,
    params.maxFiat,
    currHash,
    BigInt(params.paymentMethods),
    params.takerNonce,
  ]);

  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(
    MUGEN_CIRCUITS.BLIND_TAKE,
    computationOffset,
  );

  let finalizeSig: string;
  try {
    await program.methods
      .mugenBlindTake(
        computationOffset,
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.ciphertexts[1]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce),
      )
      .accountsPartial({ ...accounts })
      .rpc({ commitment: 'confirmed' });

    // Wait for MPC callback
    finalizeSig = await client.awaitFinalization(computationOffset);
  } catch (err) {
    throw new Error(
      `Mugen MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  // Parse result from callback logs
  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const matchLine = logs.find((l) => l.includes('MugenMatch:'));

  if (matchLine) {
    const m = matchLine.match(
      /crypto=(\d+), fiat=(\d+), maker=(\d+), taker=(\d+)/,
    );
    if (m) {
      return {
        matched: true,
        cryptoAmount: BigInt(m[1]),
        fiatAmount: BigInt(m[2]),
        makerNonce: BigInt(m[3]),
        takerNonce: BigInt(m[4]),
        currencyHash: currHash,
        signature: finalizeSig,
      };
    }
  }

  return {
    matched: false,
    cryptoAmount: 0n,
    fiatAmount: 0n,
    makerNonce: 0n,
    takerNonce: 0n,
    currencyHash: 0n,
    signature: finalizeSig,
  };
}

/**
 * Cancel an encrypted offer.
 *
 * The seller proves ownership by providing the same maker_nonce
 * encrypted. MPC compares inside the computation.
 */
export async function cancelEncryptedOffer(
  client: ArciumClient,
  program: anchor.Program,
  makerNonce: bigint,
): Promise<string> {
  const payload = client.encrypt([makerNonce]);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(
    MUGEN_CIRCUITS.CANCEL_OFFER,
    computationOffset,
  );

  try {
    const sig = await program.methods
      .mugenCancelOffer(
        computationOffset,
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce),
      )
      .accountsPartial({ ...accounts })
      .rpc({ commitment: 'confirmed' });

    return sig;
  } catch (err) {
    throw new Error(
      `Mugen MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }
}
