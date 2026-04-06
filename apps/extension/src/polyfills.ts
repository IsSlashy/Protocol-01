/**
 * Browser polyfills for Chrome extension.
 * This file is built separately and loaded as a classic script
 * BEFORE any ES module code, ensuring Buffer/process are
 * available globally before Solana/crypto libraries initialize.
 */

import { Buffer } from 'buffer';

// Make Buffer available everywhere
(window as any).Buffer = Buffer;
(globalThis as any).Buffer = Buffer;

// Process shim
const processShim = {
  env: {},
  browser: true,
  version: '',
  platform: 'browser',
  nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) => setTimeout(() => fn(...args), 0),
};

(window as any).process = processShim;
(globalThis as any).process = processShim;

// Global shim
(window as any).global = globalThis;

console.log('[P01] Polyfills loaded — Buffer:', typeof Buffer);
