#!/usr/bin/env node
/**
 * Wrapper for expo export:embed that fixes entry file path for pnpm monorepo on Windows.
 *
 * The RN Gradle Plugin passes relative paths (Windows workaround for spaces),
 * but Metro resolves entry files relative to the workspace root, not the CWD.
 * This wrapper converts the --entry-file to an absolute path before forwarding.
 */
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);

// Find and fix --entry-file argument
const entryIdx = args.indexOf('--entry-file');
if (entryIdx !== -1 && entryIdx + 1 < args.length) {
  const entryFile = args[entryIdx + 1];
  // Make absolute relative to CWD (which is the react{} root in build.gradle)
  if (!path.isAbsolute(entryFile)) {
    args[entryIdx + 1] = path.resolve(process.cwd(), entryFile);
  }
}

// Forward to the real expo CLI
const expoCli = require.resolve('@expo/cli/build/bin/cli');
const child = spawn(process.execPath, [expoCli, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 1));
