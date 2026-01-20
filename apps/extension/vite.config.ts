import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import { build } from 'esbuild';
import manifest from './manifest.json';

// Build inject script to public folder before vite runs
const buildInjectScript = () => ({
  name: 'build-inject-script',
  async config() {
    // Build inject script to public folder so crxjs can find it
    await build({
      entryPoints: [resolve(__dirname, 'src/inject/index.ts')],
      outfile: resolve(__dirname, 'public/inject.js'),
      bundle: true,
      format: 'iife',
      target: 'es2020',
      minify: false,
    });
  },
});

export default defineConfig({
  plugins: [
    buildInjectScript(), // Must run first
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
