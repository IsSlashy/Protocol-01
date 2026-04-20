import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'modules/shield': 'src/modules/shield.ts',
    'modules/stealth': 'src/modules/stealth.ts',
    'modules/confidential': 'src/modules/confidential.ts',
    'modules/streams': 'src/modules/streams.ts',
    'modules/subscriptions': 'src/modules/subscriptions.ts',
    'modules/vault': 'src/modules/vault.ts',
    'modules/registry': 'src/modules/registry.ts',
    'modules/relay': 'src/modules/relay.ts',
    'modules/mpc': 'src/modules/mpc.ts',
    'modules/compliance': 'src/modules/compliance.ts',
    'modules/airdrop': 'src/modules/airdrop.ts',
    'modules/otc': 'src/modules/otc.ts',
    'modules/payroll': 'src/modules/payroll.ts',
    'modules/treasury': 'src/modules/treasury.ts',
    'modules/instantUnshield': 'src/modules/instantUnshield.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  treeshake: true,
  minify: false,
  sourcemap: true,
  splitting: true,
  target: 'es2020',
  outDir: 'dist',
  external: ['react', '@arcium-hq/client', '@arcium-hq/reader'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
