import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  // The service-registry slice of specter-sdk is inlined — JS and TYPES both —
  // by importing it with a RELATIVE path (see the note in src/index.ts), so the
  // published bundle has no @protocol-01/* runtime dependency and its d.ts has
  // no @protocol-01/* type dependency either. `noExternal` stays as a guard: if
  // a bare `@protocol-01/specter-sdk` specifier ever creeps back into src, the
  // JS is still bundled rather than left as a broken runtime require — but the
  // d.ts bundler cannot resolve that specifier (node10 semantics, no subpath
  // `exports`), which is exactly the TS2307 this setup exists to prevent.
  noExternal: [/@protocol-01\/specter-sdk/],
  // Everything else stays as a declared peer/runtime dep.
  external: [
    '@solana/web3.js',
    '@noble/curves',
    '@noble/hashes',
    'bs58',
  ],
});
