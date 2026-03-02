/**
 * Convert a bigint to a 32-byte little-endian array.
 */
export function bigintToLeBytes32(n: bigint): number[] {
  const bytes: number[] = new Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(tmp & 0xFFn);
    tmp >>= 8n;
  }
  return bytes;
}

/**
 * Convert a bigint to a 32-byte big-endian Uint8Array.
 */
export function bigintToBeBytes32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let tmp = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(tmp & 0xFFn);
    tmp >>= 8n;
  }
  return bytes;
}

/**
 * Convert a hex string (with or without 0x prefix) to bigint.
 */
export function hexToBigint(hex: string): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + clean);
}

/**
 * Convert a bigint to a hex string (without 0x prefix).
 */
export function bigintToHex(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

/**
 * Convert a Uint8Array (little-endian) to bigint.
 */
export function leBytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert a Uint8Array (big-endian) to bigint.
 */
export function beBytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}
