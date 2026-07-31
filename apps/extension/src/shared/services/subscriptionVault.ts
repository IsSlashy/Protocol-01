/**
 * Subscription Vault Service for Chrome Extension
 *
 * Wraps subscription vault operations from the zk_shielded program.
 * Supports both normal (wallet-based) and private (ZK-based) vaults.
 *
 * Normal mode: Subscriber deposits from wallet, authenticates with wallet signature
 * Private mode: Subscriber deposits from a ZK shielded note, authenticates with
 *   STARK proof (circuit 0 = subscriber_ownership for pause/resume/cancel;
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
 *   `subscribePrivate` (below) generates the C1 proof via
 *   starkProver.generatePoolCommitmentProof and submits subscribe_private_stark.
 *   Circuit 0 (subscriber_ownership) drives pause/resume/cancel — the subscriber
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
import { deriveLicenseSecret, licenseCommitment } from './license';
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
  type ShieldReceipt,
  type PoolConfig,
} from './denominatedPool';

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
 * NOT `isActive`. The program writes that `true` at `subscribe_normal.rs:120`
 * and `subscribe_private_stark.rs:395` and `false` NOWHERE, so an exhausted
 * vault reports `true` for ever. Cancellation is not the hole either — both
 * cancel instructions `close` the account. Running out of money is the hole,
 * and nothing on chain marks it.
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
 * elapsed-period count — and `Infinity` when `intervalSlots` was 0 — which
 * `computeRefundable` then turned into an under-reported subscriber refund.
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

export function computeRefundable(vault: VaultInfo, currentSlot: number): number {
  const claimable = computeClaimable(vault, currentSlot);
  const totalOwed = (vault.claimedPeriods + claimable) * vault.rate;
  return Math.max(0, vault.totalDeposited - totalOwed);
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

/**
 * Build cancel_normal instruction.
 * Mirrors mobile buildCancelNormalIx lines 297-314.
 */
function buildCancelNormalIx(
  subscriber: PublicKey,
  vaultPDA: PublicKey,
  retailer: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('cancel_normal');
  const data = Buffer.alloc(8);
  disc.copy(data, 0);

  const keys = [
    { pubkey: subscriber, isSigner: true, isWritable: true },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: retailer, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build claim_period instruction.
 * Mirrors mobile buildClaimPeriodIx lines 240-254.
 */
function buildClaimPeriodIx(
  retailer: PublicKey,
  vaultPDA: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('claim_period');
  const data = Buffer.alloc(8);
  disc.copy(data, 0);

  const keys = [
    { pubkey: retailer, isSigner: true, isWritable: true },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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

/**
 * Build cancel_private_stark instruction (refund-via-relayer path with empty
 * commitments). The extension always uses the refund-job path because it has
 * no denominated pool to reshield into.
 * Mirrors mobile buildCancelPrivateStarkIx lines 980-1050.
 */
function buildCancelPrivateStarkRefundIx(
  payer: PublicKey,
  retailer: PublicKey,
  vaultPDA: PublicKey,
  merkleTreePDA: PublicKey,
  starkProofBuffer: PublicKey,
  refundJobPDA: PublicKey,
  relayerProgramId: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('cancel_private_stark');

  // new_commitments: Vec<[u8;32]> — length 0, new_roots: Vec<[u8;32]> — length 0
  const data = Buffer.alloc(8 + 4 + 4);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  data.writeUInt32LE(0, offset); offset += 4; // new_commitments length
  data.writeUInt32LE(0, offset);              // new_roots length

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: retailer, isSigner: false, isWritable: true },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    // denominated_pool optional — use ZK_SHIELDED_PROGRAM_ID as Anchor None sentinel
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    // merkle_tree — REQUIRED even on refund path (target_tree for keeper)
    { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: true },
    { pubkey: refundJobPDA, isSigner: false, isWritable: true },
    { pubkey: relayerProgramId, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // SPL-token optional tails
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
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
 * Cancel a normal vault and refund remaining balance to subscriber.
 * Mirrors mobile cancelNormal lines 506-540.
 */
export async function cancelNormal(vaultAddress: string): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  const vault = await fetchVault(vaultAddress);
  if (!vault) throw new Error('Vault not found');
  if (!vault.isNormalMode) throw new Error('Vault is not in normal mode');

  const retailerPubkey = new PublicKey(vault.retailer);
  const ix = buildCancelNormalIx(signer.publicKey, vaultPubkey, retailerPubkey);
  const tx = new Transaction().add(ix);
  return signSendConfirmTx(connection, tx, signer);
}

/**
 * Claim accrued periods from a vault (retailer only).
 * Mirrors mobile claimPeriod lines 419-448.
 */
export async function claimPeriod(vaultAddress: string): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  const ix = buildClaimPeriodIx(signer.publicKey, vaultPubkey);
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
 *       client_stealth_meta Option<[u8;64]>  (arg #9),
 *       license_commitment  Option<[u8;32]>  (arg #10 / LAST).
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
  clientStealthMeta?: Uint8Array,
  licenseCommitment?: Uint8Array,
): TransactionInstruction {
  const disc = getDiscriminator('subscribe_private_stark');

  // arg #9 — Borsh Option<[u8;64]> client_stealth_meta (1-byte tag + 64 if Some)
  const hasMeta = !!clientStealthMeta && clientStealthMeta.length === 64;
  const metaOptionSize = 1 + (hasMeta ? 64 : 0);
  // arg #10 (LAST) — Borsh Option<[u8;32]> license_commitment (1-byte tag + 32 if
  // Some). This is blake3(licenseSecret); the chain stores it verbatim with NO
  // verification. A merchant later checks blake3(decode(presentedKey)) == it.
  const hasLicense = !!licenseCommitment && licenseCommitment.length === 32;
  const licenseOptionSize = 1 + (hasLicense ? 32 : 0);
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 32 + 8 + 8 + 32 + 8 + metaOptionSize + licenseOptionSize);
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
  // arg #9 — client_stealth_meta Option<[u8;64]>
  if (hasMeta) {
    data.writeUInt8(1, offset); offset += 1;
    Buffer.from(clientStealthMeta!).copy(data, offset); offset += 64;
  } else {
    data.writeUInt8(0, offset); offset += 1;
  }
  // arg #10 (LAST) — license_commitment Option<[u8;32]>
  if (hasLicense) {
    data.writeUInt8(1, offset); offset += 1;
    Buffer.from(licenseCommitment!).copy(data, offset); offset += 32;
  } else {
    data.writeUInt8(0, offset); offset += 1;
  }

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
 * already on disk, so the vault stays controllable (pause/resume/cancel).
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
  let licenseCommitmentBytes: Uint8Array | undefined;
  if (serviceId) {
    licenseCommitmentBytes = licenseCommitment(
      deriveLicenseSecret(receipt.secret, serviceId),
    );
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

  // ── Generate C1 (pool_commitment) + C3 (merkle_path) via the shared
  // unshield-v3 preparer. This fetches pool leaves, rebuilds the Merkle path,
  // root-preflights against the pool ring, and produces both proofs with the
  // exact public-input layout the on-chain handler reconstructs. ──
  onProgress?.('Generating C1 + C3 STARK proofs (~2 min)...');
  const prepared = await prepareUnshield(receipt, poolConfig, connection, onProgress);
  const { c1ProofResult, c3ProofResult, merkleRoot, nullifierGoldilocks, starkCommitment } = prepared;

  const nullifierBytes = goldilocksToLeBytes32(nullifierGoldilocks);
  // merkle_root arg: low 8 bytes carry the Goldilocks root felt the C3 hash
  // binds (root[..8]); high 24 bytes zero. Must reproduce a root in the pool's
  // valid-root ring (is_valid_root account constraint).
  const merkleRootBytes = goldilocksToLeBytes32(merkleRoot);
  const minEpoch = receipt.depositEpoch;

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
      undefined, // clientStealthMeta: omit (None) for Phase 1 (arg #9).
      licenseCommitmentBytes, // arg #10 (LAST) — Option<[u8;32]> license_commitment.
    );

    onProgress?.('Sending subscription transaction...');
    const tx = new Transaction();
    tx.add(...buildComputeBudgetIxs(300_000));
    tx.add(ix);
    const sig = await signSendConfirmTx(connection, tx, signer);

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

// ---------------------------------------------------------------------------
// p01_relayer constants (mirrors mobile index.ts:67-89)
// ---------------------------------------------------------------------------

const P01_RELAYER_PROGRAM_ID = new PublicKey('2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW');

function deriveRefundJobPDA(sourceVault: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('refund_job'), sourceVault.toBuffer()],
    P01_RELAYER_PROGRAM_ID,
  );
  return pda;
}

/**
 * Cancel a private vault using STARK proof of subscriber secret (circuit 0).
 *
 * FEASIBLE: circuit 0 available in the extension.
 *
 * Uses the refund-via-relayer path (vault.client_stealth_meta path) since
 * the extension has no denominated pool to reshield into. If the vault
 * predates client_stealth_meta (legacy), falls back to a forced-forfeit
 * cancel (passes zero merkle_tree and zero refund_job as sentinels).
 *
 * Mirrors mobile cancelPrivateStark lines 1068-1169.
 *
 * @param vaultAddress - Vault PDA address (base58)
 * @param subscriberSecret - Subscriber secret bigint
 * @param onProgress - Optional progress callback
 */
export async function cancelPrivate(
  vaultAddress: string,
  subscriberSecret: string,
  onProgress?: (step: string) => void,
): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const vaultPubkey = new PublicKey(vaultAddress);

  const vault = await fetchVault(vaultAddress);
  if (!vault) throw new Error('Vault not found');
  if (!vault.isPrivateMode) throw new Error('Vault is not in private mode');

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

  onProgress?.('Building cancel transaction...');
  const retailerPubkey = new PublicKey(vault.retailer);
  const refundJobPDA = deriveRefundJobPDA(vaultPubkey);

  // Use ZK_SHIELDED_PROGRAM_ID as the Anchor None sentinel for merkle_tree
  // when no denominated pool is present. The on-chain handler must have
  // client_stealth_meta set for the refund path to succeed.
  const merkleTreeSentinel = ZK_SHIELDED_PROGRAM_ID;

  const ix = buildCancelPrivateStarkRefundIx(
    signer.publicKey,
    retailerPubkey,
    vaultPubkey,
    merkleTreeSentinel,
    proofBuffer,
    refundJobPDA,
    P01_RELAYER_PROGRAM_ID,
  );

  const tx = new Transaction();
  tx.add(...buildComputeBudgetIxs(400_000));
  tx.add(ix);
  const sig = await signSendConfirmTx(connection, tx, signer);

  onProgress?.('Closing proof buffer...');
  await closeStarkProofBuffer(proofBuffer, signer, connection);

  onProgress?.('Done!');
  return sig;
}

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
    // removal, and each one stops being findable the moment its owner calls
    // cancel_normal (which closes the account). Removing this function would
    // leave those owners with no way to see the vault they need to close.
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
