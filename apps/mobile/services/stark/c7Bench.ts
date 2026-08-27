/**
 * c7Bench.ts — the measurement that decides whether mobile may route to v4.
 *
 * # The question, and why the recorded answer is not usable
 *
 * `providers/StarkProverProvider.tsx` gives every proof 180 000 ms before it
 * gives up. The tree records ONE reason to fear that ceiling —
 * `memory/measured-on-device-proving-exceeds-180s-2026-08-03.md` — and that
 * note RETRACTS ITSELF in its own §"SECTION 1 IS WRONG": the 180 s was a
 * WebView HANG, not proving latency. The only real device datapoint in the
 * whole repository is the line that note ends on:
 *
 *   [P01PERF] circuit=3 prover=1482 ms bridge=1546 ms proofSize=78157
 *   Galaxy 0019235AU004508, release APK 1.0.3, 2026-08-03
 *
 * 1 482 ms, not 180 000. And the RN bridge cost 64 ms of that.
 *
 * # What this file does NOT tell you
 *
 * ⛔ A number produced by `scripts/c7-bench-node.ts` is a NODE number. The
 * correction factor from Node-on-this-desktop to a phone is UNKNOWN and this
 * file does not guess one. The single C3 datapoint above happens to be FASTER
 * than the same circuit measured in Node here, but one datapoint on one circuit
 * on one device is an anecdote, not a factor — and that device carried the
 * pre-coset blob the verifier now rejects.
 *
 * The Node run answers "can C7 be produced at all by mobile's own blob and
 * mobile's own glue". Only `runC7Bench` driven through the WebView answers
 * "how long does C7 take on a phone", and that needs a phone.
 *
 * # Why a median and not a run
 *
 * C7's timings on this machine spread more than 2x across samples, on hardware
 * with recorded 14900K/RAM instability. A single run is not a measurement.
 * Default is five, and `runs` below three is refused.
 */

import { C7_BENCH_WITNESS, C7_EXPECTED_PROOF_SIZE, CIRCUIT_SPEND, type SpendWitness } from './spendWitness';

/** What one proof cost. `bridgeMs` is wall time including the WebView round
 *  trip; `proverMs` is what the WASM itself reported. On Node they coincide. */
export interface C7BenchSample {
  proverMs: number;
  bridgeMs: number;
  proofSize: number;
}

export interface C7BenchResult {
  samples: C7BenchSample[];
  proverMedianMs: number;
  proverMinMs: number;
  proverMaxMs: number;
  bridgeMedianMs: number;
  proofSize: number;
  /** False when any run returned a size other than C7_EXPECTED_PROOF_SIZE —
   *  the wire format moved and the number is not comparable to anything. */
  sizeAsExpected: boolean;
}

/** The prover call this benchmark drives. Structurally what
 *  `StarkProverProvider.generateSpendProof` returns, so the provider can be
 *  passed straight in, and so can a bare wasm export in Node. */
export type SpendProver = (w: SpendWitness) => Promise<{
  proofHex: string;
  proofSize: number;
  durationMs: number;
  publicInputs: string[];
}>;

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median of nothing');
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Runs `runs` circuit-7 proofs over the canonical synthetic witness and logs
 * one `[P01PERF]` line per proof, in the exact format the 2026-08-03 device
 * capture used — so a logcat line from a phone and a stdout line from Node are
 * the same string and can be compared without translation.
 *
 * Nothing is submitted. No RPC, no SOL: the proof is generated and discarded.
 */
export async function runC7Bench(
  prove: SpendProver,
  runs = 5,
  log: (line: string) => void = (l) => console.log(l),
): Promise<C7BenchResult> {
  if (!Number.isInteger(runs) || runs < 3) {
    throw new Error(`C7 timings spread more than 2x on this hardware; a median needs at least 3 runs, got ${runs}.`);
  }

  const samples: C7BenchSample[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const r = await prove(C7_BENCH_WITNESS);
    const bridgeMs = Date.now() - t0;
    const proverMs = typeof r.durationMs === 'number' ? r.durationMs : bridgeMs;
    samples.push({ proverMs, bridgeMs, proofSize: r.proofSize });
    log(`[P01PERF] circuit=${CIRCUIT_SPEND} prover=${proverMs} ms bridge=${bridgeMs} ms proofSize=${r.proofSize}`);
  }

  const proverMs = samples.map((s) => s.proverMs);
  const proofSize = samples[0].proofSize;
  const sizeAsExpected = samples.every((s) => s.proofSize === C7_EXPECTED_PROOF_SIZE);

  const result: C7BenchResult = {
    samples,
    proverMedianMs: median(proverMs),
    proverMinMs: Math.min(...proverMs),
    proverMaxMs: Math.max(...proverMs),
    bridgeMedianMs: median(samples.map((s) => s.bridgeMs)),
    proofSize,
    sizeAsExpected,
  };

  log(`[P01PERF] circuit=${CIRCUIT_SPEND} median=${result.proverMedianMs} ms `
    + `min=${result.proverMinMs} ms max=${result.proverMaxMs} ms n=${runs}`);
  if (!sizeAsExpected) {
    log(`[P01PERF] ⛔ proof size ${proofSize} != expected ${C7_EXPECTED_PROOF_SIZE} — `
      + 'the wire format moved; this number is not comparable to any recorded one.');
  }
  return result;
}

/**
 * The one sentence the number is allowed to support, and no more.
 *
 * ⛔ It deliberately does NOT convert to a device estimate. `where` is stamped
 * into the text so a Node number can never be quoted as a phone number.
 */
export function describeC7Headroom(result: C7BenchResult, where: 'node' | 'device'): string {
  const ceiling = 180_000;
  const factor = Math.floor(ceiling / Math.max(result.proverMedianMs, 1));
  const provenance = where === 'device'
    ? 'measured ON DEVICE'
    : 'measured in NODE — the correction factor to a phone is UNKNOWN and is not applied here';
  return `C7 median ${result.proverMedianMs} ms (${provenance}); the provider's ceiling is `
    + `${ceiling} ms, i.e. ~${factor}x headroom.`;
}
