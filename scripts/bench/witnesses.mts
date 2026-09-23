/**
 * The witnesses the wasm runs (Node and browser) prove. They are the SAME
 * statements `programs/p01_stark_verifier/tests/bench_all_circuits.rs` proves
 * natively, so a native row and a wasm row of one circuit time one statement.
 *
 * Plain data, no imports: `browser/worker.mjs` receives this table over
 * postMessage (as strings) and calls the same exports.
 *
 * Depth 11 is `CANONICAL_DEPTH` in stark/src/air/{merkle_path,merkle_update,spend}.rs.
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
  { circuit: 2, name: 'C2 balance_proof', entry: 'generate_balance_stark_proof', args: u(42, 1000, 777, 999), kinds: ['u64', 'u64', 'u64', 'u64'] },
  {
    circuit: 3, name: 'C3 merkle_path', entry: 'generate_merkle_path_stark_proof',
    args: ['777', csv(CANONICAL_DEPTH, (i) => 1000 + i * 37), csv(CANONICAL_DEPTH, (i) => i % 2)],
    kinds: ['u64', 'csv', 'csv'],
  },
  {
    circuit: 4, name: 'C4 confidential_balance', entry: 'generate_confidential_balance_stark_proof',
    args: u(42, 1000, 111, 800, 222, 200, 333, 999), kinds: Array(8).fill('u64'),
  },
  {
    circuit: 5, name: 'C5 transfer', entry: 'generate_transfer_stark_proof',
    args: u(13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50), kinds: Array(13).fill('u64'),
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

export function witnessFor(circuit: number): Witness {
  const w = WITNESSES.find((x) => x.circuit === circuit);
  if (!w) throw new Error(`unknown circuit ${circuit} (0..7)`);
  return w;
}

/** Turn the string table into call arguments (u64 -> BigInt, csv stays a string). */
export function callArgs(w: Witness): Array<bigint | string> {
  return w.args.map((a, i) => (w.kinds[i] === 'u64' ? BigInt(a) : a));
}
