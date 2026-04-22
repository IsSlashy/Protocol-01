// ═══════════════════════════════════════════════════════════════════════════
// Mobile-side types for the encrypted Mugen order flow — FROST + Arcium MPC.
//
// These MUST stay in sync with apps/mugen/lib/mpc-types.ts and the response
// shapes returned by apps/mugen/app/api/orders/* and apps/mugen/app/api/trade/*.
// We duplicate (rather than import) because the mobile app and the mugen web
// app are separate TypeScript projects.
// ═══════════════════════════════════════════════════════════════════════════

export type OrderType = 'sell' | 'buy';
export type FiatCurrency = 'EUR' | 'USD';

// ─── FROST threshold metadata ──────────────────────────────────────────────
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

// ─── Encrypted offer submission ────────────────────────────────────────────
export interface EncryptedOfferRequest {
  orderType: OrderType;
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethods: number;
  expiresAtUnix: number;
  makerNoncePubkey: string;
}

export interface EncryptedOfferSuccess {
  ok: true;
  computationOffset: string;
  txSignature: string;
  threshold?: ThresholdMetaSuccess;
}

// ─── Blind-take ─────────────────────────────────────────────────────────────
export interface BlindTakeRequest {
  desiredCryptoAmountLamports: number;
  maxFiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethodsMask: number;
  takerNoncePubkey: string;
}

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

// ─── Claim match ────────────────────────────────────────────────────────────
export interface MatchedTerms {
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethods: number;
  makerNoncePubkey: string;
  takerNoncePubkey: string;
  takerWallet: string;
}

export interface ClaimMatchResponse {
  ok: true;
  tokenEscrow?: boolean;
  escrowPDA?: string;
  vaultPDA?: string;
  orderPDA?: string;
  reputationPDA?: string;
  txSignature?: string;
  simulated?: boolean;
  matchedTerms: MatchedTerms;
  note?: string;
  fallbackReason?: string;
}

// ─── Escrow status ──────────────────────────────────────────────────────────
export type EscrowStatusLabel =
  | 'awaiting_payment'
  | 'payment_confirmed'
  | 'released'
  | 'disputed'
  | 'resolved'
  | 'expired'
  | 'unknown';

export interface EscrowStatusResponse {
  exists: true;
  status: EscrowStatusLabel;
  statusCode: number;
  maker: string;
  taker: string;
  cryptoAmount: string;
  fiatAmount: string;
  expiresAt: number;
  paymentConfirmedAt: number;
  vault: string;
  tokenMint: string;
  disputeReason: number;
  disputeInitiator: string;
}

// ─── Lifecycle actions ──────────────────────────────────────────────────────
export interface ConfirmPaymentResponse {
  ok: true;
  txSignature: string;
  as: 'taker' | 'maker';
}

export interface FeeSplit {
  p01: string;
  mugen: string;
  treasury: string;
  noise: string;
  buyerAmount: string;
  totalFee: string;
  feeBps: number;
}

export interface ReleaseBootstrapped {
  buyerATA: boolean;
  p01ATA: boolean;
  mugenATA: boolean;
  treasuryATA: boolean;
  noiseATA: boolean;
  makerReputation: boolean;
  takerReputation: boolean;
}

export interface ReleaseEscrowResponse {
  ok: true;
  txSignature: string;
  feeSplit: FeeSplit;
  bootstrapped: ReleaseBootstrapped;
}

export interface DisputeResponse {
  ok: true;
  txSignature: string;
  as: 'taker' | 'maker';
  reason: number;
}

// ─── My order / cancel ──────────────────────────────────────────────────────
export interface MyOrderResponse {
  found: boolean;
  order?: {
    makerNoncePubkey: string;
    orderType: OrderType;
    cryptoAmountLamports: number;
    fiatAmountCents: number;
    fiatCurrency: FiatCurrency;
    paymentMethods: number;
    expiresAtUnix: number;
    registeredAt: number;
    mpcTxSignature?: string;
  };
}

export interface CancelResponse {
  ok: true;
  cancelled: boolean;
  txSignature?: string;
}

// ─── Private-matches feed ───────────────────────────────────────────────────
export interface PrivateMatchReceipt {
  makerNoncePubkey?: string;
  takerNoncePubkey?: string;
  escrowPDA?: string;
  txSignature?: string;
  matchedAt: number;
  status?: EscrowStatusLabel;
  cryptoAmountLamports?: number;
  fiatAmountCents?: number;
  fiatCurrency?: FiatCurrency;
}

export interface PrivateMatchesFeedResponse {
  matches: PrivateMatchReceipt[];
}

// ─── Error shape ────────────────────────────────────────────────────────────
export interface MpcApiError {
  error: string;
  detail?: string;
  signers?: { region: string; port: number }[];
  threshold?: ThresholdMetaFailure;
}

export type SubmitPhase = 'idle' | 'threshold' | 'mpc' | 'done';
