/**
 * Vitest test setup for Protocol 01 Mobile App
 *
 * Initializes mock environment for React Native modules
 * that are unavailable outside of the device runtime.
 */

import { vi } from 'vitest';

// Polyfill TextEncoder / TextDecoder for Node environments
import { TextEncoder, TextDecoder } from 'util';
if (typeof globalThis.TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  (globalThis as any).TextDecoder = TextDecoder;
}

// Polyfill Buffer
import { Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

// Suppress console.log / console.warn in tests for cleaner output
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
