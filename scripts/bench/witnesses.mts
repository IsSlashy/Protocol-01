/**
 * The witnesses the wasm runs (Node and browser) prove. They are the SAME
 * statements `programs/p01_stark_verifier/tests/bench_all_circuits.rs` proves
 * natively, so a native row and a wasm row of one circuit time one statement.
 *
 * Plain data, no imports: `browser/worker.mjs` receives this table over
 * postMessage (as strings) and calls the same exports.
 *
 * Depth 11 is `CANONICAL_DEPTH` in stark/src/air/{merkle_path,merkle_update,spend}.rs.
 *
 * Only the five circuits the shipped blob exports (0, 1, 3, 6, 7). C2, C4 and C5
 * left the blob on 2026-09-23; the native bench still proves them.
 */

export const CANONICAL_DEPTH = 11;

const csv = (n: number, f: (i: number) => number): string =>
  Array.from({ length: n }, (_, i) => String(f(i))).join(',');

export interface Witness {
  circuit: number;
  name: string;
  /** The wasm-bindgen export the web worker calls for this circuit. */
  entry: string;
  /** Arguments as strings; `kind` says which become BigInt and which stay CSV strings. */
  args: string[];
  kinds: Array<'u64' | 'csv'>;
}

const u = (...xs: number[]) => xs.map(String);

export const WITNESSES: Witness[] = [
  { circuit: 0, name: 'C0 subscriber_ownership', entry: 'generate_stark_proof', args: u(42), kinds: ['u64'] },
  { circuit: 1, name: 'C1 pool_commitment', entry: 'generate_pool_commitment_stark_proof', args: u(111, 222, 333, 444), kinds: ['u64', 'u64', 'u64', 'u64'] },
  {
    circuit: 3, name: 'C3 merkle_path', entry: 'generate_merkle_path_stark_proof',
    args: ['777', csv(CANONICAL_DEPTH, (i) => 1000 + i * 37), csv(CANONICAL_DEPTH, (i) => i % 2)],
    kinds: ['u64', 'csv', 'csv'],
  },
  {
    circuit: 6, name: 'C6 merkle_update', entry: 'generate_merkle_update_stark_proof',
    args: ['111', '222', csv(CANONICAL_DEPTH, (i) => 100 + i * 13), csv(CANONICAL_DEPTH, (i) => i % 2)],
    kinds: ['u64', 'u64', 'csv', 'csv'],
  },
  {
    circuit: 7, name: 'C7 spend', entry: 'generate_spend_stark_proof',
    args: ['42', '999', '7', '555', csv(CANONICAL_DEPTH, (i) => 1000 + i * 37), csv(CANONICAL_DEPTH, (i) => i % 2), '11,22,33,44'],
    kinds: ['u64', 'u64', 'u64', 'u64', 'csv', 'csv', 'csv'],
  },
];

/** The circuit ids the shipped blob proves, in table order: the default `--circuits`. */
export const LIVE_CIRCUITS: readonly number[] = WITNESSES.map((w) => w.circuit);

export function witnessFor(circuit: number): Witness {
  const w = WITNESSES.find((x) => x.circuit === circuit);
  if (!w) throw new Error(`unknown circuit ${circuit} (the blob proves ${LIVE_CIRCUITS.join(', ')})`);
  return w;
}

/** Turn the string table into call arguments (u64 -> BigInt, csv stays a string). */
export function callArgs(w: Witness): Array<bigint | string> {
  return w.args.map((a, i) => (w.kinds[i] === 'u64' ? BigInt(a) : a));
}
