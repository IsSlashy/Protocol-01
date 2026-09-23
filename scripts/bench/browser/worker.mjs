// Module worker for the in-browser prover benchmark. It does what the app's
// `apps/web/lib/privacy/pool/starkProver.worker.ts` does through
// `initStarkWasm({ base64 })`: take the blob's bytes, `new WebAssembly.Module`,
// then the generated glue's `initSync`, then call one export per proof.
//
// The only difference is where the bytes come from: the app decodes a base64
// constant bundled into its JS; this worker fetches the same file from the
// local bench server. The fetch is timed separately and NOT counted as init.

let glue = null;

async function init() {
  const t0 = performance.now();
  const res = await fetch('/wasm/p01_stark_bg.wasm', { cache: 'no-store' });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tFetched = performance.now();
  glue = await import('/glue/p01_stark.js');
  const tImported = performance.now();
  glue.initSync({ module: new WebAssembly.Module(bytes) });
  const tReady = performance.now();
  return {
    fetch_ms: tFetched - t0,
    glue_import_ms: tImported - tFetched,
    init_ms: tReady - tImported,
    blob_bytes: bytes.length,
  };
}

async function digest(hex) {
  const buf = new TextEncoder().encode(hex);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function prove(w) {
  const fn = glue[w.entry];
  if (typeof fn !== 'function') throw new Error(`the blob does not export ${w.entry}`);
  const a = w.args.map((x, i) => (w.kinds[i] === 'u64' ? BigInt(x) : x));
  const t0 = performance.now();
  const out = fn(...a);
  const ms = performance.now() - t0;
  const j = JSON.parse(out);
  if (j.error) throw new Error(`C${w.circuit} prover refused: ${j.error}`);
  const bytes = j.proof_size ?? (j.proof_hex ? j.proof_hex.length / 2 : 0);
  return { ms, bytes, digest: await digest(j.proof_hex ?? '') };
}

self.onmessage = async (e) => {
  const { id, cmd, witness } = e.data;
  try {
    if (cmd === 'init') self.postMessage({ id, ok: true, value: await init() });
    else if (cmd === 'prove') self.postMessage({ id, ok: true, value: await prove(witness) });
    else throw new Error(`unknown cmd ${cmd}`);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
