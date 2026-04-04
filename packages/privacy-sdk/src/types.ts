import { type Connection, type PublicKey, type Keypair, type TransactionSignature } from '@solana/web3.js';

// ─── Network ──────────────────────────────────────────────────────────────────

export type Network = 'devnet' | 'mainnet';

// ─── Wallet Adapter ───────────────────────────────────────────────────────────

export interface WalletAdapter {
  publicKey: PublicKey;
  signTransaction: (tx: any) => Promise<any>;
  signAllTransactions?: (txs: any[]) => Promise<any[]>;
}

export type Signer = Keypair | WalletAdapter;

// ─── SDK Config ───────────────────────────────────────────────────────────────

export interface PrivacySDKConfig {
  connection: Connection;
  wallet: Signer;
  network?: Network;
  /** Override default program IDs */
  programIds?: Partial<ProgramIds>;
  /** Commitment level for transactions */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

export interface ProgramIds {
  zkShielded: PublicKey;
  specter: PublicKey;
  trustless: PublicKey;
  zkspl: PublicKey;
  relayer: PublicKey;
  registry: PublicKey;
  feeSplitter: PublicKey;
  stream: PublicKey;
  subscription: PublicKey;
  quantumVault: PublicKey;
  starkVerifier: PublicKey;
  arcium: PublicKey;
  bundler: PublicKey;
  whitelist: PublicKey;
  mugenExchange: PublicKey;
}

// ─── Token ────────────────────────────────────────────────────────────────────

export type TokenSymbol = 'SOL' | 'USDC' | 'USDT' | string;

export interface TokenInfo {
  symbol: string;
  mint: PublicKey;
  decimals: number;
}

// ─── Transaction Result ───────────────────────────────────────────────────────

export interface TxResult {
  signature: TransactionSignature;
  slot?: number;
  confirmations?: number;
}

// ─── Shield Module ────────────────────────────────────────────────────────────

export interface ShieldParams {
  amount: number | bigint;
  token: TokenSymbol;
  /** Use denominated pool (fixed-amount, Tornado-style) */
  denominated?: boolean;
}

export interface UnshieldParams {
  amount: number | bigint;
  token: TokenSymbol;
  /** Recipient public key (defaults to wallet) */
  recipient?: PublicKey;
  /** Use STARK proof (quantum-resistant) instead of Groth16 */
  useStark?: boolean;
  denominated?: boolean;
}

export interface PrivateTransferParams {
  amount: number | bigint;
  token: TokenSymbol;
  /** Recipient stealth meta-address or public key */
  to: string | PublicKey;
}

export interface ShieldReceipt {
  tx: TxResult;
  commitment: bigint;
  leafIndex: number;
  note: EncryptedNote;
}

export interface UnshieldReceipt {
  tx: TxResult;
  nullifier: bigint;
  amount: bigint;
}

export interface TransferReceipt {
  tx: TxResult;
  outputCommitments: [bigint, bigint];
  nullifiers: [bigint, bigint];
}

export interface EncryptedNote {
  ciphertext: Uint8Array;
  ephemeralPubkey: Uint8Array;
  commitment: Uint8Array;
  nonce: Uint8Array;
}

export interface PoolInfo {
  address: PublicKey;
  tokenMint: PublicKey;
  leafCount: number;
  merkleRoot: bigint;
  denomination?: bigint;
  epochDelay?: number;
}

// ─── Stealth Module ───────────────────────────────────────────────────────────

export interface StealthMetaAddress {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
  /** ML-KEM-768 public key for quantum resistance (v2) */
  kemPubKey?: Uint8Array;
  /** Ed25519 spending private key (only set by generateMetaAddress). Caller MUST persist securely and zero when done. */
  spendingPrivateKey?: Uint8Array;
  /** X25519 viewing private key (only set by generateMetaAddress). Caller MUST persist securely and zero when done. */
  viewingPrivateKey?: Uint8Array;
  encoded: string;
}

export interface StealthAddress {
  address: PublicKey;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
}

export interface StealthPayment {
  address: PublicKey;
  amount: bigint;
  tokenMint: PublicKey;
  ephemeralPubKey: Uint8Array;
  timestamp: number;
}

export interface StealthSendParams {
  to: string;
  amount: number | bigint;
  token?: TokenSymbol;
  /** Use quantum-resistant v2 stealth (ML-KEM-768) */
  quantumSafe?: boolean;
}

export interface StealthSendReceipt {
  tx: TxResult;
  stealthAddress: PublicKey;
  ephemeralPubKey: Uint8Array;
}

export interface StealthScanOptions {
  fromSlot?: number;
  toSlot?: number;
  batchSize?: number;
}

export interface StealthClaimReceipt {
  tx: TxResult;
  amount: bigint;
  tokenMint: PublicKey;
}

// ─── Confidential Balances ────────────────────────────────────────────────────

export interface ConfidentialDepositParams {
  amount: number | bigint;
  token: TokenSymbol;
}

export interface ConfidentialTransferParams {
  to: PublicKey;
  amount: number | bigint;
  token: TokenSymbol;
}

export interface ConfidentialWithdrawParams {
  amount: number | bigint;
  token: TokenSymbol;
  recipient?: PublicKey;
}

export interface ConfidentialBalanceResult {
  commitment: bigint;
  /** Decrypted balance (only available if spending key is set) */
  balance?: bigint;
  tokenMint: PublicKey;
}

export interface ConfidentialProveBalanceParams {
  token: TokenSymbol;
  /** Prove balance >= threshold without revealing exact amount */
  threshold: number | bigint;
}

// ─── Streams ──────────────────────────────────────────────────────────────────

export interface CreateStreamParams {
  recipient: PublicKey;
  totalAmount: number | bigint;
  token?: TokenSymbol;
  /** Duration in seconds */
  duration: number;
  /** Use stealth address for privacy */
  private?: boolean;
}

export interface StreamInfo {
  address: PublicKey;
  sender: PublicKey;
  recipient: PublicKey;
  totalAmount: bigint;
  withdrawnAmount: bigint;
  startTime: number;
  endTime: number;
  claimable: bigint;
  tokenMint: PublicKey;
  isPrivate: boolean;
}

export interface StreamReceipt {
  tx: TxResult;
  streamAddress: PublicKey;
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

export interface CreateSubscriptionParams {
  merchant: PublicKey;
  amount: number | bigint;
  token?: TokenSymbol;
  /** Interval in seconds */
  interval: number;
  maxPayments?: number;
  name?: string;
  /** Use shielded pool for privacy */
  private?: boolean;
}

export interface SubscriptionInfo {
  address: PublicKey;
  subscriber: PublicKey;
  merchant: PublicKey;
  amount: bigint;
  interval: number;
  nextPaymentDue: number;
  paymentsCompleted: number;
  maxPayments: number;
  isActive: boolean;
  isPrivate: boolean;
  tokenMint: PublicKey;
}

export interface SubscriptionReceipt {
  tx: TxResult;
  subscriptionAddress: PublicKey;
}

// ─── Quantum Vault ────────────────────────────────────────────────────────────

export type VaultType = 'wots' | 'htl';

export interface CreateVaultParams {
  type: VaultType;
  /** For HTL: timelock in seconds */
  timelock?: number;
  /** For HTL: destination wallet on unlock */
  destination?: PublicKey;
}

export interface VaultDepositParams {
  vault: PublicKey;
  amount: number | bigint;
}

export interface VaultWithdrawParams {
  vault: PublicKey;
  amount: number | bigint;
  /** For HTL vaults: the 32-byte SHA-256 preimage that unlocks the vault */
  preimage?: Uint8Array;
}

export interface VaultInfo {
  address: PublicKey;
  type: VaultType;
  owner: PublicKey;
  balance: bigint;
  /** WOTS+: current key index */
  keyIndex?: number;
  /** HTL: unlock timestamp */
  unlockAfter?: number;
  /** HTL: destination */
  destination?: PublicKey;
}

export interface VaultReceipt {
  tx: TxResult;
  vaultAddress: PublicKey;
  /** WOTS+: the seed used to derive the keypair (caller MUST persist this) */
  secret?: Uint8Array;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface RegisterParams {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
  /** ML-KEM-768 public key for quantum-resistant stealth (v2) */
  kemPubKey?: Uint8Array;
  name?: string;
}

export interface RegistryEntry {
  owner: PublicKey;
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
  kemPubKey?: Uint8Array;
  version: number;
  name: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Relay ────────────────────────────────────────────────────────────────────

export interface RelayJobParams {
  /** Encrypted transaction data */
  encryptedTx: Uint8Array;
}

export interface RelayerInfo {
  address: PublicKey;
  operator: PublicKey;
  stake: bigint;
  encryptionKey: Uint8Array;
  kemEncryptionKey?: Uint8Array;
  isActive: boolean;
  jobsCompleted: number;
}

export interface RelayJobReceipt {
  tx: TxResult;
  jobId: string;
  jobAddress: PublicKey;
  relayer: PublicKey;
}

export interface RelayJobStatus {
  jobId: string;
  status: 'pending' | 'completed' | 'expired' | 'cancelled';
  txSignature?: string;
}

// ─── MPC (Arcium) ─────────────────────────────────────────────────────────────

export interface MPCVoteParams {
  proposalId: string;
  choice: number;
  /** Token-weighted voting amount (optional) */
  weight?: number | bigint;
}

export interface MPCCreateProposalParams {
  proposalId: string;
  optionCount: number;
  /** Deadline as Unix timestamp */
  deadline: number;
}

export interface MPCAuditParams {
  encryptedBalance: Uint8Array;
}

export interface MPCSealedBidParams {
  auctionId: PublicKey;
  bidAmount: number | bigint;
}

export interface MPCProposalInfo {
  address: PublicKey;
  proposalId: string;
  optionCount: number;
  deadline: number;
  isFinalized: boolean;
  results?: number[];
}

export interface MPCAuctionInfo {
  address: PublicKey;
  isFinalized: boolean;
  winnerCommitment?: bigint;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type PrivacyEventType =
  | 'shield'
  | 'unshield'
  | 'transfer'
  | 'stealth:send'
  | 'stealth:receive'
  | 'stealth:claim'
  | 'stream:create'
  | 'stream:withdraw'
  | 'subscription:create'
  | 'subscription:payment'
  | 'vault:create'
  | 'vault:deposit'
  | 'vault:withdraw'
  | 'relay:submit'
  | 'relay:complete'
  | 'mpc:vote'
  | 'mpc:tally'
  | 'error';

export type PrivacyEventCallback = (event: PrivacyEvent) => void;

export interface PrivacyEvent {
  type: PrivacyEventType;
  data: any;
  timestamp: number;
}

// ─── Proof Types ──────────────────────────────────────────────────────────────

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}

export interface ProofResult {
  proof: Groth16Proof;
  publicSignals: string[];
  durationMs?: number;
}

export interface ProverConfig {
  /** Circuit WASM file path or URL */
  wasmPath?: string;
  /** Circuit zkey file path or URL */
  zkeyPath?: string;
  /** Use local-only proving (default: true) */
  localOnly?: boolean;
  /** Proof generation timeout in ms (default: 120000) */
  timeout?: number;
}
