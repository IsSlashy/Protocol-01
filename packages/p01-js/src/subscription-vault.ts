/**
 * Subscription Vault Module for Protocol 01
 *
 * Provides primitives for creating and managing subscription vaults.
 * Two modes:
 * - **Normal**: Subscriber deposits from wallet, authenticates with wallet signature
 * - **Private**: Subscriber deposits from denominated pool note, authenticates with ZK proof
 *
 * On-chain program: zk_shielded (subscription vault instructions)
 * PDA seeds:
 *   - SubscriptionVault: [b"subscription_vault", retailer, subscriber_id_bytes, token_mint]
 *   - SubscriberVkData:  [b"vk_data_subscriber", authority]
 *
 * @module subscription-vault
 */

// ============ Constants ============

/** Program ID for zk_shielded (devnet deployment) */
export const ZK_SHIELDED_PROGRAM_ID = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';

/** Seed prefix for subscription vault PDA */
export const VAULT_SEED_PREFIX = 'subscription_vault';

/** Seed prefix for subscriber VK data PDA */
export const SUBSCRIBER_VK_DATA_SEED = 'vk_data_subscriber';

// ============ Types ============

/** Subscription vault information (parsed on-chain account) */
export interface VaultInfo {
  /** Vault PDA address (base58) */
  address: string;
  /** Subscriber wallet pubkey (normal mode) */
  subscriberPubkey: string | null;
  /** Subscriber commitment (private mode, hex) */
  subscriberCommitment: string | null;
  /** Retailer pubkey (base58) */
  retailer: string;
  /** Token mint (base58) */
  tokenMint: string;
  /** Total amount deposited */
  totalDeposited: number;
  /** Rate per period (lamports/atomic units) */
  rate: number;
  /** Interval between periods (slots) */
  intervalSlots: number;
  /** Start slot */
  startSlot: number;
  /** Number of periods claimed by retailer */
  claimedPeriods: number;
  /** Whether the vault is active */
  isActive: boolean;
  /** Whether the vault is paused */
  isPaused: boolean;
  /** Slot at which the vault was paused */
  pauseSlot: number | null;
  /** Total slots spent paused */
  totalPausedSlots: number;
  /** Source pool for private mode (base58) */
  sourcePool: string | null;
  /**
   * v1 stealth meta address (`[spending_pub(32) | viewing_pub(32)]`, hex), or
   * `null` for vaults created before the field existed. Appended after `bump`.
   */
  clientStealthMeta?: string | null;
  /**
   * `license_commitment = blake3(licenseSecret)` (32 bytes, hex), or `null` for
   * vaults created before license keys existed. Appended at the very end.
   */
  licenseCommitment?: string | null;
  /** Whether this is a normal (wallet) vault */
  isNormalMode: boolean;
  /** Whether this is a private (ZK) vault */
  isPrivateMode: boolean;
}

/** Parameters for creating a normal subscription */
export interface SubscribeNormalParams {
  /** Retailer pubkey (base58) */
  retailer: string;
  /** Token mint (base58, system program for SOL) */
  tokenMint: string;
  /** Amount to deposit (lamports/atomic units) */
  amount: number;
  /** Rate per period */
  rate: number;
  /** Interval between periods (slots) */
  intervalSlots: number;
  /** VK hash for subscriber ownership circuit */
  vkHashSubscriber: Uint8Array;
}

/** Parameters for creating a private subscription */
export interface SubscribePrivateParams {
  /** Retailer pubkey (base58) */
  retailer: string;
  /** Pool address (base58) */
  poolAddress: string;
  /** Denominated pool proof */
  proof: ProofData;
  /** Nullifier bytes (hex) */
  nullifier: string;
  /** Merkle root (hex) */
  merkleRoot: string;
  /** Min epoch */
  minEpoch: number;
  /** Subscriber secret (bigint string) — used to derive commitment */
  subscriberSecret: string;
  /** Rate per period */
  rate: number;
  /** Interval between periods (slots) */
  intervalSlots: number;
  /** VK hash for subscriber ownership circuit */
  vkHashSubscriber: Uint8Array;
}

/**
 * STARK proof data passed alongside a `subscribe_private` instruction.
 *
 * BREAKING CHANGE (0.3.0): replaces the Groth16 byte triple
 * (`{ pi_a, pi_b, pi_c }`) with the `StarkProofOutcome` returned by
 * `@protocol-01/stark-prover`. Re-exported here so consumers don't need to
 * pull a second dep just for the type.
 *
 * Migration:
 *   // 0.2.x
 *   const proof: ProofData = { pi_a, pi_b, pi_c };
 *   // 0.3.0+
 *   const proof: ProofData = await generateStarkProof(circuitId, inputs);
 *   // → { proofBuffer: PublicKey, circuitId: number, publicInputs?: bigint[] }
 */
export type ProofData = import('@protocol-01/stark-prover').StarkProofOutcome;

// ============ PDA Derivation ============

/**
 * Derive the subscription vault PDA.
 *
 * @param retailer - Retailer pubkey bytes (32 bytes)
 * @param subscriberIdBytes - Subscriber ID (pubkey for normal, commitment for private)
 * @param tokenMint - Token mint bytes (32 bytes)
 * @param programId - Program ID bytes (32 bytes)
 * @returns [pda, bump] tuple (as hex strings for portability)
 */
export function deriveVaultPDA(
  retailer: Uint8Array,
  subscriberIdBytes: Uint8Array,
  tokenMint: Uint8Array,
  programId: Uint8Array,
): { seeds: Uint8Array[]; } {
  const seedPrefix = new TextEncoder().encode(VAULT_SEED_PREFIX);
  return {
    seeds: [seedPrefix, retailer, subscriberIdBytes, tokenMint],
  };
}

/**
 * Derive the subscriber VK data PDA.
 *
 * @param authority - Authority pubkey bytes (32 bytes)
 * @param programId - Program ID bytes (32 bytes)
 * @returns PDA seeds
 */
export function deriveSubscriberVkPDA(
  authority: Uint8Array,
  programId: Uint8Array,
): { seeds: Uint8Array[]; } {
  const seedPrefix = new TextEncoder().encode(SUBSCRIBER_VK_DATA_SEED);
  return {
    seeds: [seedPrefix, authority],
  };
}

// ============ Computation Helpers ============

/**
 * Compute claimable periods for a vault at a given slot.
 * Accounts for paused time.
 *
 * @param vault - Vault info
 * @param currentSlot - Current Solana slot
 * @returns Number of claimable periods
 */
export function computeClaimable(vault: VaultInfo, currentSlot: number): number {
  if (!vault.isActive || vault.isPaused) {
    return 0;
  }

  const effectiveElapsed = currentSlot - vault.startSlot - vault.totalPausedSlots;
  if (effectiveElapsed <= 0) {
    return 0;
  }

  const totalPeriods = Math.floor(effectiveElapsed / vault.intervalSlots);
  return Math.max(0, totalPeriods - vault.claimedPeriods);
}

/**
 * Compute the claimable amount in lamports.
 */
export function computeClaimableAmount(vault: VaultInfo, currentSlot: number): number {
  const periods = computeClaimable(vault, currentSlot);
  const amount = periods * vault.rate;

  // Clamp to available balance
  const totalOwed = vault.claimedPeriods * vault.rate;
  const available = vault.totalDeposited - totalOwed;
  return Math.min(amount, available);
}

/**
 * Compute the refundable amount if the vault were cancelled now.
 */
export function computeRefundable(vault: VaultInfo, currentSlot: number): number {
  const claimable = computeClaimable(vault, currentSlot);
  const totalOwed = (vault.claimedPeriods + claimable) * vault.rate;
  return Math.max(0, vault.totalDeposited - totalOwed);
}

/**
 * Estimate the next claimable slot for a vault.
 */
export function nextClaimableSlot(vault: VaultInfo): number | null {
  if (!vault.isActive || vault.isPaused) {
    return null;
  }

  const nextPeriod = vault.claimedPeriods + 1;
  const slotsNeeded = nextPeriod * vault.intervalSlots;
  return vault.startSlot + vault.totalPausedSlots + slotsNeeded;
}

/**
 * Parse a vault account from raw on-chain data.
 *
 * Borsh serializes `Option<T>` VARIABLE-width: `None` is a single `0` tag byte
 * (no value bytes follow), `Some` is a `1` tag + `sizeof(T)`. Earlier this
 * decoder advanced past `sizeof(T)` on `None` too (fixed-width), which desynced
 * every field after the first `None` — `retailer` and `token_mint` were read
 * from the wrong offset (zeros). All Option reads below only consume value bytes
 * on `Some`. Verified against live devnet vaults: `retailer` lands at offset 42
 * (mode-invariant) — the two leading mutually-exclusive options total 34 bytes
 * (one Some=33 + one None=1) in both modes.
 */
export function parseVaultAccount(data: Buffer, address: string): VaultInfo {
  // Skip 8-byte discriminator
  let offset = 8;

  // Option<Pubkey> subscriber_pubkey — Borsh: 1-byte tag, then 32 bytes only if Some
  const hasSubscriberPubkey = data[offset] === 1;
  offset += 1;
  const subscriberPubkey = hasSubscriberPubkey
    ? data.slice(offset, offset + 32).toString('hex')
    : null;
  if (hasSubscriberPubkey) offset += 32;

  // Option<[u8;32]> subscriber_commitment — Borsh: 1-byte tag, then 32 bytes only if Some
  const hasCommitment = data[offset] === 1;
  offset += 1;
  const subscriberCommitment = hasCommitment
    ? data.slice(offset, offset + 32).toString('hex')
    : null;
  if (hasCommitment) offset += 32;

  // Pubkey retailer
  const retailer = data.slice(offset, offset + 32).toString('hex');
  offset += 32;

  // Pubkey token_mint
  const tokenMint = data.slice(offset, offset + 32).toString('hex');
  offset += 32;

  // u64 total_deposited
  const totalDeposited = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // u64 rate
  const rate = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // u64 interval_slots
  const intervalSlots = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // i64 start_slot
  const startSlot = Number(data.readBigInt64LE(offset));
  offset += 8;

  // u64 claimed_periods
  const claimedPeriods = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // bool is_active
  const isActive = data[offset] === 1;
  offset += 1;

  // bool is_paused
  const isPaused = data[offset] === 1;
  offset += 1;

  // Option<i64> pause_slot — Borsh: 1-byte tag, then 8 bytes only if Some
  const hasPauseSlot = data[offset] === 1;
  offset += 1;
  const pauseSlot = hasPauseSlot ? Number(data.readBigInt64LE(offset)) : null;
  if (hasPauseSlot) offset += 8;

  // i64 total_paused_slots
  const totalPausedSlots = Number(data.readBigInt64LE(offset));
  offset += 8;

  // [u8;32] vk_hash_subscriber (skip)
  offset += 32;

  // Option<Pubkey> source_pool — Borsh: 1-byte tag, then 32 bytes only if Some
  const hasSourcePool = data[offset] === 1;
  offset += 1;
  const sourcePool = hasSourcePool
    ? data.slice(offset, offset + 32).toString('hex')
    : null;
  if (hasSourcePool) offset += 32;

  // u8 bump
  if (offset < data.length) offset += 1;

  // Trailing Option fields, appended in program order (each: 1-byte tag, then
  // value bytes only if Some). Legacy accounts written before a field existed
  // simply lack the tag byte; real accounts are init'd at a fixed `space` so
  // the tag (and zero padding) is present even for None.
  //   client_stealth_meta: Option<[u8;64]>
  let clientStealthMeta: string | null = null;
  if (offset + 1 <= data.length) {
    const tag = data[offset];
    offset += 1;
    if (tag === 1 && offset + 64 <= data.length) {
      clientStealthMeta = data.slice(offset, offset + 64).toString('hex');
      offset += 64;
    }
  }
  //   license_commitment: Option<[u8;32]>
  let licenseCommitment: string | null = null;
  if (offset + 1 <= data.length) {
    const tag = data[offset];
    offset += 1;
    if (tag === 1 && offset + 32 <= data.length) {
      licenseCommitment = data.slice(offset, offset + 32).toString('hex');
      offset += 32;
    }
  }

  return {
    address,
    subscriberPubkey,
    subscriberCommitment,
    retailer,
    tokenMint,
    totalDeposited,
    rate,
    intervalSlots,
    startSlot,
    claimedPeriods,
    isActive,
    isPaused,
    pauseSlot,
    totalPausedSlots,
    sourcePool,
    clientStealthMeta,
    licenseCommitment,
    isNormalMode: hasSubscriberPubkey,
    isPrivateMode: hasCommitment,
  };
}

/**
 * For cancel_private: compute how many full denomination notes can be re-shielded.
 */
export function computeReshieldNotes(
  refundableAmount: number,
  denomination: number,
): { notes: number; reshieldAmount: number; dustForfeited: number } {
  const notes = Math.floor(refundableAmount / denomination);
  const reshieldAmount = notes * denomination;
  const dustForfeited = refundableAmount - reshieldAmount;
  return { notes, reshieldAmount, dustForfeited };
}
