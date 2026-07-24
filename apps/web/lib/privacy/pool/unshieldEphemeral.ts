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
 * What is still linkable
 * ──────────────────────
 * The user's wallet funds the ephemeral, and (unless told otherwise) receives
 * the withdrawn funds. An observer watching that wallet sees money go toward a
 * pool deposit and later come back. What the pool breaks is WHICH deposit
 * corresponds to which withdrawal, among the notes in that pool. Breaking the
 * funding link needs the relayer (Step 2). The UI must say so.
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

const SWEEP_FEE = 5_000;

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

  const prepared = await prepareUnshield(receipt, poolConfig, connection, onProgress);

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
