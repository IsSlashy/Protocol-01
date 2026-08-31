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
 * Amount quantisation, and a post-quantum note. That is the whole list today.
 *
 * It does NOT buy unlinkability: the V3 withdrawal instruction publishes the
 * note commitment in cleartext and the deposit emitted that same value, so an
 * observer matches the two from public data alone (see the header of
 * `unshieldEphemeral.ts` for the verified devnet evidence). It does not buy
 * sender anonymity either — the pre-fund is a public `user → E` transfer, and
 * breaking that link is Step 2 (the relayer).
 *
 * FUND SAFETY
 * ───────────
 *  - The C6 proof is generated BEFORE any lamport moves, so a proving failure
 *    costs nothing.
 *  - E is derived deterministically from (pool seed, pool, leaf index), so a
 *    crash mid-flight leaves its float re-derivable — `recoverFloat.ts` closes
 *    any orphaned proof buffer and sweeps it back.
 *  - The residual sweep runs in `finally`, on the success and failure paths
 *    alike, and deliberately leaves a small reserve so a later buffer close can
 *    still be paid for.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { sendWithFreshBlockhash } from './sendTx';

import {
  parseFilledSubtrees,
  prepareShieldInsert,
  prepareInsertForCommitment,
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
import { deriveNoteBlinding } from './noteBlinding';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { jitterPrefund } from './prefundAmount';

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

/**
 * Protocol fee the shield handler charges the DEPOSITOR, on top of the
 * denomination — `shield_denominated_v3.rs:218-220` with
 * `fee::SHIELD_FEE_BPS = 30` (0.3%).
 *
 * It must be funded onto the ephemeral or the final shield transaction fails
 * for insufficient lamports AFTER the whole ~140 KB proof has been uploaded and
 * verified. A 0.1 SOL shield hides this (0.0003 fits inside the margin above);
 * at 10 SOL the fee is 0.03 and the shield cannot land.
 */
const SHIELD_FEE_BPS = 30n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Left behind on E when sweeping: exactly the sweep transaction's own fee, so
 * the account lands on zero.
 *
 * It is tempting to leave more, so that E could later sign a close for a proof
 * buffer that failed to close (the buffer's ~1 SOL of rent can only be released
 * by E, since `CloseProofBuffer` is `close = authority`). That does not work at
 * any small value. E is a 0-data system account, so it must end the transaction
 * either rent-exempt or at exactly zero — the runtime rejects a
 * RentExempt -> RentPaying transition with "insufficient funds for rent". The
 * rule is written down in this repo at
 * `apps/extension/src/shared/services/relay.ts:463-467`. Leaving 20,000
 * lamports therefore did not preserve a recovery path, it made *every* sweep
 * transaction fail, silently, while the worker still reported success.
 *
 * So: drain to zero, matching the proven extension implementation
 * (`apps/extension/src/shared/services/denominatedPool.ts:2181`) and
 * `recoverFloat.ts`. Orphaned buffers are recovered by `recoverFloat.ts`
 * funding the close itself.
 */
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
  /**
   * The part of `requiredLamports` that is the user's own VALUE and never comes
   * back: the denomination plus the 0.3% shield fee. MEASURED on devnet for the
   * 1 SOL pool: 1,003,475,300 of the 1,573,486,080 pre-fund.
   *
   * Carried out of here so the funding decision can REFUSE this leg structurally
   * (`fundEphemeralForJob`) rather than by nobody having thought to ask. A
   * treasury covering a deposit is not lending rent, it is buying the note — and
   * the funder's 2 SOL per-request cap does not catch it, because it refuses
   * only pools of 10 SOL and up.
   */
  valueLamports: number;
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

  // Occupy the commitment's deposit_epoch slot with a secret blinding instead of
  // the real epoch, so the published nullifier no longer reveals the commitment.
  // Derived from the seed, so recovery still needs no stored state.
  const blinding = deriveNoteBlinding(walletSeed, poolConfig.poolPDA, counter);
  const prepared = await prepareShieldInsert(
    poolConfig,
    connection,
    walletSeed,
    counter,
    onProgress,
    blinding,
  );

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
  const protocolFee = Number(
    (poolConfig.denominationAtomic * SHIELD_FEE_BPS) / BPS_DENOMINATOR,
  );
  // Jittered, for the same reason as the withdrawal and subscribe legs: the bare
  // sum is a pure function of the pool and the proof size, so it repeats exactly
  // across every deposit into the same pool and one `memcmp` enumerates them.
  // Worse here than elsewhere, because the sum embeds the denomination and the
  // 0.3% protocol fee — the measured devnet deposit gave back
  // 1_573_486_080 − 570_010_780 = 1_003_475_300, which is 1 SOL plus 0.3% plus
  // fees, so the arithmetic disclosed the denomination on its own.
  //
  // The pool PDA is in the transaction regardless, so this does not hide which
  // denomination was bought. It removes the constant, nothing more.
  const requiredLamports = jitterPrefund(
    Number(poolConfig.denominationAtomic) +
      protocolFee +
      bufferRent +
      E_TX_FEE_BUDGET +
      SHIELD_RENT_MARGIN,
  );

  // Deterministic in (seed, pool, counter) — see deriveShieldEphemeral. The
  // job id is just a stable label for the breadcrumb, derived from the same
  // inputs so a recovery pass can match it without any stored state.
  const ephemeral = deriveShieldEphemeral(walletSeed, poolConfig.poolPDA, counter);
  const jobId = `shield:${poolConfig.poolPDA.toBase58()}:${counter}`;

  // NOT jittered, and not part of the pre-fund arithmetic: this is the honest
  // answer to "how much of this is the user buying something", which the
  // funding decision refuses on. Jittering it would make the refusal depend on
  // a random draw.
  const valueLamports = Number(poolConfig.denominationAtomic) + protocolFee;

  return { jobId, poolConfig, ephemeral, requiredLamports, valueLamports, prepared };
}

// ---------------------------------------------------------------------------
// Contribution — deposit a leaf you do NOT own
// ---------------------------------------------------------------------------

export interface PreparedContribution extends Omit<PreparedShield, 'prepared'> {
  /** The index the treasury reserved and derived its commitment for. */
  leafIndex: number;
  commitment: bigint;
  /**
   * \u26d4 NO NOTE MATERIAL, BY TYPE. `prepareInsertForCommitment` cannot
   * return `secret`, `nullifierPreimage` or `noteBlinding` because it never had
   * them, so nothing downstream can accidentally build a receipt out of a note
   * that belongs to the treasury.
   */
  prepared: Awaited<ReturnType<typeof prepareInsertForCommitment>>;
}

/**
 * Prove the insert for a commitment the TREASURY owns, and price the pre-fund.
 *
 * \U0001f3af THE HALF THAT MAKES THE TREASURY A MIXER. The contributor pays for
 * this deposit and never learns what it opens to, so they cannot spend it and
 * there is nothing to double-spend. They are paid in a DIFFERENT note out of
 * stock -- necessarily an older one, because `issue-note`'s maturity gate
 * refuses a leaf deposited moments ago. The gate is the mixing.
 *
 * Everything below the commitment is identical to `prepareShield`: the same
 * tree read, the same C6 proof, the same pricing and the same jitter. Written
 * here rather than in a module of its own so it cannot drift from those numbers
 * -- a constant copied across a wire and moved on one side is the failure this
 * repository keeps paying for.
 *
 * \u26a0 `contributorSeed` derives the EPHEMERAL only. It has nothing to do with
 * the note, which is the treasury's; it exists so a failed contribution can be
 * swept and recovered by the person who funded it.
 */
export async function prepareContribution(
  poolConfig: PoolConfig,
  connection: Connection,
  contributorSeed: Uint8Array,
  commitment: bigint,
  expectedLeafIndex: number,
  onProgress?: (step: string) => void,
): Promise<PreparedContribution> {
  if (poolConfig.token !== 'SOL') {
    throw new Error('Only SOL denominations can be contributed today.');
  }
  if (commitment <= 0n) {
    throw new Error('A contributed commitment must be a non-zero field element.');
  }

  onProgress?.('Reading the pool tree...');
  const counter = await readTreeLeafCount(connection, poolConfig);
  // \u26d4 REFUSE A RESERVATION THE TREE HAS OUTGROWN. The treasury derived this
  // commitment FOR a specific index; landing it anywhere else produces a leaf
  // whose opening the treasury computes at the wrong counter, so `issue-note`
  // would answer 500 to a paying buyer and the contributor would have funded a
  // note nobody can ever sell. Cheaper to re-reserve than to discover that.
  if (counter !== expectedLeafIndex) {
    throw new Error(
      `The pool advanced past this reservation (reserved leaf ${expectedLeafIndex}, tree is at ` +
        `${counter}). Nothing was spent \u2014 reserve again.`,
    );
  }

  const prepared = await prepareInsertForCommitment(poolConfig, connection, commitment, onProgress);
  if (prepared.insertParams.leafIndex !== expectedLeafIndex) {
    throw new Error(
      `The pool advanced while proving (leaf ${expectedLeafIndex} \u2192 ` +
        `${prepared.insertParams.leafIndex}). Nothing was spent \u2014 reserve again.`,
    );
  }

  onProgress?.('Pricing the contribution...');
  const bufferRent = await connection.getMinimumBalanceForRentExemption(
    83 + prepared.c6ProofResult.proofSize,
  );
  const protocolFee = Number(
    (poolConfig.denominationAtomic * SHIELD_FEE_BPS) / BPS_DENOMINATOR,
  );
  const requiredLamports = jitterPrefund(
    Number(poolConfig.denominationAtomic) +
      protocolFee +
      bufferRent +
      E_TX_FEE_BUDGET +
      SHIELD_RENT_MARGIN,
  );
  const ephemeral = deriveShieldEphemeral(contributorSeed, poolConfig.poolPDA, counter);
  const jobId = `contribute:${poolConfig.poolPDA.toBase58()}:${counter}`;
  const valueLamports = Number(poolConfig.denominationAtomic) + protocolFee;

  return {
    jobId,
    poolConfig,
    ephemeral,
    requiredLamports,
    valueLamports,
    leafIndex: expectedLeafIndex,
    commitment,
    prepared,
  };
}

/**
 * Run the contribution. The caller must already have funded E.
 *
 * \u26d4 IT RETURNS NO RECEIPT, AND THAT IS THE POINT. `shieldV3` builds one out
 * of the insert parameters, and on this path those carry zeros where the note
 * material would be. Handing that back would look exactly like a spendable note
 * and be worthless -- so it is dropped here rather than surfaced with a warning
 * somebody has to read.
 */
export async function executeContribution(
  ctx: PreparedContribution,
  connection: Connection,
  sweepTo: PublicKey,
  onProgress?: (step: string) => void,
): Promise<{ txSig: string; leafIndex: number; commitment: string }> {
  const { txSig } = await executeShield(
    // The shield path needs the three note fields to exist on the object; they
    // are zeros here and nothing downstream reads them, because the receipt
    // they would build is discarded on the next line.
    {
      ...ctx,
      prepared: {
        ...ctx.prepared,
        insertParams: {
          ...ctx.prepared.insertParams,
          secret: 0n,
          nullifierPreimage: 0n,
          noteBlinding: 0n,
        },
      },
    } as PreparedShield,
    connection,
    sweepTo,
    onProgress,
  );
  return { txSig, leafIndex: ctx.leafIndex, commitment: ctx.commitment.toString() };
}

// ---------------------------------------------------------------------------
// Phase 2 — spend (E signs everything)
// ---------------------------------------------------------------------------

/**
 * Run the shield with E as depositor. The caller must already have funded E
 * with `requiredLamports` (one user signature) and confirmed that transfer.
 *
 * `sweepTo` receives E's residual — recovered proof-buffer rent plus unused
 * fee budget.
 */
export async function executeShield(
  ctx: PreparedShield,
  connection: Connection,
  /**
   * Where E's residual goes. ⚠️ NOT NECESSARILY THE OWNER, and it was named
   * `ownerPubkey` here until 2026-08-22 while its caller has passed
   * `sweepTo ?? ownerPubkey` all along (`worker/poolHandlers.ts:1469`). On a
   * relayed deposit this is the deployment's FLOAT: it fronted the rent, so the
   * rent is its own coming back. The old name is why the progress line below
   * told a buyer their wallet was being repaid when it was not.
   */
  sweepTo: PublicKey,
  onProgress?: (step: string) => void,
): Promise<ShieldResult> {
  const { ephemeral, jobId, poolConfig, prepared } = ctx;

  const eSigner: WalletSigner = {
    publicKey: ephemeral.publicKey,
    signTransaction: async (t: Transaction) => {
      if (!t.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        t.recentBlockhash = blockhash;
      }
      if (!t.feePayer) t.feePayer = ephemeral.publicKey;
      t.sign(ephemeral);
      return t;
    },
  };

  try {
    // Refuse to start if the pre-fund did not actually land — otherwise we burn
    // through half the chunk uploads and strand the rest. This check lives
    // INSIDE the try on purpose: a partially-landed pre-fund leaves lamports on
    // E, and throwing before the try would skip the sweep in `finally` and
    // strand exactly the funds the check is meant to protect.
    const funded = await connection.getBalance(ephemeral.publicKey, 'confirmed');
    if (funded < ctx.requiredLamports) {
      throw new Error(
        `The shield signer is underfunded (${funded} of ${ctx.requiredLamports} lamports). ` +
          'The pre-fund transaction may not have confirmed yet — retry in a moment.',
      );
    }

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
        // 🚨 IT SAID "to your wallet", UNCONDITIONALLY, AND ON THE RELAYED
        // PATH THAT IS FALSE — the rent goes back to the float that fronted it
        // and the buyer gets nothing. `subscribeEphemeral` and
        // `unshieldEphemeral` already branch on who paid; the deposit leg was
        // the one that did not, and it is the leg the relay changed.
        //
        // Naming the destination cannot go stale the way a branch can: whoever
        // reads it can check the address against the sweep transaction.
        onProgress?.(
          `Returning recovered rent to ${sweepTo.toBase58().slice(0, 4)}…${sweepTo
            .toBase58()
            .slice(-4)}...`,
        );
        const sweepTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: ephemeral.publicKey,
            toPubkey: sweepTo,
            lamports: sweepable,
          }),
        );
        const { signature: sig, blockhash, lastValidBlockHeight } = await sendWithFreshBlockhash(
          connection,
          sweepTx,
          (t) => {
            t.sign(ephemeral);
            return t;
          },
          ephemeral.publicKey,
        );
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
 * Write a recovery breadcrumb for a prepared shield.
 *
 * CAVEAT — this is not what makes a crashed shield recoverable. Inside a Worker
 * `relayEphemeralRecovery`'s store finds no localStorage and falls back to a
 * module-scope Map, so the entry dies with the worker, and nothing in apps/web
 * reads it back. What actually recovers a crashed shield is that
 * `deriveShieldEphemeral` is deterministic in (seed, pool, leafIndex), which
 * `recoverStuckFloat` uses to re-derive and drain the key. Kept because it is
 * free and matches the format the extension-side tooling consumes.
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
