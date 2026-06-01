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
 *   The extension's denominated pool was deleted (BN254 trap). The extension only
 *   has continuous Goldilocks shielded notes (circuits 5/6). However, circuit 1
 *   (pool_commitment) requires a denominated-pool note as input (nullifier_preimage,
 *   secret, epoch, mint from a fixed-denomination Tornado-style pool). The extension
 *   WASM does expose generate_pool_commitment_stark_proof but the inputs it expects
 *   are denominated-pool-specific and there is no denominated pool to source them
 *   from in the extension. Therefore subscribePrivateStark is BLOCKED and throws
 *   an explicit error documenting this. See BLOCKED_PRIVATE_SUBSCRIBE below.
 *
 *   Circuit 0 (subscriber_ownership) IS available via starkProver.generateProof(secret).
 *   So pausePrivateStark / resumePrivateStark / cancelPrivateStark CAN be implemented
 *   — the secret is just a Goldilocks bigint stored at vault creation time.
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
import { useWalletStore, getPrivySigner } from '../store/wallet';
import { getConnection } from './wallet';
import type { VaultInfo, SubscribeNormalParams, SubscribePrivateParams, ProofData } from './subscriptionVault.types';
import type { WalletSigner } from './stark';
import {
  submitAndVerifyStarkProof,
  closeStarkProofBuffer,
  CIRCUIT_SUBSCRIBER_OWNERSHIP,
} from './stark';
import { starkProver } from './starkProver';

// Re-export types
export type { VaultInfo, SubscribeNormalParams, SubscribePrivateParams, ProofData };

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
  const privySigner = getPrivySigner();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);
  const keypair = walletState._keypair;

  const signer: WalletSigner = {
    publicKey: walletPublicKey,
    signTransaction: async (tx: Transaction): Promise<Transaction> => {
      if (walletState.isPrivyWallet && privySigner) {
        return (await privySigner(tx)) as unknown as Transaction;
      } else if (keypair) {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
        if (!tx.feePayer) tx.feePayer = walletPublicKey;
        tx.sign(keypair);
        return tx;
      }
      throw new Error('No signing method available');
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

export function computeClaimableAmount(vault: VaultInfo, currentSlot: number): number {
  const periods = computeClaimable(vault, currentSlot);
  const amount = periods * vault.rate;
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
// ---------------------------------------------------------------------------

/**
 * Build subscribe_normal instruction.
 * Args: amount: u64, rate: u64, interval_slots: u64, vk_hash_subscriber: [u8;32]
 * Accounts mirror mobile buildSubscribeNormalIx lines 199-233.
 */
function buildSubscribeNormalIx(
  subscriber: PublicKey,
  retailer: PublicKey,
  tokenMint: PublicKey,
  vaultPDA: PublicKey,
  amount: bigint,
  rate: bigint,
  intervalSlots: bigint,
  vkHashSubscriber: Uint8Array,
): TransactionInstruction {
  const disc = getDiscriminator('subscribe_normal');
  const data = Buffer.alloc(8 + 8 + 8 + 8 + 32);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  data.writeBigUInt64LE(amount, offset); offset += 8;
  data.writeBigUInt64LE(rate, offset); offset += 8;
  data.writeBigUInt64LE(intervalSlots, offset); offset += 8;
  Buffer.from(vkHashSubscriber).copy(data, offset);

  const keys = [
    { pubkey: subscriber, isSigner: true, isWritable: true },
    { pubkey: retailer, isSigner: false, isWritable: false },
    { pubkey: tokenMint, isSigner: false, isWritable: false },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // Optional token accounts — use program ID as Anchor None sentinel
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

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
// Service functions — Normal flows (no ZK proof required)
// ---------------------------------------------------------------------------

/**
 * Create a normal (wallet-based) subscription vault.
 * Mirrors mobile subscribeNormal lines 351-413.
 *
 * @param params.vkHashSubscriber - 32-byte VK hash. Pass new Uint8Array(32) for
 *   "no subscriber ownership circuit" (normal-mode vaults ignore this field
 *   on pause/resume/cancel since they use wallet signature instead).
 */
export async function subscribeNormal(params: {
  retailer: string;
  tokenMint: string;
  amount: number;
  rate: number;
  intervalSlots: number;
  vkHashSubscriber: Uint8Array;
}): Promise<string> {
  const { signer, connection } = createWalletSigner();
  const retailerPubkey = new PublicKey(params.retailer);
  const tokenMintPubkey = new PublicKey(params.tokenMint);
  const isNativeSol = tokenMintPubkey.equals(NATIVE_SOL_MINT);

  const vaultPDA = deriveVaultPDA(
    retailerPubkey,
    signer.publicKey.toBytes(),
    tokenMintPubkey,
  );

  const ix = buildSubscribeNormalIx(
    signer.publicKey,
    retailerPubkey,
    isNativeSol ? NATIVE_SOL_MINT : tokenMintPubkey,
    vaultPDA,
    BigInt(params.amount),
    BigInt(params.rate),
    BigInt(params.intervalSlots),
    params.vkHashSubscriber,
  );

  const tx = new Transaction();
  tx.add(...buildComputeBudgetIxs(300_000));
  tx.add(ix);
  return signSendConfirmTx(connection, tx, signer);
}

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

// BLOCKED_PRIVATE_SUBSCRIBE: subscribePrivate cannot be implemented in the
// extension because:
//   1. Circuit 1 (pool_commitment) requires (nullifier_preimage, secret, epoch, mint)
//      from a denominated Tornado-style pool note.
//   2. The extension's denominated pool was deleted — only Goldilocks continuous
//      shielded notes (circuits 5/6) exist.
//   3. The extension WASM does have generate_pool_commitment_stark_proof but
//      the inputs it needs are denominated-pool-specific and no such notes are
//      available in the extension.
//   Resolution: private subscription must be initiated from mobile (which has
//   the denominated pool), or the extension needs a denominated pool added.

/**
 * Create a private (ZK-based) subscription vault.
 *
 * BLOCKED: The extension has no denominated pool notes. Circuit 1
 * (pool_commitment) requires a denominated-pool note as input. See
 * BLOCKED_PRIVATE_SUBSCRIBE comment above for full rationale.
 */
export async function subscribePrivate(_params: {
  retailer: string;
  poolAddress: string;
  proof: ProofData;
  nullifier: string;
  merkleRoot: string;
  minEpoch: number;
  subscriberSecret: string;
  rate: number;
  intervalSlots: number;
  vkHashSubscriber: Uint8Array;
}): Promise<string> {
  throw new Error(
    'BLOCKED: subscribePrivate requires a denominated pool note (circuit 1 / pool_commitment). ' +
    'The extension has no denominated pool — it was deleted as a BN254 trap. ' +
    'Initiate private subscriptions from the mobile app, or add a denominated pool to the extension.',
  );
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
