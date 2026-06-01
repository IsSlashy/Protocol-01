import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  // Inline the service-registry slice of specter-sdk so the published bundle
  // has no @protocol-01/* runtime dependency.
  noExternal: [/@protocol-01\/specter-sdk/],
  // Everything else stays as a declared peer/runtime dep.
  external: [
    '@solana/web3.js',
    '@noble/curves',
    '@noble/hashes',
    'bs58',
  ],
});
