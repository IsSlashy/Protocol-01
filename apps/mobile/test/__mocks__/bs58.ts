/**
 * Mock: bs58
 */
export function encode(data: Uint8Array | Buffer): string {
  return Buffer.from(data).toString('base64').replace(/[+/=]/g, '').slice(0, 44);
}

export function decode(str: string): Uint8Array {
  // Pad for valid base64
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

export default { encode, decode };
