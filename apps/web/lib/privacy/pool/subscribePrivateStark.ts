/**
 * `subscribe_private_stark` for the web client — pay a merchant from a shielded
 * note and walk away with a license key.
 *
 * ## Shape
 *
 * Structurally this is the WITHDRAWAL path, not a lighter one. The instruction
 * requires BOTH proof buffers — C1 (pool_commitment) and C3 (merkle_path) — and
 * checks their circuit ids at `subscribe_private_stark.rs:233` and `:285`. An
 * older comment in the extension calls this "the C3-free path"; that is wrong
 * against the deployed program and reading it cost an hour. The upside is that
 * `prepareUnshieldJob` already produces exactly the pair this needs, so the
 * expensive half of the work is shared.
 *
 * ## The argument layout is the part that fails silently
 *
 * Borsh args, in on-chain order (`lib.rs:267-280`):
 *
 *   nullifier[32] | merkle_root[32] | min_epoch u64 | subscriber_commitment[32]
 *   | rate u64 | interval_slots u64 | vk_hash_subscriber[32]
 *   | stark_commitment u64 | license_commitment Option<[u8;32]>
 *
 * `client_stealth_meta: Option<[u8;64]>` USED to sit between `stark_commitment`
 * and `license_commitment`, and its tag byte was written even when None. The
 * program no longer declares it. Emitting that byte now does not fail — it
 * shifts `license_commitment` by one and the vault stores a corrupt commitment,
 * so the subscriber's key verifies against nothing and nobody finds out until a
 * merchant rejects it. The test beside this file pins every offset for that
 * reason.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { sendWithFreshBlockhash } from './sendTx';
import {
  ZK_SHIELDED_PROGRAM_ID,
  buildComputeBudgetIxs,
  deriveNullifierPDA,
  goldilocksToLeBytes32,
  type PoolConfig,
  type PrepareUnshieldResult,
  type ShieldReceipt,
} from './denominatedPool';

/**
 * Always 0, and this is load-bearing twice over. Do not turn it into a parameter.
 *
 * 🚨 The handler does NOT ignore it, unlike the unshield handler. Measured
 * 2026-08-12: `subscribe_private_stark.rs` computes
 * `effective_min_epoch = min_epoch + pool.get_dynamic_delay()` and then
 * `require!(current_epoch >= effective_min_epoch, EpochDelayNotMet)`. An earlier
 * version of this comment claimed the value was ignored; it was false, and it was
 * harmless only because this constant pins 0 and the dynamic delay is at most 2.
 * `transfer_denominated_stark_v3.rs` enforces it the same way.
 *
 * Two consequences follow, and both matter:
 *
 * 1. Publishing anything else leaks. Since the commitment blinding shipped, the
 *    note's `deposit_epoch` slot carries a 63-bit PRF secret, not an epoch, so
 *    passing `receipt.depositEpoch` here would publish the blinding in the clear
 *    and undo the whole of phase 1.
 * 2. A blinded note could never satisfy the check anyway: with a blinding near
 *    2^63, `current_epoch >= blinding + delay` is unreachable, so the note would
 *    become permanently un-subscribable with `EpochDelayNotMet`. Withdrawal is
 *    the only exit a blinded note has today.
 */
export const SUBSCRIBE_MIN_EPOCH = 0n;

/** Anchor discriminator: sha256("global:<name>")[..8]. */
async function discriminator(name: string): Promise<Buffer> {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { utf8ToBytes } = await import('@noble/hashes/utils.js');
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`)).slice(0, 8));
}

/**
 * Encode a Goldilocks u64 into the 32-byte field the vault stores.
 *
 * Little-endian in the low 8 bytes, zeroes above. The program reads
 * `commitment[..8]` as a u64 and compares it against the circuit-0 proof's
 * inputs hash, and the PDA is seeded on all 32 bytes — so the high 24 MUST be
 * zero or the vault derived here is not the vault the program derives.
 */
export function goldilocksU64To32(commitment: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = commitment & 0xffffffffffffffffn;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** PDA: `[b"subscription_vault", retailer, subscriber_id, token_mint]`. */
export function deriveSubscriptionVaultPDA(
  retailer: PublicKey,
  subscriberIdBytes: Uint8Array,
  tokenMint: PublicKey,
  programId: PublicKey = ZK_SHIELDED_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('subscription_vault'),
      retailer.toBuffer(),
      Buffer.from(subscriberIdBytes),
      tokenMint.toBuffer(),
    ],
    programId,
  );
}

export interface SubscribeIxParams {
  payer: PublicKey;
  retailer: PublicKey;
  vaultPDA: PublicKey;
  poolPDA: PublicKey;
  treePDA: PublicKey;
  nullifierPDA: PublicKey;
  c1ProofBuffer: PublicKey;
  c3ProofBuffer: PublicKey;
  nullifierBytes: Uint8Array;
  merkleRootBytes: Uint8Array;
  subscriberCommitmentBytes: Uint8Array;
  rate: bigint;
  intervalSlots: bigint;
  vkHashSubscriber: Uint8Array;
  starkCommitment: bigint;
  /** C3 public input 1: the depth-12 subtree root the on-chain walk starts from. */
  subtreeRoot: bigint;
  /** Path elements above the circuit, bottom-up. */
  siblings: bigint[];
  /** Direction bits above the circuit, same order. */
  directions: number[];
  /** blake3(licenseSecret). Stored verbatim, never verified on chain. */
  licenseCommitment?: Uint8Array;
  programId?: PublicKey;
}

/** Byte offsets of every argument, exported so the test cannot drift from the code. */
export const SUBSCRIBE_ARG_OFFSETS = {
  discriminator: 0,
  nullifier: 8,
  merkleRoot: 40,
  minEpoch: 72,
  subscriberCommitment: 80,
  rate: 112,
  intervalSlots: 120,
  vkHashSubscriber: 128,
  starkCommitment: 160,
  licenseTag: 168,
  licenseValue: 169,
} as const;

export async function buildSubscribePrivateStarkIx(
  p: SubscribeIxParams,
): Promise<TransactionInstruction> {
  const programId = p.programId ?? ZK_SHIELDED_PROGRAM_ID;
  const disc = await discriminator('subscribe_private_stark');

  const hasLicense = !!p.licenseCommitment && p.licenseCommitment.length === 32;

  // [C3-D12] The walk arguments follow `license_commitment`, matching the Rust
  // parameter order. They are the last three, so the offsets table above is
  // untouched and every existing offset test keeps meaning what it meant.
  //
  // ⛔ NOT OPTIONAL. Since 2026-08-29 the C3 proof attests membership in a
  // depth-12 SUBTREE; the handler walks the remaining levels to reach a pool
  // root. Without them the proof means "this leaf is in SOME tree".
  if (p.siblings.length !== p.directions.length) {
    throw new Error(
      `siblings (${p.siblings.length}) and directions (${p.directions.length}) must ` +
      `have equal length — the on-chain walk refuses a mismatch with WrongSiblingCount.`,
    );
  }
  if (p.directions.some((d) => d !== 0 && d !== 1)) {
    throw new Error('direction bits must be 0 or 1 — NonBinaryDirection on chain.');
  }
  const walkBytes = 8 + (4 + p.siblings.length * 8) + (4 + p.directions.length);
  const data = Buffer.alloc(
    SUBSCRIBE_ARG_OFFSETS.licenseTag + 1 + (hasLicense ? 32 : 0) + walkBytes,
  );

  disc.copy(data, SUBSCRIBE_ARG_OFFSETS.discriminator);
  Buffer.from(p.nullifierBytes).copy(data, SUBSCRIBE_ARG_OFFSETS.nullifier);
  Buffer.from(p.merkleRootBytes).copy(data, SUBSCRIBE_ARG_OFFSETS.merkleRoot);
  data.writeBigUInt64LE(SUBSCRIBE_MIN_EPOCH, SUBSCRIBE_ARG_OFFSETS.minEpoch);
  Buffer.from(p.subscriberCommitmentBytes).copy(data, SUBSCRIBE_ARG_OFFSETS.subscriberCommitment);
  data.writeBigUInt64LE(p.rate, SUBSCRIBE_ARG_OFFSETS.rate);
  data.writeBigUInt64LE(p.intervalSlots, SUBSCRIBE_ARG_OFFSETS.intervalSlots);
  Buffer.from(p.vkHashSubscriber).copy(data, SUBSCRIBE_ARG_OFFSETS.vkHashSubscriber);
  data.writeBigUInt64LE(p.starkCommitment, SUBSCRIBE_ARG_OFFSETS.starkCommitment);
  data.writeUInt8(hasLicense ? 1 : 0, SUBSCRIBE_ARG_OFFSETS.licenseTag);
  if (hasLicense) {
    Buffer.from(p.licenseCommitment!).copy(data, SUBSCRIBE_ARG_OFFSETS.licenseValue);
  }

  let walkOffset = SUBSCRIBE_ARG_OFFSETS.licenseTag + 1 + (hasLicense ? 32 : 0);
  data.writeBigUInt64LE(p.subtreeRoot, walkOffset); walkOffset += 8;
  data.writeUInt32LE(p.siblings.length, walkOffset); walkOffset += 4;
  for (const sib of p.siblings) { data.writeBigUInt64LE(sib, walkOffset); walkOffset += 8; }
  data.writeUInt32LE(p.directions.length, walkOffset); walkOffset += 4;
  for (const dir of p.directions) { data.writeUInt8(dir, walkOffset); walkOffset += 1; }

  // Account order mirrors `SubscribePrivateStark<'info>`. The three trailing
  // Option accounts must be present even for a native-SOL pool — Anchor 0.32
  // rejects a short list with AccountNotEnoughKeys (3005) inside the resolver,
  // before the handler runs, and an absent optional is the program's own id.
  const sentinel = programId;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.retailer, isSigner: false, isWritable: false },
      { pubkey: p.vaultPDA, isSigner: false, isWritable: true },
      { pubkey: p.poolPDA, isSigner: false, isWritable: true },
      { pubkey: p.treePDA, isSigner: false, isWritable: false },
      { pubkey: p.nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: p.c1ProofBuffer, isSigner: false, isWritable: false },
      { pubkey: p.c3ProofBuffer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: sentinel, isSigner: false, isWritable: false }, // token_program
      { pubkey: sentinel, isSigner: false, isWritable: false }, // pool_vault
      { pubkey: sentinel, isSigner: false, isWritable: false }, // vault_token_account
    ],
    data,
  });
}

export interface SubscribeOnChainParams {
  receipt: ShieldReceipt;
  poolConfig: PoolConfig;
  prepared: PrepareUnshieldResult;
  retailer: PublicKey;
  subscriberCommitment: bigint;
  rate: bigint;
  intervalSlots: bigint;
  vkHashSubscriber: Uint8Array;
  licenseCommitment?: Uint8Array;
}

/**
 * Upload C1 + C3 and send the subscribe. `signer` is the ephemeral that was
 * pre-funded; it pays the rent for both proof buffers and the vault.
 *
 * Deliberately mirrors `unshieldDenominatedStarkV3`'s ordering: both buffers are
 * uploaded and verified BEFORE the subscribe is built, so a proof that fails
 * verification costs buffer rent (recoverable) rather than a half-created vault.
 */
export async function subscribePrivateStark(
  params: SubscribeOnChainParams,
  signer: import('./stark').WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<{ txSig: string; vaultPDA: PublicKey }> {
  const { submitAndVerifyStarkProof, closeStarkProofBuffer } = await import('./stark');
  const { CIRCUIT_POOL_COMMITMENT, CIRCUIT_MERKLE_PATH } = await import('./denominatedPool');

  const { prepared, poolConfig } = params;
  const createdBuffers: PublicKey[] = [];

  try {
    onProgress?.('Uploading the ownership proof...');
    const c1 = await submitAndVerifyStarkProof(
      {
        proofBytes: prepared.c1ProofResult.proofBytes,
        circuitId: CIRCUIT_POOL_COMMITMENT,
        publicInputs: prepared.c1ProofResult.publicInputs,
        proofSize: prepared.c1ProofResult.proofSize,
      },
      signer,
      connection,
      onProgress,
    );
    createdBuffers.push(c1.proofBuffer);

    onProgress?.('Uploading the membership proof...');
    const c3 = await submitAndVerifyStarkProof(
      {
        proofBytes: prepared.c3ProofResult.proofBytes,
        circuitId: CIRCUIT_MERKLE_PATH,
        publicInputs: prepared.c3ProofResult.publicInputs,
        proofSize: prepared.c3ProofResult.proofSize,
      },
      signer,
      connection,
      onProgress,
    );
    createdBuffers.push(c3.proofBuffer);

    const nullifierBytes = Uint8Array.from(goldilocksToLeBytes32(prepared.nullifierGoldilocks));
    const merkleRootBytes = Uint8Array.from(goldilocksToLeBytes32(prepared.merkleRoot));
    const subscriberCommitmentBytes = goldilocksU64To32(params.subscriberCommitment);
    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, nullifierBytes);
    const [vaultPDA] = deriveSubscriptionVaultPDA(
      params.retailer,
      subscriberCommitmentBytes,
      poolConfig.tokenMint,
    );

    onProgress?.('Opening the subscription vault...');
    const ix = await buildSubscribePrivateStarkIx({
      payer: signer.publicKey,
      retailer: params.retailer,
      vaultPDA,
      poolPDA: poolConfig.poolPDA,
      treePDA: poolConfig.treePDA,
      nullifierPDA,
      c1ProofBuffer: c1.proofBuffer,
      c3ProofBuffer: c3.proofBuffer,
      nullifierBytes,
      merkleRootBytes,
      subscriberCommitmentBytes,
      rate: params.rate,
      intervalSlots: params.intervalSlots,
      vkHashSubscriber: params.vkHashSubscriber,
      starkCommitment: prepared.starkCommitment,
      licenseCommitment: params.licenseCommitment,
      subtreeRoot: prepared.subtreeRoot,
      siblings: prepared.siblings,
      directions: prepared.directions,
    });

    // ⚠️ This used to send a transaction whose `recentBlockhash` was never set
    // here, relying on the signer's fallback — which fetched a `confirmed` one.
    // Same defect as everywhere else, one level of indirection away.
    // 🚨 THIS PATH HAD NO COMPUTE BUDGET AT ALL, so it ran on Solana's 200,000
    // CU default. That was survivable before; it is not now. The handler walks
    // three Poseidon levels, and one on-chain `hash2` measures ~34,469 CU
    // (litesvm SBF VM, 2026-08-29,
    // `subscribe_v4_adversarial::the_walk_is_what_the_new_instruction_pays_for`),
    // so the walk alone adds ~103,400 on top of two proof-buffer verifications.
    //
    // 400,000 matches what every other v3/v4 path on this surface requests.
    const tx = new Transaction();
    // [ZK-DEPTH-11 2026-08-30] 400,000 -> 500,000. `resolve_pool_root` walks
    // FOUR levels now: ~137,876 CU at the ~34,469 measured per on-chain `hash2`,
    // up from ~103,407. ⚠️ Headroom, not an end-to-end measurement.
    tx.add(...buildComputeBudgetIxs(500_000));
    tx.add(ix);
    const { signature: txSig, blockhash, lastValidBlockHeight } = await sendWithFreshBlockhash(
      connection,
      tx,
      (t) => signer.signTransaction(t),
      signer.publicKey,
    );
    await connection.confirmTransaction(
      { signature: txSig, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    return { txSig, vaultPDA };
  } finally {
    // Buffer rent is only reclaimable by the ephemeral that opened it, so this
    // runs even on failure — the same reason the withdrawal path does it.
    for (const b of createdBuffers) {
      try {
        await closeStarkProofBuffer(b, signer, connection);
      } catch (e) {
        console.warn('[pool/subscribe] buffer close failed, rent recoverable later:', e);
      }
    }
  }
}
