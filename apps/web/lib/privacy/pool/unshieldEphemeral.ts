/**
 * unshieldEphemeral — withdraw a note from the denominated pool without asking
 * the user's wallet to sign the proof uploads.
 *
 * Same shape as `shieldEphemeral.ts`, and for the same reason: an unshield
 * uploads TWO STARK proofs (C1 pool_commitment + C3 merkle_path), each in
 * 1000-byte chunks, and every one of those transactions is signed by the proof
 * buffer's authority. A deterministic ephemeral signs them; the user's wallet
 * signs only the pre-fund.
 *
 * A DIFFERENT ephemeral from the shield's
 * ─────────────────────────────────────────
 * The shield ephemeral is the on-chain depositor. If the same key also
 * performed the withdrawal, deposit and withdrawal would carry an identical
 * signer and the pool would hide nothing at all — the one property this step
 * exists to provide. The derivation is domain-separated so the two can never
 * coincide.
 *
 * WHAT THIS DOES NOT HIDE — read before writing any copy about it
 * ────────────────────────────────────────────────────────────────
 * The V3 withdrawal instruction takes the note commitment as a PUBLIC argument
 * (`buildUnshieldDenominatedStarkV3Ix` writes `starkCommitment` at instruction
 * byte offset 80), and the deposit emitted that identical value in its
 * `LeafInserted` event. So an observer with only public data matches a
 * withdrawal to its exact deposit. Verified on devnet 2026-07-25: unshield
 * `2FhzBLHc…` carries 1126946528953530644, the commitment the shield logged for
 * leaf 28.
 *
 * The effective anonymity set is therefore ONE, regardless of how many notes
 * the pool holds. The domain separation below removes the signer correlation,
 * which is necessary but nowhere near sufficient; it does nothing about the
 * commitment argument. Fixing this needs a program change so membership is
 * proven without revealing which leaf — the C3 proof already proves membership,
 * so publishing the leaf defeats the point of proving it.
 *
 * Until that lands, this path buys amount quantisation and a post-quantum note,
 * NOT unlinkability. Do not describe it as unlinkable anywhere.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { prepareUnshieldFromPath, type StoredMerklePath } from './unshieldFromPath';
import {
  isNullifierSpent,
  prepareUnshield,
  unshieldDenominatedStarkV3,
  type PoolConfig,
  type PrepareUnshieldResult,
  type ShieldReceipt,
  type WalletSigner,
} from './denominatedPool';

/** Domain separator — deliberately NOT the shield's. See file header. */
const UNSHIELD_EPHEMERAL_INFO = utf8ToBytes('p01:web:unshield-ephemeral:v1');

/** NullifierRecord init (~0.0009 SOL) plus margin. */
const NULLIFIER_RENT = 2_000_000;

/** Fee headroom for ~2 proofs' worth of chunk uploads plus the inner tx. */
const E_TX_FEE_BUDGET = 4_000_000;

/** See shieldEphemeral.ts — leaves enough for a later buffer close. */
const SWEEP_FEE = 25_000;

/**
 * Derive the withdrawal ephemeral from the pool seed and the note's leaf index.
 * Deterministic, so a crashed unshield can be swept by re-deriving it.
 */
export function deriveUnshieldEphemeral(
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  leafIndex: number,
): Keypair {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, leafIndex, true);
  const info = concatBytes(UNSHIELD_EPHEMERAL_INFO, poolPDA.toBytes(), idx);
  return Keypair.fromSeed(hkdf(sha256, walletSeed, undefined, info, 32));
}

export interface PreparedUnshield {
  jobId: string;
  poolConfig: PoolConfig;
  receipt: ShieldReceipt;
  ephemeral: Keypair;
  requiredLamports: number;
  prepared: PrepareUnshieldResult;
}

/**
 * Rebuild the Merkle proof, prove C1 + C3, and price the pre-fund. Nothing is
 * signed or submitted, so a failure here costs nothing.
 *
 * `prepareUnshield` runs its own pre-flight: it refuses to proceed unless the
 * rebuilt root is in the pool's current-or-historical root ring, which is what
 * stops us burning proof rent on a guaranteed rejection.
 */
export async function prepareUnshieldJob(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  walletSeed: Uint8Array,
  onProgress?: (step: string) => void,
  storedPath?: StoredMerklePath,
): Promise<PreparedUnshield> {
  // Fail fast and free if this note is already spent — otherwise the on-chain
  // NullifierRecord init would reject after the whole upload.
  onProgress?.('Checking the note is unspent...');
  const spent = await isNullifierSpent(
    connection,
    poolConfig.poolPDA,
    receipt.nullifierPreimage,
    receipt.secret,
  );
  if (spent) {
    throw new Error('This note has already been withdrawn.');
  }

  // Prefer the path captured when this note was shielded: it needs no
  // transaction history, which an RPC may no longer serve. Returns null if its
  // root has aged out of the pool's 100-root ring, in which case we rebuild
  // from history as before.
  let prepared = storedPath
    ? await prepareUnshieldFromPath(receipt, poolConfig, connection, storedPath, onProgress)
    : null;
  if (storedPath && !prepared) {
    onProgress?.('Stored Merkle root has aged out — rebuilding from history...');
  }
  if (!prepared) {
    prepared = await prepareUnshield(receipt, poolConfig, connection, onProgress);
  }

  onProgress?.('Pricing the withdrawal...');
  const [r1, r3] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(83 + prepared.c1ProofResult.proofSize),
    connection.getMinimumBalanceForRentExemption(83 + prepared.c3ProofResult.proofSize),
  ]);
  // C1 and C3 buffers are held open at the same time — the handler reads both
  // in one transaction — so the peak float is their sum.
  const requiredLamports = r1 + r3 + NULLIFIER_RENT + E_TX_FEE_BUDGET;

  const ephemeral = deriveUnshieldEphemeral(walletSeed, poolConfig.poolPDA, receipt.leafIndex);

  return {
    jobId: `unshield:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}`,
    poolConfig,
    receipt,
    ephemeral,
    requiredLamports,
    prepared,
  };
}

/**
 * Upload both proofs and withdraw to `recipient`. The caller must already have
 * funded the ephemeral with `requiredLamports`.
 *
 * `ownerPubkey` receives the ephemeral's residual once the buffers close.
 */
export async function executeUnshield(
  ctx: PreparedUnshield,
  connection: Connection,
  recipient: PublicKey,
  ownerPubkey: PublicKey,
  onProgress?: (step: string) => void,
): Promise<{ txSig: string }> {
  const { ephemeral, poolConfig, prepared, receipt } = ctx;

  const eSigner: WalletSigner = {
    publicKey: ephemeral.publicKey,
    signTransaction: async (t: Transaction) => {
      if (!t.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        t.recentBlockhash = blockhash;
      }
      if (!t.feePayer) t.feePayer = ephemeral.publicKey;
      t.sign(ephemeral);
      return t;
    },
  };

  const funded = await connection.getBalance(ephemeral.publicKey, 'confirmed');
  if (funded < ctx.requiredLamports) {
    throw new Error(
      `The withdrawal signer is underfunded (${funded} of ${ctx.requiredLamports} lamports). ` +
        'The pre-fund transaction may not have confirmed yet — retry in a moment.',
    );
  }

  try {
    const txSig = await unshieldDenominatedStarkV3(
      receipt,
      poolConfig,
      recipient,
      prepared,
      eSigner,
      connection,
      onProgress,
    );
    return { txSig };
  } finally {
    try {
      const eBal = await connection.getBalance(ephemeral.publicKey, 'confirmed');
      const sweepable = eBal - SWEEP_FEE;
      if (sweepable > 0) {
        onProgress?.('Returning recovered rent to your wallet...');
        const sweepTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: ephemeral.publicKey,
            toPubkey: ownerPubkey,
            lamports: sweepable,
          }),
        );
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        sweepTx.recentBlockhash = blockhash;
        sweepTx.feePayer = ephemeral.publicKey;
        sweepTx.sign(ephemeral);
        const sig = await connection.sendRawTransaction(sweepTx.serialize());
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      }
    } catch (sweepErr: unknown) {
      console.warn(
        '[pool/unshield] ephemeral sweep failed; the key is re-derivable, funds recoverable:',
        sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
      );
    }
  }
}
