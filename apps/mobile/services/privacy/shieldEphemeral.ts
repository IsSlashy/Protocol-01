/**
 * shieldEphemeral — make the V3 deposit stop signing with the user's wallet.
 *
 * WHAT WAS MEASURED, AND WHY THIS FILE EXISTS
 * ───────────────────────────────────────────
 * Two devnet transactions from the same phone, same client, same relayer
 * (`2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW`), 2026-08-04:
 *
 *   UnshieldDenominatedStarkV3  slot 481,027,681
 *     only signer: 2Aqb47tbzGGuD9myGKFnhvCyxR9xgdbnNU4G75AzCaGD  (ephemeral)
 *     user wallet 4vGBhCsonwAxMUHKFPGSz9x8R9R4NxJxMwHnyDz92ajo:  ABSENT
 *
 *   ShieldDenominatedV3         slot 481,009,924
 *     only signer: 4vGBhCsonwAxMUHKFPGSz9x8R9R4NxJxMwHnyDz92ajo  (THE WALLET)
 *
 * The withdrawal hid the wallet; the deposit did not.
 *
 * THE RELAYER CANNOT FIX THIS, AND SAYS SO ITSELF
 * ───────────────────────────────────────────────
 * `v3RelayerWrapper.ts:122-129` compiles the inner transaction with
 * `payerKey: userPubkey` and signs it BEFORE encrypting. The relayer decrypts an
 * already-signed transaction and broadcasts it; it cannot rewrite a signer set.
 * `v3RelayerWrapper.ts:13-20` states the same limitation. Relaying buys the IP
 * and the OUTER fee payer, never the inner signer. So the only fix is to make
 * the inner signer somebody other than the wallet.
 *
 * WHAT THIS BUYS — AND WHAT IT DOES NOT
 * ─────────────────────────────────────
 * BUYS: the `shield_denominated_v3` instruction no longer carries the user's
 * wallet as `depositor: Signer`. Its account list, and the C6 proof buffer's
 * `authority` that the handler binds to it
 * (`shield_denominated_v3.rs:75-80`), name an ephemeral E instead. Combined
 * with the relayer this means no wallet key appears anywhere in the deposit
 * transaction — which is the precondition the relayer was always missing.
 *
 * DOES NOT BUY: anonymity. The wallet still funds E with a PLAIN, PUBLIC
 * `SystemProgram.transfer`, and the residual is swept back to the wallet the
 * same way. Two transfers of a conspicuous size, minutes apart, one hop from
 * the deposit. An observer following value gets from the deposit back to the
 * wallet in one step. This is a shape change and a relayer precondition, not
 * unlinkability. Closing the funding link needs a k-anonymous feeder pool
 * (Phase A.5), which is not built.
 *
 * DOES NOT BUY: an anonymity set. The withdrawal publishes the same note
 * commitment the deposit published — CONFIRMED on the two transactions above,
 * leaf 16 = 8901821612542787864 in both. Only the C7 spend circuit
 * (`docs/C7_SPEND_CIRCUIT_PLAN.md`) changes that. Nothing here touches it.
 *
 * FUND SAFETY — THE PART THAT MATTERS MOST
 * ────────────────────────────────────────
 * E holds the FULL DENOMINATION plus ~1 SOL of proof-buffer rent between the
 * pre-fund and the sweep. If E were not re-derivable, a crash in that window
 * would strand all of it forever. So E is a pure function of
 * (secret note seed, pool PDA, counter) — no stored state, no randomness, no
 * device affinity. Re-installing the app and restoring the same wallet
 * re-derives the identical E, and `resumeShieldPrefund` finds the money still
 * sitting there and continues instead of paying twice.
 *
 * The counter is the same one `findSafeShieldCounter` picks, so a resumed
 * attempt lands on the same E: the previous attempt never wrote a nullifier
 * (the shield did not execute), so the counter walk returns the same value.
 */

import {
  Keypair as SolKeypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { SWEEP_FEE_RESERVE } from './ephemeralSigner';

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Domain separator. Distinct from the web string (`p01:web:shield-ephemeral:v1`)
 * on purpose: the two clients key off different secrets (web off a pool seed
 * derived from a wallet signature, mobile off the local keypair's `secretKey`
 * seed), so sharing an info string would imply an interchangeability that does
 * not exist.
 */
export const SHIELD_EPHEMERAL_INFO = 'p01:mobile:shield-ephemeral:v3';

/**
 * Derive the shield depositor E from the wallet's SECRET seed.
 *
 * `noteSeed` is `deriveLocalNoteSeed().noteSeed` — the same secret every note in
 * this app derives from. It is NOT the wallet address: see
 * `ephemeralSigner.ts` for the class of bug that produced, and why an HMAC over
 * public values is not a derivation.
 *
 * Deterministic in (noteSeed, poolPDA, counter) and nothing else. That is the
 * entire recovery story — do not add a timestamp, a random nonce, or a device
 * id to these inputs.
 */
export function deriveShieldEphemeral(
  noteSeed: Uint8Array,
  poolPDA: PublicKey,
  counter: number,
): SolKeypair {
  if (noteSeed.length < 32) {
    throw new Error(
      `deriveShieldEphemeral: seed too short (${noteSeed.length} bytes, need >= 32)`,
    );
  }
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(`deriveShieldEphemeral: counter must be a non-negative integer, got ${counter}`);
  }
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, true);
  const info = concatBytes(
    utf8ToBytes(SHIELD_EPHEMERAL_INFO),
    poolPDA.toBytes(),
    counterBytes,
  );
  return SolKeypair.fromSeed(hkdf(sha256, noteSeed, undefined, info, 32));
}

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/**
 * Protocol fee the handler charges the DEPOSITOR on top of the denomination:
 * `shield_denominated_v3.rs:220` with `fee::SHIELD_FEE_BPS = 30` (0.3%).
 *
 * It must be funded onto E or the shield transaction fails for insufficient
 * lamports AFTER the entire 145 KB proof has been uploaded and verified. At
 * 0.1 SOL the fee (300,000 lamports) hides inside the margin; at 10 SOL it is
 * 0.03 SOL and the shield cannot land.
 */
export const SHIELD_FEE_BPS = 30n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Per-transaction fee headroom for everything E signs: ~145 chunk uploads plus
 * init, resizes, verify phase 1, DEEP-ALI phase 2, the shield itself, the
 * buffer close and the sweep. Rounded up hard — an underfunded E strands the
 * flow mid-upload with the denomination already on it.
 */
export const E_TX_FEE_BUDGET = 3_000_000;

/**
 * Slack for the fee-escrow PDA the handler touches plus rent drift.
 *
 * `shield_denominated_v3.rs:228-243`: on the FIRST shield into a fresh pool the
 * fee escrow is a 0-lamport system account, and the handler tops it up to the
 * rent-exempt minimum (~890,880 lamports) out of the depositor's balance
 * instead of transferring the fee alone. That top-up comes from E, so E must be
 * able to cover it.
 */
export const SHIELD_RENT_MARGIN = 2_000_000;

/**
 * Extra funded onto E when the relayer is enabled.
 *
 * `v3RelayerWrapper.signAndSendViaRelayer` pre-funds the relay-job ephemeral
 * FROM the inner signer (`signFn` at v3RelayerWrapper.ts:153-160), which is now
 * E. Same figure the V3 unshield path already uses for the same reason
 * (`denominatedPoolStore.ts` RELAYER_TOPUP).
 */
export const RELAYER_TOPUP = 40_000_000;

export function shieldProtocolFee(denominationAtomic: bigint): number {
  return Number((denominationAtomic * SHIELD_FEE_BPS) / BPS_DENOMINATOR);
}

/**
 * Everything E must hold before `shieldV3` is allowed to start.
 *
 * Pure, so the number can be asserted in a test instead of discovered on
 * devnet with a stranded denomination.
 */
export function computeShieldPrefundLamports(args: {
  denominationAtomic: bigint;
  /** Rent for the C6 proof buffer: getMinimumBalanceForRentExemption(83 + UNIFORM_PROOF_SIZE). */
  bufferRent: number;
  relayerEnabled: boolean;
}): number {
  return (
    Number(args.denominationAtomic) +
    shieldProtocolFee(args.denominationAtomic) +
    args.bufferRent +
    E_TX_FEE_BUDGET +
    SHIELD_RENT_MARGIN +
    (args.relayerEnabled ? RELAYER_TOPUP : 0)
  );
}

// ---------------------------------------------------------------------------
// Pre-fund (idempotent) and sweep
// ---------------------------------------------------------------------------

export interface PrefundOutcome {
  /** How much was actually moved. 0 when E was already funded. */
  fundedLamports: number;
  /** E's balance after the pre-fund settled. */
  balance: number;
  /** Signature of the funding transfer, or null when none was needed. */
  signature: string | null;
}

/**
 * Fund E up to `requiredLamports`, resuming rather than double-paying.
 *
 * A previous attempt that crashed after funding left the money at this exact
 * address, because E is deterministic. So: read the balance first, fund only
 * the shortfall, and fund nothing at all when it is already there. Paying the
 * full amount blindly would strand the earlier payment AND spend twice.
 *
 * The funding transfer is signed by the user's wallet and is PUBLIC — this is
 * the residual link documented at the top of this file. It is not hidden and
 * this function does not pretend otherwise.
 */
export async function resumeShieldPrefund(
  connection: Connection,
  funder: SolKeypair,
  ephemeral: SolKeypair,
  requiredLamports: number,
): Promise<PrefundOutcome> {
  let balance = 0;
  try {
    balance = await connection.getBalance(ephemeral.publicKey, 'confirmed');
  } catch {
    // RPC hiccup. Treating this as "empty" would double-fund, so treat it as
    // fatal instead: the caller has spent nothing yet.
    throw new Error(
      'Could not read the shield signer balance — refusing to fund blindly (that would double-spend a resumed attempt).',
    );
  }

  if (balance >= requiredLamports) {
    console.log(
      `[ShieldEphemeral] E already holds ${(balance / 1e9).toFixed(6)} SOL >= ` +
        `${(requiredLamports / 1e9).toFixed(6)} — resuming without funding`,
    );
    return { fundedLamports: 0, balance, signature: null };
  }

  const shortfall = requiredLamports - balance;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: ephemeral.publicKey,
      lamports: shortfall,
    }),
  );
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = funder.publicKey;
  tx.sign(funder);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature, 'confirmed');

  const after = await connection.getBalance(ephemeral.publicKey, 'confirmed');
  return { fundedLamports: shortfall, balance: after, signature };
}

/**
 * Return E's residual — recovered proof-buffer rent plus unused fee budget — to
 * `destination`.
 *
 * Drains to zero on purpose. E is a 0-data system account: the runtime rejects
 * a RentExempt -> RentPaying transition, so leaving a small reserve behind does
 * not preserve a recovery path, it makes every sweep fail. The rule is written
 * down in this repo at `apps/extension/src/shared/services/relay.ts:463-467`.
 *
 * Best-effort: a failed sweep leaves recoverable lamports at a deterministic
 * address, which is strictly better than throwing over the caller's real error.
 */
export async function sweepShieldEphemeral(
  connection: Connection,
  ephemeral: SolKeypair,
  destination: PublicKey,
): Promise<number> {
  try {
    const bal = await connection.getBalance(ephemeral.publicKey, 'confirmed');
    const sweepable = bal - SWEEP_FEE_RESERVE;
    if (sweepable <= 0) return 0;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: ephemeral.publicKey,
        toPubkey: destination,
        lamports: sweepable,
      }),
    );
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = ephemeral.publicKey;
    tx.sign(ephemeral);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, 'confirmed');
    console.log(
      `[ShieldEphemeral] swept ${(sweepable / 1e9).toFixed(6)} SOL back to ` +
        destination.toBase58().slice(0, 8) + '…',
    );
    return sweepable;
  } catch (e) {
    console.warn(
      '[ShieldEphemeral] sweep failed — funds remain at the deterministic E and are ' +
        're-derivable from (seed, pool, counter):',
      e,
    );
    return 0;
  }
}
