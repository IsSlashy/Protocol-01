/**
 * shieldEphemeral — shield into the denominated pool without asking the user's
 * wallet to sign ~150 times.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `shield_denominated_v3` binds the C6 proof buffer to the depositor
 * (`shield_denominated_v3.rs:80`: `proof_buffer.authority == depositor`), and a
 * C6 merkle-update proof is ~140 KB, uploaded in 1000-byte chunks. So the
 * depositor signs ~150 transactions. In the extension/mobile that is free (the
 * signer is a local keypair); with Phantom on /pay it would be ~150 approval
 * popups.
 *
 * So we reuse the pattern `transferDenominatedStarkV3` already ships (and that
 * is device-proven): a deterministic **ephemeral E** is the proof-buffer
 * authority AND the depositor. The user's wallet signs exactly ONE transaction —
 * the pre-fund — and E signs everything else locally. E's residual is swept back
 * afterwards.
 *
 * WHAT THIS DOES AND DOES NOT BUY
 * ───────────────────────────────
 * The pre-fund tx is a public `user → E` transfer, so the funding link is NOT
 * hidden yet; this is amount privacy + funding↔claim unlinkability inside the
 * pool, not sender anonymity. Breaking the user→E link is Step 2 (relayer).
 * Do not describe this as sender anonymity anywhere in the UI.
 *
 * FUND SAFETY
 * ───────────
 *  - The C6 proof is generated BEFORE any lamport moves, so a proving failure
 *    costs nothing.
 *  - A recovery breadcrumb is written BEFORE the pre-fund, and E is derived
 *    deterministically (`deriveEphemeralForRelay`), so a crash mid-flight leaves
 *    funds sweepable rather than stranded.
 *  - The residual sweep runs in `finally`, on the success and failure paths
 *    alike.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

import {
  parseFilledSubtrees,
  prepareShieldInsert,
  shieldV3,
  type PoolConfig,
  type ShieldReceipt,
  type WalletSigner,
} from './denominatedPool';
import {
  addPendingRelay,
  markPendingRelayErrored,
  removePendingRelay,
} from './relayEphemeralRecovery';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// ---------------------------------------------------------------------------
// Ephemeral derivation
// ---------------------------------------------------------------------------

const SHIELD_EPHEMERAL_INFO = utf8ToBytes('p01:web:shield-ephemeral:v1');

/**
 * Derive the shield ephemeral E deterministically from the pool seed, the pool,
 * and the note counter — the SAME inputs the note itself derives from.
 *
 * Deliberately NOT `deriveEphemeralForRelay`: that keys off a random per-install
 * session seed which, inside a Worker, has no localStorage and falls back to an
 * in-memory map (`relayEphemeralRecovery.ts`). A page reload would lose it and
 * strand anything left on E. Deriving from the wallet seed instead makes E
 * re-derivable from the wallet signature alone, on any device, forever — so a
 * crashed shield can always be swept by re-deriving the same (pool, counter).
 */
export function deriveShieldEphemeral(
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  counter: number,
): Keypair {
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, true);
  const info = concatBytes(SHIELD_EPHEMERAL_INFO, poolPDA.toBytes(), counterBytes);
  return Keypair.fromSeed(hkdf(sha256, walletSeed, undefined, info, 32));
}

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/**
 * Per-transaction fee headroom for everything E signs: ~150 chunk uploads +
 * init + resizes + verify phase 1 + DEEP-ALI phase 2 + the shield itself +
 * buffer close + the sweep. 5000 lamports each, rounded up hard — an
 * underfunded E strands the whole flow mid-upload.
 */
const E_TX_FEE_BUDGET = 3_000_000;

/** Slack for the fee-escrow PDA the shield handler touches, plus rent drift. */
const SHIELD_RENT_MARGIN = 2_000_000;

/** Left on E so the sweep transaction can pay its own fee. */
const SWEEP_FEE = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Everything phase 2 needs, held in the worker between the two phases. */
export interface PreparedShield {
  jobId: string;
  poolConfig: PoolConfig;
  ephemeral: Keypair;
  /** Lamports the user's wallet must move onto E before `executeShield`. */
  requiredLamports: number;
  prepared: Awaited<ReturnType<typeof prepareShieldInsert>>;
}

export interface ShieldResult {
  txSig: string;
  receipt: ShieldReceipt;
}

/**
 * Number of leaves currently in the pool's Merkle tree, straight from the tree
 * account. This is the pool's real note count — and the real anonymity set —
 * regardless of how much transaction history the RPC still serves.
 */
export async function readTreeLeafCount(
  connection: Connection,
  poolConfig: PoolConfig,
): Promise<number> {
  const info = await connection.getAccountInfo(poolConfig.treePDA);
  if (!info) throw new Error(`Tree account not found: ${poolConfig.treePDA.toBase58()}`);
  return parseFilledSubtrees(Buffer.from(info.data)).leafCount;
}

// ---------------------------------------------------------------------------
// Phase 1 — prove (no funds move)
// ---------------------------------------------------------------------------

/**
 * Read the tree, derive the note, prove C6, and price the pre-fund. Nothing is
 * signed or submitted here: if this throws, no lamports have moved.
 *
 * `walletSeed` is the caller's pool seed — the note secrets derive from it, so
 * the note belongs to the user even though the on-chain depositor is E.
 */
export async function prepareShield(
  poolConfig: PoolConfig,
  connection: Connection,
  walletSeed: Uint8Array,
  onProgress?: (step: string) => void,
): Promise<PreparedShield> {
  if (poolConfig.token !== 'SOL') {
    // USDC needs the SPL leg funded onto E's ATA as well; not wired yet, and a
    // half-wired token path would strand tokens on E.
    throw new Error('Only SOL denominations can be shielded from /pay today.');
  }

  // The note counter is the leaf index this shield will occupy.
  //
  // It CANNOT come from scanning past notes: a note's insert event lives in
  // transaction history, and public devnet RPC prunes that (the 0.1 SOL pool
  // reports 27 leaves in its tree account but retains 1 signature). A scan
  // would miss existing notes and hand back a counter already in use — and
  // since the nullifier is poseidon(np, secret) with no epoch input, that
  // collision would strand the older note permanently.
  //
  // The tree account's leaf count is authoritative and never pruned, and leaf
  // indices are unique by construction, so deriving from it makes a collision
  // structurally impossible without depending on history at all.
  onProgress?.('Reading the pool tree...');
  const counter = await readTreeLeafCount(connection, poolConfig);

  const prepared = await prepareShieldInsert(poolConfig, connection, walletSeed, counter, onProgress);

  // prepareShieldInsert re-reads the tree; if another shield landed in between,
  // our note secrets would be keyed to a leaf index this insert no longer
  // occupies — which is exactly the collision the derivation is meant to
  // exclude. Refuse rather than shield into an ambiguous slot.
  if (prepared.insertParams.leafIndex !== counter) {
    throw new Error(
      `The pool advanced while preparing (leaf ${counter} → ${prepared.insertParams.leafIndex}). ` +
        'Nothing was spent — try again.',
    );
  }

  // Price the pre-fund from the ACTUAL proof size (83-byte header + proof), the
  // same way the transfer path does — no hard-coded worst case.
  onProgress?.('Pricing the shield...');
  const bufferRent = await connection.getMinimumBalanceForRentExemption(
    83 + prepared.c6ProofResult.proofSize,
  );
  const requiredLamports =
    Number(poolConfig.denominationAtomic) + bufferRent + E_TX_FEE_BUDGET + SHIELD_RENT_MARGIN;

  // Deterministic in (seed, pool, counter) — see deriveShieldEphemeral. The
  // job id is just a stable label for the breadcrumb, derived from the same
  // inputs so a recovery pass can match it without any stored state.
  const ephemeral = deriveShieldEphemeral(walletSeed, poolConfig.poolPDA, counter);
  const jobId = `shield:${poolConfig.poolPDA.toBase58()}:${counter}`;

  return { jobId, poolConfig, ephemeral, requiredLamports, prepared };
}

// ---------------------------------------------------------------------------
// Phase 2 — spend (E signs everything)
// ---------------------------------------------------------------------------

/**
 * Run the shield with E as depositor. The caller must already have funded E
 * with `requiredLamports` (one user signature) and confirmed that transfer.
 *
 * `ownerPubkey` receives E's residual — recovered proof-buffer rent plus unused
 * fee budget.
 */
export async function executeShield(
  ctx: PreparedShield,
  connection: Connection,
  ownerPubkey: PublicKey,
  onProgress?: (step: string) => void,
): Promise<ShieldResult> {
  const { ephemeral, jobId, poolConfig, prepared } = ctx;

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

  // Refuse to start if the pre-fund did not actually land — otherwise we burn
  // through half the chunk uploads and strand the rest.
  const funded = await connection.getBalance(ephemeral.publicKey, 'confirmed');
  if (funded < ctx.requiredLamports) {
    throw new Error(
      `The shield signer is underfunded (${funded} of ${ctx.requiredLamports} lamports). ` +
        'The pre-fund transaction may not have confirmed yet — retry in a moment.',
    );
  }

  try {
    const { txSig, receipt } = await shieldV3(
      poolConfig,
      prepared.c6ProofResult,
      prepared.insertParams,
      eSigner,
      connection,
      onProgress,
    );
    return { txSig, receipt };
  } finally {
    // Sweep E's residual back whether the shield landed or threw. `shieldV3`
    // already closes its own C6 buffer in a finally, so by here the rent is
    // back on E.
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
      await removePendingRelay(jobId);
    } catch (sweepErr: unknown) {
      const msg = sweepErr instanceof Error ? sweepErr.message : String(sweepErr);
      console.warn('[pool/shield] ephemeral sweep failed; funds recoverable via breadcrumb:', msg);
      try {
        await markPendingRelayErrored(jobId, 'shield sweep failed: ' + msg);
      } catch {
        /* breadcrumb store unavailable — nothing further we can do here */
      }
    }
  }
}

/**
 * Write the recovery breadcrumb for a prepared shield. MUST be called before
 * the pre-fund transaction is submitted, so a crash between funding and
 * `executeShield` still leaves E re-derivable and sweepable.
 */
export async function recordShieldBreadcrumb(ctx: PreparedShield): Promise<void> {
  await addPendingRelay({
    jobId: ctx.jobId,
    ephemeralPubkey: ctx.ephemeral.publicKey.toBase58(),
    expectedLamports: ctx.requiredLamports,
    createdAt: new Date().toISOString(),
    reason: 'shield-ephemeral-depositor',
  });
}
