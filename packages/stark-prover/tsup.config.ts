import { defineConfig } from 'tsup';

/**
 * tsup config for @protocol-01/stark-prover.
 *
 * The WASM blob (`wasm/p01_stark_bg.wasm`) is shipped verbatim under the
 * package's `files` field — we don't bundle it into the JS output. The
 * `wasm-loader` resolves it at runtime via dynamic import (Node) or fetch
 * (Browser), with a base64 fallback for environments where neither works
 * (Service Workers, MV3 background pages).
 *
 * Keep splitting:false so the dist tree mirrors the entry list 1:1 — easier
 * to consume from React Native and other bundlers that fight code-splitting.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'wasm-loader': 'src/wasm-loader.ts',
    'upload-protocol': 'src/upload-protocol.ts',
    types: 'src/types.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  treeshake: true,
  minify: false,
  sourcemap: true,
  splitting: false,
  target: 'es2020',

  // ⛔ WITHOUT THIS LINE apps/web DOES NOT BUILD AT ALL.
  //
  // tsup 8 ships `removeNodeProtocol: true` as a hard-coded default (measured
  // in node_modules/tsup/dist/index.js, whose node-protocol plugin rewrites
  // `node:X` to `X` marked external). So `import('node:fs/promises')` in
  // wasm-loader.ts reached dist as `import('fs/promises')`.
  //
  // To Node those are the same module. To a BROWSER bundler they are not: the
  // prefixed form is an unmistakable builtin it can leave alone, while the bare
  // form is a package name it must resolve and cannot find. Turbopack failed on
  // it and every Vercel deployment from 2026-08-26 16:45 onward went ERROR —
  // five in a row, none of them noticed, because nothing in CI builds this app.
  //
  // ⚠️ IT IS NOT esbuild. Measured directly through its transform API: es2020,
  // node18, both together, platform node and platform neutral ALL keep the
  // prefix. Reasoning about the target was a wrong lead and cost a rebuild.
  //
  // MEASURED after: grep -c "node:fs/promises" dist/wasm-loader.mjs goes 0 -> 3
  // in both .mjs and .js, and the wasm blob sha256 stays 72a8c700c466a296.
  removeNodeProtocol: false,

  /**
   * ⛔ THE SECOND HALF OF THE SAME BUILD FAILURE. Fixing the node: prefix alone
   * still left apps/web unable to build.
   *
   * The wasm-bindgen glue in wasm/p01_stark.js contains
   * `new URL("p01_stark_bg.wasm", import.meta.url)`, and tsup inlines that glue
   * into dist/. A browser bundler treats that expression as an ASSET REFERENCE
   * and resolves it at build time, relative to the emitting module — so it looks
   * for dist/p01_stark_bg.wasm, which did not exist. The blob lives one level up
   * in wasm/, where the package's own exports map points.
   *
   * ⚠️ THAT CODE PATH IS DEAD IN THE BROWSER AND THE COPY IS STILL REQUIRED.
   * apps/web calls `initStarkWasm({ base64: STARK_WASM_BASE64 })`, so this URL
   * is never read at runtime there. Bundlers resolve statically; being
   * unreachable does not save it.
   *
   * A copy, not a move: wasm/ stays where package.json's "./wasm/*" exports and
   * the Node resolution paths in wasm-loader.ts expect it. Both files must
   * remain byte-identical — the deployed verifier rejects a proof from any other
   * blob, which is the failure recorded on 2026-08-04 for stark-prover@0.1.2.
   * shippedBlob.test.ts is what holds that line; this copy is inside its scope.
   */
  async onSuccess() {
    const { copyFile, mkdir } = await import('node:fs/promises');
    await mkdir('dist', { recursive: true });
    for (const f of ['p01_stark_bg.wasm', 'p01_stark.js']) {
      await copyFile(`wasm/${f}`, `dist/${f}`);
    }
  },
  outDir: 'dist',
  // Treat the host SDK + Solana web3 as externals — peer deps.
  external: ['@protocol-01/privacy-sdk', '@solana/web3.js'],
});
