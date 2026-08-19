/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    environmentMatchGlobs: [
      // ZK proof tests need Node.js Worker threads (snarkjs/ffjavascript)
      ['src/shared/services/denominatedPool.test.ts', 'node'],
    ],
    css: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [
      'node_modules',
      'dist',
      // ⛔ `src/popup/**/*.test.{ts,tsx}` WAS EXCLUDED HERE UNTIL 2026-08-19.
      //
      // The stated cause was a React version conflict — extension react ^19.2.3
      // against react-router-dom ^6.22.0, pnpm hoisting a nested react copy, and
      // every `render()` throwing "Cannot read properties of null (reading
      // 'useRef')". The proposed fix was a pnpm override or react-router v7.
      //
      // Neither was needed in the end: apps/web hit the same wall, diagnosed it
      // as no consistent (react, react-dom) pair existing anywhere in the
      // install, and fixed it on 2026-07-27 by moving root react to 19.2.6 so a
      // single copy hoists for every workspace. That fix covered this package
      // too, and nothing here was re-run to notice.
      //
      // 🚨 WHAT THE EXCLUSION ACTUALLY COST. 13 files and 161 assertions sat
      // unexecuted, including ShieldedWallet and ConnectDapp — the shield UI and
      // the dapp connection. Six of them had gone stale without failing, and one
      // of the six PINNED A BUG: it asserted that Transfer navigates to
      // `/shielded/transfer`, a route that builds `global:transfer_stark`, an
      // instruction zk_shielded has never had. A test that cannot run cannot
      // tell you it is wrong, so it quietly became documentation for a defect.
      //
      // If a render here ever returns an empty <body> again, look for a nested
      // react copy before suspecting the components — and do not re-add this
      // line without a measurement that says the conflict is back.
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/popup/**/*.tsx', 'src/shared/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.*'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
