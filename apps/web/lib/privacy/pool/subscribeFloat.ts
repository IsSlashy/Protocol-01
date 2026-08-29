/**
 * subscribeFloat — ONE source for the float a subscription locks, shared by the
 * code that transfers it and the copy that discloses it.
 *
 * 🚨 WHY THIS FILE EXISTS
 * ───────────────────────
 * `SubscribePanel`'s cost disclosure — the box read BEFORE the user signs —
 * said "roughly 1 SOL is locked to hold space for the two proofs, the same pair
 * a withdrawal needs". Both halves were wrong on the route the app now takes:
 *
 *   * circuit 7 rents ONE buffer, not two, and the float is ~0.55 SOL, so the
 *     figure overstated the lock by nearly 2x;
 *   * "the same pair a withdrawal needs" named a pair the withdrawal stopped
 *     using on 2026-08-26 when apps/web was wired to circuit 7.
 *
 * A disclosure that overstates a cost is not "the safe direction". It teaches
 * the reader that this panel's numbers are approximate, and the two sentences
 * beside it — the whole note is spent, there is no refund — are not.
 *
 * ⛔ THE COPY MUST NOT CARRY ITS OWN NUMBER. That is how the figure went stale:
 * a literal in JSX has nothing to disagree with. `SUBSCRIBE_FLOAT_SOL` below is
 * computed from the same `subscribeFloorLamports` the job uses to decide what to
 * transfer, so changing the pricing moves the copy in the same commit or the
 * pin in `subscribeFloat.test.ts` goes red.
 *
 * WHAT IS MEASURED AND WHAT IS DERIVED
 * ────────────────────────────────────
 *   MEASURED   the proof wire sizes, and the rent constants. Both are
 *              cross-checked in the test against the repo's own records rather
 *              than trusted here.
 *   DERIVED    the rent, from Solana's rent-exemption formula, which reproduces
 *              `getMinimumBalanceForRentExemption` exactly. The check that it
 *              really does: the pair figure this file computes,
 *              1_035_725_040 lamports, is the exact number `prefundAmount.ts`
 *              records as MEASURED on devnet across 4 of 4 subscriptions. The
 *              test re-reads that number out of that file and compares.
 *
 * ⚠️ THIS IS AN ESTIMATE AND THE COPY SAYS "ABOUT". The job prices its float
 * from live RPC at execute time; a disclosure shown before the note is even
 * chosen cannot. What this file guarantees is that the two use the SAME
 * ARITHMETIC over the same terms, so they can only disagree by the proof size
 * moving — which the test also pins.
 *
 * ⛔ NO IMPORTS. This module is pulled into a React component; importing
 * `subscribeEphemeral` or `denominatedPool` from a panel would drag the whole
 * pool stack, which is deliberately confined to the worker.
 */

// ---------------------------------------------------------------------------
// Solana rent exemption
// ---------------------------------------------------------------------------

/** `ACCOUNT_STORAGE_OVERHEAD` — bytes the runtime charges on top of the data. */
export const RENT_ACCOUNT_OVERHEAD_BYTES = 128;
/** `DEFAULT_LAMPORTS_PER_BYTE_YEAR`. */
export const RENT_LAMPORTS_PER_BYTE_YEAR = 3_480;
/** `DEFAULT_EXEMPTION_THRESHOLD`, in years. */
export const RENT_EXEMPTION_YEARS = 2;

/**
 * What `connection.getMinimumBalanceForRentExemption(dataLen)` returns.
 *
 * Reproduced rather than fetched because a disclosure is rendered before any
 * RPC round trip the user would wait for. Verified against a live figure — see
 * the header.
 */
export function rentExemptLamports(dataLen: number): number {
  return (RENT_ACCOUNT_OVERHEAD_BYTES + dataLen) * RENT_LAMPORTS_PER_BYTE_YEAR * RENT_EXEMPTION_YEARS;
}

// ---------------------------------------------------------------------------
// The parts of the float
// ---------------------------------------------------------------------------

/** `ProofBuffer::PROOF_DATA_OFFSET` — header ahead of the proof bytes. */
export const PROOF_BUFFER_HEADER_BYTES = 83;

/**
 * `SubscriptionVault::LEN`, summed field by field at
 * `programs/zk_shielded/src/state/subscription_vault.rs:135-153`.
 *
 * ⚠️ This rent does NOT come back. The vault stays open until `claim_period`
 * closes it on the final claim, and the close sweeps it to the RETAILER.
 */
export const SUBSCRIPTION_VAULT_LEN = 361;

/** NullifierRecord init (~0.0009 SOL) plus margin. */
export const NULLIFIER_RENT = 2_000_000;

/** Fee headroom for the chunk uploads plus the inner transaction. */
export const E_TX_FEE_BUDGET = 4_000_000;

/**
 * Proof sizes on the wire, MEASURED.
 *
 * C7 is the size of a real proof accepted by the deployed verifier
 * (`packages/stark-prover/deployed-verifier.json`, devnet transaction
 * `4yKg4gGm…`). C1 and C3 come from the re-measured table in
 * `programs/p01_stark_verifier/tests/cross_circuit_confusion.rs`.
 *
 * ⛔ 258,958 is NOT the pair. That figure predates the B4 pair-leaf change of
 * 28 July and is still quoted in places; the cut C7 buys is 1.9x, not 3.3x.
 * `subscribeFloat.test.ts` re-reads all three out of those files.
 */
export const MEASURED_PROOF_BYTES = {
  // [C1-N256 2026-08-29] 68,881 -> 80,577. C1 was the one circuit the depth cut
  // could not save, so its geometry moved (n 128 -> 256) and its wire grew with
  // it. C3 and C7 took depth cuts instead and their sizes did not move.
  c1: 80_577,
  c3: 78_157,
  c7: 77_965,
} as const;

/** Rent for one proof buffer holding `proofBytes` of proof. */
export function proofBufferRentLamports(proofBytes: number): number {
  return rentExemptLamports(PROOF_BUFFER_HEADER_BYTES + proofBytes);
}

// ---------------------------------------------------------------------------
// THE formula
// ---------------------------------------------------------------------------

/**
 * The pre-fund floor for a subscription, before `jitterPrefund` rounds it up.
 *
 * `proofBufferRent` is the TOTAL buffer rent for the route: one buffer on
 * circuit 7, the sum of two on the C1 + C3 pair. That parameter is the only
 * thing that differs between the two routes, which is why they share this
 * function — and why the panel can quote both from it.
 *
 * ⛔ Never transfer this figure directly. `prefundAmount.ts` explains why the
 * exact value is a `memcmp` fingerprint; the callers jitter it.
 */
export function subscribeFloorLamports(parts: {
  proofBufferRent: number;
  vaultRent: number;
}): number {
  return parts.proofBufferRent + NULLIFIER_RENT + E_TX_FEE_BUDGET + parts.vaultRent;
}

/** The two routes a subscription can take, priced. */
export const SUBSCRIBE_FLOAT_LAMPORTS = {
  /** Circuit 7: ONE proof buffer. What this app tries first. */
  c7: subscribeFloorLamports({
    proofBufferRent: proofBufferRentLamports(MEASURED_PROOF_BYTES.c7),
    vaultRent: rentExemptLamports(SUBSCRIPTION_VAULT_LEN),
  }),
  /** The C1 + C3 pair: TWO proof buffers. The fallback, and the older shape. */
  pair: subscribeFloorLamports({
    proofBufferRent:
      proofBufferRentLamports(MEASURED_PROOF_BYTES.c1) +
      proofBufferRentLamports(MEASURED_PROOF_BYTES.c3),
    vaultRent: rentExemptLamports(SUBSCRIPTION_VAULT_LEN),
  }),
} as const;

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Two decimals — the precision a "roughly" sentence can honestly carry. */
export function floatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(2);
}

/**
 * What the disclosure renders. ⛔ Interpolate these; never retype the digits.
 */
export const SUBSCRIBE_FLOAT_SOL = {
  c7: floatSol(SUBSCRIBE_FLOAT_LAMPORTS.c7),
  pair: floatSol(SUBSCRIBE_FLOAT_LAMPORTS.pair),
} as const;
