/**
 * webviewProver.test.ts — run the two React Native provers for real.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `apps/web` and `apps/extension` reach the prover by importing this package,
 * so a type error catches a broken call. The two React Native surfaces cannot
 * import anything: their prover is an ES5 template string inside a WebView
 * `<script>`, under `script-src 'unsafe-inline' 'wasm-unsafe-eval'`. Nothing
 * compiles it, nothing type-checks it, and `packages/react-native-zk` ships
 * `"test": "echo \"Tests require React Native environment\""`.
 *
 * 🚨 SO UNTIL THIS FILE, THOSE TWO SURFACES HAD NO EXECUTABLE COVERAGE AT ALL.
 * That is not hypothetical harm: both of them carried a hand-rolled
 * wasm-bindgen ABI with exactly ONE import entry, and the circuit-7 blob needs
 * TWENTY-FIVE. They would have failed at proof time — which on this path is
 * after ~87 upload transactions and ~1 SOL of buffer rent, not at load.
 *
 * WHAT IT ACTUALLY DOES
 * ─────────────────────
 * Extracts each prover's HTML from its own source file, evaluates its
 * `<script>` blocks in a `vm` realm holding ONLY what a WebView exposes —
 * WebAssembly, TextDecoder, TextEncoder, crypto, atob, performance — with no
 * Node built-ins, no require, no module system, then drives it through the same
 * `postMessage` protocol the component uses and requires a real proof back.
 *
 * ⚠️ A realm is not a WebView. This cannot see a CSP violation, a Hermes/JSC
 * parser difference, or `ReactNativeWebView` transport limits. It answers one
 * question — "does this prover, as written, load the shipped blob and produce a
 * proof?" — which is precisely the question that was going unanswered.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../..');

const BLOB = resolve(REPO, 'packages/stark-prover/wasm/p01_stark_bg.wasm');
const WASM_BASE64 = readFileSync(BLOB).toString('base64');

interface Surface {
  readonly label: string;
  /** The .tsx carrying the prover HTML. */
  readonly source: string;
  /** The `const` the HTML is assigned to. */
  readonly constant: string;
  /** The generated-glue twin this surface imports. */
  readonly glue: string;
  /** Payload that asks for a circuit-1 (pool commitment) proof. */
  readonly poolRequest: Record<string, unknown>;
  /** Payload that initialises the module. */
  readonly initRequest: (base64: string) => Record<string, unknown>;
}

const SURFACES: readonly Surface[] = [
  {
    label: 'apps/mobile',
    source: 'apps/mobile/services/stark/StarkProver.tsx',
    constant: 'STARK_HTML',
    glue: 'apps/mobile/services/stark/starkGlueIife.ts',
    initRequest: (base64) => ({ type: 'initWasm', wasmBase64: base64 }),
    poolRequest: { type: 'generatePoolProof', id: 'p1', args: ['11', '22', '0', '33'] },
  },
  {
    label: 'packages/react-native-zk',
    source: 'packages/react-native-zk/src/ZKProver.tsx',
    constant: 'PROVER_HTML_HEAD',
    glue: 'packages/react-native-zk/src/glueIife.ts',
    initRequest: (base64) => ({ type: 'init', wasm: base64 }),
    poolRequest: {
      type: 'generatePoolProof',
      id: 'p1',
      nullifierPreimage: '11',
      secret: '22',
      epoch: '0',
      mint: '33',
    },
  },
];

/** Pull `const NAME = \`…\`;` out of a source file, verbatim. */
function extractTemplate(src: string, name: string): string {
  const decl = `const ${name} = \``;
  const i = src.indexOf(decl);
  if (i < 0) throw new Error(`${name} not found — the prover was renamed?`);
  const start = i + decl.length;
  const end = src.indexOf('`', start);
  if (end < 0) throw new Error(`${name} has no closing backtick`);
  const tpl = src.slice(start, end);
  // The first backtick after the opening one is where TypeScript ends the
  // literal too — so if it is not the one after </html>, the page is cut
  // short for the app exactly as it is here. That happened on 2026-08-31: a
  // comment inside the mobile prover quoted three file names in backticks,
  // and this test reported "expected 1 to be 2" script tags, which reads like
  // a dropped glue injection rather than what it was.
  if (!tpl.trimEnd().endsWith('</html>')) {
    const line = src.slice(0, end).split('\n').length;
    throw new Error(`${name} is closed by a backtick at line ${line}, before </html> — `
      + 'a backtick anywhere inside the template, comments included, ends the literal there');
  }
  return tpl;
}

/** The glue source, as the surface's own twin carries it. */
function readGlue(rel: string): string {
  const src = readFileSync(resolve(REPO, rel), 'utf8');
  const m = src.match(/export const STARK_GLUE_IIFE = ([\s\S]*);\n$/);
  if (!m) throw new Error(`${rel} does not export STARK_GLUE_IIFE`);
  return JSON.parse(m[1]) as string;
}

interface Post {
  type: string;
  id?: string;
  error?: string;
  proofHex?: string;
  proofSize?: number;
  circuitId?: number;
  commitment?: string;
  nullifier?: string;
  publicInputs?: string[];
}

/**
 * Evaluate the prover's scripts in a bare realm and return both the posts it
 * made and a way to feed it more messages.
 */
function bootProver(html: string): {
  posts: Post[];
  send: (payload: Record<string, unknown>) => void;
} {
  const posts: Post[] = [];
  const handlers: Array<(e: { data: string }) => void> = [];

  const listen = (type: string, fn: (e: { data: string }) => void): void => {
    if (type === 'message') handlers.push(fn);
  };

  // ⛔ Deliberately minimal. Adding a Node global here would let the prover
  // depend on something a WebView does not have, and this test would still
  // pass. Everything below is present in a React Native WebView.
  const sandbox: Record<string, unknown> = {
    WebAssembly,
    TextDecoder,
    TextEncoder,
    atob,
    crypto: globalThis.crypto,
    performance,
    console,
    ReactNativeWebView: {
      postMessage: (s: string) => { posts.push(JSON.parse(s) as Post); },
    },
    addEventListener: listen,
    document: { addEventListener: listen },
  };
  // In a WebView `window`, `self` and `globalThis` are ONE object, and this
  // realm has to say so. Until 2026-09-02 `window` was a separate literal
  // holding only ReactNativeWebView and addEventListener — harmless while
  // circuit 1 was deterministic. Since the lift-column wave every circuit
  // draws a CSPRNG mask, and the glue reaches the CSPRNG through js-sys's
  // global lookup: `self`, then `window`, then `globalThis`, then `global`,
  // in that order (the four `__wbg_static_accessor_*` imports). A `window`
  // without `crypto` won that lookup and the prover refused with "Web Crypto
  // API is unavailable" — a harness artefact no phone reproduces, because
  // `window.crypto` is defined wherever `crypto` is. MEASURED 2026-09-02: the
  // same HTML, with `crypto` reachable through `window`, proves circuit 1
  // (94,897 bytes). Nothing from Node is added here; the anti-vacuity above
  // still holds. `apps/mobile/services/stark/webviewSpend.test.ts` has
  // carried the same shape since 2026-08-27.
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = createContext(sandbox);

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length, 'expected a glue tag and a prover tag').toBe(2);
  for (const s of scripts) runInContext(s, ctx, { timeout: 120_000 });

  return {
    posts,
    send: (payload) => {
      const e = { data: JSON.stringify(payload) };
      for (const h of handlers) h(e);
    },
  };
}

describe.each(SURFACES)('$label WebView prover', (surface) => {
  const src = readFileSync(resolve(REPO, surface.source), 'utf8');
  const raw = extractTemplate(src, surface.constant);

  it('injects the generated glue exactly once', () => {
    // Anti-vacuity. Without this, dropping the injection would leave the tests
    // below failing for a reason that reads like a prover bug.
    const hits = raw.split('${STARK_GLUE_IIFE}').length - 1;
    expect(hits, 'the HTML must interpolate the glue exactly once').toBe(1);
  });

  it('carries no hand-rolled wasm-bindgen ABI', () => {
    // The five copies of this ABI were the actual defect. `__wbindgen_` names
    // belong to the generated glue and must not reappear in hand-written code.
    //
    // Scan the CODE, not the prose: the note left in each prover deliberately
    // names every symbol it replaced, so scanning the raw text would fail on
    // the explanation of the very fix it is checking for.
    const code = raw.replace(/^\s*\/\/.*$/gm, '');
    for (const dead of ['passStringToWasm', 'readStringReturn', '__wbindgen_malloc',
      '__wbindgen_free', '__wbindgen_start']) {
      expect(code, `${dead} is back in ${surface.source}`).not.toContain(dead);
    }
  });

  const html = raw.replace('${STARK_GLUE_IIFE}', readGlue(surface.glue));

  it('loads the shipped blob and proves circuit 1', { timeout: 180_000 }, () => {
    const { posts, send } = bootProver(html);
    expect(posts.map((p) => p.type)).toContain('ready');

    send(surface.initRequest(WASM_BASE64));
    const err = posts.find((p) => p.type === 'wasmError');
    expect(err?.error ?? null, 'the module failed to instantiate').toBeNull();
    expect(posts.some((p) => p.type === 'wasmLoaded')).toBe(true);

    send(surface.poolRequest);
    const failed = posts.find((p) => p.type === 'error');
    expect(failed?.error ?? null, 'proving failed').toBeNull();

    const proof = posts.find((p) => p.type === 'proof' && p.id === 'p1');
    expect(proof, 'no proof came back').toBeDefined();
    expect(proof!.circuitId).toBe(1);
    // A real proof, not an empty envelope: the hex must be the declared length.
    expect(proof!.proofSize).toBeGreaterThan(10_000);
    expect(proof!.proofHex!.length).toBe(proof!.proofSize! * 2);
    expect(proof!.nullifier).toMatch(/^\d+$/);
  });

  it('refuses to prove before the module is loaded', () => {
    const { posts, send } = bootProver(html);
    send(surface.poolRequest);
    const failed = posts.find((p) => p.type === 'error');
    expect(failed?.error ?? '').toContain('not initialized');
  });
});
