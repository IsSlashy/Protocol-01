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
): TransactionInstruction {
  const disc = getDiscriminator('subscribe_normal');

  // Args: amount: u64, rate: u64, interval_slots: u64, vk_hash_subscriber: [u8;32]
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
    // Optional accounts
    { pubkey: tokenProgram || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: subscriberTokenAccount || ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: !!subscriberTokenAccount },
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
  const minEpoch = currentEpoch - 1n;

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
  );

  onProgress?.('Sending subscription transaction...');
  const tx = new Transaction();
  tx.add(...buildComputeBudgetIxs(300_000));
  tx.add(ix);
  let sig: string;
  try {
    sig = await signAndSend(connection, tx, keypair, walletSigner);
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
): TransactionInstruction {
  const disc = getDiscriminator('subscribe_private_stark');

  // Args: nullifier: [u8;32], merkle_root: [u8;32], min_epoch: u64,
  //       subscriber_commitment: [u8;32], rate: u64, interval_slots: u64,
  //       vk_hash_subscriber: [u8;32], stark_commitment: u64
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 32 + 8 + 8 + 32 + 8);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(minEpoch, offset); offset += 8;
  Buffer.from(subscriberCommitmentBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(rate, offset); offset += 8;
  data.writeBigUInt64LE(intervalSlots, offset); offset += 8;
  Buffer.from(vkHashSubscriber).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(starkCommitment, offset);

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: retailer, isSigner: false, isWritable: false },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: false },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
    { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
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
    { pubkey: starkProofBuffer, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: ZK_SHIELDED_PROGRAM_ID, keys, data });
}

/**
 * Build cancel_private_stark instruction.
 * The on-chain program reads the pre-verified STARK proof buffer (circuit 0: subscriber_ownership),
 * re-shields `notes_to_reshield = refundable / denomination` outputs into the source pool,
 * pays `claimable_periods * rate` to the retailer, and closes the vault to the payer.
 */
function buildCancelPrivateStarkIx(
  payer: PublicKey,
  retailer: PublicKey,
  vaultPDA: PublicKey,
  denominatedPoolPDA: PublicKey,
  merkleTreePDA: PublicKey,
  starkProofBuffer: PublicKey,
  newCommitments: number[][],
  newRoots: number[][],
): TransactionInstruction {
  const disc = getDiscriminator('cancel_private_stark');

  // Args: new_commitments: Vec<[u8;32]>, new_roots: Vec<[u8;32]>
  const n = newCommitments.length;
  if (newRoots.length !== n) {
    throw new Error('new_commitments and new_roots must have the same length');
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

  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: retailer, isSigner: false, isWritable: true },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: denominatedPoolPDA, isSigner: false, isWritable: true },
    { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
    { pubkey: starkProofBuffer, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
): Promise<string> {
  payLog('vault-cancel', 'cancelPrivateStark-start', {
    vault: vaultPDA.toBase58(),
    retailer: retailer.toBase58(),
    pool: sourcePool.poolPDA.toBase58(),
    reShieldCount: newCommitmentBytes.length,
    flavor: 'zk',
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

  const ix = buildCancelPrivateStarkIx(
    payerPubkey,
    retailer,
    vaultPDA,
    sourcePool.poolPDA,
    sourcePool.treePDA,
    proofBuffer,
    commitmentArrays,
    rootArrays,
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
    flavor: 'zk',
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

  // Option<Pubkey> subscriber_pubkey
  const hasSubscriberPubkey = data[offset] === 1; offset += 1;
  const subscriberPubkey = hasSubscriberPubkey
    ? new PublicKey(data.slice(offset, offset + 32)).toBase58()
    : null;
  offset += 32;

  // Option<[u8;32]> subscriber_commitment
  const hasCommitment = data[offset] === 1; offset += 1;
  let subscriberCommitment: bigint | null = null;
  if (hasCommitment) {
    let val = 0n;
    for (let b = 31; b >= 0; b--) {
      val = (val << 8n) | BigInt(data[offset + b]);
    }
    subscriberCommitment = val;
  }
  offset += 32;

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

  // Option<i64> pause_slot
  const hasPauseSlot = data[offset] === 1; offset += 1;
  const pauseSlot = hasPauseSlot ? data.readBigInt64LE(offset) : null;
  offset += 8;

  // i64 total_paused_slots
  const totalPausedSlots = data.readBigInt64LE(offset); offset += 8;

  // [u8;32] vk_hash_subscriber (skip)
  offset += 32;

  // Option<Pubkey> source_pool
  const hasSourcePool = data[offset] === 1; offset += 1;
  const sourcePool = hasSourcePool
    ? new PublicKey(data.slice(offset, offset + 32)).toBase58()
    : null;

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
