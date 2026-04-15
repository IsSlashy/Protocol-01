// ═══════════════════════════════════════════════════════════════════════════
// Shared types for the encrypted Mugen order flow — FROST + Arcium MPC.
// Mirrors the shape returned by /api/orders/encrypted and /api/trade/blind-take.
// ═══════════════════════════════════════════════════════════════════════════

export type OrderType = 'sell' | 'buy';
export type FiatCurrency = 'EUR' | 'USD';

export interface ThresholdSigner {
  region: string;
  port: number;
  signerPubkey: string;
  signedAt: number;
}

export interface ThresholdMetaSuccess {
  reached: true;
  signaturesCount: number;
  threshold: number;
  totalSigners: number;
  txHashHex: string;
  signers: ThresholdSigner[];
}

export interface ThresholdMetaFailure {
  reached: false;
  signaturesCount: number;
  threshold: number;
  totalSigners: number;
}

export interface EncryptedOfferRequest {
  orderType: OrderType;
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethods: number;
  expiresAtUnix: number;
  makerNoncePubkey: string;
  /** Layer 3 opt-in: server will fire N indistinguishable decoys alongside. */
  boostPrivacy?: boolean;
}

export interface EncryptedOfferSuccess {
  ok: true;
  computationOffset: string;
  txSignature: string;
  /** Layer 3: number of decoys scheduled after this submit (0 if boost off). */
  decoysScheduled?: number;
  threshold?: ThresholdMetaSuccess;
}

export interface BlindTakeRequest {
  desiredCryptoAmountLamports: number;
  maxFiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethodsMask: number;
  takerNoncePubkey: string;
}

/**
 * Details of the matched maker order surfaced to the taker so they can
 * trigger the follow-up claim-match + escrow creation.
 *
 * MVP: sourced from the ephemeral server-side encrypted-order registry.
 * Production path = parse the Arcium MPC callback output (blocked on
 * arcium-anchor 0.9.2 callback output wrapper ABI).
 */
export interface MatchedOrderDetails {
  makerNoncePubkey: string;
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethods: number;
  expiresAtUnix: number;
  mpcTxSignature: string;
  registeredAt: number;
}

export interface BlindTakeMatched {
  matched: true;
  computationOffset: string;
  txSignature: string;
  matchedOrderNonce: string;
  matchedCryptoAmount: number;
  matchedFiatAmount: number;
  threshold?: ThresholdMetaSuccess;
  matchedOrder?: MatchedOrderDetails;
}

export interface BlindTakeNoMatch {
  matched: false;
  computationOffset: string;
  txSignature: string;
  threshold?: ThresholdMetaSuccess;
}

export type BlindTakeResponse = BlindTakeMatched | BlindTakeNoMatch;

export interface MpcApiError {
  error: string;
  detail?: string;
  signers?: { region: string; port: number }[];
  threshold?: ThresholdMetaFailure;
}

export type SubmitPhase = 'idle' | 'threshold' | 'mpc' | 'done';
