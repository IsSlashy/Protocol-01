/**
 * Runs the WebView's OWN script — the ES5 string that ships inside
 * `StarkProver.tsx`'s `STARK_HTML` — against mobile's OWN wasm blob, and asks
 * it for a real circuit-7 proof.
 *
 * # Why this exists
 *
 * Until 2026-08-27 mobile had NO spend entry point at any of the three bridge
 * layers: no `generateSpendProof` case in the WebView switch, no method on
 * `StarkProverHandle`, no wrapper in `StarkProverProvider`. The blob and the
 * glue were fine and had been for weeks — nobody could reach them.
 *
 * A unit test of the TypeScript wrappers would not have caught that, because
 * the part that was missing is a STRING. `STARK_HTML` is a template literal:
 * TypeScript does not parse its contents, ESLint does not lint them, and the
 * bundler ships them verbatim. A typo inside it fails at runtime on a phone, in
 * a hidden 1x1 WebView, as a promise that never settles — which is exactly what
 * the "180 s on-device proving" scare of 2026-08-03 turned out to be.
 *
 * So the string is extracted from the file as text and executed. Short of
 * building an APK, it is the only way to know it runs at all.
 *
 * # What this does NOT prove
 *
 * ⛔ NOT a timing measurement. Node on a desktop is not a phone and the
 * correction factor is UNKNOWN. For the device number see `c7Bench.ts`.
 *
 * ⛔ NOT that the chain accepts the proof. Only a submission proves that —
 * `packages/stark-prover/scripts/c7-live-proof.ts` without `--dry-run`. What it
 * does prove is that the public inputs are identical to the ones that script
 * gets from the package's own loader, which is the thing that would otherwise
 * drift in silence.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, it, expect } from 'vitest';

import { STARK_WASM_BASE64 } from './wasmData';
import { STARK_GLUE_IIFE } from './starkGlueIife';
import { C7_BENCH_WITNESS, C7_EXPECTED_PROOF_SIZE } from './spendWitness';

/**
 * What `c7-live-proof.ts --dry-run` reports for this witness.
 *
 * ⚠ THE ROOT MOVED WITH THE DEPTH AND THE NULLIFIER DID NOT, which is the
 * shape to expect. The nullifier is `poseidon(nullifierPreimage, secret)` and
 * knows nothing about the tree; the root folds the PATH, so cutting circuit 7's
 * subtree from 12 levels to 11 changes it and must. It was
 * 5529976937288699293 while the witness carried twelve elements.
 *
 * Measured by driving the shipped blob in this very test, not copied from a
 * comment: the WebView computed it from the same wasm the app loads.
 */
const REFERENCE_NULLIFIER = '8223017349269710682';
const REFERENCE_ROOT = '17585268705969894025';

const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g');
const LF = String.fromCharCode(10);

/** Pull the second <script> body out of STARK_HTML, as text. */
function extractWebViewScript(): string {
  const src = readFileSync(join(__dirname, 'StarkProver.tsx'), 'utf8').replace(CRLF, LF);
  const marker = '<script>' + LF + '(function() {';
  const open = src.indexOf(marker);
  expect(open, 'STARK_HTML no longer contains the WebView IIFE').toBeGreaterThan(-1);
  const body = src.slice(open + ('<script>' + LF).length);
  const close = body.indexOf(LF + '</script>');
  expect(close, 'the WebView IIFE is not closed').toBeGreaterThan(-1);
  return body.slice(0, close);
}

interface Posted {
  type: string;
  id?: string;
  error?: string;
  circuitId?: number;
  publicInputs?: string[];
  proofHex?: string;
  proofSize?: number;
  durationMs?: number;
}

/**
 * Stand up the WebView's globals, load both <script> tags in order, and return
 * a driver that posts a message in and collects what comes back out.
 */
function bootWebView(): { send: (msg: unknown) => Posted[]; posted: Posted[] } {
  const posted: Posted[] = [];
  // The script registers the SAME handler on both `document` and `window`
  // (Android and iOS deliver on different targets). `inject()` only ever calls
  // window.postMessage, so only the window list is dispatched — collapsing the
  // two here would double every reply and hide a genuine duplicate-post bug.
  const windowListeners: ((e: { data: string }) => void)[] = [];
  const documentListeners: ((e: { data: string }) => void)[] = [];

  const target = {
    addEventListener: (_t: string, fn: (e: { data: string }) => void) => { windowListeners.push(fn); },
    ReactNativeWebView: {
      postMessage: (s: string) => { posted.push(JSON.parse(s) as Posted); },
    },
    // The C7 blob draws a 1,280-element CSPRNG mask; without this the glue's
    // getrandom shim throws and no spend proof can be built at all.
    crypto: globalThis.crypto,
  };

  const sandbox: Record<string, unknown> = {
    window: target,
    self: target,
    document: {
      addEventListener: (_t: string, fn: (e: { data: string }) => void) => { documentListeners.push(fn); },
    },
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    console: globalThis.console,
    atob: (b64: string) => Buffer.from(b64, 'base64').toString('binary'),
  };
  sandbox.globalThis = sandbox;
  const ctx = createContext(sandbox);

  // The two <script> tags, in the order the WebView loads them.
  runInContext(STARK_GLUE_IIFE, ctx);
  runInContext(extractWebViewScript(), ctx);

  // Both targets must be wired, or one of the two platforms is deaf.
  expect(windowListeners, 'the script stopped listening on window').toHaveLength(1);
  expect(documentListeners, 'the script stopped listening on document').toHaveLength(1);

  return {
    posted,
    send(msg: unknown) {
      const before = posted.length;
      // `inject()` calls window.postMessage(JSON.stringify(msg)) — a STRING.
      for (const fn of windowListeners) fn({ data: JSON.stringify(msg) });
      return posted.slice(before);
    },
  };
}

describe("the WebView's own script, executed", () => {
  it('announces ready, then loads the C7 blob', () => {
    const wv = bootWebView();
    expect(wv.posted.map((p) => p.type)).toContain('ready');

    const out = wv.send({ type: 'initWasm', wasmBase64: STARK_WASM_BASE64 });
    expect(out.map((p) => p.type)).toEqual(['wasmLoaded']);
  });

  it(
    'produces a real circuit-7 proof with the six public inputs in order',
    () => {
      const wv = bootWebView();
      wv.send({ type: 'initWasm', wasmBase64: STARK_WASM_BASE64 });

      const out = wv.send({ type: 'generateSpendProof', id: 'c7_1', ...C7_BENCH_WITNESS });
      expect(out).toHaveLength(1);
      const msg = out[0];
      expect(msg.error, 'the WebView refused: ' + msg.error).toBeUndefined();
      expect(msg.type).toBe('proof');
      expect(msg.id).toBe('c7_1');
      expect(msg.circuitId).toBe(7);
      expect(msg.proofSize).toBe(C7_EXPECTED_PROOF_SIZE);
      expect(msg.proofHex).toHaveLength(C7_EXPECTED_PROOF_SIZE * 2);
      expect(typeof msg.durationMs).toBe('number');

      // ⛔ ORDER-SENSITIVE. `unshield_denominated_stark_v4` rebuilds these same
      // 48 bytes to compare against the buffer's public_inputs_hash. Sorting or
      // reordering breaks that hash, and the failure lands after the whole
      // 78-chunk upload rather than early.
      expect(msg.publicInputs).toEqual([
        REFERENCE_NULLIFIER,
        REFERENCE_ROOT,
        ...C7_BENCH_WITNESS.recipientHash,
      ]);
    },
    120_000,
  );

  it('refuses a short path instead of proving a tree nobody uses', () => {
    const wv = bootWebView();
    wv.send({ type: 'initWasm', wasmBase64: STARK_WASM_BASE64 });

    const out = wv.send({
      type: 'generateSpendProof', id: 'c7_short',
      ...C7_BENCH_WITNESS,
      pathElements: C7_BENCH_WITNESS.pathElements.slice(0, 10),
      pathIndices: C7_BENCH_WITNESS.pathIndices.slice(0, 10),
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('error');
    expect(out[0].error).toMatch(/exactly 11 path elements/);
  });

  it('refuses a recipient hash that is not four limbs', () => {
    const wv = bootWebView();
    wv.send({ type: 'initWasm', wasmBase64: STARK_WASM_BASE64 });

    const out = wv.send({
      type: 'generateSpendProof', id: 'c7_rh',
      ...C7_BENCH_WITNESS,
      recipientHash: ['1', '2', '3'],
    });
    expect(out[0].type).toBe('error');
    expect(out[0].error).toMatch(/4 recipientHash limbs, got 3/);
  });

  it('refuses to prove before the blob is loaded', () => {
    const wv = bootWebView();
    const out = wv.send({ type: 'generateSpendProof', id: 'c7_cold', ...C7_BENCH_WITNESS });
    expect(out[0].type).toBe('error');
    expect(out[0].error).toMatch(/WASM not initialized/);
  });
});
