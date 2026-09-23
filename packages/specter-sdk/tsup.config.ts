import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core.ts',
    'src/wallet/index.ts',
    'src/stealth/index.ts',
    'src/transfer/index.ts',
    'src/indexing/index.ts',
    'src/relay/index.ts',
    'src/service-registry/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  // ⛔ THIS `clean` ALSO APPLIES TO `build:core`, AND THAT WIPED THE PACKAGE.
  //
  // `build:core` is `tsup src/core.ts …` with no `--config`, so tsup
  // auto-discovers THIS file and inherits `clean: true`. It therefore deleted
  // dist/ and rebuilt only core: 39 files became 13, and dist/index.mjs — the
  // main entry every other consumer resolves — was gone.
  //
  // apps/web's build script calls `build:core` directly, so on a full
  // `turbo run build` the web app's build DESTROYED this package for the
  // extension, which then failed to resolve it and lost 2 test files.
  // MEASURED 2026-08-26; `--no-clean` in that script is what stops it.
  //
  // Removing `--clean` from the script was NOT enough and the difference is
  // the lesson: the flag was never where the behaviour came from.
  clean: true,
  outDir: 'dist',
});
