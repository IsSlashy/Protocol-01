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
    /**
     * 🚨 WITHOUT A URL, jsdom RUNS ON `about:blank` -- AN OPAQUE ORIGIN,
     * WHERE `localStorage` IS NOT A REAL STORAGE OBJECT.
     *
     * `window.localStorage.clear is not a function`, 73 times, across SIX test
     * files: buyerKey, knownSpentNoteKeys, paySubscriptions,
     * paySubscriptionsRecovery, SendForm and SubscriptionsPanel. Every one of
     * them failed in its first `beforeEach`, so nothing inside them ran at all
     * and none of their assertions had been protecting anything.
     *
     * ⛔ That is the same shape as the circuit-7 depth break: the tests that
     * would have caught it were not running. A suite that reports failures
     * nobody reads is indistinguishable from a suite that is switched off.
     */
    environmentOptions: {
      jsdom: { url: 'http://localhost:3000' },
    },
    globals: true,
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
    setupFiles: ['__tests__/setup.tsx'],
    css: false,
    // ---------------------------------------------------------------------
    // Why the fan-out is capped, measured 2026-08-11.
    //
    // Two separate things wedged `npx vitest run` on 2026-08-11, both printing
    // the same useless "RUN v3.2.4" and then silence forever.
    //
    // The one that stopped collection was the next/font/google mock, and it is
    // fixed in `__tests__/setup.tsx`: read the `NOT_A_FONT` note there. Short
    // version, a Proxy that answers every key with a font factory also answers
    // `then`, vitest awaits the mock namespace, and awaiting a thenable whose
    // `then` never calls resolve hangs the import with no timeout to catch it.
    // Reproduced here in a one file probe: a static import of app/_styx/fonts
    // under the unguarded Proxy prints the RUN banner and nothing else, killed
    // at 70 s. Nothing in this config file caused it or could have fixed it.
    //
    // The second one survives that fix and is what the settings below are for.
    // The main process can block writing its report to a stdout pipe the caller
    // has stopped draining, while the workers have already finished the whole
    // suite. Measured: workers 41.6 s of CPU with the tests done, main process
    // 2.3 s and stuck. Same tree, same config, stdout to a file finishes in
    // 8.7 s and emits 42356 bytes; stdout to an abandoned pipe never returns.
    // Two knobs follow from that.
    //
    // 1. Output volume. 42 KB of report overruns a typical capture buffer, so
    //    the tail of a red run can wedge the writer. Most of those bytes were
    //    Testing Library printing the whole rendered DOM on each failed query,
    //    so `__tests__/setup.tsx` caps DEBUG_PRINT_LIMIT. No assertion changes.
    //
    // 2. Blast radius. Tinypool spawns minForks eagerly, so on this 32 core box
    //    every run, even a one file run, started 31 worker processes, and every
    //    wedged run stranded all 31. 720 leaked node.exe from 23 earlier
    //    attempts were still resident when this was diagnosed, holding 3.7 GB.
    //    maxForks 8 costs nothing at this suite size and minForks 1 stops the
    //    eager spawn, so a future wedge strands a handful, not a poolful.
    //
    // Do not read this cap as "the tests are too slow". The suite is fast:
    // 28 files, 515 tests, about 9 s wall clock.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 8,
        minForks: 1,
      },
    },
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
