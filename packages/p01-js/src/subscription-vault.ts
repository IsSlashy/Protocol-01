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

// SubscribeNormalParams was removed together with the on-chain `subscribe_normal`
// instruction. That vault's PDA was seeded on the subscriber's wallet pubkey, so
// re-deriving the address answered "does wallet W subscribe to merchant M?" for
// free. Subscribing is private-only; see SubscribePrivateParams.

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
 * Total periods the subscriber paid for at subscribe time.
 *
 * This is what bounds entitlement — not `isActive`, which the program writes
 * `true` at `subscribe_private_stark.rs:395` (the only instruction left that
 * creates a vault) and
 * `false` NOWHERE, so an exhausted vault reports `true` for ever.
 */
export function periodsPaidFor(vault: Pick<VaultInfo, 'totalDeposited' | 'rate'>): number {
  if (vault.rate === 0) return 0;
  return Math.floor(vault.totalDeposited / vault.rate);
}

/** Zero-based index of the period the subscription is in at `currentSlot`. */
export function periodsElapsed(
  vault: Pick<VaultInfo, 'startSlot' | 'totalPausedSlots' | 'intervalSlots'>,
  currentSlot: number,
): number {
  if (vault.intervalSlots === 0) return 0;
  const effective = currentSlot - vault.startSlot - vault.totalPausedSlots;
  if (effective <= 0) return 0;
  return Math.floor(effective / vault.intervalSlots);
}

/**
 * Periods this vault can still PAY for. Zero means every further claim is
 * refused on chain. Not an entitlement test — a retailer that neglects to claim
 * leaves this high long after the subscriber stopped being current.
 */
export function fundedPeriodsRemaining(
  vault: Pick<VaultInfo, 'totalDeposited' | 'rate' | 'claimedPeriods'>,
): number {
  if (vault.rate === 0) return 0;
  return Math.max(0, Math.floor(vault.totalDeposited / vault.rate) - vault.claimedPeriods);
}

/**
 * Whether the subscription entitles its holder to service RIGHT NOW.
 *
 * Local port of `subscriptionIsCurrent` from
 * `packages/merchant-sdk/src/period-math.ts`, kept here so this package stays
 * dependency-free. `src/subscription-vault.test.ts` runs the shared
 * `ENTITLEMENT_PARITY_VECTORS` table through both, so the two cannot drift.
 */
export function subscriptionIsCurrent(vault: VaultInfo, currentSlot: number): boolean {
  if (!vault.isActive || vault.isPaused) return false;
  if (vault.intervalSlots === 0) return false;
  return periodsElapsed(vault, currentSlot) < periodsPaidFor(vault);
}

/**
 * Compute claimable periods for a vault at a given slot.
 * Accounts for paused time.
 *
 * Faithful port of `SubscriptionVault::claimable_periods`
 * (`programs/zk_shielded/src/state/subscription_vault.rs:133`), INCLUDING the
 * `max_funded` clamp. Without that clamp this returned the raw elapsed-period
 * count: 40 for a five-period subscription left running, and `Infinity` when
 * `intervalSlots` was 0. The since-removed `computeRefundable` fed on it and
 * under-reported the subscriber's refund — for a 350,000-lamport deposit at
 * 100,000/period, read five periods after start, it said 0 where the program
 * refunded 50,000. Refunds no longer exist, so that consequence is historical;
 * the clamp is still load-bearing for `computeClaimableAmount`.
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

  // On chain this is a u64 division; `interval_slots == 0` would panic. The
  // program forbids it at subscribe time, so this is only a guard against a
  // hand-built VaultInfo.
  if (vault.intervalSlots === 0) {
    return 0;
  }

  const totalPeriods = Math.floor(effectiveElapsed / vault.intervalSlots);
  const unclaimed = Math.max(0, totalPeriods - vault.claimedPeriods);
  return Math.min(unclaimed, fundedPeriodsRemaining(vault));
}

/**
 * Compute the claimable amount in lamports.
 */
export function computeClaimableAmount(vault: VaultInfo, currentSlot: number): number {
  const periods = computeClaimable(vault, currentSlot);
  const amount = periods * vault.rate;

  // Mirrors the program's own `actual_amount = claim_amount.min(vault_balance)`
  // (`claim_period.rs:65`). Redundant now that `computeClaimable` clamps, and
  // kept only because the program keeps it.
  const totalOwed = vault.claimedPeriods * vault.rate;
  const available = vault.totalDeposited - totalOwed;
  return Math.min(amount, available);
}

/**
 * Amount the retailer has not been paid yet, in atomic units.
 *
 * A subscription vault is a one-way prepaid envelope: money that enters it can
 * only ever leave it toward the retailer. There is no cancellation and no
 * refund, so this is NOT "what the subscriber could get back" — it is what the
 * retailer is still owed and will eventually receive. Pause changes WHEN that
 * happens, never HOW MUCH.
 *
 * Invariant: `computeAlreadyPaidToRetailer + computeOutstandingToRetailer`
 * equals `totalDeposited` at every slot, for every vault shape.
 *
 * Replaces the removed `computeRefundable`, which answered "what would the
 * subscriber get back if the vault were cancelled now". Cancellation no longer
 * exists, so that number was value on paper only.
 */
export function computeOutstandingToRetailer(vault: VaultInfo): number {
  return Math.max(0, vault.totalDeposited - vault.claimedPeriods * vault.rate);
}

/**
 * Amount the retailer has already swept out of the vault, in atomic units.
 * Counterpart of {@link computeOutstandingToRetailer}.
 */
export function computeAlreadyPaidToRetailer(vault: VaultInfo): number {
  return Math.min(vault.totalDeposited, vault.claimedPeriods * vault.rate);
}

/**
 * First slot at which {@link subscriptionIsCurrent} turns false, or `null` when
 * the vault never entitles anyone (inactive, paused, `rate` 0, `intervalSlots`
 * 0, or a deposit that did not cover one whole period).
 */
export function subscriptionEndSlot(vault: VaultInfo): number | null {
  if (!vault.isActive || vault.isPaused) return null;
  if (vault.intervalSlots === 0) return null;
  const paid = periodsPaidFor(vault);
  if (paid === 0) return null;
  return vault.startSlot + vault.totalPausedSlots + paid * vault.intervalSlots;
}

/**
 * Estimate the next claimable slot for a vault.
 */
export function nextClaimableSlot(vault: VaultInfo): number | null {
  if (!vault.isActive || vault.isPaused) {
    return null;
  }

  // A vault with no funded periods left will never have another claimable slot:
  // `claim_period` requires `claimable_periods > 0`, and that is clamped by
  // `max_funded` (`subscription_vault.rs:149-154`), so every later call fails
  // with NoClaimablePeriods. Without this the answer came from `isActive`,
  // which the program writes `true` at subscribe and `false` nowhere, so an
  // exhausted subscription was told to come back at a slot where nothing would
  // ever be waiting for it.
  if (fundedPeriodsRemaining(vault) === 0) {
    return null;
  }

  if (vault.intervalSlots === 0) {
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

/*
 * REMOVED: `computeReshieldNotes`.
 *
 * It sized the re-shield leg of `cancel_private_stark` — how many whole
 * denomination notes the refunded residual bought back into the source pool.
 * Cancellation and refunds are gone from the protocol, so there is no residual
 * to re-shield and no inbound leg to size. See `computeOutstandingToRetailer`.
 */
