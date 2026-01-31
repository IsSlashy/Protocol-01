// Programmatic vitest runner that bypasses pnpm symlink issues on Windows + Node 24
// Uses custom ESM loader for ESM resolution and CJS monkey-patch for require()

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Register the custom ESM loader for THIS process
register('./_pnpm-loader.mjs', pathToFileURL('./'));

// Set NODE_OPTIONS to propagate our loaders to child processes spawned by vitest
const cjsPatchPath = 'P:/p01/packages/zk-sdk/_pnpm-cjs-patch.cjs';
const esmLoaderPath = 'file:///P:/p01/packages/zk-sdk/_pnpm-loader.mjs';
const existingOptions = process.env.NODE_OPTIONS || '';
process.env.NODE_OPTIONS = `${existingOptions} --require "${cjsPatchPath}" --loader "${esmLoaderPath}"`.trim();

// Set process.argv for vitest CLI
process.argv = ['node', 'vitest', 'run', '--reporter=verbose'];

// Import vitest CLI directly
await import('file:///P:/p01/packages/zk-sdk/node_modules/.pnpm/vitest@1.6.1_@types+node@20.19.30/node_modules/vitest/dist/cli.js');
