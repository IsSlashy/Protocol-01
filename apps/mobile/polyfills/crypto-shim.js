/**
 * Crypto shim for React Native — bridges Node.js `crypto` API to WebCrypto.
 * Must be loaded AFTER `react-native-get-random-values` (which polyfills
 * `globalThis.crypto.getRandomValues`).
 *
 * Provides: randomBytes, getRandomValues
 * Used by: @arcium-hq/client, @coral-xyz/anchor
 */

const { Buffer } = require('buffer');

function randomBytes(size) {
  const bytes = new Uint8Array(size);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Should never reach here — react-native-get-random-values polyfills this
    throw new Error('crypto.getRandomValues not available');
  }
  return Buffer.from(bytes);
}

function getRandomValues(arr) {
  return globalThis.crypto.getRandomValues(arr);
}

// Stub for createHash — callers should use @noble/hashes instead
function createHash(algorithm) {
  throw new Error(
    `crypto.createHash("${algorithm}") is not available in React Native. Use @noble/hashes.`
  );
}

function createHmac(algorithm) {
  throw new Error(
    `crypto.createHmac("${algorithm}") is not available in React Native. Use @noble/hashes/hmac.`
  );
}

module.exports = {
  randomBytes,
  getRandomValues,
  createHash,
  createHmac,
  webcrypto: globalThis.crypto,
};
