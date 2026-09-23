import { type Connection, type PublicKey, type Keypair, type TransactionSignature } from '@solana/web3.js';

// ─── Network ──────────────────────────────────────────────────────────────────

/** Solana cluster target. Use 'devnet' for testing, 'mainnet' for production. */
export type Network = 'devnet' | 'mainnet';

// ─── Wallet Adapter ───────────────────────────────────────────────────────────

/** Minimal wallet adapter interface compatible with @solana/wallet-adapter. */
export interface WalletAdapter {
  publicKey: PublicKey;
  signTransaction: (tx: any) => Promise<any>;
  signAllTransactions?: (txs: any[]) => Promise<any[]>;
  /**
   * Off-chain message signer. Present on software wallets (Phantom, Solflare,
   * Android MWA); absent on hardware (Ledger). Used by `deriveP01Identity` to
   * obtain deterministic input keying material. See identity/deriveIdentity.ts.
   */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

/** A signer is either a Solana Keypair (for scripts/backends) or a WalletAdapter (for frontends). */
export type Signer = Keypair | WalletAdapter;

// ─── SDK Config ───────────────────────────────────────────────────────────────

/** Configuration for initializing the PrivacySDK. */
export interface PrivacySDKConfig {
  /** Active Solana RPC connection. */
  connection: Connection;
  /** Wallet used to sign transactions. Accepts Keypair or WalletAdapter. */
  wallet: Signer;
  /**
   * 32-byte spending key, validated and held as `sdk.spendingKey`. Since 2.0.0
   * no module of this SDK builds shielded notes with it; it stays required so
   * one config shape serves every host. The SDK never derives this implicitly.
   * Integrators may either:
   *   - call `deriveSpendingKeyFromSignature(signer, { domain })` and pass
   *     the result here (recommended default, cross-app portable), or
   *   - supply their own 32-byte material (hardware wallet, seed derivation,
   *     user-imported key) wrapped with `asSpendingKey(bytes)`.
   * See P11.D decision (2026-04-18).
   */
  spendingKey: Uint8Array;
  /** Target network. Defaults to 'devnet' with a console warning if omitted. */
  network?: Network;
  /** Override default program IDs (e.g., for custom deployments or localnet). */
  programIds?: Partial<ProgramIds>;
  /** Commitment level for transaction confirmations. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * On-chain program addresses, per network.
 *
 * 2.0.0 dropped `trustless`, `zkspl`, `stream`, `subscription`, `whitelist`
 * and `bundler`: no program is deployed behind any of them, and the modules
 * that read them were removed.
 */
export interface ProgramIds {
  /** zk_shielded pool program. No module of this SDK builds pool instructions. */
  zkShielded: PublicKey;
  /** On-chain relayer program (transaction relay). */
  relayer: PublicKey;
  /** Stealth meta-address registry program. */
  registry: PublicKey;
  /** STARK proof verifier program. */
  starkVerifier: PublicKey;
}

// ─── Token ────────────────────────────────────────────────────────────────────

/** Token symbol string. Standard symbols are 'SOL', 'USDC', 'USDT'; any mint address is also accepted. */
export type TokenSymbol = 'SOL' | 'USDC' | 'USDT' | string;

/** Resolved token information including mint address and decimals. */
export interface TokenInfo {
  symbol: string;
  mint: PublicKey;
  decimals: number;
}

// ─── Transaction Result ───────────────────────────────────────────────────────

/** Result of a confirmed on-chain transaction. */
export interface TxResult {
  /** Base-58 encoded transaction signature. */
  signature: TransactionSignature;
  /** Slot in which the transaction was processed. */
  slot?: number;
  /** Number of confirmations at time of return. */
  confirmations?: number;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/** Parameters for registering a stealth meta-address on-chain. */
export interface RegisterParams {
  /** Ed25519 spending public key. */
  spendingPubKey: Uint8Array;
  /** X25519 viewing public key. */
  viewingPubKey: Uint8Array;
  /** ML-KEM-768 public key for quantum-resistant stealth (v2). */
  kemPubKey?: Uint8Array;
  /** Human-readable name/alias. */
  name?: string;
}

/** On-chain registry entry for a stealth meta-address. */
export interface RegistryEntry {
  /** Wallet that owns this registry entry. */
  owner: PublicKey;
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
  kemPubKey?: Uint8Array;
  /** Registry entry version (1 = Ed25519 only, 2 = Ed25519 + ML-KEM). */
  version: number;
  name: string;
  /** Unix timestamp of creation. */
  createdAt: number;
  /** Unix timestamp of last update. */
  updatedAt: number;
}

// ─── Relay ────────────────────────────────────────────────────────────────────

/** Parameters for submitting a transaction through the privacy relay. */
export interface RelayJobParams {
  /** Encrypted transaction data (encrypted to the relayer's public key). */
  encryptedTx: Uint8Array;
}

/** On-chain information about a registered relayer. */
export interface RelayerInfo {
  /** Relayer account address. */
  address: PublicKey;
  /** Relayer operator wallet. */
  operator: PublicKey;
  /** Staked amount in lamports. */
  stake: bigint;
  /** X25519 encryption key for encrypting transaction data. */
  encryptionKey: Uint8Array;
  /** ML-KEM encryption key for quantum-resistant relay (optional). */
  kemEncryptionKey?: Uint8Array;
  isActive: boolean;
  jobsCompleted: number;
}

/** Receipt from submitting a relay job. */
export interface RelayJobReceipt {
  tx: TxResult;
  /** Unique job identifier. */
  jobId: string;
  /** On-chain job account address. */
  jobAddress: PublicKey;
  /** Relayer that accepted the job. */
  relayer: PublicKey;
}

/** Status of a relay job. */
export interface RelayJobStatus {
  jobId: string;
  status: 'pending' | 'completed' | 'expired' | 'cancelled';
  /** Transaction signature once the relayer executes the job. */
  txSignature?: string;
}

// ─── Events ───────────────────────────────────────────────────────────────────

/** Event types emitted by the SDK. Subscribe with `sdk.on(type, callback)`. */
export type PrivacyEventType =
  | 'relay:submit'
  | 'relay:complete'
  | 'error';

/** Callback function for SDK events. */
export type PrivacyEventCallback = (event: PrivacyEvent) => void;

/** An event emitted by the SDK. */
export interface PrivacyEvent {
  type: PrivacyEventType;
  data: any;
  /** Unix timestamp (ms) when the event was emitted. */
  timestamp: number;
}
