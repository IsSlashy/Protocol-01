/**
 * spendRouting.ts — WHICH withdrawal circuit a v3-pool note goes through, and
 * what is refused first. The decision the two unshield screens share.
 *
 * ⛔ AN ALLOW-LIST, AND THAT IS THE WHOLE SAFETY PROPERTY.
 *
 *   1. `whyCircuit7Cannot(receipt)` — synchronously, FIRST. A pre-blinding note
 *      never enters the try below and can never be mistaken for a prover
 *      failure.
 *   2. `prepareV4()` — the leaf scan, the root pre-flight and the circuit-7
 *      proof. If it throws `V4Unprovable` ("this NOTE cannot go through this
 *      circuit"), fall back to the C1 + C3 pair. If it throws anything else, a
 *      broken PROVER is speaking, and answering that by republishing the
 *      commitment on the pair and reporting success is the exact failure the
 *      pair exists to remove. Rethrow.
 *   3. `spendV4(prepared)` or `spendPair()`. ⛔ NOTHING HERE MAY FALL BACK, AND
 *      THE STRUCTURE IS THE GUARANTEE — the catch wraps the PREPARE only. Once
 *      the proof is uploaded and the nullifier PDA initialised, a v3 retry pays
 *      the buffer rent twice and then dies on the double-spend guard, having
 *      already spent the note.
 *
 * Why a separate module with closures instead of code in the screens: the
 * screens are expo-router components and cannot be exercised in Node, so a
 * routing decision written inline there would have no test — and `apps/web`
 * learned what that costs when its v3 branch was dead code in production for a
 * few hours while every test stayed green. This function takes the three legs
 * as closures so `spendRouting.test.ts` can pin the DECISION against mocks
 * while the screens keep their pair path byte for byte.
 *
 * Routed on the TYPE, not on the wording: the prover result crosses the
 * WebView bridge as JSON, but `V4Unprovable` is thrown on this side of it, so
 * `instanceof` survives.
 */

import type { ShieldReceipt } from './index';
import { V4Unprovable, whyCircuit7Cannot } from './index';

export interface RouteUnshieldSpendParams<Prepared> {
  receipt: Pick<ShieldReceipt, 'depositEpoch'>;
  /** Leaf scan + root pre-flight + circuit-7 proof. Nothing spent on return. */
  prepareV4: () => Promise<Prepared>;
  /** Upload + `unshield_denominated_stark_v4`. May NOT fall back. */
  spendV4: (prepared: Prepared) => Promise<string>;
  /** The C1 + C3 pair, byte for byte what the screen ran before circuit 7. */
  spendPair: () => Promise<string>;
  onProgress?: (step: string) => void;
}

export interface RoutedSpend {
  txSig: string;
  version: 'v3' | 'v4';
}

export async function routeUnshieldSpend<Prepared>(
  p: RouteUnshieldSpendParams<Prepared>,
): Promise<RoutedSpend> {
  let preparedV4: Prepared | null = null;
  // Asked synchronously first, so a pre-blinding note never enters the try
  // below and can never be mistaken for a prover failure.
  let v4Refusal: string | null = whyCircuit7Cannot(p.receipt);
  if (v4Refusal === null) {
    try {
      p.onProgress?.('Preparing the circuit-7 spend proof...');
      preparedV4 = await p.prepareV4();
    } catch (err: unknown) {
      if (!(err instanceof V4Unprovable)) throw err;
      v4Refusal = err.message;
    }
  }
  if (v4Refusal !== null) {
    console.warn(
      '[DenomPool/mobile] circuit 7 could not prove this note; falling back to the ' +
        'C1 + C3 pair, which publishes the note commitment:',
      v4Refusal,
    );
    // The user is TOLD the withdrawal became the linkable kind. A silent
    // downgrade is the failure mode this whole change exists to avoid.
    p.onProgress?.('Circuit 7 cannot prove this note — falling back to the C1 + C3 pair...');
  }

  // ⛔ NOTHING BELOW THIS LINE MAY FALL BACK.
  if (preparedV4 !== null) {
    return { txSig: await p.spendV4(preparedV4), version: 'v4' };
  }
  return { txSig: await p.spendPair(), version: 'v3' };
}
