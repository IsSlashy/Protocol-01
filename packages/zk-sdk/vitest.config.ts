import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        lib: ['ES2022', 'DOM'],
        strict: true,
        moduleResolution: 'node',
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        allowSyntheticDefaultImports: true,
      },
    }),
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
