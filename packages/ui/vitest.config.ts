import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Don't pass tsconfig to esbuild transform
    tsconfigRaw: '{}',
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
