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
  test: {
    // 🚨 `lib/**`, NOT `lib/privacy/pool/**`.
    //
    // The narrower pattern left `lib/privacy/serviceRegistry.test.ts` matched by
    // NO config in this app: not this one, not the default (`__tests__/**`), not
    // the ui one (`__tests__/components|pages`). 23 assertions that never ran and
    // never reported anything — a suite is not green, it is absent, and nothing
    // distinguishes the two from a passing summary line.
    //
    // Verified with `npx vitest list --config <each>`: it was the only orphan in
    // the repo. Keeping the glob at `lib/**` means the next test written beside a
    // module, rather than under `pool/`, is picked up instead of silently lost.
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
