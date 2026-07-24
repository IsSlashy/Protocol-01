/**
 * Chain-pluggable stealth interface.
 *
 * The hybrid stealth *crypto* (derive keys, encapsulate ML-KEM, view-tag,
 * one-time address) is chain-agnostic — only the wallet/signer and the
 * on-chain transport differ per chain. Every chain implements this one
 * interface so the coin selector and the send/receive UI are written once.
 *
 * This lives in `@protocol-01/pay-core` so it is framework-agnostic: no
 * Next.js or Vite specific imports. Both apps/web (Next 16) and
 * apps/extension (Vite) consume it identically.
 *
 * The Solana adapter (`chains/solana.ts`) is the real specter-sdk-backed
 * implementation: it is secret-free and delegates all stealth crypto to
 * `worker/workerCore.ts` over the typed worker RPC in `worker/messages.ts`.
 * The Starknet adapter (`chains/starknet.ts`) is live too: send/scan/claim run
 * on the direct ERC-20 + pq_announcer path (amounts public on that path; the
 * STRK20 pool integration that hides amounts is still gated).
 */

export type ChainId = 'solana' | 'starknet';

export type AdapterStatus = 'live' | 'coming-soon';

export interface Asset {
  symbol: string; // e.g. 'SOL'
  name: string; // e.g. 'Solana'
  chainId: ChainId;
  decimals: number;
  /** Minimum sendable amount in whole units (rent + fee + dust floor). */
  minSend: number;
  status: AdapterStatus;
  /** Optional UI note explaining a `coming-soon` gate (e.g. SPL not yet in SDK). */
  note?: string;
}

/** Public identity derived from a wallet signature. NEVER carries secrets. */
export interface DerivedIdentity {
  chainId: ChainId;
  /** Encoded v2 hybrid meta-address (st:02…). Public — safe to share. */
  meta: string;
  spendingPubKey: string;
  viewingPubKey: string;
  /** ML-KEM-768 public key (display-truncated in UI). */
  kemPubKey: string;
}

export interface ResolvedRecipient {
  meta: string;
  version: 2;
  /** Human label for the UI (wallet address or "pasted meta"). */
  label: string;
}

export interface FeeQuote {
  networkFee: number;
  protocolFee: number;
  /** One-time announcement rent the SENDER pays on top of the amount (not deducted). */
  senderRent?: number;
  /** Minimum amount the recipient can viably claim (claim fee + rent-exemption + margin). */
  minSend: number;
  estTime: string;
  /** Number of wallet approvals the send will raise (1 with signAllTransactions). */
  approvals: number;
}

export interface SendParams {
  recipient: ResolvedRecipient;
  asset: Asset;
  amount: number;
}

export interface TxRef {
  signature: string;
  explorerUrl?: string;
}

export interface StealthPayment {
  id: string;
  stealthAddress: string;
  amount: number;
  assetSymbol: string;
  ephemeralPubKey: string;
  receivedAt: number;
  claimed: boolean;
}

/**
 * One chain's stealth capabilities. Wallet connection is owned by the UI
 * (via @solana/wallet-adapter for Solana); the adapter only receives the
 * signature bytes it needs to derive the identity.
 */
export interface ChainStealthAdapter {
  id: ChainId;
  label: string;
  status: AdapterStatus;
  assets: Asset[];

  /** Derive the PUBLIC identity from a wallet signature. Secrets stay isolated. */
  deriveMeta(signature: Uint8Array): Promise<DerivedIdentity>;

  /** Resolve a recipient wallet address or pasted st: meta to a v2 meta. */
  resolveRecipient(input: string): Promise<ResolvedRecipient>;

  /** Fee + min-send quote, shown upfront. */
  quoteFees(asset: Asset, amount: number): FeeQuote;

  send(params: SendParams): Promise<TxRef>;
  scan(identity: DerivedIdentity): Promise<StealthPayment[]>;
  claim(payment: StealthPayment, identity: DerivedIdentity, destination: string): Promise<TxRef>;

  /** Publish this identity's meta on-chain (register_v2) so others can pay by wallet. */
  registerSelf(identity: DerivedIdentity): Promise<TxRef>;
}
