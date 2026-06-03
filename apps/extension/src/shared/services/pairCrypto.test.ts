// @vitest-environment node
// (pure crypto — no DOM. node realm keeps Uint8Array consistent for tweetnacl's
//  instanceof checks; jsdom's separate realm would spuriously fail them.)
import { describe, it, expect } from 'vitest';
import {
  encryptPairingWith,
  decryptPairing,
  isPairingQR,
  generatePairingCode,
  normalizeCode,
  formatCodeForDisplay,
} from './pairCrypto';

// Deterministic fixtures shared with apps/mobile/utils/crypto/pairCrypto.test.ts.
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const CODE = 'ABCD2EFG3HIJ4KLM';
const SALT = new Uint8Array(16);
for (let i = 0; i < 16; i++) SALT[i] = i;
const NONCE = new Uint8Array(24);
for (let i = 0; i < 24; i++) NONCE[i] = 0x10 + i;
const EXPIRY = 4102444800; // 2100-01-01 — never expires

// CROSS-PLATFORM CONTRACT: this exact string is also asserted (decrypt) in the
// mobile test. If it ever differs between platforms, the scheme has drifted.
const VECTOR =
  'p01pair1:AfSGVwAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnUBPd-2N9_eUbtSzIIz00_dmYBNwVaNFXZFuQEAhWIDwsXd8pqMTwwIJbvB2mNgtTG5VHF56XYaUuUi3DhQhPun27oTRSr8EnnAt4Nod-Ftxl2D7hpMXFyhqL0A';

describe('pairCrypto', () => {
  it('round-trips encrypt -> decrypt', async () => {
    const qr = await encryptPairingWith(MNEMONIC, CODE, SALT, NONCE, EXPIRY);
    expect(isPairingQR(qr)).toBe(true);
    expect(await decryptPairing(qr, CODE)).toBe(MNEMONIC);
  });

  it('matches the cross-platform known vector', async () => {
    const qr = await encryptPairingWith(MNEMONIC, CODE, SALT, NONCE, EXPIRY);
    // eslint-disable-next-line no-console
    console.log('PAIR_VECTOR=' + qr);
    expect(qr).toBe(VECTOR);
  });

  it('rejects the wrong code', async () => {
    const qr = await encryptPairingWith(MNEMONIC, CODE, SALT, NONCE, EXPIRY);
    await expect(decryptPairing(qr, 'ZZZZ2ZZZ3ZZZ4ZZZ')).rejects.toThrow();
  });

  it('rejects an expired QR', async () => {
    const qr = await encryptPairingWith(MNEMONIC, CODE, SALT, NONCE, 1000);
    await expect(decryptPairing(qr, CODE)).rejects.toThrow(/expired/i);
  });

  it('normalizes code grouping/case', () => {
    expect(normalizeCode('abcd-2efg 3hij4klm')).toBe(CODE);
    expect(formatCodeForDisplay(CODE)).toBe('ABCD-2EFG-3HIJ-4KLM');
  });

  it('generates 16-char base32 codes', () => {
    expect(generatePairingCode()).toMatch(/^[A-Z2-7]{16}$/);
  });
});
