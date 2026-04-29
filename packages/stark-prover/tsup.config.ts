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
  outDir: 'dist',
  // Treat the host SDK + Solana web3 as externals — peer deps.
  external: ['@protocol-01/privacy-sdk', '@solana/web3.js'],
});
