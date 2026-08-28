/**
 * How much room is left before P11 can no longer prove anything about the float?
 *
 * 🚨 WHY THIS EXISTS. P11's green verdict rests on ONE account. The probe walks
 * the deposit payer's funder — the float — and reads that history IN FULL,
 * because the tool refuses to argue an absence from a truncated walk. MEASURED
 * 2026-08-28: 58 transactions, none naming the buyer. That is the whole basis of
 * the PASS.
 *
 * The float only ever grows. Every relayed deposit adds to it. Past the walk
 * limit the probe stops returning green and starts returning INCONCLUSIVE —
 * which is NOT a failure anyone would notice as one, because it is not red. The
 * verdict would quietly stop being a verdict.
 *
 * Nothing measured that. This makes the headroom a number an operator can read
 * before it runs out, rather than a surprise in the middle of an audit.
 *
 * ⛔ THIS IS NOT A READINESS CONDITION. A long float history does not stop a
 * single deposit from being relayed; it stops the MEASUREMENT from being
 * provable. `ready` answers "can this relay", and folding a second question into
 * it would make readiness mean two things — the mistake `relay-to-buyer` already
 * refuses for the float balance.
 */

/**
 * The ceiling P11 will walk, from `verify/p01-verify.mjs`:
 * `const historyLimit = Math.min(1000, chunkLimit + 1)`. A history at or past
 * this is truncated, and a truncated funder history turns P11 INCONCLUSIVE.
 */
export const P11_FUNDER_WALK_LIMIT = 1000;

/** Where the warning starts. Early enough to act, late enough not to nag. */
export const P11_FUNDER_WARN_FRACTION = 0.6;

export type FunderHistoryLevel = 'unknown' | 'ok' | 'warn' | 'exhausted';

export interface FunderHistoryVerdict {
  length: number | null;
  limit: number;
  level: FunderHistoryLevel;
  /** Plain sentence for an operator. Never a reassurance when the answer is unknown. */
  note: string;
}

export function funderHistoryVerdict(
  length: number | null,
  limit: number = P11_FUNDER_WALK_LIMIT,
): FunderHistoryVerdict {
  // ⚠️ `null` is UNREAD, not zero — the same rule the float balance follows.
  // Reporting an unread history as healthy is how a green that means nothing
  // gets published.
  if (length === null) {
    return {
      length: null,
      limit,
      level: 'unknown',
      note: 'The float history could not be read, so the headroom P11 needs is unknown — not fine.',
    };
  }
  if (length >= limit) {
    return {
      length,
      limit,
      level: 'exhausted',
      note:
        `The float has ${length} transactions, at or past the ${limit} P11 will walk. The probe ` +
        'refuses to argue an absence from a truncated history, so it now returns INCONCLUSIVE — ' +
        'which is not green and must never be reported as one. Move the float to a fresh address.',
    };
  }
  if (length >= Math.floor(limit * P11_FUNDER_WARN_FRACTION)) {
    return {
      length,
      limit,
      level: 'warn',
      note:
        `The float has ${length} of the ${limit} transactions P11 will walk. Past that the ` +
        'unlinkability verdict goes INCONCLUSIVE rather than red, so it would stop being a ' +
        'verdict without anything turning a warning colour. Plan a fresh float.',
    };
  }
  return {
    length,
    limit,
    level: 'ok',
    note: `The float has ${length} of the ${limit} transactions P11 will walk.`,
  };
}
