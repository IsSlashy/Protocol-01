/**
 * UC8: Mugen P2P Exchange — Encrypted Order Matching via Arcium MPC.
 *
 * Privacy Layer 8: Even the Solana program cannot see trade terms.
 * Orders are encrypted in MPC persistent state. Matching is blind.
 * Only the match result (amounts + anonymous nonces) is revealed
 * on-chain for escrow creation.
 *
 * Flow:
 *   1. Seller: submitEncryptedOffer() → offer stored in MPC state
 *   2. Buyer: blindTakeOrder() → MPC checks compatibility in the dark
 *   3. If match: MugenMatchFound event emitted → escrow created
 *   4. If no match: "MugenNoMatch" logged, nothing leaked
 */

import * as anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import type { ArciumClient } from '../client';

// ─── Circuit names (must match encrypted-ixs function names) ────────────────

export const MUGEN_CIRCUITS = {
  SUBMIT_OFFER: 'mugen_submit_offer',
  BLIND_TAKE: 'mugen_blind_take',
  CANCEL_OFFER: 'mugen_cancel_offer',
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EncryptedOfferParams {
  /** Crypto amount in lamports (e.g., 100_000_000n for 0.1 SOL). */
  cryptoAmount: bigint;
  /** Fiat amount in cents (e.g., 1500n for $15.00). */
  fiatAmount: bigint;
  /** Fiat currency code ("USD", "EUR", "GBP"). */
  currency: string;
  /** Accepted payment methods bitmask. */
  paymentMethods: number;
  /** Anonymous maker nonce — random per offer, used to link to escrow. */
  makerNonce: bigint;
}

export interface BlindTakeParams {
  /** Desired crypto amount in lamports. */
  desiredCrypto: bigint;
  /** Maximum fiat willing to pay (cents). */
  maxFiat: bigint;
  /** Required currency code. */
  currency: string;
  /** Buyer's accepted payment methods bitmask. */
  paymentMethods: number;
  /** Anonymous taker nonce — random, used to link to escrow. */
  takerNonce: bigint;
}

export interface OfferReceipt {
  computationOffset: anchor.BN;
  makerNonce: bigint;
  signature: string;
}

export interface MatchResult {
  matched: boolean;
  cryptoAmount: bigint;
  fiatAmount: bigint;
  makerNonce: bigint;
  takerNonce: bigint;
  currencyHash: bigint;
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

  const sig = await program.methods
    .mugenSubmitOffer(
      computationOffset,
      Array.from(payload.ciphertexts[0]),
      Array.from(payload.ciphertexts[1]),
      Array.from(payload.publicKey),
      client.nonceToU128(payload.nonce),
    )
    .accountsPartial({ ...accounts })
    .rpc({ commitment: 'confirmed' });

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

  const sig = await program.methods
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
  const finalizeSig = await client.awaitFinalization(computationOffset);

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
}
