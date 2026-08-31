/**
 * The treasury's seeds, parsed in ONE place.
 *
 * 🚨 THIS MODULE EXISTS BECAUSE THE SAME PARSER LIVED IN FOUR FILES AND MOVED IN
 * ONE. `P01_TREASURY_POOL_SEED` grew from a single hex seed to a comma-separated
 * list on 2026-08-31 — the change that recovered 47 issuable notes — and
 * `issue-note` learned to read it while `contribute-note`, `swap-note` and
 * `checkInventory` kept testing `/^[0-9a-fA-F]{64}$/` against a 129-character
 * value. Every one of them decided the deployment held no treasury at all.
 *
 * MEASURED, in production, within minutes: "this deployment holds no treasury
 * and cannot take a contribution" — a 503 on the buyer's own shield, from a
 * treasury holding sixty leaves.
 *
 * ⛔ SO THERE IS ONE PARSER AND EVERY CALLER IMPORTS IT. A format written on
 * both sides of a wire and moved on one side is the failure this repository
 * keeps paying for; the only fix that holds is not having two sides.
 */

/**
 * Every seed this treasury holds, in configured order.
 *
 * ⛔ ORDER MATTERS AND THE FIRST IS ACTIVE: it is what a NEW leaf is derived
 * under. The rest are read-only in practice — they open what they already own,
 * which is the whole reason the list exists rather than a single value that
 * would have to be switched, orphaning one set to recover another.
 *
 * ⚠️ A malformed entry is DROPPED, never defaulted. A typo in one of several
 * seeds must not silently become a treasury that owns nothing, and it must not
 * take the well-formed ones down with it.
 */
export function treasurySeeds(env: NodeJS.ProcessEnv = process.env): Uint8Array[] {
  const raw = env.P01_TREASURY_POOL_SEED ?? '';
  const out: Uint8Array[] = [];
  for (const part of raw.split(',')) {
    const hex = part.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) continue;
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out.push(bytes);
  }
  return out;
}

/**
 * The seed new notes are created under: the first configured one.
 *
 * `null` when nothing parses, which every caller must treat as "this deployment
 * holds no treasury" — the honest reading, and the one that refuses rather than
 * deriving notes under a seed nobody chose.
 */
export function activeTreasurySeed(env: NodeJS.ProcessEnv = process.env): Uint8Array | null {
  return treasurySeeds(env)[0] ?? null;
}
