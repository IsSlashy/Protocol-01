import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, './') + '/',
    },
    // Belt and braces. The real fix is that the workspace now resolves a single
    // react/react-dom pair (see the note on the exclude list below), but dedupe
    // keeps a future nested copy from silently reintroducing two instances.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    setupFiles: ['__tests__/setup.tsx'],
    css: false,
    // The component and page rendering suites were excluded here from ~April
    // until 2026-07-27. Every render produced `<body><div /></body>` with no
    // error, and the exclusion comment blamed "some transitive dep" pulling a
    // second react.
    //
    // The actual cause was narrower and fixable: no consistent (react,
    // react-dom) pair existed anywhere in the install. The root pinned
    // `react: 19.1.0` while `react-dom@19.2.6` declares `peerDependencies:
    // { react: "^19.2.6" }` — so the root pairing violated react-dom's own peer
    // requirement. Under `node-linker=hoisted`, apps/web got a nested react
    // 19.2.6 (version conflict) but no nested react-dom, so react-dom loaded
    // from the root and bound to 19.1.0 there.
    //
    // The tell was not a version mismatch — both reported 19.2.6 — but the
    // warning "An update to Root inside a test was not wrapped in act(...)"
    // appearing on a render that WAS wrapped in act(). `act` came from one React
    // instance and the renderer's internals from the other, so the update was
    // never queued and never flushed.
    //
    // Fix: root react 19.1.0 -> 19.2.6. That satisfies react-dom's `^19.2.6`
    // AND react-native 0.81.5's `^19.1.0` (a caret range — RN never required
    // exactly 19.1.0), so the conflict disappears and one react is hoisted for
    // everyone. If these suites ever render empty again, check for a nested
    // react copy before suspecting the components.
    //
    // They render now, but they stay out of the DEFAULT run for a different and
    // honest reason: 123 of their assertions are stale, asserting site copy that
    // has since been rewritten — some of it deleted deliberately by the
    // claims-honesty pass. They live in `vitest.ui.config.ts` and run with
    // `pnpm test:ui`, which documents the exact counts. Fold them back in here
    // once those assertions are updated; do not fold them in by loosening them.
    // Folded back in on 2026-07-27: 310 passing, 0 failing. `vitest.ui.config.ts`
    // is kept for running the rendering suites alone; this default run now
    // covers everything, so the gate means what it says.
    exclude: ['node_modules', 'dist', '.next'],
  },
});
