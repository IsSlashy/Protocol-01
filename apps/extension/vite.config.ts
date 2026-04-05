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
