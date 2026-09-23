import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'modules/registry': 'src/modules/registry.ts',
    'modules/relay': 'src/modules/relay.ts',
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
  external: ['react'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
