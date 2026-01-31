import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: {
    tsconfig: path.resolve(__dirname, 'tsconfig.json'),
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
