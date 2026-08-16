/**
 * prefundAmount — stop the pre-fund from being a deterministic fingerprint.
 *
 * THE DEFECT, MEASURED
 * ────────────────────
 * `requiredLamports` is a pure function of the circuit geometry: two proof
 * buffers' rent, the nullifier record's, a fixed fee budget, and for a subscribe
 * the vault's. Nothing in it varies. On devnet the subscribe pre-fund came to
 * 1_035_725_040 lamports and that exact value appeared on 4 of 4 subscriptions
 * — so a single `memcmp` over transfer amounts enumerates every Styx
 * subscription ever made, before reading a single proof byte. The shield leg has
 * the same shape at 1_573_486_080, and the difference between the two even
 * discloses which operation is about to happen.
 *
 * WHAT THIS FIXES, AND WHAT IT DOES NOT
 * ─────────────────────────────────────
 * It kills EXACT-MATCH enumeration, which is the cheap filter — the one that
 * costs an analyst one indexer query. It does NOT hide the operation. A transfer
 * of roughly one SOL into a brand-new account that then sends ~150 transactions
 * in ninety seconds is still recognisable by shape, and no amount of jitter
 * touches that. Anyone quoting this file as unlinkability is misreading it; the
 * channel that matters is who funded the ephemeral at all, which is what
 * `ephemeralFunder.ts` addresses and what probe P6 measures.
 *
 * WHY ROUNDING AND NOT ONLY NOISE
 * ───────────────────────────────
 * Pure noise leaves 1_035_729_412 — a number that occurs in ordinary traffic
 * essentially never, so every pre-fund still stands out as machine-generated
 * even though no two match. Rounding UP to a whole hundredth of a SOL produces
 * 1.04, 1.05, 1.06 — amounts humans send. Rounding alone would be a new
 * constant, so a random number of steps is added on top. The result varies AND
 * looks ordinary, which is strictly better than either half.
 *
 * ⚠️ UPWARD ONLY, ALWAYS. The pre-fund is a floor: the ephemeral pays rent for
 * two buffers it has already begun filling, and coming up short does not fail
 * cheaply — it fails after ~150 chunk uploads, with the float stranded. The
 * surplus is not a cost: the sweep in the `finally` returns whatever is left to
 * whoever paid. What it does cost is BALANCE — the payer must hold the rounded
 * amount, not the exact one.
 */

/** 0.01 SOL. The granularity a human would actually type. */
const STEP_LAMPORTS = 10_000_000;

/**
 * How many extra steps may be added, at most. Four gives five possible values
 * per rounding bucket — enough that no single amount repeats across a demo, and
 * small enough (0.04 SOL of extra float, fully returned) that a payer who could
 * afford the operation can still afford it.
 */
const MAX_EXTRA_STEPS = 4;

/**
 * A uniform integer in [0, boundExclusive), from the platform CSPRNG.
 *
 * Rejection sampling rather than `% bound`: the modulo of a uniform 32-bit draw
 * is biased toward the low values whenever `bound` does not divide 2^32, and a
 * biased step count is a weaker fingerprint than an unbiased one rather than no
 * fingerprint at all. `Math.random` is not used anywhere here — it is seeded
 * predictably in some engines, and a predictable pre-fund is the constant we
 * are removing.
 */
function randomBelow(boundExclusive: number): number {
  if (boundExclusive <= 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / boundExclusive) * boundExclusive;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % boundExclusive;
  }
}

/**
 * Round `required` up to a whole 0.01 SOL, then add 0 to 4 more of them.
 *
 * Always returns at least `required`, so it is safe to substitute anywhere the
 * exact figure was used. Exported for the tests, which assert exactly that.
 */
export function jitterPrefund(required: number): number {
  if (!Number.isFinite(required) || required <= 0) return required;
  const rounded = Math.ceil(required / STEP_LAMPORTS) * STEP_LAMPORTS;
  return rounded + randomBelow(MAX_EXTRA_STEPS + 1) * STEP_LAMPORTS;
}

export const PREFUND_STEP_LAMPORTS = STEP_LAMPORTS;
export const PREFUND_MAX_EXTRA_STEPS = MAX_EXTRA_STEPS;
