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
   * 32-byte spending key used to derive the Goldilocks owner identity for
   * shielded notes. The SDK never derives this implicitly. Integrators may
   * either:
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

/** On-chain program addresses for each Protocol 01 module. */
export interface ProgramIds {
  /** ZK shielded pool program (shield/unshield/transfer). */
  zkShielded: PublicKey;
  /** Stealth address program (send/scan/claim). */
  specter: PublicKey;
  /** Trustless pool program (no-relayer nullifier verification). */
  trustless: PublicKey;
  /** Confidential SPL token program (encrypted balances). */
  zkspl: PublicKey;
  /** On-chain relayer program (transaction relay). */
  relayer: PublicKey;
  /** Stealth meta-address registry program. */
  registry: PublicKey;
  /** Fee splitter program (protocol fee distribution). */
  feeSplitter: PublicKey;
  /** Payment streaming program. */
  stream: PublicKey;
  /** Recurring subscription payment program. */
  subscription: PublicKey;
  /** Quantum-safe vault program (WOTS+ and Hash-Timelock). */
  quantumVault: PublicKey;
  /** STARK proof verifier program (quantum-resistant proofs). */
  starkVerifier: PublicKey;
  /** Arcium MPC program (multi-party computation). */
  arcium: PublicKey;
  /** Transaction bundler program. */
  bundler: PublicKey;
  /** Whitelist program (access control). */
  whitelist: PublicKey;
  /** Mugen P2P exchange program. */
  mugenExchange: PublicKey;
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

// ─── Shield Module ────────────────────────────────────────────────────────────

/** Parameters for shielding (depositing) funds into a privacy pool. */
export interface ShieldParams {
  /** Amount in base units (lamports for SOL, smallest unit for SPL). */
  amount: number | bigint;
  /** Token to shield. */
  token: TokenSymbol;
  /** Use denominated pool (fixed-amount, Tornado-style) instead of variable-amount pool. */
  denominated?: boolean;
}

/** Parameters for unshielding (withdrawing) funds from a privacy pool. */
export interface UnshieldParams {
  /** Amount in base units to withdraw. */
  amount: number | bigint;
  /** Token to unshield. */
  token: TokenSymbol;
  /** Recipient public key. Defaults to the connected wallet. */
  recipient?: PublicKey;
  /**
   * Use STARK proof (quantum-resistant) for variable-pool unshield.
   * Denominated-pool unshield is always STARK after P3.7 (Groth16 removed on-chain).
   */
  useStark?: boolean;
  /** Withdraw from denominated pool. */
  denominated?: boolean;
}

/** Parameters for a private transfer within the shielded pool. */
export interface PrivateTransferParams {
  /** Amount in base units. */
  amount: number | bigint;
  /** Token to transfer. */
  token: TokenSymbol;
  /** Recipient stealth meta-address (st:...) or raw public key. */
  to: string | PublicKey;
}

/** Receipt returned after a successful shield operation. */
export interface ShieldReceipt {
  tx: TxResult;
  /** Poseidon commitment of the newly created note. */
  commitment: bigint;
  /** Merkle tree leaf index of the commitment. */
  leafIndex: number;
  /** Encrypted note data (must be stored to later unshield). */
  note: EncryptedNote;
}

/** Receipt returned after a successful unshield operation. */
export interface UnshieldReceipt {
  tx: TxResult;
  /** Nullifier that was revealed (prevents double-spend). */
  nullifier: bigint;
  /** Amount withdrawn in base units. */
  amount: bigint;
}

/** Receipt returned after a successful private transfer. */
export interface TransferReceipt {
  tx: TxResult;
  /** The two new output note commitments [change, recipient]. */
  outputCommitments: [bigint, bigint];
  /** The two input nullifiers that were spent. */
  nullifiers: [bigint, bigint];
}

/** Encrypted note data that must be persisted to later spend the note. */
export interface EncryptedNote {
  /** Encrypted note payload (contains secret, nullifier preimage, amount). */
  ciphertext: Uint8Array;
  /** Ephemeral public key for ECDH decryption. */
  ephemeralPubkey: Uint8Array;
  /** Note commitment (for indexing). */
  commitment: Uint8Array;
  /** Encryption nonce. */
  nonce: Uint8Array;
}

/** On-chain privacy pool state. */
export interface PoolInfo {
  /** Pool account address. */
  address: PublicKey;
  /** SPL token mint for this pool. */
  tokenMint: PublicKey;
  /** Number of leaves (notes) inserted into the Merkle tree. */
  leafCount: number;
  /** Current Merkle root. */
  merkleRoot: bigint;
  /** Fixed denomination in base units (only for denominated pools). */
  denomination?: bigint;
  /** Minimum epoch delay before unshielding (anti-timing-attack). */
  epochDelay?: number;
}

// ─── Stealth Module ───────────────────────────────────────────────────────────

/** A stealth meta-address consisting of spending and viewing keys (EIP-5564 style for Solana). */
export interface StealthMetaAddress {
  /** Ed25519 spending public key. */
  spendingPubKey: Uint8Array;
  /** X25519 viewing public key (for ECDH shared-secret derivation). */
  viewingPubKey: Uint8Array;
  /** ML-KEM-768 public key for quantum resistance (v2). */
  kemPubKey?: Uint8Array;
  /** Ed25519 spending private key (only set by generateMetaAddress). Caller MUST persist securely and zero when done. */
  spendingPrivateKey?: Uint8Array;
  /** X25519 viewing private key (only set by generateMetaAddress). Caller MUST persist securely and zero when done. */
  viewingPrivateKey?: Uint8Array;
  /** Bech32-encoded meta-address string (st:...). */
  encoded: string;
}

/** A one-time stealth address derived from a meta-address. */
export interface StealthAddress {
  /** The derived one-time Solana address. */
  address: PublicKey;
  /** Ephemeral public key (must be published for recipient to scan). */
  ephemeralPubKey: Uint8Array;
  /** View tag for fast scanning (first byte of shared secret hash). */
  viewTag: number;
}

/** A detected incoming stealth payment. */
export interface StealthPayment {
  /** Stealth address holding the funds. */
  address: PublicKey;
  /** Payment amount in base units. */
  amount: bigint;
  /** SPL token mint. */
  tokenMint: PublicKey;
  /** Ephemeral public key from the sender. */
  ephemeralPubKey: Uint8Array;
  /** Unix timestamp of the payment transaction. */
  timestamp: number;
}

/** Parameters for sending to a stealth address. */
export interface StealthSendParams {
  /** Recipient's stealth meta-address string (st:...). */
  to: string;
  /** Amount in base units. */
  amount: number | bigint;
  /** Token to send (defaults to SOL). */
  token?: TokenSymbol;
  /** Use quantum-resistant v2 stealth (ML-KEM-768 key encapsulation). */
  quantumSafe?: boolean;
}

/** Receipt from a stealth send operation. */
export interface StealthSendReceipt {
  tx: TxResult;
  /** The one-time stealth address funds were sent to. */
  stealthAddress: PublicKey;
  /** Ephemeral public key (recipient needs this to detect and claim). */
  ephemeralPubKey: Uint8Array;
}

/** Options for scanning the chain for incoming stealth payments. */
export interface StealthScanOptions {
  /** Start scanning from this slot (inclusive). */
  fromSlot?: number;
  /** Stop scanning at this slot (inclusive). */
  toSlot?: number;
  /** Number of slots to fetch per RPC call. */
  batchSize?: number;
}

/** Receipt from claiming a stealth payment. */
export interface StealthClaimReceipt {
  tx: TxResult;
  /** Amount claimed in base units. */
  amount: bigint;
  /** Token mint of the claimed funds. */
  tokenMint: PublicKey;
}

// ─── Confidential Balances ────────────────────────────────────────────────────

/** Parameters for depositing into a confidential (encrypted) balance account. */
export interface ConfidentialDepositParams {
  amount: number | bigint;
  token: TokenSymbol;
}

/** Parameters for transferring between confidential balance accounts. */
export interface ConfidentialTransferParams {
  /** Recipient's public key. */
  to: PublicKey;
  amount: number | bigint;
  token: TokenSymbol;
}

/** Parameters for withdrawing from a confidential balance back to a normal account. */
export interface ConfidentialWithdrawParams {
  amount: number | bigint;
  token: TokenSymbol;
  /** Recipient public key. Defaults to the connected wallet. */
  recipient?: PublicKey;
}

/** Result of querying a confidential balance. */
export interface ConfidentialBalanceResult {
  /** On-chain Poseidon commitment of the balance. */
  commitment: bigint;
  /** Decrypted balance (only available if the spending key is provided). */
  balance?: bigint;
  /** Token mint address. */
  tokenMint: PublicKey;
}

/** Parameters for generating a range proof over a confidential balance. */
export interface ConfidentialProveBalanceParams {
  token: TokenSymbol;
  /** Prove balance >= threshold without revealing exact amount. */
  threshold: number | bigint;
}

// ─── Streams ──────────────────────────────────────────────────────────────────

/** Parameters for creating a payment stream. */
export interface CreateStreamParams {
  /** Stream recipient. */
  recipient: PublicKey;
  /** Total amount to stream in base units. */
  totalAmount: number | bigint;
  /** Token to stream (defaults to SOL). */
  token?: TokenSymbol;
  /** Stream duration in seconds. */
  duration: number;
  /** Route the stream through a stealth address for sender/recipient privacy. */
  private?: boolean;
}

/** On-chain state of a payment stream. */
export interface StreamInfo {
  /** Stream account address. */
  address: PublicKey;
  sender: PublicKey;
  recipient: PublicKey;
  /** Total stream amount in base units. */
  totalAmount: bigint;
  /** Amount already withdrawn by the recipient. */
  withdrawnAmount: bigint;
  /** Stream start time (Unix timestamp). */
  startTime: number;
  /** Stream end time (Unix timestamp). */
  endTime: number;
  /** Currently claimable amount in base units. */
  claimable: bigint;
  tokenMint: PublicKey;
  /** Whether the stream uses stealth addresses. */
  isPrivate: boolean;
}

/** Receipt from creating a stream. */
export interface StreamReceipt {
  tx: TxResult;
  /** Address of the created stream account. */
  streamAddress: PublicKey;
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

/** Parameters for creating a recurring subscription. */
export interface CreateSubscriptionParams {
  /** Merchant (payee) public key. */
  merchant: PublicKey;
  /** Payment amount per interval in base units. */
  amount: number | bigint;
  /** Token to pay with (defaults to SOL). */
  token?: TokenSymbol;
  /** Payment interval in seconds (e.g., 2592000 for ~30 days). */
  interval: number;
  /** Maximum number of payments before auto-cancellation. */
  maxPayments?: number;
  /** Human-readable subscription label. */
  name?: string;
  /** Route payments through the shielded pool for privacy. */
  private?: boolean;
}

/** On-chain state of a subscription. */
export interface SubscriptionInfo {
  address: PublicKey;
  subscriber: PublicKey;
  merchant: PublicKey;
  /** Amount per payment in base units. */
  amount: bigint;
  /** Payment interval in seconds. */
  interval: number;
  /** Unix timestamp of the next payment due date. */
  nextPaymentDue: number;
  paymentsCompleted: number;
  maxPayments: number;
  isActive: boolean;
  /** Whether payments are routed through the shielded pool. */
  isPrivate: boolean;
  tokenMint: PublicKey;
}

/** Receipt from creating a subscription. */
export interface SubscriptionReceipt {
  tx: TxResult;
  subscriptionAddress: PublicKey;
}

// ─── Quantum Vault ────────────────────────────────────────────────────────────

/** Vault type: 'wots' for Winternitz OTS (key-rotation), 'htl' for Hash-Timelock (cold storage). */
export type VaultType = 'wots' | 'htl';

/** Parameters for creating a quantum-safe vault. */
export interface CreateVaultParams {
  /** Vault type. 'wots' rotates keys after each withdrawal; 'htl' uses preimage + timelock. */
  type: VaultType;
  /** For HTL: timelock duration in seconds. */
  timelock?: number;
  /** For HTL: destination wallet that receives funds on unlock. */
  destination?: PublicKey;
}

/** Parameters for depositing into a vault. */
export interface VaultDepositParams {
  /** Vault account address. */
  vault: PublicKey;
  /** Amount to deposit in base units. */
  amount: number | bigint;
}

/** Parameters for withdrawing from a vault. */
export interface VaultWithdrawParams {
  /** Vault account address. */
  vault: PublicKey;
  /** Amount to withdraw in base units. */
  amount: number | bigint;
  /** For HTL vaults: the 32-byte SHA-256 preimage that unlocks the vault. */
  preimage?: Uint8Array;
  /** For WOTS+ vaults: 32-byte seed for the CURRENT signing key. */
  seed?: Uint8Array;
  /** For WOTS+ vaults: 32-byte seed for the NEXT key (post-rotation). */
  nextSeed?: Uint8Array;
  /** For WOTS+ vaults: withdrawal destination. Defaults to the wallet owner. */
  destination?: PublicKey;
  /** For WOTS+ vaults: the vault's current `withdrawal_count` (fetched on-chain). */
  withdrawalCount?: number | bigint;
}

/** On-chain state of a quantum-safe vault. */
export interface VaultInfo {
  address: PublicKey;
  type: VaultType;
  owner: PublicKey;
  /** Current vault balance in lamports. */
  balance: bigint;
  /** WOTS+: current key index (increments after each withdrawal). */
  keyIndex?: number;
  /** HTL: Unix timestamp after which the vault can be unlocked. */
  unlockAfter?: number;
  /** HTL: destination wallet for unlocked funds. */
  destination?: PublicKey;
}

/** Receipt from a vault operation. */
export interface VaultReceipt {
  tx: TxResult;
  vaultAddress: PublicKey;
  /** WOTS+: the seed used to derive the keypair. Caller MUST persist this securely. */
  secret?: Uint8Array;
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

// ─── MPC (Arcium) ─────────────────────────────────────────────────────────────

/** Parameters for casting an MPC-private vote. */
export interface MPCVoteParams {
  /** Proposal to vote on. */
  proposalId: string;
  /** Vote choice index (0-based). */
  choice: number;
  /** Token-weighted voting amount (optional, for token-weighted governance). */
  weight?: number | bigint;
}

/** Parameters for creating an MPC voting proposal. */
export interface MPCCreateProposalParams {
  proposalId: string;
  /** Number of vote options. */
  optionCount: number;
  /** Voting deadline as Unix timestamp. */
  deadline: number;
}

/** Parameters for an MPC-private audit (prove solvency without revealing balances). */
export interface MPCAuditParams {
  /** Encrypted balance data to audit. */
  encryptedBalance: Uint8Array;
}

/** Parameters for submitting a sealed bid in an MPC auction. */
export interface MPCSealedBidParams {
  /** Auction account address. */
  auctionId: PublicKey;
  /** Bid amount in base units. */
  bidAmount: number | bigint;
}

/** On-chain MPC proposal state. */
export interface MPCProposalInfo {
  address: PublicKey;
  proposalId: string;
  optionCount: number;
  /** Voting deadline as Unix timestamp. */
  deadline: number;
  /** Whether tallying has been finalized. */
  isFinalized: boolean;
  /** Decrypted vote tallies per option (only available after finalization). */
  results?: number[];
}

/** On-chain MPC auction state. */
export interface MPCAuctionInfo {
  address: PublicKey;
  isFinalized: boolean;
  /** Commitment of the winning bid (only available after finalization). */
  winnerCommitment?: bigint;
}

// ─── Events ───────────────────────────────────────────────────────────────────

/** Event types emitted by the SDK. Subscribe with `sdk.on(type, callback)`. */
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

/** Callback function for SDK events. */
export type PrivacyEventCallback = (event: PrivacyEvent) => void;

/** An event emitted by the SDK. */
export interface PrivacyEvent {
  type: PrivacyEventType;
  data: any;
  /** Unix timestamp (ms) when the event was emitted. */
  timestamp: number;
}

// ─── Proof Types ──────────────────────────────────────────────────────────────

/** Groth16 proof as output by snarkjs. Used internally for ZK operations. */
export interface Groth16Proof {
  /** G1 point A: [x, y, z] as decimal strings. */
  pi_a: [string, string, string];
  /** G2 point B: [[c0_x, c1_x], [c0_y, c1_y], [c0_z, c1_z]] as decimal strings. */
  pi_b: [[string, string], [string, string], [string, string]];
  /** G1 point C: [x, y, z] as decimal strings. */
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}

/** Result from generating a ZK proof. */
export interface ProofResult {
  proof: Groth16Proof;
  /** Public signals as decimal strings. */
  publicSignals: string[];
  /** Time taken to generate the proof in milliseconds. */
  durationMs?: number;
}

/**
 * STARK proof outcome returned by a host-supplied generator.
 *
 * The host is responsible for:
 *  1. Running the WASM prover (mobile/extension/Node-native).
 *  2. Uploading the proof bytes to p01_stark_verifier (chunked writes).
 *  3. Invoking the two-phase on-chain verify (DEEP-ALI phase 1 + phase 2).
 *  4. Returning the PDA of the verified proof buffer so the SDK can reference
 *     it from the zk_shielded instruction.
 *
 * Using a callback keeps the privacy-sdk free of Rust/WASM dependencies while
 * still letting callers compose shield/transfer/unshield_stark instructions.
 */
export interface StarkProofOutcome {
  /** PDA of the verified STARK proof buffer held by p01_stark_verifier. */
  proofBuffer: import('@solana/web3.js').PublicKey;
  /** Circuit identifier (0–6). Informational — callers may log / assert. */
  circuitId: number;
  /** Public inputs bound into the STARK transcript, for downstream checks. */
  publicInputs?: bigint[];
}

/**
 * Host-supplied STARK prover + verifier submitter.
 *
 * `circuitId` uses the values from {@link STARK_CIRCUITS}:
 *   5 = transfer (width 6, trace 512) — used for variable-pool transfer/unshield.
 *   6 = merkle_update (depth 15)     — used for variable-pool shield root update.
 */
export type StarkProofGenerator = (
  circuitId: number,
  privateInputs: Record<string, string | string[] | number[]>,
) => Promise<StarkProofOutcome>;

/** Configuration for the ZK prover. */
export interface ProverConfig {
  /**
   * Host-supplied STARK prover + verifier submitter. Required for
   * shield/transfer/unshield on the variable-amount pool (all paths are STARK
   * post-migration). Denominated-pool operations may still route through a
   * pre-verified buffer supplied out-of-band.
   */
  generateStarkProof?: StarkProofGenerator;
  /** Use local-only proving -- no remote prover fallback (default: true). */
  localOnly?: boolean;
  /** Proof generation + verification timeout in ms (default: 120000). */
  timeout?: number;

  /** @deprecated Groth16 circuit WASM — kept for compliance.ts only. */
  wasmPath?: string;
  /** @deprecated Groth16 zkey — kept for compliance.ts only. */
  zkeyPath?: string;
}
