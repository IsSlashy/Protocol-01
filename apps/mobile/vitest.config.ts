/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', '.expo', 'android', 'ios'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'stores/**/*.ts',
        'services/**/*.ts',
        'utils/**/*.ts',
        'hooks/**/*.ts',
      ],
      exclude: ['**/*.d.ts', '**/*.test.*', 'test/**'],
    },
    testTimeout: 15000,
  },
  resolve: {
    alias: [
      // More specific paths MUST come before less specific to avoid prefix matching issues
      { find: '@scure/bip39/wordlists/english', replacement: resolve(__dirname, './test/__mocks__/@scure/bip39/wordlists/english.ts') },
      { find: '@scure/bip39', replacement: resolve(__dirname, './test/__mocks__/@scure/bip39.ts') },
      { find: '@solana/spl-token', replacement: resolve(__dirname, './test/__mocks__/@solana/spl-token.ts') },
      { find: '@solana/web3.js', replacement: resolve(__dirname, './test/__mocks__/@solana/web3.js.ts') },
      { find: '@react-native-async-storage/async-storage', replacement: resolve(__dirname, './test/__mocks__/async-storage.ts') },
      { find: '@', replacement: resolve(__dirname, '.') },
      { find: 'expo-crypto', replacement: resolve(__dirname, './test/__mocks__/expo-crypto.ts') },
      { find: 'expo-secure-store', replacement: resolve(__dirname, './test/__mocks__/expo-secure-store.ts') },
      { find: 'expo-local-authentication', replacement: resolve(__dirname, './test/__mocks__/expo-local-authentication.ts') },
      { find: 'expo-background-fetch', replacement: resolve(__dirname, './test/__mocks__/expo-background-fetch.ts') },
      { find: 'expo-task-manager', replacement: resolve(__dirname, './test/__mocks__/expo-task-manager.ts') },
      { find: 'ed25519-hd-key', replacement: resolve(__dirname, './test/__mocks__/ed25519-hd-key.ts') },
      { find: 'crypto-js', replacement: resolve(__dirname, './test/__mocks__/crypto-js.ts') },
      { find: 'tweetnacl', replacement: resolve(__dirname, './test/__mocks__/tweetnacl.ts') },
      { find: 'bs58', replacement: resolve(__dirname, './test/__mocks__/bs58.ts') },
    ],
  },
});
