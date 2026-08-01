import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Component and page RENDERING suites — run with `pnpm test:ui`.
 *
 * These are quarantined out of the default `pnpm test` run, but NOT because
 * they cannot run: as of 2026-07-27 they render correctly again (see the note
 * in vitest.config.ts about the react/react-dom unification). They are
 * quarantined because their ASSERTIONS are stale.
 *
 * Last measured: 245 passing, 123 failing, 29 skipped across 20 files.
 *
 * The failures are content drift, not defects. These suites were excluded from
 * CI around April 2026 and the site copy has been rewritten repeatedly since —
 * including by the claims-honesty pass, which deliberately deleted strings like
 * "TEE Compute, Private Relayers" and "ZK Shielded Pool". So a number of these
 * assertions are asserting copy that was removed ON PURPOSE, and updating them
 * requires deciding what the honest current wording is, one at a time. That is
 * a judgement task, not a find-and-replace.
 *
 * Do not "fix" these by loosening the assertions. The point of a copy assertion
 * is to fail when the copy changes.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, './') + '/',
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['__tests__/components/**/*.test.{ts,tsx}', '__tests__/pages/**/*.test.{ts,tsx}'],
    setupFiles: ['__tests__/setup.tsx'],
    css: false,
    exclude: ['node_modules', 'dist', '.next'],
  },
});
