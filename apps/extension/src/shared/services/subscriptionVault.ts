/**
 * Subscription Vault Service for Chrome Extension
 *
 * Wraps subscription vault operations from the zk_shielded program.
 * Supports both normal (wallet-based) and private (ZK-based) vaults.
 *
 * Normal mode: Subscriber deposits from wallet, authenticates with wallet signature
 * Private mode: Subscriber deposits from a ZK shielded note, authenticates with
 *   STARK proof (circuit 0 = subscriber_ownership for pause/resume;
 *   circuit 1 = pool_commitment for subscribe).
 *
 * ARCHITECTURE NOTE — private-subscribe note source:
 *   Private subscribe consumes a Goldilocks DENOMINATED pool note (the extension's
 *   `services/denominatedPool.ts`, re-added 2026-06-01). Circuit 1 (pool_commitment)
 *   takes that note's (nullifier_preimage, secret, epoch, mint) as input; the note is
 *   created by shielding into a fixed-denomination V3 pool (circuit 6) first. This is
 *   the C3-free path — `subscribe_private_stark` validates the merkle root via the
 *   pool's valid-root ring, not a circuit-3 merkle-path proof.
 *
 *   `subscribePrivate` (below) routes PER NOTE, the same way the withdrawal
 *   store does: a PRF-blinded note is proven on circuit 7 and submitted as
 *   `subscribe_private_stark_v4` (ONE buffer, no `stark_commitment` on the
 *   wire — see `subscribePrivateStarkV4.ts`); a note circuit 7 cannot prove
 *   (`whyCircuit7Cannot`, or a `V4Unprovable` from the prepare) falls back to
 *   the C1 + C3 pair and `subscribe_private_stark`. Nothing else falls back.
 *   Circuit 0 (subscriber_ownership) drives pause/resume — the subscriber
 *   secret is a Goldilocks bigint stored at vault creation time.
 *
 *   Denominated unshield (C1+C3) and note-to-note transfer (C1+C3+C6) live in
 *   denominatedPool.ts and verify on-chain — the C3 verifier was realigned +
 *   redeployed 2026-05-29. Subscribe itself stays on the C3-free valid-root path
 *   above (it never needs a merkle-path proof).
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { deriveLicenseSecret, encodeLicenseKey, licenseCommitment } from './license';
import { useLicenseStore } from '../store/license';
import { useWalletStore } from '../store/wallet';
import { getConnection } from './wallet';
import type { VaultInfo, SubscribePrivateParams, ProofData } from './subscriptionVault.types';
import type { WalletSigner } from './stark';
import {
  submitAndVerifyStarkProof,
  closeStarkProofBuffer,
  CIRCUIT_SUBSCRIBER_OWNERSHIP,
  CIRCUIT_POOL_COMMITMENT,
  type GenericStarkProof,
} from './stark';
import { starkProver } from './starkProver';
import {
  deriveNullifierPDA,
  goldilocksToLeBytes32,
  isNullifierSpent,
  prepareUnshield,
  findPoolV3,
  CIRCUIT_MERKLE_PATH,
  V4Unprovable,
  type ShieldReceipt,
  type PoolConfig,
} from './denominatedPool';
import { whyCircuit7Cannot } from '../store/denominatedPool';
import {
  prepareSubscribeV4,
  subscribePrivateStarkV4,
  type PrepareSubscribeV4Result,
  type SubscribeBinding,
} from './subscribePrivateStarkV4';

/**
 * Thrown when the selected note's nullifier already exists on-chain — the note
 * was already spent (a prior subscription or unshield). Carries `noteId` so the
 * UI/store can drop the stale note from the local picker.
 */
export class NoteAlreadySpentError extends Error {
  readonly noteId: string;
  constructor(noteId: string) {
    super(
      'This shielded note has already been spent (used for a prior subscription ' +
      'or withdrawal). Pick a different note, or shield a new one.',
    );
    this.name = 'NoteAlreadySpentError';
    this.noteId = noteId;
  }
}

// Re-export types
export type { VaultInfo, SubscribePrivateParams, ProofData };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** zk_shielded program ID (devnet) */
export const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');

/** Subscription vault PDA seed prefix */
const VAULT_SEED_PREFIX = 'subscription_vault';

/** Subscriber VK data PDA seed prefix */
const SUBSCRIBER_VK_DATA_SEED = 'vk_data_subscriber';

/** Native SOL mint (system program ID) */
const NATIVE_SOL_MINT = SystemProgram.programId;

// ---------------------------------------------------------------------------
// Wallet adapter — builds a WalletSigner from the current wallet store state
// ---------------------------------------------------------------------------

function createWalletSigner(): { signer: WalletSigner; connection: Connection } {
  const walletState = useWalletStore.getState();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);
  const keypair = walletState._keypair;

  if (!keypair) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const signer: WalletSigner = {
    publicKey: walletPublicKey,
    signTransaction: async (tx: Transaction): Promise<Transaction> => {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
      if (!tx.feePayer) tx.feePayer = walletPublicKey;
      tx.sign(keypair);
      return tx;
    },
  };

  return { signer, connection };
}

// ---------------------------------------------------------------------------
// Instruction discriminator helper
// Mirrors mobile: sha256("global:<name>")[0..8]
// ---------------------------------------------------------------------------

function getDiscriminator(name: string): Buffer {
  const hash = sha256(utf8ToBytes(`global:${name}`));
  return Buffer.from(hash.slice(0, 8));
}

// ---------------------------------------------------------------------------
// Compute budget helpers
// ---------------------------------------------------------------------------

function buildComputeBudgetIxs(cuLimit = 300_000, cuPriceMicroLamports = 1000): TransactionInstruction[] {
  const limitData = Buffer.alloc(5);
  limitData.writeUInt8(2, 0);
  limitData.writeUInt32LE(cuLimit, 1);

  const priceData = Buffer.alloc(9);
  priceData.writeUInt8(3, 0);
  priceData.writeBigUInt64LE(BigInt(cuPriceMicroLamports), 1);

  return [
    new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: limitData }),
    new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: priceData }),
  ];
}

// ---------------------------------------------------------------------------
// Sign + send helper (mirrors mobile signAndSend)
// ---------------------------------------------------------------------------

async function signSendConfirmTx(
  connection: Connection,
  tx: Transaction,
  signer: WalletSigner,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  const signed = await signer.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/**
 * Derive subscription vault PDA.
 * Mirrors mobile deriveVaultPDA byte-for-byte.
 */
export function deriveVaultPDA(
  retailer: PublicKey,
  subscriberIdBytes: Uint8Array,
  tokenMint: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_SEED_PREFIX),
      retailer.toBuffer(),
      Buffer.from(subscriberIdBytes),
      tokenMint.toBuffer(),
    ],
    ZK_SHIELDED_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive subscriber VK data PDA.
 */
export function deriveSubscriberVkPDA(authority: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SUBSCRIBER_VK_DATA_SEED), authority.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Computation helpers
// ---------------------------------------------------------------------------

/**
 * Total periods the subscriber paid for at subscribe time — the only thing
 * that bounds entitlement.
 *
 * NOT `isActive`. The program writes that `true` at
 * `subscribe_private_stark.rs:395` -- the only instruction left that creates a
 * vault -- and `false` NOWHERE, so an exhausted
 * vault reports `true` for ever. Cancellation was REMOVED from the protocol, so
 * the only thing that ever closes a vault now is `claim_period` on the final
 * claim. Running out of money before that lands is the hole, and nothing on
 * chain marks it.
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
 * Periods this vault can still PAY for. Zero means the program refuses every
 * further claim. Not an entitlement test: a retailer that neglects to claim
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
 * `packages/merchant-sdk/src/period-math.ts` — the extension bundles its own
 * copy because the MV3 build does not pull workspace packages at runtime.
 * `subscriptionVault.entitlement.test.ts` runs the shared
 * `ENTITLEMENT_PARITY_VECTORS` table through both, so they cannot drift.
 */
export function subscriptionIsCurrent(vault: VaultInfo, currentSlot: number): boolean {
  if (!vault.isActive || vault.isPaused) return false;
  if (vault.intervalSlots === 0) return false;
  return periodsElapsed(vault, currentSlot) < periodsPaidFor(vault);
}

/**
 * What the popup is allowed to say a vault is, given the slot it last polled.
 *
 * The store initialises `currentSlot` to 0 and PERSISTS it, so a freshly opened
 * popup can hold a slot of 0 or one from a previous session. At slot 0
 * `periodsElapsed` reads 0 and every subscription looks brand new — rendering
 * ACTIVE off that is the same failure as rendering it off `isActive`, so it
 * gets its own answer.
 *
 * Local port of `entitlementStatus` from
 * `packages/merchant-sdk/src/period-math.ts`; pinned by the parity test.
 */
export type EntitlementStatus = 'inactive' | 'paused' | 'unknown' | 'current' | 'ended';

export function entitlementStatus(vault: VaultInfo, currentSlot: number): EntitlementStatus {
  if (!vault.isActive) return 'inactive';
  if (vault.isPaused) return 'paused';
  if (currentSlot <= 0) return 'unknown';
  if (currentSlot < vault.startSlot) return 'unknown';
  return subscriptionIsCurrent(vault, currentSlot) ? 'current' : 'ended';
}

/**
 * First slot at which {@link subscriptionIsCurrent} turns false, or `null` when
 * the vault never entitles anyone.
 */
export function subscriptionEndSlot(vault: VaultInfo): number | null {
  if (!vault.isActive || vault.isPaused) return null;
  if (vault.intervalSlots === 0) return null;
  const paid = periodsPaidFor(vault);
  if (paid === 0) return null;
  return vault.startSlot + vault.totalPausedSlots + paid * vault.intervalSlots;
}

/**
 * Faithful port of `SubscriptionVault::claimable_periods`
 * (`programs/zk_shielded/src/state/subscription_vault.rs:133`), INCLUDING the
 * `max_funded` clamp that was missing. Without it this returned the raw
 * elapsed-period count — and `Infinity` when `intervalSlots` was 0 — which the
 * since-removed `computeRefundable` then turned into an under-reported refund.
 * Refunds no longer exist; the clamp still matters for `computeClaimableAmount`.
 */
export function computeClaimable(vault: VaultInfo, currentSlot: number): number {
  if (!vault.isActive || vault.isPaused) {
    return 0;
  }
  const effectiveElapsed = currentSlot - vault.startSlot - vault.totalPausedSlots;
  if (effectiveElapsed <= 0) {
    return 0;
  }
  if (vault.intervalSlots === 0) {
    return 0;
  }
  const totalPeriods = Math.floor(effectiveElapsed / vault.intervalSlots);
  const unclaimed = Math.max(0, totalPeriods - vault.claimedPeriods);
  return Math.min(unclaimed, fundedPeriodsRemaining(vault));
}

export function computeClaimableAmount(vault: VaultInfo, currentSlot: number): number {
  const periods = computeClaimable(vault, currentSlot);
  const amount = periods * vault.rate;
  // Mirrors the program's own `actual_amount = claim_amount.min(vault_balance)`
  // (`claim_period.rs:65`).
  const totalOwed = vault.claimedPeriods * vault.rate;
  const available = vault.totalDeposited - totalOwed;
  return Math.min(amount, available);
}

/**
 * Amount the retailer has not been paid yet, in atomic units.
 *
 * A subscription vault is a one-way prepaid envelope: money that enters it can
 * only ever leave it toward the retailer. This is NOT "what the subscriber gets
 * back" — there is no cancellation and no refund. It is what the retailer is
 * still owed and will eventually receive; pause changes WHEN, never HOW MUCH.
 *
 * Replaces `computeRefundable`.
 */
export function computeOutstandingToRetailer(vault: VaultInfo): number {
  return Math.max(0, vault.totalDeposited - vault.claimedPeriods * vault.rate);
}

/** Amount the retailer has already swept out of the vault, in atomic units. */
export function computeAlreadyPaidToRetailer(vault: VaultInfo): number {
  return Math.min(vault.totalDeposited, vault.claimedPeriods * vault.rate);
}

export function nextClaimableSlot(vault: VaultInfo): number | null {
  if (!vault.isActive || vault.isPaused) {
    return null;
  }
  // A vault that has no funded periods left will never have another claimable
  // slot: `claim_period` requires `claimable_periods > 0` and that is clamped
  // by `max_funded` (subscription_vault.rs:149-154), so every future call
  // fails with NoClaimablePeriods. Without this the function answered from
  // `isActive` — which the program writes true at subscribe and false nowhere
  // — and named a slot in the future for a subscription that had ended. The
  // popup rendered that beside the new ENDED badge as "Next claim: Slot N".
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

// ---------------------------------------------------------------------------
// Vault parsing
// ---------------------------------------------------------------------------

/**
 * Parse vault account data into VaultInfo.
 * Uses variable-length Borsh Option layout (same as mobile fetchVault).
 */
export function parseVaultAccount(data: Buffer, address: string): VaultInfo {
  let offset = 8; // Skip discriminator

  // Option<Pubkey> subscriber_pubkey — 1-byte tag, then 32 bytes only if Some
  const hasSubscriberPubkey = data[offset] === 1;
  offset += 1;
  const subscriberPubkey = hasSubscriberPubkey
    ? new PublicKey(data.slice(offset, offset + 32)).toBase58()
    : null;
  if (hasSubscriberPubkey) offset += 32;

  // Option<[u8;32]> subscriber_commitment — 1-byte tag, then 32 bytes only if Some
  const hasCommitment = data[offset] === 1;
  offset += 1;
  const subscriberCommitment = hasCommitment
    ? Buffer.from(data.slice(offset, offset + 32)).toString('hex')
    : null;
  if (hasCommitment) offset += 32;

  // Pubkey retailer
  const retailer = new PublicKey(data.slice(offset, offset + 32)).toBase58();
  offset += 32;

  // Pubkey token_mint
  const tokenMint = new PublicKey(data.slice(offset, offset + 32)).toBase58();
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

  // Option<i64> pause_slot — 1-byte tag, then 8 bytes only if Some
  const hasPauseSlot = data[offset] === 1;
  offset += 1;
  const pauseSlot = hasPauseSlot ? Number(data.readBigInt64LE(offset)) : null;
  if (hasPauseSlot) offset += 8;

  // i64 total_paused_slots
  const totalPausedSlots = Number(data.readBigInt64LE(offset));
  offset += 8;

  // [u8;32] vk_hash_subscriber (skip)
  offset += 32;

  // Option<Pubkey> source_pool — 1-byte tag, then 32 bytes only if Some
  const hasSourcePool = data[offset] === 1;
  offset += 1;
  const sourcePool = hasSourcePool
    ? new PublicKey(data.slice(offset, offset + 32)).toBase58()
    : null;

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
    isNormalMode: hasSubscriberPubkey,
    isPrivateMode: hasCommitment,
  };
}

// ---------------------------------------------------------------------------
// Instruction Builders — mirrored byte-for-byte from mobile index.ts
//
// buildSubscribeNormalIx is gone: the on-chain `subscribe_normal` derived its
// vault PDA from the subscriber's wallet, so the vault address published the
// (wallet, merchant) pair to anyone who could run findProgramAddress.
// ---------------------------------------------------------------------------

/**
 * Build pause_normal instruction.
 * Mirrors mobile buildPauseNormalIx lines 260-273.
 */
function buildPauseNormalIx(
  subscriber: PublicKey,
  vaultPDA: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('pause_normal');
  const data = Buffer.alloc(8);
  disc.copy(data, 0);

  const keys = [
    { pubkey: subscriber, isSigner: true, isWritable: false },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build resume_normal instruction.
 * Mirrors mobile buildResumeNormalIx lines 276-292.
 */
function buildResumeNormalIx(
  subscriber: PublicKey,
  vaultPDA: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('resume_normal');
  const data = Buffer.alloc(8);
  disc.copy(data, 0);

  const keys = [
    { pubkey: subscriber, isSigner: true, isWritable: false },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/*
 * REMOVED: buildCancelNormalIx / buildCancelPrivateStarkRefundIx.
 *
 * `cancel_normal` and `cancel_private_stark` no longer exist in zk_shielded. A
 * subscription is a one-way prepaid envelope: money that enters a vault can only
 * ever leave it toward the retailer, and `claim_period` closes the vault on the
 * final claim. There is nothing left for a client to build.
 */

/**
 * Build claim_period instruction.
 * Mirrors mobile `buildClaimPeriodIx`.
 *
 * PERMISSIONLESS since the no-cancel lot: `retailer` is NOT a signer. The
 * program pins it to `vault.retailer` with a `==` constraint and the vault PDA
 * is the only authority over the funds, so whoever sends the transaction picks
 * the timing and pays the fee but cannot change the destination. Marking it
 * `isSigner: true` would make the runtime demand a signature the program never
 * asks for — which fails precisely for the merchants this change exists to
 * rescue, the ones whose retailer key is gone.
 *
 * `retailer` MUST be read off the vault, never assumed to be the local wallet.
 *
 * SIX accounts, not three. `ClaimPeriod<'info>` ends with token_program /
 * vault_token_account / retailer_token_account, all `Option<..>`. This builder
 * emitted only the first three until 2026-08-04, so every claim it produced died
 * with AccountNotEnoughKeys (3005 / 0xbbd) inside Anchor's account resolver —
 * before the handler ran, with an error naming neither the vault nor the money.
 * Anchor 0.32 tolerates missing trailing optionals only under the
 * `allow-missing-optionals` feature, which this program does not enable; an
 * absent optional is the executing program's OWN id.
 *
 * MEASURED on devnet 2026-08-04 against the pre-landing program: the six-account
 * form settled (tx `649EaoTP95ZS3oWhiKvWhvHHrGyoijhd5Zb5ZsyaTuejxxqMTNNPW34FS79qDvpSUVnb2uJAje7H4E4jaDcMwymY`,
 * 7,343 CU) while the three-account form returned 3005 on the very same vault.
 * `subscriptionVault.claimAccounts.test.ts` keeps the count tied to the Rust struct.
 *
 * Native SOL only, which is every vault the product creates. For an SPL vault use
 * `buildClaimPeriodInstruction` from `@protocol-01/merchant-sdk`; with the
 * sentinels an SPL vault fails in the handler with MissingTokenProgram, which
 * names the real problem, instead of 3005.
 */
function buildClaimPeriodIx(
  retailer: PublicKey,
  vaultPDA: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('claim_period');
  const data = Buffer.alloc(8);
  disc.copy(data, 0);

  const keys = [
    { pubkey: retailer, isSigner: false, isWritable: true },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // token_program: Option<Program<Token>> — absent
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    // vault_token_account: Option<Account<TokenAccount>> — absent
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    // retailer_token_account: Option<Account<TokenAccount>> — absent
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build pause_private_stark instruction.
 * Mirrors mobile buildPausePrivateStarkIx lines 907-925.
 * stark_proof_buffer is mut because the handler invalidates it post-use.
 */
function buildPausePrivateStarkIx(
  payer: PublicKey,
  vaultPDA: PublicKey,
  starkProofBuffer: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('pause_private_stark');
  const data = Buffer.alloc(8);
  disc.copy(data, 0);

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: false },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build resume_private_stark instruction.
 * Mirrors mobile buildResumePrivateStarkIx lines 931-949.
 */
function buildResumePrivateStarkIx(
  payer: PublicKey,
  vaultPDA: PublicKey,
  starkProofBuffer: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('resume_private_stark');
  const data = Buffer.alloc(8);
  disc.copy(data, 0);

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: false },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// Goldilocks helpers (mirrors mobile goldilocksU64To32)
// ---------------------------------------------------------------------------

/**
 * Encode a Goldilocks u64 commitment into the 32-byte subscriber_commitment
 * field. Bytes 0..8 = u64 LE, bytes 8..32 = 0.
 * Matches mobile subscriptionVault/index.ts:44.
 */
export function goldilocksU64To32(commitment: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = commitment & 0xFFFFFFFFFFFFFFFFn;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xFFn);
    v >>= 8n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Service functions — LEGACY normal-mode vault lifecycle (no ZK proof required).
// There is no `subscribeNormal` any more, so these only ever act on vaults that
// were opened before `subscribe_normal` was removed from the program.
// ---------------------------------------------------------------------------

/**
 * Pause a normal vault (subscriber only).
 * Mirrors mobile pauseNormal lines 454-475.
 */
export async function pauseNormal(vaultAddress: string): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  const vault = await fetchVault(vaultAddress);
  if (!vault) throw new Error('Vault not found');
  if (!vault.isNormalMode) throw new Error('Vault is not in normal mode');

  const ix = buildPauseNormalIx(signer.publicKey, vaultPubkey);
  const tx = new Transaction().add(ix);
  return signSendConfirmTx(connection, tx, signer);
}

/**
 * Resume a normal vault (subscriber only).
 * Mirrors mobile resumeNormal lines 480-501.
 */
export async function resumeNormal(vaultAddress: string): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  const vault = await fetchVault(vaultAddress);
  if (!vault) throw new Error('Vault not found');
  if (!vault.isNormalMode) throw new Error('Vault is not in normal mode');

  const ix = buildResumeNormalIx(signer.publicKey, vaultPubkey);
  const tx = new Transaction().add(ix);
  return signSendConfirmTx(connection, tx, signer);
}

/**
 * Push a vault's accrued payment to its retailer.
 *
 * PERMISSIONLESS: the local wallet is only the fee payer. It used to be passed
 * as the retailer account AND as the signer, so this silently only worked when
 * you happened to be the merchant. The retailer is now read off the vault,
 * which is also the only address the program will ever pay.
 */
export async function claimPeriod(vaultAddress: string): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  const vault = await fetchVault(vaultAddress);
  if (!vault) throw new Error('Subscription vault not found on chain');

  const ix = buildClaimPeriodIx(new PublicKey(vault.retailer), vaultPubkey);
  const tx = new Transaction().add(ix);
  return signSendConfirmTx(connection, tx, signer);
}

// ---------------------------------------------------------------------------
// Service functions — Private ZK flows
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Private subscribe helpers
// ---------------------------------------------------------------------------

/**
 * Build subscribe_private_stark instruction.
 * Mirrors mobile buildSubscribePrivateStarkIx lines 828-901.
 *
 * Args: nullifier[32], merkle_root[32], min_epoch u64,
 *       subscriber_commitment[32], rate u64, interval_slots u64,
 *       vk_hash_subscriber[32], stark_commitment u64,
 *       license_commitment  Option<[u8;32]>  (arg #9 / LAST).
 *
 * REMOVED: `client_stealth_meta: Option<[u8;64]>` used to be arg #9, and its
 * Borsh tag byte went on the wire even when None. The on-chain instruction no
 * longer declares it, so that byte must NOT be emitted — one stray byte and the
 * program deserialises `license_commitment` from the wrong offset.
 *
 * Account order mirrors subscribe_private_stark.rs (hardened 2026-06-13):
 *   payer, retailer, vault, denominated_pool, merkle_tree, nullifier_record,
 *   c1_proof_buffer, c3_proof_buffer, system_program, <SPL option tail×3>.
 *
 * The on-chain handler now REQUIRES a Circuit-3 (merkle_path) proof buffer
 * immediately AFTER the C1 buffer. Without it the note membership is never
 * proven — a forging attacker could synthesize a valid C1 for a never-deposited
 * commitment and drain one denomination per call (mirrors the C3 gate already
 * present on unshield_denominated_stark_v3). Both buffers are read-only here;
 * the handler does not write to them (the caller closes them after).
 */
/**
 * The ONLY value this client publishes as `min_epoch` on a subscribe.
 *
 * See the reasoning at the call site. Kept as a constant rather than a parameter
 * so no future call site can reintroduce a note-derived value — the same shape
 * as `UNSHIELD_MIN_EPOCH` and `TRANSFER_MIN_EPOCH` in `denominatedPool.ts`.
 */
export const SUBSCRIBE_MIN_EPOCH = 0n;

function buildSubscribePrivateStarkIx(
  payer: PublicKey,
  retailer: PublicKey,
  vaultPDA: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  nullifierPDA: PublicKey,
  c1ProofBuffer: PublicKey,
  c3ProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  minEpoch: bigint,
  subscriberCommitmentBytes: number[],
  rate: bigint,
  intervalSlots: bigint,
  vkHashSubscriber: Uint8Array,
  starkCommitment: bigint,
  licenseCommitment: Uint8Array | undefined,
  // [C3-D12] The walk arguments follow `license_commitment`, matching the Rust
  // parameter order. They are the LAST three, so every absolute offset the
  // encoding tests decode at is untouched.
  //
  // ⛔ NOT OPTIONAL. Since 2026-08-29 the C3 proof attests membership in a
  // depth-12 SUBTREE; the handler walks the remaining levels to reach a pool
  // root. Without them the proof means "this leaf is in SOME tree", which
  // anyone satisfies with a tree they built themselves.
  subtreeRoot: bigint,
  siblings: bigint[],
  directions: number[],
): TransactionInstruction {
  const disc = getDiscriminator('subscribe_private_stark');
  if (siblings.length !== directions.length) {
    throw new Error(
      `siblings (${siblings.length}) and directions (${directions.length}) must have ` +
      `equal length — the on-chain walk refuses a mismatch with WrongSiblingCount.`,
    );
  }
  if (directions.some((d) => d !== 0 && d !== 1)) {
    throw new Error('direction bits must be 0 or 1 — NonBinaryDirection on chain.');
  }

  // arg #9 (LAST) — Borsh Option<[u8;32]> license_commitment (1-byte tag + 32 if
  // Some). This is blake3(licenseSecret); the chain stores it verbatim with NO
  // verification. A merchant later checks blake3(decode(presentedKey)) == it.
  const hasLicense = !!licenseCommitment && licenseCommitment.length === 32;
  const licenseOptionSize = 1 + (hasLicense ? 32 : 0);
  const walkBytes = 8 + (4 + siblings.length * 8) + (4 + directions.length);
  const data = Buffer.alloc(
    8 + 32 + 32 + 8 + 32 + 8 + 8 + 32 + 8 + licenseOptionSize + walkBytes,
  );
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(minEpoch, offset); offset += 8;
  Buffer.from(subscriberCommitmentBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(rate, offset); offset += 8;
  data.writeBigUInt64LE(intervalSlots, offset); offset += 8;
  Buffer.from(vkHashSubscriber).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(starkCommitment, offset); offset += 8;
  // arg #9 (LAST) — license_commitment Option<[u8;32]>
  if (hasLicense) {
    data.writeUInt8(1, offset); offset += 1;
    Buffer.from(licenseCommitment!).copy(data, offset); offset += 32;
  } else {
    data.writeUInt8(0, offset); offset += 1;
  }
  // [C3-D12] args #10-#12 — subtree_root u64 | Vec<u64> siblings | Vec<u8> directions.
  data.writeBigUInt64LE(subtreeRoot, offset); offset += 8;
  data.writeUInt32LE(siblings.length, offset); offset += 4;
  for (const sib of siblings) { data.writeBigUInt64LE(sib, offset); offset += 8; }
  data.writeUInt32LE(directions.length, offset); offset += 4;
  for (const dir of directions) { data.writeUInt8(dir, offset); offset += 1; }

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: retailer, isSigner: false, isWritable: false },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: false },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    // c1_proof_buffer + c3_proof_buffer are read-only `AccountInfo` on-chain
    // (the handler only reads `verified`/`circuit_id`/`public_inputs_hash`; it
    // can't write to a buffer owned by p01_stark_verifier). The caller closes
    // them afterward. C3 MUST come immediately after C1 (struct field order in
    // subscribe_private_stark.rs), before system_program. Mirrors the unshield
    // v3 ix account order (denominatedPool.ts buildUnshieldDenominatedStarkV3Ix).
    { pubkey: c1ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: c3ProofBuffer, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // Optional SPL-token accounts — use program ID as Anchor None sentinel.
    // Without these, ix fails with AccountNotEnoughKeys (3005). Mirrors mobile
    // lines 893-898.
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Create a private (ZK-based) subscription vault.
 *
 * Shield receipt must come from the denominated pool store (shielded via
 * circuit 6). This function generates BOTH STARK proofs the hardened on-chain
 * `subscribe_private_stark` now requires:
 *   - Circuit 1 (pool_commitment): proves knowledge of secret + nullifier
 *     preimage hashing to the note's nullifier and commitment.
 *   - Circuit 3 (merkle_path):     proves that commitment is a leaf in the
 *     pool tree at `merkle_root` — i.e. the note was actually deposited.
 *
 * Both proofs (and the byte-identical Merkle-path / hashing) come from the same
 * `prepareUnshield` helper the extension's own unshield-v3 flow uses, so the
 * C3 public-inputs hash matches on-chain byte-for-byte:
 *   C1 hash = sha256(nullifier_u64 LE || stark_commitment u64 LE)
 *   C3 hash = sha256(leaf_u64 LE || root[..8] || depth(=15) u64 LE)
 * where leaf == stark_commitment (both reconstruct from the same note) and
 * root == merkle_root[..8] (bound by the pool's valid-root ring).
 *
 * FIX B (#6a): the subscriber secret is encrypted (sessionCrypto / AES-256-GCM)
 * and persisted to chrome.storage.local BEFORE the vault-creation tx is sent.
 * If the popup closes mid-proof (~2 min) or the tx confirms but the page
 * unmounts before the old post-creation save ran, the (encrypted) secret is
 * already on disk, so the vault stays controllable (pause/resume).
 *
 * FIX C (2026-09-02): the LICENSE KEY gets the same treatment. It used to be
 * derived and saved by the page only after this function returned, i.e. after
 * the two proof-buffer closes in `finally` (two more confirmed transactions),
 * the store's getProgramAccounts reload and a fetchVault. A popup that closed
 * in that window left a paid vault whose commitment was on chain and no key
 * anywhere, and nothing could rebuild one. Now the service tag is recorded in
 * the license store the instant before the tx is sent, and the key is saved
 * synchronously the instant the tx is confirmed, before anything else runs.
 * The license store can rebuild the key from the tag plus the note secret FIX
 * B already saved, which covers a confirmation this device never observed.
 *
 * Mirrors mobile subscribePrivateStark + extension unshieldDenominatedStarkV3.
 * Adaptation: uses extension's legacy submitAndVerifyStarkProof (non-uniform).
 */
export async function subscribePrivate(params: {
  receipt: ShieldReceipt;
  poolPDA: string;
  treePDA: string;
  retailer: string;
  rate: bigint;
  intervalSlots: bigint;
  subscriberOwnershipCommitment: bigint;
  vkHashSubscriber: Uint8Array;
  /**
   * Service identifier mixed into the license-key HKDF `info`. Mobile passes the
   * registry slug when available, else `retailerKey.toBase58()`. When provided,
   * the trailing Option<[u8;32]> arg #10 `license_commitment =
   * blake3(deriveLicenseSecret(receipt.secret, serviceId))` is posted on-chain so
   * a merchant can verify a presented license key. When omitted, None is posted.
   */
  serviceId?: string;
  /** Display name stored next to the license key (registry name, else what the user typed). */
  serviceName?: string;
  onProgress?: (step: string) => void;
}): Promise<string> {
  const {
    receipt,
    poolPDA: poolPDAStr,
    treePDA: treePDAStr,
    retailer,
    rate,
    intervalSlots,
    subscriberOwnershipCommitment,
    vkHashSubscriber,
    serviceId,
    serviceName,
    onProgress,
  } = params;

  const { signer, connection } = createWalletSigner();

  const retailerPubkey = new PublicKey(retailer);
  const poolPDA = new PublicKey(poolPDAStr);
  const treePDA = new PublicKey(treePDAStr);

  // Resolve the pool config for prepareUnshield (needs treePDA + denomination).
  const poolConfig: PoolConfig | undefined = findPoolV3(receipt.token, receipt.denominationHuman);
  if (!poolConfig) {
    throw new Error(
      `subscribePrivate: no V3 pool registered for ${receipt.token} ${receipt.denominationHuman}. ` +
      'Reshield with a current denomination.',
    );
  }

  // Fail-fast: a note is single-use. If its nullifier record already exists
  // on-chain (prior subscribe/unshield), subscribe_private_stark will reject
  // it with "Allocate ... already in use" — but only AFTER we've spent ~2min
  // generating + uploading the proofs. Check the (cheap) nullifier PDA first.
  onProgress?.('Checking note is unspent...');
  const alreadySpent = await isNullifierSpent(
    connection,
    poolPDA,
    receipt.nullifierPreimage,
    receipt.secret,
  );
  if (alreadySpent) {
    throw new NoteAlreadySpentError(receipt.commitment.toString());
  }

  onProgress?.('Encoding subscriber commitment...');
  const subscriberCommitmentBytes = goldilocksU64To32(subscriberOwnershipCommitment);

  // License-key commitment (commitment scheme): derive a per-subscriber 128-bit
  // licenseSecret from the SAME master note secret the vault's
  // subscriber_commitment is derived from (receipt.secret), scoped by serviceId,
  // then post blake3(licenseSecret) on-chain as the trailing Option<[u8;32]>
  // (arg #10, LAST). The chain stores it verbatim (no verification); a merchant
  // later checks blake3(decode(presentedKey)) against it off-chain. The displayed
  // key is encodeLicenseKey(licenseSecret) from the same inputs (CreateSubscription).
  let licenseSecretBytes: Uint8Array | undefined;
  let licenseCommitmentBytes: Uint8Array | undefined;
  if (serviceId) {
    licenseSecretBytes = deriveLicenseSecret(receipt.secret, serviceId);
    licenseCommitmentBytes = licenseCommitment(licenseSecretBytes);
  }

  onProgress?.('Deriving vault PDA...');
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('subscription_vault'),
      retailerPubkey.toBuffer(),
      Buffer.from(subscriberCommitmentBytes),
      SystemProgram.programId.toBuffer(), // SOL mint — Phase 1 SOL only
    ],
    ZK_SHIELDED_PROGRAM_ID,
  );

  // ── FIX B: persist the (encrypted) subscriber secret BEFORE creation ──────
  // The subscriber secret == the note's own Goldilocks secret (mobile parity).
  // If we only saved it after the tx (the old flow), a popup-close during the
  // ~2-min proof/creation window stranded the vault forever. Persist now, while
  // we still hold both the secret and the derived vault PDA. saveSecret encrypts
  // with the in-memory session password (sessionCrypto) so nothing lands at rest
  // in plaintext.
  onProgress?.('Securing subscriber key...');
  try {
    const { useSubscriptionVaultStore } = await import('../store/subscriptionVault');
    await useSubscriptionVaultStore.getState().saveSecret(
      vaultPDA.toBase58(),
      receipt.secret.toString(),
    );
  } catch (e) {
    // Never proceed to burn proof rent + create an uncontrollable vault if we
    // could not stash the controlling secret first.
    throw new Error(
      'Could not securely save the subscriber key before creating the vault ' +
      '(wallet may be locked). Aborting to avoid an uncontrollable vault. ' +
      `Cause: ${(e as Error)?.message ?? String(e)}`,
    );
  }

  // ── ROUTE: CIRCUIT 7, OR THE C1 + C3 PAIR ─────────────────────────────────
  //
  // THE ROUTE IS PER NOTE, NOT A MIGRATION — the same decision, in the same
  // order, as the withdrawal store (`store/denominatedPool.ts`). The pair
  // below stays reachable indefinitely: a note whose blinding is unknown can
  // be spent nowhere else, and `prepareSubscribeV4` has no stored-path fast
  // path, so a note whose root aged out of the pool's 100-root ring still
  // needs the v3 rebuild. Neither leg is legacy.
  //
  // The binding is fixed BEFORE the proof: `rate`, `intervalSlots`,
  // `vkHashSubscriber` and the license commitment are inside the circuit-7
  // transcript, so a change to any of them after this point is a different
  // proof. `subscribePrivateStarkV4` re-checks every one of them at send.
  const binding: SubscribeBinding = {
    vault: vaultPDA,
    rate,
    intervalSlots,
    vkHashSubscriber,
    licenseCommitment: licenseCommitmentBytes,
  };
  let preparedV4: PrepareSubscribeV4Result | null = null;
  // Asked synchronously first, so a pre-blinding note never enters the try
  // below and can never be mistaken for a prover failure.
  const v4Refusal: string | null = whyCircuit7Cannot(receipt);
  if (v4Refusal === null) {
    try {
      onProgress?.('Preparing the circuit-7 subscribe proof...');
      preparedV4 = await prepareSubscribeV4(
        receipt,
        poolConfig,
        connection,
        binding,
        subscriberOwnershipCommitment,
        retailerPubkey,
        onProgress,
      );
    } catch (err: unknown) {
      // ⛔ AN ALLOW-LIST, AND THAT IS THE WHOLE SAFETY PROPERTY. Only
      // `V4Unprovable` — "this NOTE cannot go through this circuit" — routes
      // to the pair. A wrong felt count, a transcript bound to other terms, a
      // vault that does not derive: those are a broken prover or a broken
      // caller, and answering them by republishing the commitment on the pair
      // and reporting success is the exact failure the pair exists to remove.
      // Everything that is not `V4Unprovable` is rethrown, fail closed.
      if (!(err instanceof V4Unprovable)) throw err;
      onProgress?.(
        'Circuit 7 cannot prove this note — falling back to the C1 + C3 pair ' +
        '(this subscription will publish the note commitment).',
      );
      console.warn('[SubscriptionVault] circuit 7 refused, falling back to the pair:', err.message);
    }
  } else {
    onProgress?.(
      'Falling back to the C1 + C3 pair (this subscription will publish the note commitment).',
    );
    console.warn('[SubscriptionVault] circuit 7 refused:', v4Refusal);
  }

  if (preparedV4 !== null) {
    // ⛔ NOTHING AFTER THIS POINT MAY FALL BACK TO v3. Once the proof is
    // uploaded and the nullifier PDA initialised, a v3 retry pays the buffer
    // rent a second time and dies on the double-spend guard with the note
    // already spent. Any throw from here propagates as is.
    const { txSig } = await subscribePrivateStarkV4(
      {
        receipt,
        poolConfig,
        prepared: preparedV4,
        retailer: retailerPubkey,
        subscriberCommitment: subscriberOwnershipCommitment,
        binding,
        // FIX C, part 1 — the same placement as the v3 leg below: the instant
        // before the tx is sent, after the upload, so a proof or upload failure
        // never leaves a tag for a vault that was never created.
        onBeforeSend: () => {
          if (serviceId) {
            useLicenseStore.getState().recordVaultTag({
              vaultAddress: vaultPDA.toBase58(),
              retailer,
              serviceTag: serviceId,
              serviceName,
            });
          }
        },
      },
      signer,
      connection,
      onProgress,
    );

    // FIX C, part 2 — synchronously, the moment the tx is confirmed, exactly
    // as the v3 leg does it. The proof-buffer close has already run inside
    // `subscribePrivateStarkV4`'s `finally`; that is one confirmed transaction
    // between confirmation and this write rather than zero, and the tag
    // recorded above covers it if this device never gets here.
    if (serviceId && licenseSecretBytes) {
      try {
        useLicenseStore.getState().saveLicense({
          licenseKey: encodeLicenseKey(licenseSecretBytes),
          retailer,
          mode: 'zk',
          serviceName,
          createdAt: Date.now(),
          vaultAddress: vaultPDA.toBase58(),
          serviceTag: serviceId,
        });
      } catch (e) {
        console.warn(
          '[SubscriptionVault] license key persist failed (rebuildable from the vault tag):',
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    onProgress?.('Done!');
    return txSig;
  }

  // ── v3: byte for byte what this function did before circuit 7 existed. ──
  //
  // Generate C1 (pool_commitment) + C3 (merkle_path) via the shared
  // unshield-v3 preparer. This fetches pool leaves, rebuilds the Merkle path,
  // root-preflights against the pool ring, and produces both proofs with the
  // exact public-input layout the on-chain handler reconstructs.
  onProgress?.('Generating C1 + C3 STARK proofs (~2 min)...');
  const prepared = await prepareUnshield(receipt, poolConfig, connection, onProgress);
  const {
    c1ProofResult, c3ProofResult, merkleRoot, nullifierGoldilocks, starkCommitment,
    // [C3-D12] `merkleRoot` is the POOL root from the client's own tree walk;
    // `subtreeRoot` is what C3 actually proved. See `prepareUnshield`.
    subtreeRoot, siblings, directions,
  } = prepared;

  const nullifierBytes = goldilocksToLeBytes32(nullifierGoldilocks);
  // merkle_root arg: low 8 bytes carry the Goldilocks root felt the C3 hash
  // binds (root[..8]); high 24 bytes zero. Must reproduce a root in the pool's
  // valid-root ring (is_valid_root account constraint).
  const merkleRootBytes = goldilocksToLeBytes32(merkleRoot);
  // TWIN OF THE TRANSFER LANDMINE, same fix. `subscribe_private_stark.rs:196-204`
  // enforces `current_epoch >= min_epoch + dynamic_delay` exactly as the transfer
  // handler does, so passing the note's deposit epoch here is not a maturity
  // check — it is a timer that a PRF-blinded note can never satisfy. A blinding
  // is ~2^62 and the absolute epoch is ~66,800, so every blinded note would
  // become permanently un-SUBSCRIBABLE the day Part A lands. Silent capability
  // loss, not fund loss, which is why nothing would have caught it.
  //
  // Passing 0 costs no security: `min_epoch` is a public input of NONE of the
  // proof buffers this instruction reads (C1 binds [nullifier, commitment], C3
  // binds [commitment, root, depth]), so it was never bound to the note and a
  // hostile client could always have passed 0 anyway. Maturity intent stays where
  // it can actually be enforced — the client pre-flight before proving.
  const minEpoch = SUBSCRIBE_MIN_EPOCH;

  const createdBuffers: PublicKey[] = [];
  let c1ProofBuffer: PublicKey | undefined;
  let c3ProofBuffer: PublicKey | undefined;

  try {
    // Step 1: Submit + verify C1 (pool_commitment).
    onProgress?.('Submitting C1 (pool_commitment) proof on-chain...');
    const c1Proof: GenericStarkProof = {
      proofBytes: c1ProofResult.proofBytes,
      circuitId: CIRCUIT_POOL_COMMITMENT,
      publicInputs: c1ProofResult.publicInputs,
      proofSize: c1ProofResult.proofSize,
    };
    const c1Res = await submitAndVerifyStarkProof(c1Proof, signer, connection, onProgress);
    c1ProofBuffer = c1Res.proofBuffer;
    createdBuffers.push(c1ProofBuffer);

    // Step 2: Submit + verify C3 (merkle_path).
    onProgress?.('Submitting C3 (merkle_path) proof on-chain...');
    const c3Proof: GenericStarkProof = {
      proofBytes: c3ProofResult.proofBytes,
      circuitId: CIRCUIT_MERKLE_PATH,
      publicInputs: c3ProofResult.publicInputs,
      proofSize: c3ProofResult.proofSize,
    };
    const c3Res = await submitAndVerifyStarkProof(c3Proof, signer, connection, onProgress);
    c3ProofBuffer = c3Res.proofBuffer;
    createdBuffers.push(c3ProofBuffer);

    // Step 3: Build + send subscribe_private_stark (C1 then C3 buffer).
    onProgress?.('Building subscription transaction...');
    const [nullifierPDA] = deriveNullifierPDA(poolPDA, Buffer.from(nullifierBytes));

    const ix = buildSubscribePrivateStarkIx(
      signer.publicKey,
      retailerPubkey,
      vaultPDA,
      poolPDA,
      treePDA,
      nullifierPDA,
      c1ProofBuffer,
      c3ProofBuffer,
      nullifierBytes,
      merkleRootBytes,
      minEpoch,
      Array.from(subscriberCommitmentBytes),
      rate,
      intervalSlots,
      vkHashSubscriber,
      starkCommitment,
      licenseCommitmentBytes, // arg #9 — Option<[u8;32]> license_commitment.
      subtreeRoot,            // arg #10
      siblings,               // arg #11
      directions,             // arg #12
    );

    onProgress?.('Sending subscription transaction...');
    const tx = new Transaction();
    // [C3-D12] 300,000 -> 400,000. One on-chain `hash2` is ~34,469 CU (measured
    // 2026-08-29 on the litesvm SBF VM), so the three levels the handler now
    // walks add ~103,400. Matches the web app and the v4 path.
    tx.add(...buildComputeBudgetIxs(400_000));
    tx.add(ix);

    // FIX C, part 1: from the next line on the vault may exist on chain, so the
    // tag that rebuilds its key is recorded now. If confirmation is never
    // observed here (popup closed, RPC timed out on a tx that landed), the
    // license store can still derive the key from this tag and the secret
    // FIX B saved. Recorded here rather than with FIX B so a proof or upload
    // failure never leaves a tag for a vault that was never created.
    if (serviceId) {
      useLicenseStore.getState().recordVaultTag({
        vaultAddress: vaultPDA.toBase58(),
        retailer,
        serviceTag: serviceId,
        serviceName,
      });
    }

    const sig = await signSendConfirmTx(connection, tx, signer);

    // FIX C, part 2: the key is persisted HERE, synchronously, the moment the
    // tx is confirmed. No await sits between the confirmation and this write,
    // and the proof-buffer closes in `finally` (two more confirmed
    // transactions) only start after it. The bytes encoded are the very
    // preimage of the commitment posted above, so this key verifies against
    // this vault.
    if (serviceId && licenseSecretBytes) {
      try {
        useLicenseStore.getState().saveLicense({
          licenseKey: encodeLicenseKey(licenseSecretBytes),
          retailer,
          mode: 'zk',
          serviceName,
          createdAt: Date.now(),
          vaultAddress: vaultPDA.toBase58(),
          serviceTag: serviceId,
        });
      } catch (e) {
        // Non-fatal: the tag recorded above still lets the store rebuild it.
        console.warn(
          '[SubscriptionVault] license key persist failed (rebuildable from the vault tag):',
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    onProgress?.('Done!');
    return sig;
  } finally {
    // Close both proof buffers (rent recovery), same as unshield v3.
    for (const buf of createdBuffers) {
      try {
        onProgress?.('Closing proof buffer (rent recovery)...');
        await closeStarkProofBuffer(buf, signer, connection);
      } catch (closeErr: unknown) {
        console.warn(
          '[SubscriptionVault] closeStarkProofBuffer failed:',
          closeErr instanceof Error ? closeErr.message : String(closeErr),
        );
      }
    }
  }
}

/**
 * Pause a private vault using STARK proof of subscriber secret (circuit 0).
 *
 * FEASIBLE: circuit 0 (subscriber_ownership) is fully available in the
 * extension via starkProver.generateProof(secret).
 *
 * Mirrors mobile pausePrivateStark lines 712-759.
 *
 * @param vaultAddress - Vault PDA address (base58)
 * @param subscriberSecret - Subscriber secret bigint (stored in vault store)
 * @param onProgress - Optional progress callback
 */
export async function pausePrivate(
  vaultAddress: string,
  subscriberSecret: string,
  onProgress?: (step: string) => void,
): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  onProgress?.('Generating STARK proof...');
  await starkProver.start();
  const proofResult = await starkProver.generateProof(subscriberSecret);

  const proofBytes = hexToBytes(proofResult.proofHex);
  const commitment = BigInt(proofResult.commitment);

  onProgress?.('Submitting STARK proof on-chain...');
  const { proofBuffer } = await submitAndVerifyStarkProof(
    {
      proofBytes,
      circuitId: CIRCUIT_SUBSCRIBER_OWNERSHIP,
      publicInputs: [commitment],
      proofSize: proofResult.proofSize,
    },
    signer,
    connection,
    onProgress,
  );

  onProgress?.('Building pause transaction...');
  const ix = buildPausePrivateStarkIx(signer.publicKey, vaultPubkey, proofBuffer);
  const tx = new Transaction().add(ix);
  const sig = await signSendConfirmTx(connection, tx, signer);

  onProgress?.('Closing proof buffer...');
  await closeStarkProofBuffer(proofBuffer, signer, connection);

  onProgress?.('Done!');
  return sig;
}

/**
 * Resume a private vault using STARK proof of subscriber secret (circuit 0).
 *
 * FEASIBLE: circuit 0 available in the extension.
 *
 * Mirrors mobile resumePrivateStark lines 770-817.
 *
 * @param vaultAddress - Vault PDA address (base58)
 * @param subscriberSecret - Subscriber secret bigint (stored in vault store)
 * @param onProgress - Optional progress callback
 */
export async function resumePrivate(
  vaultAddress: string,
  subscriberSecret: string,
  onProgress?: (step: string) => void,
): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  onProgress?.('Generating STARK proof...');
  await starkProver.start();
  const proofResult = await starkProver.generateProof(subscriberSecret);

  const proofBytes = hexToBytes(proofResult.proofHex);
  const commitment = BigInt(proofResult.commitment);

  onProgress?.('Submitting STARK proof on-chain...');
  const { proofBuffer } = await submitAndVerifyStarkProof(
    {
      proofBytes,
      circuitId: CIRCUIT_SUBSCRIBER_OWNERSHIP,
      publicInputs: [commitment],
      proofSize: proofResult.proofSize,
    },
    signer,
    connection,
    onProgress,
  );

  onProgress?.('Building resume transaction...');
  const ix = buildResumePrivateStarkIx(signer.publicKey, vaultPubkey, proofBuffer);
  const tx = new Transaction().add(ix);
  const sig = await signSendConfirmTx(connection, tx, signer);

  onProgress?.('Closing proof buffer...');
  await closeStarkProofBuffer(proofBuffer, signer, connection);

  onProgress?.('Done!');
  return sig;
}

/*
 * REMOVED: cancelPrivate, deriveRefundJobPDA and the p01_relayer program id.
 *
 * cancelPrivate built `cancel_private_stark`, generated the circuit-0 STARK
 * ownership proof for it and derived the `refund_job` PDA so the keeper could
 * pay the residual back to the subscriber's stealth address. That whole leg is
 * gone: the instruction no longer exists on chain, and the refund it served was
 * the only INBOUND operation in the system.
 *
 * The circuit-0 proof itself is NOT dead — pauseVault / resumeVault still use it.
 */

// ---------------------------------------------------------------------------
// Hex helper
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a vault by address.
 */
export async function fetchVault(vaultAddress: string): Promise<VaultInfo | null> {
  const { connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  try {
    const accountInfo = await connection.getAccountInfo(vaultPubkey);
    if (!accountInfo || !accountInfo.data) {
      return null;
    }
    return parseVaultAccount(accountInfo.data, vaultAddress);
  } catch (error) {
    console.error('[SubscriptionVault] fetchVault error:', error);
    return null;
  }
}

/**
 * Fetch all vaults for a wallet (as subscriber).
 * Uses getProgramAccounts with memcmp filter on subscriber_pubkey (normal mode).
 */
export async function fetchAllVaults(walletPubkey: string): Promise<VaultInfo[]> {
  const { connection } = createWalletSigner();
  const pubkey = new PublicKey(walletPubkey);

  try {
    // memcmp.bytes uses base58 encoding in @solana/web3.js.
    // We match the 1-byte Some tag + 32 subscriber pubkey bytes at offset 8.
    // This picks up normal-mode vaults only.
    //
    // RESIDUAL LEAK, kept on purpose. This filter is the same membership oracle
    // that got `subscribe_normal` deleted, in its other form: any RPC caller can
    // memcmp offset 8 for any wallet and get that wallet's subscriptions, and
    // running it here also hands the wallet to the RPC provider. It survives
    // because `subscriber_pubkey` is a plaintext wallet inside a public account,
    // which no client-side change can fix. It is bounded: no new normal-mode
    // vault can be created, so this can only ever return vaults that predate the
    // removal, and each one stops being findable when `claim_period` closes it on the
    // retailer's final claim. (cancel_normal used to be the owner-driven way out;
    // cancellation has been removed from the protocol.) Removing this function
    // would leave those owners with no way to see their vault at all.
    // Private vaults are keyed on a commitment and never match this filter.
    const filterBytes = Buffer.from([1, ...pubkey.toBytes()]);
    const accounts = await connection.getProgramAccounts(ZK_SHIELDED_PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 8,
            bytes: filterBytes.toString('base64'),
            encoding: 'base64' as const,
          },
        },
      ],
    });

    const vaults: VaultInfo[] = [];
    for (const { pubkey: vaultPubkey, account } of accounts) {
      try {
        const dataBuffer = Buffer.isBuffer(account.data)
          ? account.data
          : Buffer.from(account.data);
        const vault = parseVaultAccount(dataBuffer, vaultPubkey.toBase58());
        vaults.push(vault);
      } catch (error) {
        console.error('[SubscriptionVault] Failed to parse vault:', vaultPubkey.toBase58(), error);
      }
    }

    return vaults;
  } catch (error) {
    console.error('[SubscriptionVault] fetchAllVaults error:', error);
    return [];
  }
}
