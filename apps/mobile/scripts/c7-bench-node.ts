/**
 * c7-bench-node.ts — run mobile's OWN circuit-7 prover, outside a WebView.
 *
 *   N24="/c/Users/amirr/AppData/Roaming/fnm/node-versions/v24.19.0/installation"
 *   export PATH="$N24:$PATH"
 *   ./node_modules/.bin/tsx apps/mobile/scripts/c7-bench-node.ts [--runs 5]
 *
 * (from the repo root — `tsx` lives in the root node_modules.)
 *
 * # What this measures, and what it does not
 *
 * ✅ It measures that `services/stark/wasmData.ts` and
 * `services/stark/starkGlueIife.ts` — the two files the WebView actually loads,
 * loaded here the same way the WebView loads them: the IIFE evaluated as a
 * script, then `initSync` on a `WebAssembly.Module` built from the base64 —
 * can produce a circuit-7 proof, and that its public inputs are BYTE-FOR-BYTE
 * the ones `packages/stark-prover/scripts/c7-live-proof.ts` gets from the
 * package's own loader. Before this script existed, mobile's glue had never
 * been executed anywhere: it was generated, committed, and shipped unrun.
 *
 * ⛔ It does NOT measure how long C7 takes on a phone. This is Node on a
 * desktop. THE CORRECTION FACTOR TO A DEVICE IS UNKNOWN and this script does
 * not invent one. Do not quote a number from here as a device number.
 *
 * The device number comes from the same benchmark driven through the WebView —
 * Settings → About → seven taps → Privacy tech tests → "Circuit 7 spend proof"
 * — read off `adb logcat -s ReactNativeJS`. Both print the identical
 * `[P01PERF]` line, so the two can be compared without translation.
 *
 * NO RPC. NO SOL. The proof is generated and discarded.
 */

import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';

import { STARK_WASM_BASE64 } from '../services/stark/wasmData';
import { STARK_GLUE_IIFE } from '../services/stark/starkGlueIife';
import { runC7Bench, describeC7Headroom, type SpendProver } from '../services/stark/c7Bench';
import { C7_EXPECTED_PROOF_SIZE } from '../services/stark/spendWitness';

/** What `c7-live-proof.ts --dry-run` reports for C7_BENCH_WITNESS against the
 *  package's own copy of the blob. Mobile's copy must agree exactly, or the two
 *  twins have drifted and every proof this client makes is rejected on chain. */
const REFERENCE = {
  nullifier: '8223017349269710682',
  root: '5529976937288699293',
  proofSize: C7_EXPECTED_PROOF_SIZE,
};

interface SpendJson {
  circuit_id: number;
  nullifier: string;
  root: string;
  recipient_hash: [string, string, string, string];
  proof_hex: string;
  proof_size: number;
  error?: string;
}

interface Glue {
  initSync(m: { module: WebAssembly.Module }): unknown;
  generate_spend_stark_proof?: (
    nullifierPreimage: bigint, secret: bigint, blinding: bigint, tokenMint: bigint,
    pathElementsCsv: string, pathIndicesCsv: string, recipientHashCsv: string,
  ) => string;
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function main(): void {
  const runs = arg('runs', 5);

  console.log('=== C7 on mobile\'s own blob and glue — IN NODE ==============');

  // Exactly what the WebView does: evaluate the IIFE as a script, then reach
  // for the single global it assigns. If the bundling ever stops assigning
  // `P01StarkGlue`, the WebView breaks in the same way and this catches it here.
  const glue = runInThisContext(`${STARK_GLUE_IIFE}\nP01StarkGlue;`) as Glue | undefined;
  if (!glue || typeof glue.initSync !== 'function') {
    console.error('FAIL — starkGlueIife.ts did not yield a P01StarkGlue with initSync.');
    process.exit(1);
  }

  const bytes = Buffer.from(STARK_WASM_BASE64, 'base64');
  console.log(`  blob             ${bytes.length.toLocaleString()} bytes (from wasmData.ts)`);

  const require_ = createRequire(import.meta.url);
  const { createHash } = require_('node:crypto') as typeof import('node:crypto');
  console.log(`  blob sha256      ${createHash('sha256').update(bytes).digest('hex')}`);

  glue.initSync({ module: new WebAssembly.Module(bytes) });

  const spend = glue.generate_spend_stark_proof;
  if (typeof spend !== 'function') {
    console.error('FAIL — mobile\'s glue does not export generate_spend_stark_proof.');
    console.error('       The twins are stale, or they carry the pre-C7 blob.');
    process.exit(1);
  }

  let last: SpendJson | null = null;
  const prove: SpendProver = async (w) => {
    const t0 = Date.now();
    const json = JSON.parse(spend(
      BigInt(w.nullifierPreimage), BigInt(w.secret), BigInt(w.blinding), BigInt(w.tokenMint),
      w.pathElements.join(','), w.pathIndices.join(','), w.recipientHash.join(','),
    )) as SpendJson;
    const durationMs = Date.now() - t0;
    if (json.error) throw new Error(`the prover refused: ${json.error}`);
    last = json;
    return {
      proofHex: json.proof_hex,
      proofSize: json.proof_size,
      durationMs,
      publicInputs: [json.nullifier, json.root, ...json.recipient_hash],
    };
  };

  console.log(`  witness          the one c7-live-proof.ts uses, felt for felt`);
  console.log(`  runs             ${runs}\n`);

  runC7Bench(prove, runs).then((result) => {
    const j = last as SpendJson | null;
    if (!j) { console.error('FAIL — no proof was produced.'); process.exit(1); }

    console.log('');
    console.log(`  circuit          ${j.circuit_id}`);
    console.log(`  proof            ${j.proof_size.toLocaleString()} bytes`
      + `  (${Math.ceil(j.proof_size / 1000)} chunks, 1 buffer)`);
    console.log(`  nullifier        ${j.nullifier}`);
    console.log(`  subtree root     ${j.root}`);
    console.log(`  public inputs    ${2 + j.recipient_hash.length} felts, order-sensitive`);
    console.log('');
    console.log(`  ${describeC7Headroom(result, 'node')}`);

    // The equivalence check. This is the point of the script: mobile's twins
    // must be the package's blob, proven by behaviour and not by a hash alone.
    const drift: string[] = [];
    if (j.circuit_id !== 7) drift.push(`circuit_id ${j.circuit_id} != 7`);
    if (j.nullifier !== REFERENCE.nullifier) drift.push(`nullifier ${j.nullifier} != ${REFERENCE.nullifier}`);
    if (j.root !== REFERENCE.root) drift.push(`root ${j.root} != ${REFERENCE.root}`);
    if (j.proof_size !== REFERENCE.proofSize) drift.push(`proof_size ${j.proof_size} != ${REFERENCE.proofSize}`);

    console.log('');
    if (drift.length > 0) {
      console.error('FAIL — mobile\'s twins disagree with packages/stark-prover:');
      for (const d of drift) console.error(`       · ${d}`);
      console.error('       Regenerate with stark-wasm-twins.mjs --write and stark-glue-iife.mjs --write.');
      process.exit(1);
    }
    console.log('  PASS — mobile\'s blob and glue reproduce c7-live-proof.ts exactly.');
    console.log('  ⛔ This is a NODE number. The factor to a phone is UNKNOWN.');
  }).catch((err: unknown) => {
    console.error(`FAIL — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });

}

main();
