import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const pkgDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core.ts',
    'src/wallet/index.ts',
    'src/stealth/index.ts',
    'src/transfer/index.ts',
    'src/streams/index.ts',
    'src/proving/index.ts',
    'src/indexing/index.ts',
    'src/relay/index.ts',
    'src/service-registry/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  // Inline @protocol-01/stark-prover (JS only — the WASM is copied below).
  //
  // WHY: the packed manifest used to carry `"@protocol-01/stark-prover":
  // "workspace:^"` in `dependencies`, and `npm install <tgz>` outside the
  // workspace dies on that spec with EUNSUPPORTEDPROTOCOL before reading
  // anything else — the exact command the merchant-sdk README recommends.
  // MEASURED 2026-08-04. stark-prover is not on npm, so no version rewrite
  // could save the install either; the only self-contained shape is to bundle
  // it. It now sits in devDependencies, where npm never tries to resolve it.
  noExternal: [/@protocol-01\/stark-prover/],
  onSuccess: async () => {
    // The bundled wasm-loader resolves `../wasm/p01_stark_bg.wasm` relative to
    // the module that contains it. That is two different places depending on
    // the build: ESM code-splits the loader into a chunk at `dist/` (→
    // `<pkg>/wasm`), CJS inlines it into every entry, including the nested
    // `dist/proving/index.js` (→ `dist/wasm`). Ship the file at both — 125 KB
    // twice — so the zero-config path works everywhere; callers with stricter
    // needs pass an explicit WasmSource, as before.
    const src = join(pkgDir, '..', 'stark-prover', 'wasm');
    for (const dest of [join(pkgDir, 'wasm'), join(pkgDir, 'dist', 'wasm')]) {
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
    }
    console.log('WASM copied to wasm/ and dist/wasm/');
  },
});
