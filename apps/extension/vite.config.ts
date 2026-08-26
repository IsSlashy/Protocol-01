import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import { build } from 'esbuild';
import manifest from './manifest.json';

// Build inject script + polyfills to public folder before vite runs
const buildPreScripts = () => ({
  name: 'build-pre-scripts',
  async config() {
    // Build inject script
    await build({
      entryPoints: [resolve(__dirname, 'src/inject/index.ts')],
      outfile: resolve(__dirname, 'public/inject.js'),
      bundle: true,
      format: 'iife',
      target: 'es2020',
      minify: false,
    });
    // Build polyfills (Buffer, process, global) — loaded as classic script before modules
    await build({
      entryPoints: [resolve(__dirname, 'src/polyfills.ts')],
      outfile: resolve(__dirname, 'public/polyfills.js'),
      bundle: true,
      format: 'iife',
      target: 'es2020',
      minify: false,
    });
  },
});

export default defineConfig({
  plugins: [
    buildPreScripts(), // Must run first
    react(),
    crx({ manifest }),
  ],
  // ⛔ THE WORKER FORMAT MUST MATCH HOW THE WORKER IS ACTUALLY CREATED.
  //
  // services/starkProver.ts builds it as new Worker(url, { type: 'module' }) —
  // a module worker — and has since it was written. Vite's default
  // worker.format is 'iife', which contradicts that. Nothing noticed for as
  // long as the worker's graph had no dynamic import to split.
  //
  // 6333aa00 (2026-08-25 20:56) gave it one: it replaced this worker's
  // hand-written wasm ABI with @protocol-01/stark-prover, whose loader does
  // await import('node:fs/promises') on its Node path. Rollup then needs code
  // splitting, iife cannot code-split, and the build died on
  // "Invalid value iife for option output.format". The SAME commit broke
  // apps/web's build the same evening for a different reason, and neither was
  // seen for a day: CI ran on master only and this work is on a feature branch.
  //
  // 'es' is not a workaround. It is the format this worker already runs in.
  worker: {
    format: 'es',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Polyfill Node.js modules for browser
      buffer: 'buffer/',
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      // Fix @noble/post-quantum subpath resolution
      '@noble/post-quantum/ml-kem': resolve(__dirname, '../../node_modules/@noble/post-quantum/ml-kem.js'),
    },
  },
  define: {
    // Define process for Node.js compatibility
    'process.env': {},
    'process.browser': true,
    'process.version': '""',
    'process.platform': '"browser"',
    global: 'globalThis',
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
    include: ['buffer', 'process'],
  },
  build: {
    outDir: 'dist',
    minify: false,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    rollupOptions: {
      plugins: [
        // Inject polyfills
        {
          name: 'node-polyfills',
          resolveId(id) {
            if (id === 'process') {
              return 'process';
            }
            return null;
          },
        },
      ],
    },
  },
});
