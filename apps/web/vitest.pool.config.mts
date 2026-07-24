import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Denominated-pool extraction parity gate. Runs the pool math tests against the
 * REAL @solana/web3.js in a node environment — separate from the main suite,
 * whose jsdom setup mocks web3 for component rendering. Asserts the pool code
 * ported into lib/privacy/pool stays byte-identical to the proven extension
 * (commitment low-u64 == WASM circuit output), so a drift can never silently
 * reach a shielded /pay send. Run: pnpm test:pool
 */
export default defineConfig({
  resolve: { alias: { '@/': path.resolve(__dirname, './') + '/' } },
  test: { include: ['lib/privacy/pool/**/*.test.ts'], environment: 'node' },
});
