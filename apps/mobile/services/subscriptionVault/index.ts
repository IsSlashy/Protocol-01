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
 * field expected by the vault. The on-chain pause/resume handlers read
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

/*
 * REMOVED, and they were EXPORTS: P01_RELAYER_PROGRAM_ID, REFUND_MIN_RESIDUAL,
 * REFUND_KEEPER_FEE, deriveRefundJobPDA.
 *
 * All four existed only to drive the refund-via-relayer leg of
 * `cancel_private_stark`: the keeper fee and the minimum residual decided
 * whether a refund was worth paying for, and the PDA addressed the RefundJob it
 * created. That instruction is gone, so a vault has no inbound leg at all and
 * nothing here has a caller. p01_relayer keeps its own copies of the constants.
 */

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
   * vault was created with the (now removed) refund-via-relayer path enabled.
   * DEPRECATED AND UNUSED: it addressed the subscriber for a refund, and there
   * is no refund. Kept because the on-chain field is kept — the vault layout is
   * byte-identical so the 16 live devnet vaults stay decodable. Legacy V4 vaults
   * that predate the field decode as `null` (trailing-zero padding → tag 0).
   */
  clientStealthMeta: Uint8Array | null;
}

// SubscribeNormalConfig is gone with the subscribe_normal instruction: a vault
// keyed on the subscriber's wallet made "wallet W pays merchant M" readable by
// anyone who could derive a PDA. Subscribing is private-only now.

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
 * Build claim_period instruction.
 *
 * PERMISSIONLESS since the no-cancel lot: `retailer` is NOT a signer any more.
 * The on-chain account struct pins it to `vault.retailer` with a `==`
 * constraint and the vault PDA is the only authority over the funds, so the
 * sender of the transaction cannot change where the money goes — only when it
 * moves, and they pay the fee. Passing `isSigner: true` here would make the
 * runtime demand a signature the program no longer asks for, which fails for
 * exactly the merchants this change exists to rescue: the ones whose retailer
 * key is gone.
 *
 * `retailer` MUST be read off the vault, never assumed to be the local wallet.
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
 * Push a subscription vault's accrued payment to its retailer.
 *
 * PERMISSIONLESS: the local wallet is only the fee payer. It used to be passed
 * as the retailer account AND as the signer, so this function silently only
 * worked when you happened to be the merchant. The retailer is now read off
 * the vault, which is also the only address the program will pay.
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

  const connection = getConnection();

  onProgress?.('Reading vault...');
  const vault = await fetchVault(vaultPDA);
  if (!vault) throw new Error('Subscription vault not found on chain');

  onProgress?.('Building transaction...');
  const ix = buildClaimPeriodIx(new PublicKey(vault.retailer), vaultPDA);

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

/*
 * REMOVED: cancelNormal. `cancel_normal` no longer exists in zk_shielded, and
 * with it the only instruction that paid a subscriber back.
 */

// ---------------------------------------------------------------------------
// STARK Variants (quantum-resistant)
// ---------------------------------------------------------------------------

/**
 * Create a private (ZK-authenticated) subscription from a denominated pool note
 * using STARK proof verification (quantum-resistant).
 *
 * Flow (mirrors unshield_denominated_stark_v3 — TWO proof buffers):
 *   1. Submit + verify C1 (pool_commitment) STARK proof → c1ProofBuffer
 *   2. Submit + verify C3 (merkle_path) STARK proof      → c3ProofBuffer
 *   3. Call subscribe_private_stark referencing BOTH verified buffers
 *   4. Close BOTH proof buffers and recover rent (handler does not touch them)
 *
 * The C3 (merkle_path) proof is a hardening requirement added on-chain: without
 * it a quantum/forging attacker could synthesize a valid C1 proof for a
 * never-deposited commitment and drain `denomination` per call. The handler
 * reconstructs `sha256(stark_commitment_u64_le || merkle_root[..8] || depth=15_u64_le)`
 * and compares it to the C3 buffer's stored public_inputs hash, so the
 * `merkle_root` passed to the ix MUST be the root the C3 proof targeted —
 * we therefore derive it from `c3ProofData.publicInputs[1]` (the Goldilocks
 * root the prover witnessed), NOT from the possibly-stale receipt.
 */
export async function subscribePrivateStark(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  vaultConfig: SubscribePrivateConfig,
  subscriberOwnershipCommitment: bigint,
  vkHashSubscriber: Uint8Array,
  starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  c3ProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
  onProgress?: (step: string) => void,
  walletSigner?: WalletSigner,
  /**
   * 32-byte `license_commitment = blake3(licenseSecret)`, posted on-chain as
   * the LAST subscribe arg (now #9, previously #10). Stored verbatim — no
   * on-chain verification. Enables off-chain license-key verification by a
   * merchant (no shared secret).
   */
  licenseCommitment?: Uint8Array,
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
    CIRCUIT_MERKLE_PATH,
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

  // subscribe_private_stark on-chain reads the nullifier as a Goldilocks u64
  // in bytes[0..8] and hashes it together with stark_commitment to match the
  // STARK verifier's stored inputs hash. Using a Groth16/BN254 Poseidon
  // nullifier here (all 32 bytes non-zero) would always fail that hash check
  // with InvalidProof. The proof's public_inputs[0] IS the Goldilocks u64
  // nullifier — take it directly.
  const goldilocksNullifier = starkProofData.publicInputs[0] ?? 0n;
  const nullifierBytes = Array.from(goldilocksU64To32(goldilocksNullifier));

  // Derive the merkle_root from the C3 proof's public inputs (layout
  // [leaf_u64, root_u64, depth] per stark/src/air/merkle_path.rs). This is
  // the canonical source — the handler reconstructs the C3 expected hash from
  // `merkle_root[..8]`, so the bytes we ship MUST equal `root_u64.to_le_bytes()`.
  // `goldilocksU64To32` (and bigintToLeBytes32 on a u64-masked value) both put
  // the u64 LE into bytes[0..8], so `merkleRootBytes[..8] == root_u64 LE`.
  // Falling back to receipt.merkleRoot only if the proof omitted it (shouldn't).
  const merkleRootGl = c3ProofData.publicInputs[1] ?? receipt.merkleRoot ?? 0n;
  const merkleRootBytes = bigintToLeBytes32(merkleRootGl & 0xFFFFFFFFFFFFFFFFn);
  // min_epoch must satisfy: current_epoch >= min_epoch + dynamic_delay (where
  // dynamic_delay scales with pool activity, often 0..N). Setting min_epoch
  // to the note's deposit epoch lets the on-chain check evaluate as
  // "current_epoch ≥ depositEpoch + dynamic_delay" — i.e. the note has aged
  // at least `dynamic_delay` epochs since it was shielded. The previous
  // (currentEpoch - 1n) only works if dynamic_delay ≤ 1, which fails on
  // active pools and surfaces as EpochDelayNotMet (6023 / 0x1787).
  const minEpoch = receipt.depositEpoch;

  if (licenseCommitment && licenseCommitment.length !== 32) {
    throw new Error(
      `subscribePrivateStark: licenseCommitment must be 32 bytes, got ${licenseCommitment.length}`,
    );
  }

  // TWO buffers — close both in `finally` regardless of whether the subscribe
  // tx succeeds (rent recovery), mirroring unshield_denominated_stark_v3.
  const createdBuffers: PublicKey[] = [];
  try {
    // Step 1: C1 (pool_commitment) — proves knowledge of secret + nullifier.
    onProgress?.('Submitting C1 (pool_commitment) proof on-chain...');
    const { proofBuffer: c1ProofBuffer } = await submitAndVerifyStarkProof(
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
    createdBuffers.push(c1ProofBuffer);

    // Step 2: C3 (merkle_path) — NEW hardening requirement. Proves the C1
    // commitment is a leaf at `merkle_root`. Distinct PDA from C1 (legacy
    // buffer PDA seeds circuit_id, so id=1 and id=3 never collide).
    onProgress?.('Submitting C3 (merkle_path) proof on-chain...');
    const { proofBuffer: c3ProofBuffer } = await submitAndVerifyStarkProof(
      {
        proofBytes: c3ProofData.proofBytes,
        circuitId: CIRCUIT_MERKLE_PATH,
        publicInputs: c3ProofData.publicInputs,
        proofSize: c3ProofData.proofSize,
      },
      walletSigner,
      onProgress,
      connection,
    );
    createdBuffers.push(c3ProofBuffer);

    // Step 3: Build + send subscribe_private_stark instruction (both buffers).
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
      c1ProofBuffer,
      c3ProofBuffer,
      Array.from(nullifierBytes),
      merkleRootBytes,
      minEpoch,
      Array.from(subscriberCommitmentBytes),
      vaultConfig.rate,
      vaultConfig.intervalSlots,
      vkHashSubscriber,
      starkCommitment,
      licenseCommitment,
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

    onProgress?.('Done!');
    markPayComplete('zk-recurring', {
      signature: sig,
      vault: vaultPDA.toBase58(),
      pool: poolConfig.poolPDA.toBase58(),
    });
    return sig;
  } finally {
    // Step 4: Close BOTH proof buffers (recover rent). The on-chain handler
    // explicitly does NOT write to the buffers ("Caller closes them"), so we
    // always close every buffer we created, success or failure.
    for (const buf of createdBuffers) {
      try {
        onProgress?.('Closing proof buffer...');
        await closeStarkProofBuffer(buf, walletSigner, connection);
      } catch (closeErr: any) {
        console.warn('[SubscriptionVault] closeStarkProofBuffer failed:', closeErr?.message ?? String(closeErr));
      }
    }
  }
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
  licenseCommitment?: Uint8Array,
): TransactionInstruction {
  const disc = getDiscriminator('subscribe_private_stark');

  // Args (in on-chain order): nullifier: [u8;32], merkle_root: [u8;32],
  //   min_epoch: u64, subscriber_commitment: [u8;32], rate: u64,
  //   interval_slots: u64, vk_hash_subscriber: [u8;32], stark_commitment: u64,
  //   license_commitment:  Option<[u8;32]>  (arg #9 / LAST, 1-byte tag + 32 if Some)
  //
  // REMOVED: `client_stealth_meta: Option<[u8;64]>` used to sit between
  // `stark_commitment` and `license_commitment` as arg #9, and its Borsh tag
  // byte was written even when None. The on-chain instruction no longer
  // declares it, so that tag byte must NOT be emitted — an extra byte here and
  // the program's `license_commitment` deserialises from the wrong offset.
  const hasLicense = !!licenseCommitment && licenseCommitment.length === 32;
  const licenseOptionSize = 1 + (hasLicense ? 32 : 0);
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 32 + 8 + 8 + 32 + 8 + licenseOptionSize);
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

  // arg #9 (LAST) — Borsh Option<[u8;32]> license_commitment: tag (0=None,
  // 1=Some) followed by 32 bytes if Some. This is blake3(licenseSecret); the
  // chain stores it verbatim with NO verification. A merchant later checks
  // blake3(decode(presentedKey)) == vault.license_commitment off-chain.
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
    // c1_proof_buffer is read-only here (the handler reads circuit_id=1 /
    // verified / deep_ali / inputs_hash but never writes — the subscribe
    // handler ends with "Caller closes them", so no on-chain invalidation).
    { pubkey: c1ProofBuffer, isSigner: false, isWritable: false },
    // c3_proof_buffer (merkle_path, circuit 3) — NEW hardening requirement.
    // Goes IMMEDIATELY AFTER c1_proof_buffer to match the on-chain
    // SubscribePrivateStark accounts struct order. Read-only for the same
    // reason as c1 above. Without it the ix fails with AccountNotEnoughKeys
    // (3005 / 0xbbd) before reaching the handler; with a bad C3 hash it
    // reverts InvalidProof.
    { pubkey: c3ProofBuffer, isSigner: false, isWritable: false },
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

/*
 * REMOVED: buildCancelPrivateStarkIx and cancelPrivateStark.
 *
 * They built `cancel_private_stark`, generated the circuit-0 STARK ownership
 * proof for it and drove BOTH refund routes: the legacy re-shield of the
 * residual into the source denominated pool, and the refund-via-relayer path
 * that CPI'd p01_relayer::submit_refund_job so a keeper could pay the residual
 * to the subscriber's stealth address.
 *
 * The instruction no longer exists on chain. A subscription is a one-way
 * prepaid envelope: money that enters a vault can only ever leave it toward the
 * retailer, and `claim_period` closes the vault on the final claim. The refund
 * leg was also the ONLY inbound operation in the system, so deleting it removes
 * the hard half of the privacy surface as well.
 *
 * The circuit-0 proof is NOT dead — pausePrivateStark / resumePrivateStark
 * still generate and consume it.
 */

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

// ---------------------------------------------------------------------------
// Period math
//
// Local port of `packages/merchant-sdk/src/period-math.ts`. React Native cannot
// import the SDK, so the copy lives here and `entitlement.test.ts` runs the
// shared `ENTITLEMENT_PARITY_VECTORS` table through both to stop them drifting.
// ---------------------------------------------------------------------------

function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

/**
 * Total periods the subscriber paid for at subscribe time — the only thing
 * that bounds entitlement.
 *
 * NOT `isActive`: the program writes it `true` at
 * `subscribe_private_stark.rs:395` -- the only instruction left that creates a
 * vault -- and `false` NOWHERE, so an exhausted vault
 * reports `true` for ever. Cancellation was REMOVED from the protocol, so the
 * only thing that closes a vault now is `claim_period` on the final claim.
 * Running out of money before that lands is the hole, and nothing on chain
 * marks it.
 */
export function periodsPaidFor(vault: Pick<VaultInfo, 'totalDeposited' | 'rate'>): bigint {
  if (vault.rate === 0n) return 0n;
  return vault.totalDeposited / vault.rate;
}

/** Zero-based index of the period the subscription is in at `currentSlot`. */
export function periodsElapsed(
  vault: Pick<VaultInfo, 'startSlot' | 'totalPausedSlots' | 'intervalSlots'>,
  currentSlot: number,
): bigint {
  if (vault.intervalSlots === 0n) return 0n;
  const effective = BigInt(currentSlot) - vault.startSlot - vault.totalPausedSlots;
  if (effective <= 0n) return 0n;
  return effective / vault.intervalSlots;
}

/**
 * Periods this vault can still PAY for. Zero means the program refuses every
 * further claim. Not an entitlement test: a retailer that neglects to claim
 * leaves this high long after the subscriber stopped being current.
 */
export function fundedPeriodsRemaining(
  vault: Pick<VaultInfo, 'totalDeposited' | 'rate' | 'claimedPeriods'>,
): bigint {
  if (vault.rate === 0n) return 0n;
  return satSub(vault.totalDeposited / vault.rate, vault.claimedPeriods);
}

/** Whether the subscription entitles its holder to service RIGHT NOW. */
export function subscriptionIsCurrent(vault: VaultInfo, currentSlot: number): boolean {
  if (!vault.isActive || vault.isPaused) return false;
  if (vault.intervalSlots === 0n) return false;
  return periodsElapsed(vault, currentSlot) < periodsPaidFor(vault);
}

/**
 * First slot at which {@link subscriptionIsCurrent} turns false, or `null` when
 * the vault never entitles anyone.
 */
export function subscriptionEndSlot(vault: VaultInfo): bigint | null {
  if (!vault.isActive || vault.isPaused) return null;
  if (vault.intervalSlots === 0n) return null;
  const paid = periodsPaidFor(vault);
  if (paid === 0n) return null;
  return vault.startSlot + vault.totalPausedSlots + paid * vault.intervalSlots;
}

/**
 * What a screen is allowed to say about a vault, given the slot it last polled.
 *
 * Both vault screens hold `currentSlot` in local state starting at `null` and
 * fetch it in an effect, so the first paint happens with no clock at all — and
 * at slot 0 the period arithmetic reads "period 0 of N" for every
 * subscription. Saying "Active" off that is the same failure as saying it off
 * `isActive`, so it gets its own answer.
 */
export type EntitlementStatus = 'inactive' | 'paused' | 'unknown' | 'current' | 'ended';

export function entitlementStatus(vault: VaultInfo, currentSlot: number): EntitlementStatus {
  if (!vault.isActive) return 'inactive';
  if (vault.isPaused) return 'paused';
  if (currentSlot <= 0) return 'unknown';
  if (BigInt(currentSlot) < vault.startSlot) return 'unknown';
  return subscriptionIsCurrent(vault, currentSlot) ? 'current' : 'ended';
}

/**
 * Compute claimable periods for a vault.
 *
 * Faithful port of `SubscriptionVault::claimable_periods`
 * (`programs/zk_shielded/src/state/subscription_vault.rs:133`), INCLUDING the
 * `max_funded` clamp that was missing. Without it this returned the raw
 * elapsed-period count, and the since-removed `computeCancelPreview` turned
 * that into an under-reported refund on the cancel sheet: a 350,000-lamport
 * deposit at 100,000 per period, read five periods after start, showed 0
 * refundable where the program returned 50,000. Refunds no longer exist, so that
 * consequence is historical; the clamp is still load-bearing for
 * `computeClaimableAmount` and `computeSubscriptionOutlook`.
 * `intervalSlots === 0` also divided by zero, which
 * in bigint arithmetic THROWS rather than returning Infinity.
 */
export function computeClaimable(vault: VaultInfo, currentSlot: number): number {
  if (!vault.isActive || vault.isPaused) return 0;
  if (vault.intervalSlots === 0n) return 0;

  const effectiveElapsed = BigInt(currentSlot) - vault.startSlot - vault.totalPausedSlots;
  if (effectiveElapsed <= 0n) return 0;

  const totalPeriods = effectiveElapsed / vault.intervalSlots;
  const unclaimed = satSub(totalPeriods, vault.claimedPeriods);
  const maxFunded = fundedPeriodsRemaining(vault);
  return Number(unclaimed < maxFunded ? unclaimed : maxFunded);
}

/**
 * Compute claimable amount in lamports/atomic units.
 */
export function computeClaimableAmount(vault: VaultInfo, currentSlot: number): bigint {
  const periods = BigInt(computeClaimable(vault, currentSlot));
  const amount = periods * vault.rate;

  // Mirrors the program's own `actual_amount = claim_amount.min(vault_balance)`
  // (`claim_period.rs:65`).
  const totalOwed = vault.claimedPeriods * vault.rate;
  const available = satSub(vault.totalDeposited, totalOwed);
  return amount < available ? amount : available;
}

/**
 * What is left to happen on a subscription vault, computed client-side so the
 * UI can show the subscriber where their money stands.
 *
 * REPLACES `CancelPreview` / `computeCancelPreview`, which quoted the refund a
 * cancellation would have produced (`refundable`, `notesToReshield`,
 * `dustAmount` — the re-shield leg of the deleted `cancel_private_stark`).
 * There is no cancellation and no refund: a vault is a one-way prepaid envelope
 * and `outstandingToRetailer` is money the RETAILER will receive, never money
 * the subscriber can get back.
 *
 * Invariant, at every slot and for every vault shape:
 *   alreadyPaidToRetailer + outstandingToRetailer === vault.totalDeposited
 */
export interface SubscriptionOutlook {
  /** Periods accrued but not yet claimed by the retailer. */
  claimablePeriods: bigint;
  /** Atomic units the retailer can sweep right now. */
  claimableAmount: bigint;
  /** Atomic units the retailer has already swept. */
  alreadyPaidToRetailer: bigint;
  /**
   * Atomic units the retailer is still owed and will eventually receive,
   * including the sub-period remainder that never bought a whole period.
   * NOT refundable to the subscriber under any circumstance.
   */
  outstandingToRetailer: bigint;
}

export function computeSubscriptionOutlook(
  vault: VaultInfo,
  currentSlot: number,
): SubscriptionOutlook {
  const claimablePeriods = BigInt(computeClaimable(vault, currentSlot));
  const claimableAmount = claimablePeriods * vault.rate;
  const claimed = vault.claimedPeriods * vault.rate;
  const alreadyPaidToRetailer = claimed < vault.totalDeposited ? claimed : vault.totalDeposited;
  const outstandingToRetailer = vault.totalDeposited - alreadyPaidToRetailer;

  return {
    claimablePeriods,
    claimableAmount,
    alreadyPaidToRetailer,
    outstandingToRetailer,
  };
}
