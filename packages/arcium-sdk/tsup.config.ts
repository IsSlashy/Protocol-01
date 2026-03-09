import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'relay/index': 'src/relay/index.ts',
    'stealth/index': 'src/stealth/index.ts',
    'registry/index': 'src/registry/index.ts',
    'nullifier/index': 'src/nullifier/index.ts',
    'audit/index': 'src/audit/index.ts',
    'governance/index': 'src/governance/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    '@arcium-hq/client',
    '@arcium-hq/reader',
    '@coral-xyz/anchor',
    '@solana/web3.js',
  ],
});
