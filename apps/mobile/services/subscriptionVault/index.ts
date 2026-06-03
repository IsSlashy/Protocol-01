/**
 * Subscription Vault Service for React Native
 *
 * Client-side management for subscription vaults.
 * Supports two modes:
 *   - Normal: wallet-based subscriptions (subscriber authenticates with wallet signature)
 *   - Private: ZK-based subscriptions (subscriber authenticates with ZK proof)
 *
 * On-chain program: GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c (zk_shielded)
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { getConnection } from '../solana/connection';
import { getKeypair } from '../solana/wallet';
import type { PoolConfig, ShieldReceipt } from '../denominatedPool';
import {
  bigintToLeBytes32,
  deriveNullifierPDA,
} from '../denominatedPool';
import { payLog, markPayComplete, inspectPayError } from '../payments/diagnostics';

/**
 * Encode a Goldilocks u64 commitment into the 32-byte `subscriber_commitment`
 * field expected by the vault. The on-chain pause/resume/cancel handlers read
 * `commitment[..8]` as a little-endian u64 and compare it against the
 * circuit-0 STARK proof's stored inputs hash (sha256(u64_le_bytes)).
 * Bytes 8..32 must be zero so the vault PDA derivation matches the one used
 * during subscribe.
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
// Constants
// ---------------------------------------------------------------------------

export const ZK_SHIELDED_PROGRAM_ID = new PublicKey(
  'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c'
);

/**
 * p01_relayer program ID — used by the refund-via-relayer path on cancel.
 * The `refund_job` PDA derives from `[b"refund_job", source_vault]` and is
 * initialized by `cancel_private_stark` via CPI to `submit_refund_job`.
 */
export const P01_RELAYER_PROGRAM_ID = new PublicKey(
  '2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW'
);

/** Below this lamports residual, refund-via-relayer falls back to forfeit-dust
 * (keeper fee + rent costs eat the residual). Mirrors `REFUND_MIN_RESIDUAL`
 * in p01_relayer constants. */
export const REFUND_MIN_RESIDUAL: bigint = 100_000n;

/** Lamports paid to the keeper that processes a RefundJob. Mirrors
 * `REFUND_KEEPER_FEE` in p01_relayer constants. */
export const REFUND_KEEPER_FEE: bigint = 50_000n;

/**
 * Derive the `refund_job` PDA for a given source vault. Matches the on-chain
 * seed `[b"refund_job", source_vault.as_ref()]` in p01_relayer.
 */
export function deriveRefundJobPDA(sourceVault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('refund_job'), sourceVault.toBuffer()],
    P01_RELAYER_PROGRAM_ID,
  );
}

const NATIVE_SOL_MINT = SystemProgram.programId;

const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  'ComputeBudget111111111111111111111111111111'
);

/** Build compute budget instructions */
function buildComputeBudgetIxs(cuLimit = 300_000, cuPriceMicroLamports = 1000) {
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
// Types
// ---------------------------------------------------------------------------

export interface VaultInfo {
  address: string;
  subscriberPubkey: string | null;
  subscriberCommitment: bigint | null;
  retailer: string;
  tokenMint: string;
  totalDeposited: bigint;
  rate: bigint;
  intervalSlots: bigint;
  startSlot: bigint;
  claimedPeriods: bigint;
  isActive: boolean;
  isPaused: boolean;
  pauseSlot: bigint | null;
  totalPausedSlots: bigint;
  sourcePool: string | null;
  isNormalMode: boolean;
  isPrivateMode: boolean;
  /**
   * v1 stealth meta address `[spending_pub(32) | viewing_pub(32)]` if the
   * vault was created with refund-via-relayer enabled. Legacy V4 vaults that
   * predate the field decode as `null` (trailing-zero padding → Option tag 0).
   */
  clientStealthMeta: Uint8Array | null;
}

export interface SubscribeNormalConfig {
  retailer: PublicKey;
  tokenMint: PublicKey;
  amount: bigint;
  rate: bigint;
  intervalSlots: bigint;
}

export interface SubscribePrivateConfig {
  retailer: PublicKey;
  rate: bigint;
  intervalSlots: bigint;
}

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

// ---------------------------------------------------------------------------
// PDA Derivation
// ---------------------------------------------------------------------------

export function deriveVaultPDA(
  retailer: PublicKey,
  subscriberId: PublicKey | Uint8Array,
  tokenMint: PublicKey
): [PublicKey, number] {
  const subscriberIdBytes = subscriberId instanceof PublicKey
    ? subscriberId.toBytes()
    : subscriberId;

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('subscription_vault'),
      retailer.toBuffer(),
      Buffer.from(subscriberIdBytes),
      tokenMint.toBuffer(),
    ],
    ZK_SHIELDED_PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Instruction Builders
// ---------------------------------------------------------------------------

function getDiscriminator(name: string): Buffer {
  const hash = sha256(utf8ToBytes(`global:${name}`));
  return Buffer.from(hash.slice(0, 8));
}

/**
 * Build subscribe_normal instruction.
 * Creates a wallet-authenticated subscription vault.
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
  tokenProgram?: PublicKey,
  subscriberTokenAccount?: PublicKey,
  vaultTokenAccount?: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('subscribe_normal');

  // On-chain arg order (subscribe_normal.rs:57-64):
  //   rate | interval_slots | amount | token_mint(Pubkey/32) | vk_hash_subscriber([u8;32])
  // token_mint is an ARGUMENT (native SOL ⇒ SystemProgram.programId), NOT an
  // account. The previous builder serialized amount|rate|interval (wrong order),
  // omitted token_mint entirely, and passed token_mint as a phantom account —
  // every subscribe_normal tx failed before reaching the handler.
  const data = Buffer.alloc(8 + 8 + 8 + 8 + 32 + 32);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  data.writeBigUInt64LE(rate, offset); offset += 8;
  data.writeBigUInt64LE(intervalSlots, offset); offset += 8;
  data.writeBigUInt64LE(amount, offset); offset += 8;
  tokenMint.toBuffer().copy(data, offset); offset += 32;
  Buffer.from(vkHashSubscriber).copy(data, offset);

  // Account order == SubscribeNormal struct field order (subscribe_normal.rs:19-40).
  // No token_mint account. Optional token accounts (token_program,
  // subscriber_token_account, vault_token_account) use the executing program ID
  // as Anchor 0.32's `None` sentinel — same pattern as subscribe_private_stark.
  const keys = [
    { pubkey: subscriber, isSigner: true, isWritable: true },
    { pubkey: retailer, isSigner: false, isWritable: false },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: tokenProgram || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: subscriberTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!subscriberTokenAccount },
    { pubkey: vaultTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!vaultTokenAccount },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build claim_period instruction.
 * Allows the retailer to claim accumulated subscription payments.
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
 * Build pause_normal instruction.
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

// ---------------------------------------------------------------------------
// Wallet Signer Helper
// ---------------------------------------------------------------------------

async function signAndSend(
  connection: Connection,
  tx: Transaction,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
): Promise<string> {
  if (keypair) {
    return await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: 'confirmed',
    });
  }
  if (walletSigner) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = walletSigner.publicKey;
    const signed = await walletSigner.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return sig;
  }
  throw new Error('No wallet available for signing');
}

// ---------------------------------------------------------------------------
// Public Functions
// ---------------------------------------------------------------------------

/**
 * Create a normal (wallet-authenticated) subscription.
 */
export async function subscribeNormal(
  config: SubscribeNormalConfig,
  vkHashSubscriber: Uint8Array,
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
): Promise<string> {
  payLog('classic-recurring-p2b', 'subscribeNormal-start', {
    retailer: config.retailer.toBase58(),
    tokenMint: config.tokenMint.toBase58(),
    amount: String(config.amount),
    rate: String(config.rate),
    intervalSlots: String(config.intervalSlots),
  });

  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  onProgress?.('Deriving vault PDA...');
  const [vaultPDA] = deriveVaultPDA(config.retailer, walletPubkey, config.tokenMint);

  onProgress?.('Building transaction...');

  const isNativeSOL = config.tokenMint.equals(NATIVE_SOL_MINT);
  let tokenProgram: PublicKey | undefined;
  let subscriberTokenAccount: PublicKey | undefined;

  if (!isNativeSOL) {
    tokenProgram = TOKEN_PROGRAM_ID;
    subscriberTokenAccount = await getAssociatedTokenAddress(config.tokenMint, walletPubkey);
  }

  const ix = buildSubscribeNormalIx(
    walletPubkey,
    config.retailer,
    config.tokenMint,
    vaultPDA,
    config.amount,
    config.rate,
    config.intervalSlots,
    vkHashSubscriber,
    tokenProgram,
    subscriberTokenAccount,
  );

  onProgress?.('Sending transaction...');
  const tx = new Transaction();
  tx.add(...buildComputeBudgetIxs(300_000));
  tx.add(ix);
  let sig: string;
  try {
    sig = await signAndSend(connection, tx, keypair, walletSigner);
  } catch (err: any) {
    inspectPayError('classic-recurring-p2b', err?.message ?? String(err), 'subscribeNormal');
    throw err;
  }

  onProgress?.('Done!');
  markPayComplete('classic-recurring-p2b', { signature: sig, vault: vaultPDA.toBase58() });
  return sig;
}

/**
 * Retailer claims accumulated subscription payments.
 */
export async function claimPeriod(
  vaultPDA: PublicKey,
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
): Promise<string> {
  payLog('vault-claim', 'claimPeriod-start', { vault: vaultPDA.toBase58() });

  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  onProgress?.('Building transaction...');
  const ix = buildClaimPeriodIx(walletPubkey, vaultPDA);

  onProgress?.('Sending transaction...');
  const tx = new Transaction().add(ix);
  let sig: string;
  try {
    sig = await signAndSend(connection, tx, keypair, walletSigner);
  } catch (err: any) {
    inspectPayError('vault-claim', err?.message ?? String(err), 'claimPeriod');
    throw err;
  }

  onProgress?.('Done!');
  markPayComplete('vault-claim', { signature: sig, vault: vaultPDA.toBase58() });
  return sig;
}

/**
 * Pause a normal subscription.
 */
export async function pauseNormal(
  vaultPDA: PublicKey,
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
): Promise<string> {
  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  onProgress?.('Building transaction...');
  const ix = buildPauseNormalIx(walletPubkey, vaultPDA);

  onProgress?.('Sending transaction...');
  const tx = new Transaction().add(ix);
  const sig = await signAndSend(connection, tx, keypair, walletSigner);

  onProgress?.('Done!');
  return sig;
}

/**
 * Resume a normal subscription.
 */
export async function resumeNormal(
  vaultPDA: PublicKey,
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
): Promise<string> {
  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  onProgress?.('Building transaction...');
  const ix = buildResumeNormalIx(walletPubkey, vaultPDA);

  onProgress?.('Sending transaction...');
  const tx = new Transaction().add(ix);
  const sig = await signAndSend(connection, tx, keypair, walletSigner);

  onProgress?.('Done!');
  return sig;
}

/**
 * Cancel a normal subscription (refunds subscriber).
 */
export async function cancelNormal(
  vaultPDA: PublicKey,
  retailer: PublicKey,
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
): Promise<string> {
  payLog('vault-cancel', 'cancelNormal-start', {
    vault: vaultPDA.toBase58(),
    retailer: retailer.toBase58(),
    flavor: 'classic',
  });

  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  onProgress?.('Building transaction...');
  const ix = buildCancelNormalIx(walletPubkey, vaultPDA, retailer);

  onProgress?.('Sending transaction...');
  const tx = new Transaction().add(ix);
  let sig: string;
  try {
    sig = await signAndSend(connection, tx, keypair, walletSigner);
  } catch (err: any) {
    inspectPayError('vault-cancel', err?.message ?? String(err), 'cancelNormal');
    throw err;
  }

  onProgress?.('Done!');
  markPayComplete('vault-cancel', { signature: sig, vault: vaultPDA.toBase58(), flavor: 'classic' });
  return sig;
}

// ---------------------------------------------------------------------------
// STARK Variants (quantum-resistant)
// ---------------------------------------------------------------------------

/**
 * Create a private (ZK-authenticated) subscription from a denominated pool note
 * using STARK proof verification (quantum-resistant).
 *
 * Flow:
 *   1. Generate pool_commitment STARK proof on-device
 *   2. Submit + verify STARK proof on-chain (buffer stays open)
 *   3. Call subscribe_private_stark which reads the verified proof buffer
 *   4. Close proof buffer and recover rent
 */
export async function subscribePrivateStark(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  vaultConfig: SubscribePrivateConfig,
  subscriberOwnershipCommitment: bigint,
  vkHashSubscriber: Uint8Array,
  starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  clientStealthMeta?: Uint8Array,
): Promise<string> {
  payLog('zk-recurring', 'subscribePrivateStark-start', {
    retailer: vaultConfig.retailer.toBase58(),
    rate: String(vaultConfig.rate),
    intervalSlots: String(vaultConfig.intervalSlots),
    pool: poolConfig.poolPDA.toBase58(),
    leafIndex: receipt.leafIndex,
    receiptHasMerkleRoot: receipt.merkleRoot !== undefined,
  });

  const {
    submitAndVerifyStarkProof,
    closeStarkProofBuffer,
    CIRCUIT_POOL_COMMITMENT,
  } = await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  onProgress?.('Encoding subscriber commitment...');
  const subscriberCommitmentBytes = goldilocksU64To32(subscriberOwnershipCommitment);

  onProgress?.('Deriving vault PDA...');
  const [vaultPDA] = deriveVaultPDA(
    vaultConfig.retailer,
    subscriberCommitmentBytes,
    poolConfig.tokenMint
  );

  onProgress?.('Preparing unshield proof...');
  const slot = await connection.getSlot('confirmed');
  const currentEpoch = BigInt(Math.floor(slot / 7200));

  if (!receipt.merklePathElements || !receipt.merklePathIndices || !receipt.merkleRoot) {
    throw new Error('Receipt missing Merkle proof data');
  }

  // subscribe_private_stark on-chain reads the nullifier as a Goldilocks u64
  // in bytes[0..8] and hashes it together with stark_commitment to match the
  // STARK verifier's stored inputs hash. Using a Groth16/BN254 Poseidon
  // nullifier here (all 32 bytes non-zero) would always fail that hash check
  // with InvalidProof. The proof's public_inputs[0] IS the Goldilocks u64
  // nullifier — take it directly.
  const goldilocksNullifier = starkProofData.publicInputs[0] ?? 0n;
  const nullifierBytes = Array.from(goldilocksU64To32(goldilocksNullifier));
  const merkleRootBytes = bigintToLeBytes32(receipt.merkleRoot);
  // min_epoch must satisfy: current_epoch >= min_epoch + dynamic_delay (where
  // dynamic_delay scales with pool activity, often 0..N). Setting min_epoch
  // to the note's deposit epoch lets the on-chain check evaluate as
  // "current_epoch ≥ depositEpoch + dynamic_delay" — i.e. the note has aged
  // at least `dynamic_delay` epochs since it was shielded. The previous
  // (currentEpoch - 1n) only works if dynamic_delay ≤ 1, which fails on
  // active pools and surfaces as EpochDelayNotMet (6023 / 0x1787).
  const minEpoch = receipt.depositEpoch;

  // Step 1: Submit + verify STARK proof on-chain (buffer stays open)
  onProgress?.('Submitting STARK proof on-chain...');
  const { proofBuffer } = await submitAndVerifyStarkProof(
    {
      proofBytes: starkProofData.proofBytes,
      circuitId: CIRCUIT_POOL_COMMITMENT,
      publicInputs: starkProofData.publicInputs,
      proofSize: starkProofData.proofSize,
    },
    walletSigner,
    onProgress,
    connection,
  );

  // Step 2: Build + send subscribe_private_stark instruction
  onProgress?.('Building subscription transaction...');
  const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);

  const starkCommitment = starkProofData.publicInputs[1] ?? 0n;

  if (clientStealthMeta && clientStealthMeta.length !== 64) {
    throw new Error(
      `subscribePrivateStark: clientStealthMeta must be 64 bytes, got ${clientStealthMeta.length}`,
    );
  }

  const ix = buildSubscribePrivateStarkIx(
    walletPubkey,
    vaultConfig.retailer,
    vaultPDA,
    poolConfig.poolPDA,
    poolConfig.treePDA,
    nullifierPDA,
    proofBuffer,
    Array.from(nullifierBytes),
    merkleRootBytes,
    minEpoch,
    Array.from(subscriberCommitmentBytes),
    vaultConfig.rate,
    vaultConfig.intervalSlots,
    vkHashSubscriber,
    starkCommitment,
    clientStealthMeta,
  );

  onProgress?.('Sending subscription transaction...');
  const tx = new Transaction();
  tx.add(...buildComputeBudgetIxs(300_000));
  tx.add(ix);
  let sig: string;
  try {
    // Route through p01_relayer (when `relayerV3Enabled`) so the on-chain
    // tx fee payer is a relayer pubkey, NOT the subscriber's wallet. This
    // closes the leak documented at the May-9 audit: the wallet pubkey
    // appearing as Account #0 / fee payer of the subscribe tx — which let
    // any chain-scanner correlate "wallet X created sub Y at time T".
    // Falls back to direct on relayer error unless strict-mode is on.
    const { signAndSendV3 } = await import('../denominatedPool');
    sig = await signAndSendV3(connection, tx, keypair, walletSigner);
  } catch (err: any) {
    inspectPayError('zk-recurring', err?.message ?? String(err), 'subscribePrivateStark');
    throw err;
  }

  // Step 3: Close proof buffer (recover rent)
  onProgress?.('Closing proof buffer...');
  await closeStarkProofBuffer(proofBuffer, walletSigner, connection);

  onProgress?.('Done!');
  markPayComplete('zk-recurring', {
    signature: sig,
    vault: vaultPDA.toBase58(),
    pool: poolConfig.poolPDA.toBase58(),
  });
  return sig;
}

/**
 * Pause a private subscription using STARK proof (quantum-resistant).
 *
 * Flow:
 *   1. Generate subscriber_ownership STARK proof on-device
 *   2. Submit + verify STARK proof on-chain (buffer stays open)
 *   3. Call pause_private_stark which reads the verified proof buffer
 *   4. Close proof buffer and recover rent
 */
export async function pausePrivateStark(
  vaultPDA: PublicKey,
  starkProofData: { proofBytes: Uint8Array; commitment: bigint; proofSize: number },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
): Promise<string> {
  const {
    submitAndVerifyStarkProof,
    closeStarkProofBuffer,
    CIRCUIT_SUBSCRIBER_OWNERSHIP,
  } = await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  // Step 1: Submit + verify STARK proof on-chain (buffer stays open)
  onProgress?.('Submitting STARK proof on-chain...');
  const { proofBuffer } = await submitAndVerifyStarkProof(
    {
      proofBytes: starkProofData.proofBytes,
      circuitId: CIRCUIT_SUBSCRIBER_OWNERSHIP,
      publicInputs: [starkProofData.commitment],
      proofSize: starkProofData.proofSize,
    },
    walletSigner,
    onProgress,
    connection,
  );

  // Step 2: Build + send pause_private_stark instruction
  onProgress?.('Building pause transaction...');
  const ix = buildPausePrivateStarkIx(walletPubkey, vaultPDA, proofBuffer);

  onProgress?.('Sending pause transaction...');
  const tx = new Transaction().add(ix);
  const sig = await signAndSend(connection, tx, keypair, walletSigner);

  // Step 3: Close proof buffer (recover rent)
  onProgress?.('Closing proof buffer...');
  await closeStarkProofBuffer(proofBuffer, walletSigner, connection);

  onProgress?.('Done!');
  return sig;
}

/**
 * Resume a private subscription using STARK proof (quantum-resistant).
 *
 * Flow:
 *   1. Generate subscriber_ownership STARK proof on-device
 *   2. Submit + verify STARK proof on-chain (buffer stays open)
 *   3. Call resume_private_stark which reads the verified proof buffer
 *   4. Close proof buffer and recover rent
 */
export async function resumePrivateStark(
  vaultPDA: PublicKey,
  starkProofData: { proofBytes: Uint8Array; commitment: bigint; proofSize: number },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
): Promise<string> {
  const {
    submitAndVerifyStarkProof,
    closeStarkProofBuffer,
    CIRCUIT_SUBSCRIBER_OWNERSHIP,
  } = await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const walletPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const connection = getConnection();

  // Step 1: Submit + verify STARK proof on-chain (buffer stays open)
  onProgress?.('Submitting STARK proof on-chain...');
  const { proofBuffer } = await submitAndVerifyStarkProof(
    {
      proofBytes: starkProofData.proofBytes,
      circuitId: CIRCUIT_SUBSCRIBER_OWNERSHIP,
      publicInputs: [starkProofData.commitment],
      proofSize: starkProofData.proofSize,
    },
    walletSigner,
    onProgress,
    connection,
  );

  // Step 2: Build + send resume_private_stark instruction
  onProgress?.('Building resume transaction...');
  const ix = buildResumePrivateStarkIx(walletPubkey, vaultPDA, proofBuffer);

  onProgress?.('Sending resume transaction...');
  const tx = new Transaction().add(ix);
  const sig = await signAndSend(connection, tx, keypair, walletSigner);

  // Step 3: Close proof buffer (recover rent)
  onProgress?.('Closing proof buffer...');
  await closeStarkProofBuffer(proofBuffer, walletSigner, connection);

  onProgress?.('Done!');
  return sig;
}

// ---------------------------------------------------------------------------
// STARK Instruction Builders
// ---------------------------------------------------------------------------

/**
 * Build subscribe_private_stark instruction.
 * The on-chain program reads the pre-verified STARK proof buffer (circuit 1: pool_commitment)
 * instead of verifying a Groth16 proof inline.
 */
function buildSubscribePrivateStarkIx(
  payer: PublicKey,
  retailer: PublicKey,
  vaultPDA: PublicKey,
  poolPDA: PublicKey,
  treePDA: PublicKey,
  nullifierPDA: PublicKey,
  starkProofBuffer: PublicKey,
  nullifierBytes: number[],
  merkleRootBytes: number[],
  minEpoch: bigint,
  subscriberCommitmentBytes: number[],
  rate: bigint,
  intervalSlots: bigint,
  vkHashSubscriber: Uint8Array,
  starkCommitment: bigint,
  clientStealthMeta?: Uint8Array,
): TransactionInstruction {
  const disc = getDiscriminator('subscribe_private_stark');

  // Args: nullifier: [u8;32], merkle_root: [u8;32], min_epoch: u64,
  //       subscriber_commitment: [u8;32], rate: u64, interval_slots: u64,
  //       vk_hash_subscriber: [u8;32], stark_commitment: u64,
  //       client_stealth_meta: Option<[u8;64]> (1-byte tag + 64 bytes if Some)
  const hasMeta = !!clientStealthMeta && clientStealthMeta.length === 64;
  const optionSize = 1 + (hasMeta ? 64 : 0);
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 32 + 8 + 8 + 32 + 8 + optionSize);
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

  // Borsh Option<[u8;64]>: tag (0=None, 1=Some) followed by 64 bytes if Some.
  // Refund-via-relayer: when set, cancel routes residual through p01_relayer
  // RefundJob instead of legacy reshield. Persisted on-chain in
  // `vault.client_stealth_meta`.
  if (hasMeta) {
    data.writeUInt8(1, offset); offset += 1;
    Buffer.from(clientStealthMeta!).copy(data, offset); offset += 64;
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
    // stark_proof_buffer is `#[account(mut)]` in subscribe_private_stark
    // (the handler invalidates it post-use by setting verified=false).
    // Pass writable=true to match — otherwise Anchor throws ConstraintMut
    // (2000 / 0x7d0).
    { pubkey: starkProofBuffer, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // Optional accounts for SPL-token pools (token_program, pool_vault,
    // vault_token_account). Anchor 0.32 requires placeholder accounts even
    // when None — pass the executing program ID as the sentinel that Anchor
    // interprets as `None`. Without these, the ix fails with
    // AccountNotEnoughKeys (3005 / 0xbbd) before reaching the handler.
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build pause_private_stark instruction.
 * The on-chain program reads the pre-verified STARK proof buffer (circuit 0: subscriber_ownership).
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
    // pause_private_stark.rs:73 declares `#[account(mut)] stark_proof_buffer`
    // because the handler invalidates the buffer (verified=false) post-use.
    // Passing isWritable: false → Anchor 2000 ConstraintMut (0x7d0).
    { pubkey: starkProofBuffer, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build resume_private_stark instruction.
 * The on-chain program reads the pre-verified STARK proof buffer (circuit 0: subscriber_ownership).
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
    // resume_private_stark also declares stark_proof_buffer as `mut` (handler
    // invalidates the buffer post-use). See pause builder above for context.
    { pubkey: starkProofBuffer, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build cancel_private_stark instruction.
 * The on-chain program reads the pre-verified STARK proof buffer (circuit 0: subscriber_ownership),
 * re-shields `notes_to_reshield = refundable / denomination` outputs into the source pool,
 * pays `claimable_periods * rate` to the retailer, and closes the vault to the payer.
 */
/**
 * Build `cancel_private_stark` instruction. Supports two paths:
 *
 * - **Legacy reshield** (`refundJobPDA === undefined`): caller supplies
 *   `newCommitments` + `newRoots` for the on-chain reshield into the source
 *   denominated pool. `denominatedPoolPDA` and `merkleTreePDA` are required.
 * - **Refund-via-relayer** (`refundJobPDA !== undefined`): on-chain handler
 *   CPI's `p01_relayer::submit_refund_job` to create the RefundJob PDA and
 *   transfers the residual lamports into it. `newCommitments`/`newRoots` must
 *   be empty; `merkleTreePDA` is still REQUIRED (used as `target_tree` for
 *   the keeper). Only `denominatedPoolPDA` may be omitted on this path.
 *
 * Account list (final, per Agent A):
 *   `payer (signer mut), retailer (ro), vault (mut),
 *    denominated_pool? (mut), merkle_tree (mut), stark_proof_buffer (mut),
 *    refund_job? (mut), p01_relayer_program? (ro), system_program (ro),
 *    token_program? (ro), vault_token_account? (mut),
 *    pool_vault? (mut), retailer_token_account? (mut)`
 *
 * Args stay `(new_commitments: Vec<[u8;32]>, new_roots: Vec<[u8;32]>)` —
 * empty Vecs on the refund path.
 */
function buildCancelPrivateStarkIx(
  payer: PublicKey,
  retailer: PublicKey,
  vaultPDA: PublicKey,
  denominatedPoolPDA: PublicKey | undefined,
  merkleTreePDA: PublicKey,
  starkProofBuffer: PublicKey,
  newCommitments: number[][],
  newRoots: number[][],
  refundJobPDA?: PublicKey,
): TransactionInstruction {
  const disc = getDiscriminator('cancel_private_stark');

  // Args: new_commitments: Vec<[u8;32]>, new_roots: Vec<[u8;32]>
  const n = newCommitments.length;
  if (newRoots.length !== n) {
    throw new Error('new_commitments and new_roots must have the same length');
  }
  const useRefundJob = !!refundJobPDA;
  if (useRefundJob && n > 0) {
    throw new Error(
      'cancel_private_stark refund-via-relayer path expects empty new_commitments/new_roots',
    );
  }
  const data = Buffer.alloc(8 + 4 + n * 32 + 4 + n * 32);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  data.writeUInt32LE(n, offset); offset += 4;
  for (const c of newCommitments) {
    Buffer.from(c).copy(data, offset); offset += 32;
  }
  data.writeUInt32LE(n, offset); offset += 4;
  for (const r of newRoots) {
    Buffer.from(r).copy(data, offset); offset += 32;
  }

  // Anchor 0.32 needs placeholder accounts even when None. Use the executing
  // program ID as the sentinel that the handler interprets as `None` for the
  // optional pool/SPL-token accounts on the refund-via-relayer path. Same
  // convention used for SPL-token optional accounts in subscribe/pause/resume.
  const poolKey = denominatedPoolPDA ?? ZK_SHIELDED_PROGRAM_ID;
  const refundJobKey = refundJobPDA ?? ZK_SHIELDED_PROGRAM_ID;
  const relayerProgKey = useRefundJob ? P01_RELAYER_PROGRAM_ID : ZK_SHIELDED_PROGRAM_ID;

  // Order matches Agent A's final contract. Even on the refund path
  // `merkle_tree` is required (CPI argument target_tree for the keeper).
  // Optional accounts use ZK_SHIELDED_PROGRAM_ID as Anchor's None sentinel.
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: retailer, isSigner: false, isWritable: true },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    // denominated_pool — optional on refund path, required on legacy path.
    { pubkey: poolKey, isSigner: false, isWritable: !!denominatedPoolPDA },
    // merkle_tree — REQUIRED for both paths (target_tree on refund path).
    { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: true },
    // refund_job / p01_relayer_program — optional on legacy path. Anchor
    // requires placeholder accounts even when None, so we always pass them.
    { pubkey: refundJobKey, isSigner: false, isWritable: useRefundJob },
    { pubkey: relayerProgKey, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // SPL-token optional tail — none of the mobile paths use SPL today
    // (SOL-only vaults). Always pass the program-ID sentinel so AccountNotEnoughKeys
    // can't surface if future handler revisions read these slots.
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // vault_token_account
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // pool_vault
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // retailer_token_account
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Cancel a private (ZK-authenticated) subscription using STARK proof (quantum-resistant).
 *
 * Flow:
 *   1. Generate subscriber_ownership STARK proof (circuit 0) on-device
 *   2. Submit + verify STARK proof on-chain (buffer stays open)
 *   3. Call cancel_private_stark which:
 *        - pays claimable periods to the retailer
 *        - re-shields the remaining refundable balance as `new_commitments` into
 *          the source denominated pool (dust below one denomination is forfeited)
 *        - closes the vault to the payer
 *   4. Close proof buffer and recover rent
 *
 * SOL-only. SPL support requires additional token accounts (not wired).
 */
export async function cancelPrivateStark(
  vaultPDA: PublicKey,
  retailer: PublicKey,
  sourcePool: { poolPDA: PublicKey; treePDA: PublicKey },
  newCommitmentBytes: Uint8Array[],
  newRootBytes: Uint8Array[],
  starkProofData: { proofBytes: Uint8Array; commitment: bigint; proofSize: number },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  /**
   * When set, routes the residual through `p01_relayer::submit_refund_job`
   * instead of the legacy reshield path. Caller must have already verified
   * that `vault.client_stealth_meta != null` and `residual >= REFUND_MIN_RESIDUAL`.
   * `newCommitmentBytes` / `newRootBytes` should be empty in this case.
   *
   * **NOTE:** `sourcePool.treePDA` is REQUIRED on both paths — even on the
   * refund path it is forwarded to the CPI as `target_tree` for the keeper.
   * Only `denominatedPoolPDA` is optional on the refund path.
   */
  useRefundJob?: boolean,
): Promise<string> {
  payLog('vault-cancel', 'cancelPrivateStark-start', {
    vault: vaultPDA.toBase58(),
    retailer: retailer.toBase58(),
    pool: sourcePool.poolPDA.toBase58(),
    reShieldCount: newCommitmentBytes.length,
    flavor: useRefundJob ? 'zk-refund-job' : 'zk',
  });

  const {
    submitAndVerifyStarkProof,
    closeStarkProofBuffer,
    CIRCUIT_SUBSCRIBER_OWNERSHIP,
  } = await import('../stark');

  onProgress?.('Reading wallet...');
  const keypair = walletSigner ? null : await getKeypair();
  if (!keypair && !walletSigner) throw new Error('Wallet not found');

  const connection = getConnection();

  // Step 1: Submit + verify STARK proof on-chain (buffer stays open)
  onProgress?.('Submitting STARK proof on-chain...');
  const { proofBuffer } = await submitAndVerifyStarkProof(
    {
      proofBytes: starkProofData.proofBytes,
      circuitId: CIRCUIT_SUBSCRIBER_OWNERSHIP,
      publicInputs: [starkProofData.commitment],
      proofSize: starkProofData.proofSize,
    },
    walletSigner,
    onProgress,
    connection,
  );

  // Step 2: Build + send cancel_private_stark instruction
  onProgress?.('Building cancel transaction...');
  const payerPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  const commitmentArrays = newCommitmentBytes.map(b => Array.from(b));
  const rootArrays = newRootBytes.map(b => Array.from(b));

  // Refund-via-relayer path: derive refund_job PDA from the source vault.
  // Legacy reshield path: refund_job is undefined and denominated_pool is required.
  // merkle_tree is always required (target_tree on refund path).
  const refundJobPDA = useRefundJob ? deriveRefundJobPDA(vaultPDA)[0] : undefined;

  const ix = buildCancelPrivateStarkIx(
    payerPubkey,
    retailer,
    vaultPDA,
    useRefundJob ? undefined : sourcePool.poolPDA,
    sourcePool.treePDA,
    proofBuffer,
    commitmentArrays,
    rootArrays,
    refundJobPDA,
  );

  onProgress?.('Sending cancel transaction...');
  const tx = new Transaction();
  tx.add(...buildComputeBudgetIxs(400_000));
  tx.add(ix);
  let sig: string;
  try {
    sig = await signAndSend(connection, tx, keypair, walletSigner);
  } catch (err: any) {
    inspectPayError('vault-cancel', err?.message ?? String(err), 'cancelPrivateStark');
    throw err;
  }

  // Step 3: Close proof buffer (recover rent)
  onProgress?.('Closing proof buffer...');
  await closeStarkProofBuffer(proofBuffer, walletSigner, connection);

  onProgress?.('Done!');
  markPayComplete('vault-cancel', {
    signature: sig,
    vault: vaultPDA.toBase58(),
    flavor: useRefundJob ? 'zk-refund-job' : 'zk',
  });
  return sig;
}

/**
 * Fetch a vault account from on-chain.
 */
export async function fetchVault(vaultPDA: PublicKey): Promise<VaultInfo | null> {
  const connection = getConnection();
  const account = await connection.getAccountInfo(vaultPDA);
  if (!account) return null;

  const data = account.data;
  let offset = 8; // skip discriminator

  // Option<Pubkey> subscriber_pubkey — Borsh: 1-byte tag, then 32 bytes only if Some
  const hasSubscriberPubkey = data[offset] === 1; offset += 1;
  let subscriberPubkey: string | null = null;
  if (hasSubscriberPubkey) {
    subscriberPubkey = new PublicKey(data.slice(offset, offset + 32)).toBase58();
    offset += 32;
  }

  // Option<[u8;32]> subscriber_commitment — Borsh: 1-byte tag, then 32 bytes only if Some
  const hasCommitment = data[offset] === 1; offset += 1;
  let subscriberCommitment: bigint | null = null;
  if (hasCommitment) {
    let val = 0n;
    for (let b = 31; b >= 0; b--) {
      val = (val << 8n) | BigInt(data[offset + b]);
    }
    subscriberCommitment = val;
    offset += 32;
  }

  // Pubkey retailer
  const retailer = new PublicKey(data.slice(offset, offset + 32)).toBase58(); offset += 32;

  // Pubkey token_mint
  const tokenMint = new PublicKey(data.slice(offset, offset + 32)).toBase58(); offset += 32;

  // u64 total_deposited
  const totalDeposited = data.readBigUInt64LE(offset); offset += 8;

  // u64 rate
  const rate = data.readBigUInt64LE(offset); offset += 8;

  // u64 interval_slots
  const intervalSlots = data.readBigUInt64LE(offset); offset += 8;

  // i64 start_slot
  const startSlot = data.readBigInt64LE(offset); offset += 8;

  // u64 claimed_periods
  const claimedPeriods = data.readBigUInt64LE(offset); offset += 8;

  // bool is_active
  const isActive = data[offset] === 1; offset += 1;

  // bool is_paused
  const isPaused = data[offset] === 1; offset += 1;

  // Option<i64> pause_slot — Borsh: 1-byte tag, then 8 bytes only if Some
  const hasPauseSlot = data[offset] === 1; offset += 1;
  let pauseSlot: bigint | null = null;
  if (hasPauseSlot) {
    pauseSlot = data.readBigInt64LE(offset);
    offset += 8;
  }

  // i64 total_paused_slots
  const totalPausedSlots = data.readBigInt64LE(offset); offset += 8;

  // [u8;32] vk_hash_subscriber (skip)
  offset += 32;

  // Option<Pubkey> source_pool — Borsh: 1-byte tag, then 32 bytes only if Some
  const hasSourcePool = data[offset] === 1; offset += 1;
  let sourcePool: string | null = null;
  if (hasSourcePool) {
    sourcePool = new PublicKey(data.slice(offset, offset + 32)).toBase58();
    offset += 32;
  }

  // u8 bump
  // Some old V4 vaults may stop here (account length = 263 bytes), with the
  // `client_stealth_meta` Option field appended later by the program upgrade.
  // Guard against truncated reads below.
  if (offset < data.length) {
    offset += 1; // skip bump
  }

  // Option<[u8;64]> client_stealth_meta — Borsh: 1-byte tag, then 64 bytes only if Some
  // Legacy V4 vaults (account size 263 bytes) end right after bump and have no
  // tag byte → decode as None. New vaults (account size 373 bytes) include the
  // full Option. Trailing zero padding on old vaults also decodes as None.
  let clientStealthMeta: Uint8Array | null = null;
  if (offset + 1 <= data.length) {
    const tag = data[offset];
    offset += 1;
    if (tag === 1 && offset + 64 <= data.length) {
      clientStealthMeta = new Uint8Array(data.slice(offset, offset + 64));
      offset += 64;
    }
  }

  return {
    address: vaultPDA.toBase58(),
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
    clientStealthMeta,
  };
}

/**
 * Compute claimable periods for a vault.
 */
export function computeClaimable(vault: VaultInfo, currentSlot: number): number {
  if (!vault.isActive || vault.isPaused) return 0;

  const effectiveElapsed = BigInt(currentSlot) - vault.startSlot - vault.totalPausedSlots;
  if (effectiveElapsed <= 0n) return 0;

  const totalPeriods = effectiveElapsed / vault.intervalSlots;
  return Number(totalPeriods > vault.claimedPeriods ? totalPeriods - vault.claimedPeriods : 0n);
}

/**
 * Compute claimable amount in lamports/atomic units.
 */
export function computeClaimableAmount(vault: VaultInfo, currentSlot: number): bigint {
  const periods = BigInt(computeClaimable(vault, currentSlot));
  const amount = periods * vault.rate;

  const totalOwed = vault.claimedPeriods * vault.rate;
  const available = vault.totalDeposited - totalOwed;
  return amount < available ? amount : available;
}

/**
 * Breakdown of what a cancel will produce, computed client-side so the UI
 * can show the user what they're about to do before they sign.
 *
 * The math mirrors the on-chain handler in
 * `programs/zk_shielded/src/instructions/cancel_private_stark.rs`:
 *   retailer_amount  = (claimed + claimable) * rate − already_paid
 *   refundable       = total_deposited − (claimed + claimable) * rate
 *   notes_to_reshield = floor(refundable / denomination)
 *   dust              = refundable − notes_to_reshield * denomination
 *
 * `dustAmount` is the residual below one full denomination — currently
 * returned to the payer in clear when the vault PDA is closed. A follow-up
 * routes it to a self-stealth address for privacy.
 */
export interface CancelPreview {
  /** Periods accrued but not yet claimed by the retailer. */
  claimablePeriods: bigint;
  /** Atomic units owed to the retailer on cancel. */
  claimableAmount: bigint;
  /** Total atomic units the retailer has been / will be paid. */
  totalConsumed: bigint;
  /** Atomic units available to refund after paying the retailer. */
  refundable: bigint;
  /** How many full-denomination notes we can re-shield. */
  notesToReshield: bigint;
  /** Atomic units below one denomination — routed to stealth. */
  dustAmount: bigint;
}

export function computeCancelPreview(
  vault: VaultInfo,
  currentSlot: number,
  denominationAtomic: bigint,
): CancelPreview {
  const claimablePeriods = BigInt(computeClaimable(vault, currentSlot));
  const claimableAmount = claimablePeriods * vault.rate;
  const totalConsumed = (vault.claimedPeriods + claimablePeriods) * vault.rate;
  const refundable = vault.totalDeposited > totalConsumed
    ? vault.totalDeposited - totalConsumed
    : 0n;
  const notesToReshield = denominationAtomic > 0n
    ? refundable / denominationAtomic
    : 0n;
  const dustAmount = refundable - notesToReshield * denominationAtomic;

  return {
    claimablePeriods,
    claimableAmount,
    totalConsumed,
    refundable,
    notesToReshield,
    dustAmount,
  };
}
