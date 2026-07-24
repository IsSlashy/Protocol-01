/**
 * Worker-scope Buffer polyfill. MUST be the first static import of the worker
 * entry: ESM evaluates imports in dependency order, so this module runs before
 * the pay-core / specter-sdk / web3.js graph, some of which touch the global
 * Buffer at module-evaluation time.
 */
import { Buffer } from 'buffer';

if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}
