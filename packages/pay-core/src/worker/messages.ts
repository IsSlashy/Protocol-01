/**
 * Worker RPC message protocol — the typed boundary between the Solana adapter
 * (`chains/solana.ts`, secret-free, runs anywhere) and the stealth crypto core
 * (`worker/workerCore.ts`, holds ALL secrets, runs inside a Web Worker).
 *
 * The adapter serializes a `WorkerRequest`, hands it to a `SolanaWorkerClient`
 * (in production: a postMessage bridge to the per-app Worker entry; by default:
 * an in-process shim), and reads back a `WorkerResponse` carrying only PUBLIC
 * data (encoded metas, public payment views, unsigned transactions, tx refs).
 * No secret (spending secret, viewing X25519 private, ML-KEM secret, or derived
 * stealth keypair) ever appears in any message defined here.
 *
 * This file is framework-agnostic: type-only imports, no Web/Worker APIs.
 */

import type { Cluster } from '@protocol-01/specter-sdk/core';
import type { DerivedIdentity, ResolvedRecipient, StealthPayment, TxRef } from '../types';

// ---------------------------------------------------------------------------
// Requests (adapter -> worker core)
// ---------------------------------------------------------------------------

/** Derive the PUBLIC stealth identity from a wallet signature. Secrets are
 *  derived and retained INSIDE the worker core, keyed by the returned meta. */
export interface DeriveMetaRequest {
  kind: 'deriveMeta';
  /** Raw Ed25519 wallet signature over the domain-separated derivation message. */
  signature: Uint8Array;
  /** Connected wallet (base58). Claims from this identity may only pay out to
   *  this wallet — same-origin script cannot redirect a claim. The worker
   *  REJECTS claims from sessions derived without one (unbound sessions), so
   *  the adapter must always supply it (it refuses to derive without a signer
   *  runtime). Optional only for wire compatibility. */
  ownerWallet?: string;
}

/** Resolve a wallet address (registry lookup) or a pasted `st:02…` meta. */
export interface ResolveRecipientRequest {
  kind: 'resolveRecipient';
  input: string;
}

/** Build the (unsigned) v2 hybrid send transactions for a native-SOL payment.
 *  The worker core builds them from PUBLIC data only (recipient meta + sender
 *  pubkey); the caller's wallet signs all of them in ONE approval and submits. */
export interface BuildSendRequest {
  kind: 'buildSend';
  /** Connected wallet public key (base58) — fee payer / funding source. */
  senderPubkey: string;
  /** Recipient's v2 meta-address (st:02…). */
  recipientMeta: string;
  /** Asset symbol: 'SOL' (native) or 'USDC' (SPL). */
  assetSymbol: string;
  /** Amount in the asset's base units (lamports for SOL, 1e-6 for USDC), as a
   *  decimal string (bigint is not structured-cloneable everywhere). */
  amountLamports: string;
}

/** Scan the chain for inbound stealth payments to this identity. Requires the
 *  secret session created by a prior `deriveMeta` (looked up by `meta`). */
export interface ScanRequest {
  kind: 'scan';
  /** The identity's encoded meta (session key). */
  meta: string;
}

/** Claim a previously-scanned payment. The worker core self-signs the drain
 *  with the derived one-time stealth keypair and submits it. */
export interface ClaimRequest {
  kind: 'claim';
  meta: string;
  /** Payment id returned by a prior scan (its stealth address, base58). */
  paymentId: string;
  /** Destination wallet (base58) to receive the claimed funds. */
  destination: string;
}

/** Build the (unsigned) `register_v2` transaction publishing this identity's
 *  meta on-chain so others can pay it by wallet address. */
export interface RegisterSelfRequest {
  kind: 'registerSelf';
  senderPubkey: string;
  meta: string;
  name?: string;
}

/** Forget every in-memory secret session (wallet disconnect / switch). */
export interface ClearSessionsRequest {
  kind: 'clearSessions';
}

export type WorkerRequest =
  | DeriveMetaRequest
  | ResolveRecipientRequest
  | BuildSendRequest
  | ScanRequest
  | ClaimRequest
  | RegisterSelfRequest
  | ClearSessionsRequest;

export type WorkerRequestKind = WorkerRequest['kind'];

// ---------------------------------------------------------------------------
// Responses (worker core -> adapter)
// ---------------------------------------------------------------------------

export interface DeriveMetaResponse {
  kind: 'deriveMeta';
  identity: DerivedIdentity;
}

export interface ResolveRecipientResponse {
  kind: 'resolveRecipient';
  recipient: ResolvedRecipient;
}

/** Unsigned, base64-serialized legacy transactions the caller must sign+submit.
 *  Ordering contract: every tx EXCEPT the last is metadata (announcement init +
 *  KEM chunks); the LAST tx moves the funds. The caller must submit in order and
 *  abort before the last tx on any failure — then no funds have moved. */
export interface BuildSendResponse {
  kind: 'buildSend';
  transactionsB64: string[];
  /** The one-time stealth address funds are sent to (base58) — for display. */
  stealthAddress: string;
  /** Blockhash stamped on every tx + its expiry, for proper confirmation. */
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface ScanResponse {
  kind: 'scan';
  payments: StealthPayment[];
}

export interface ClaimResponse {
  kind: 'claim';
  tx: TxRef;
}

export interface RegisterSelfResponse {
  kind: 'registerSelf';
  transactionsB64: string[];
}

export interface ClearSessionsResponse {
  kind: 'clearSessions';
}

export type WorkerResponse =
  | DeriveMetaResponse
  | ResolveRecipientResponse
  | BuildSendResponse
  | ScanResponse
  | ClaimResponse
  | RegisterSelfResponse
  | ClearSessionsResponse;

/** Map a request kind to its matching response kind (compile-time correlation). */
export type ResponseFor<R extends WorkerRequest> = Extract<WorkerResponse, { kind: R['kind'] }>;

// ---------------------------------------------------------------------------
// Transport + runtime interfaces (implemented by the per-app wiring)
// ---------------------------------------------------------------------------

/**
 * The transport the adapter uses to reach the worker core. In production this
 * is a postMessage bridge to the Worker (secrets stay off the main thread); a
 * default in-process implementation is used when none is injected.
 */
export interface SolanaWorkerClient {
  request<R extends WorkerRequest>(req: R): Promise<ResponseFor<R>>;
}

/** RPC / program configuration for the worker core's own Connection. */
export interface SolanaWorkerConfig {
  /** Solana RPC endpoint the worker core connects to (scan/claim). */
  rpcUrl: string;
  cluster?: Cluster;
  /** Optional base58 override for the stealth program id (defaults to devnet). */
  programId?: string;
  /** Optional base58 override for the registry program id (defaults to devnet). */
  registryProgramId?: string;
  /** USDC mint (base58) for SPL stealth sends (defaults to Circle devnet USDC). */
  usdcMint?: string;
}

/**
 * Main-thread signer runtime. `buildSend` / `registerSelf` return UNSIGNED
 * transactions; the connected wallet (which the worker core never sees) signs
 * them in one approval and submits. The per-app UI provides this.
 */
export interface SolanaSignerRuntime {
  /** Connected wallet public key (base58) — fee payer for sends/registration. */
  senderPubkey: string;
  /**
   * Sign every provided (base64) transaction with the wallet in a single
   * approval and submit them IN ORDER, confirming each before the next. The
   * last tx is the funds transfer: abort before it on any earlier failure.
   * Resolves with the LAST transaction's signature (the payment).
   */
  signAndSubmit(
    transactionsB64: string[],
    ctx: { blockhash: string; lastValidBlockHeight: number },
  ): Promise<string>;
}
