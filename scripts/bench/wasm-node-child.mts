/**
 * One Node process proving with the SHIPPED wasm blob, through the package's
 * own loader (`initStarkWasm`), the same way the app's worker does. Spawned by
 * run.mts; prints one line `BENCH_JSON {...}` on stdout.
 *
 *   npx tsx scripts/bench/wasm-node-child.mts --mode warm --circuits 0,7 --n 30
 *   npx tsx scripts/bench/wasm-node-child.mts --mode cold --circuits 7
 *
 * warm: instantiate once, then per circuit one DISCARDED warm-up call and n
 *       timed calls in the same instance.
 * cold: instantiate, then ONE timed call. The parent spawns a new process per
 *       cold sample, so nothing (module, JIT, allocator) is carried over.
 *
 * Timed: the export call alone (`generate_*_stark_proof(...)` returning the JSON
 * string), which is exactly what `starkProver.worker.ts` puts in `durationMs`.
 * Not timed: parsing that JSON, hex decoding, anything on chain.
 * Every proof is new: the wasm draws its blinding mask from the CSPRNG on every
 * call, so no two samples prove the same bytes.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { initStarkWasm } from '../../packages/stark-prover/src/wasm-loader.ts';
import { WITNESSES, callArgs, witnessFor } from './witnesses.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const BLOB = path.resolve(here, '../../packages/stark-prover/wasm/p01_stark_bg.wasm');

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const mode = opt('mode') ?? 'warm';
const n = Number(opt('n') ?? 1);
const circuits = (opt('circuits') ?? WITNESSES.map((w) => w.circuit).join(','))
  .split(',').map((c) => Number(c.trim()));

type Fn = (...a: Array<bigint | string>) => string;

function proveOnce(exp: Record<string, unknown>, circuit: number) {
  const w = witnessFor(circuit);
  const fn = exp[w.entry] as Fn | undefined;
  if (typeof fn !== 'function') throw new Error(`the shipped blob does not export ${w.entry}`);
  const a = callArgs(w);
  const t0 = performance.now();
  const out = fn(...a);
  const ms = performance.now() - t0;
  const j = JSON.parse(out) as { error?: string; proof_hex?: string; proof_size?: number };
  if (j.error) throw new Error(`C${circuit} prover refused: ${j.error}`);
  const bytes = j.proof_size ?? (j.proof_hex ? j.proof_hex.length / 2 : 0);
  if (!(bytes > 0)) throw new Error(`C${circuit}: empty proof`);
  // A digest of the proof proves the samples are distinct proofs (fresh mask).
  const digest = createHash('sha256').update(j.proof_hex ?? '').digest('hex').slice(0, 16);
  return { ms, bytes, digest };
}

async function main() {
  const bytes = new Uint8Array(readFileSync(BLOB));
  const blobSha256 = createHash('sha256').update(bytes).digest('hex');
  const tInit = performance.now();
  const exp = (await initStarkWasm({ bytes })) as unknown as Record<string, unknown>;
  const initMs = performance.now() - tInit;

  const result: Record<string, unknown> = {
    mode, node: process.version, blob_sha256: blobSha256, blob_bytes: bytes.length, init_ms: initMs, circuits: {},
  };
  const out = result.circuits as Record<string, unknown>;
  if (mode === 'cold') {
    if (circuits.length !== 1) throw new Error('--mode cold proves exactly one circuit per process');
    const r = proveOnce(exp, circuits[0]);
    out[`C${circuits[0]}`] = { prove_ms: [r.ms], bytes: r.bytes, digests: [r.digest] };
  } else {
    for (const c of circuits) {
      const warm = proveOnce(exp, c); // discarded warm-up
      const ms: number[] = [];
      const digests: string[] = [];
      let size = warm.bytes;
      for (let i = 0; i < n; i++) {
        const r = proveOnce(exp, c);
        ms.push(r.ms);
        digests.push(r.digest);
        size = r.bytes;
      }
      out[`C${c}`] = { warmup_ms: warm.ms, prove_ms: ms, bytes: size, digests };
    }
  }
  process.stdout.write(`BENCH_JSON ${JSON.stringify(result)}\n`);
}

main().catch((e) => {
  process.stderr.write(`FAIL ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
