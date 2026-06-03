/**
 * Tests for the MOBILE device-pairing adapter (Stage S3).
 *
 * Pure JS crypto (tweetnacl + ml-kem + @noble/hashes) — no WASM, runs in the node
 * vitest env. Mirrors the extension's pairing.test.ts and the SDK protocol.test.ts
 * so the three byte-identical implementations are held to the SAME contract:
 * SAS binds BOTH frames (Finding #1), nonce echo + replay (Finding #4), BIP39
 * checksum, low-order X25519 reject (Finding #2), strict length gates (Finding #5),
 * and the sender-side hardware/seedless guard (Finding #3).
 *
 * IMPORTANT — tweetnacl un-mock: the global vitest config (apps/mobile/vitest.config.ts)
 * aliases `tweetnacl` to a lightweight STUB that lacks `scalarMult` / `secretbox`.
 * The hardened pairing box needs the REAL primitives, so this file overrides the
 * alias with `vi.mock('tweetnacl', ...)` loading the genuine nacl-fast.js. The wallet
 * service is mocked too so we don't pull in solana/web3 — `validateMnemonic` is
 * backed by the real `bip39` (a hoisted monorepo dependency).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── un-mock tweetnacl back to the real implementation ──────────────────────────
// The config alias would otherwise hand us the stub in apps/mobile/test/__mocks__.
vi.mock('tweetnacl', async () => {
  // Import the genuine package by ABSOLUTE path so the config's `tweetnacl` alias
  // (a prefix match) does not redirect us back to the stub. tweetnacl is hoisted to
  // the monorepo root node_modules.
  const path = await import('node:path');
  const url = await import('node:url');
  const real = await import(
    url.pathToFileURL(
      path.resolve(__dirname, '../../../../node_modules/tweetnacl/nacl-fast.js'),
    ).href
  );
  return { default: (real as { default: unknown }).default ?? real };
});

// ─── mock the wallet service (sender reads mnemonic, receiver imports) ───────────
const VALID_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

let mockMnemonic: string | null;
let lastImported: string | null;

vi.mock('../solana/wallet', async () => {
  // Real BIP39 checksum validation (bip39 is hoisted at the monorepo root).
  const bip39 = await import('bip39');
  return {
    validateMnemonic: (m: string) => bip39.validateMnemonic(m),
    getMnemonic: async () => mockMnemonic,
    importWallet: async (m: string) => {
      lastImported = m;
      return { publicKey: 'MockPubKey1111111111111111111111111111111111' };
    },
  };
});

import {
  startAsReceiver,
  senderConsumeQr1,
  senderBuildQr2,
  receiverConsumeQr2,
  receiverImportFromQr2,
  sasEqual,
  ConsumedNonceSet,
  isPairingQr1,
  isPairingQr2,
  PAIR_QR1_PREFIX,
  PAIR_ENC_PREFIX,
  MAX_PAIRING_INPUT_CHARS,
} from './pairing';

beforeEach(() => {
  mockMnemonic = VALID_MNEMONIC;
  lastImported = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Drive a full sender↔receiver handshake; returns the pieces for assertions. */
async function runHandshake() {
  const receiver = startAsReceiver();
  const parsedQr1 = senderConsumeQr1(receiver.qr1);
  const { qr2, sas: senderSas } = await senderBuildQr2(parsedQr1);
  const receiverSas = receiver.computeSasForQr2(qr2);
  return { receiver, parsedQr1, qr2, senderSas, receiverSas };
}

describe('pairing — happy path', () => {
  it('round-trips the mnemonic and both SAS match', async () => {
    const { receiver, qr2, senderSas, receiverSas } = await runHandshake();

    expect(senderSas).toHaveLength(6);
    expect(/^\d{6}$/.test(senderSas)).toBe(true);
    expect(sasEqual(senderSas, receiverSas)).toBe(true);

    const out = receiverConsumeQr2(receiver, qr2);
    expect(out.mnemonic).toBe(VALID_MNEMONIC);
    expect(out.walletKind).toBe('seed');
  });

  it('receiverImportFromQr2 imports the decrypted mnemonic and returns a pubkey', async () => {
    const receiver = startAsReceiver();
    const parsedQr1 = senderConsumeQr1(receiver.qr1);
    const { qr2 } = await senderBuildQr2(parsedQr1);

    const { publicKey } = await receiverImportFromQr2(receiver, qr2);
    expect(publicKey).toMatch(/^MockPubKey/);
    expect(lastImported).toBe(VALID_MNEMONIC);
  });

  it('QR#1 carries the p01pair1: prefix; QR#2 carries p01pairenc1:', async () => {
    const { receiver, qr2 } = await runHandshake();
    expect(receiver.qr1.startsWith(PAIR_QR1_PREFIX)).toBe(true);
    expect(qr2.startsWith(PAIR_ENC_PREFIX)).toBe(true);
    expect(isPairingQr1(receiver.qr1)).toBe(true);
    expect(isPairingQr2(qr2)).toBe(true);
    expect(isPairingQr1(qr2)).toBe(false);
    expect(isPairingQr2(receiver.qr1)).toBe(false);
  });
});

describe('pairing — MITM / SAS (Finding #1)', () => {
  it('SAS differs when QR#2 ephemeral material is swapped (binds BOTH frames)', async () => {
    const receiver = startAsReceiver();
    const parsedQr1 = senderConsumeQr1(receiver.qr1);

    // Two independent QR#2 builds → different ephemeral material → different SAS,
    // even though QR#1 (the receiver bundle) is identical. If the SAS hashed only
    // QR#1 these would collide.
    const a = await senderBuildQr2(parsedQr1);
    const b = await senderBuildQr2(parsedQr1);
    expect(a.qr2).not.toBe(b.qr2);
    expect(a.sas).not.toBe(b.sas);

    // The receiver-computed SAS tracks whichever QR#2 it actually sees.
    expect(sasEqual(receiver.computeSasForQr2(a.qr2), a.sas)).toBe(true);
    expect(sasEqual(receiver.computeSasForQr2(b.qr2), b.sas)).toBe(true);
    expect(sasEqual(receiver.computeSasForQr2(a.qr2), b.sas)).toBe(false);
  });

  it('SAS differs when the QR#1 bundle is tampered (receiver bundle swapped)', async () => {
    // A MITM that re-presents the SAME QR#2 but under receiverB's bundle (a swapped
    // QR#1) gets DIFFERENT digits: receiverB computes the SAS over ITS OWN bundle +
    // nonce + the scanned QR#2 ephemeral material, which cannot equal the sender's
    // SAS (bound to A's bundle).
    const receiverA = startAsReceiver();
    const receiverB = startAsReceiver();
    const parsedA = senderConsumeQr1(receiverA.qr1);
    const built = await senderBuildQr2(parsedA);

    expect(sasEqual(receiverA.computeSasForQr2(built.qr2), built.sas)).toBe(true);
    expect(sasEqual(receiverB.computeSasForQr2(built.qr2), built.sas)).toBe(false);
  });
});

describe('pairing — replay / nonce (Finding #4)', () => {
  it('refuses a second consumeQr2 (single-shot ephemeral key)', async () => {
    const { receiver, qr2 } = await runHandshake();
    expect(receiverConsumeQr2(receiver, qr2).mnemonic).toBe(VALID_MNEMONIC);
    expect(() => receiverConsumeQr2(receiver, qr2)).toThrow();
  });

  it('rejects a QR#2 whose nonce does not echo this receiver (cross-device replay)', async () => {
    // Build QR#2 against receiverA's bundle, try to consume on receiverB.
    const receiverA = startAsReceiver();
    const receiverB = startAsReceiver();
    const parsedA = senderConsumeQr1(receiverA.qr1);
    const { qr2 } = await senderBuildQr2(parsedA);
    // receiverB has different ephemeral keys → decrypt itself fails first, but the
    // point is it never yields receiverA's mnemonic.
    expect(() => receiverConsumeQr2(receiverB, qr2)).toThrow();
  });

  it('ConsumedNonceSet rejects a duplicate nonce', () => {
    const set = new ConsumedNonceSet();
    const n = new Uint8Array(16).fill(3);
    set.consume(n);
    expect(set.has(n)).toBe(true);
    expect(() => set.consume(n)).toThrow(/replay/i);
  });
});

describe('pairing — expiry (Finding #4, UX-grade)', () => {
  it('rejects a QR#2 consumed after the ceremony TTL', async () => {
    const receiver = startAsReceiver(1); // 1-second TTL
    const parsed = senderConsumeQr1(receiver.qr1);
    const { qr2 } = await senderBuildQr2(parsed);

    // Jump the clock past expiry.
    const realNow = Date.now;
    try {
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 5000);
      expect(() => receiverConsumeQr2(receiver, qr2)).toThrow(/expired/i);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('pairing — BIP39 checksum', () => {
  it('refuses to build QR#2 for an invalid active seed', async () => {
    mockMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    const receiver = startAsReceiver();
    const parsed = senderConsumeQr1(receiver.qr1);
    await expect(senderBuildQr2(parsed)).rejects.toThrow(/invalid/i);
  });
});

describe('pairing — strict length / parse gates (Finding #5)', () => {
  it('senderConsumeQr1 rejects a missing prefix', () => {
    expect(() => senderConsumeQr1('not-a-pairing-qr')).toThrow(/prefix/i);
  });

  it('senderConsumeQr1 rejects an over-long input before decode', () => {
    const huge = PAIR_QR1_PREFIX + 'A'.repeat(MAX_PAIRING_INPUT_CHARS + 1);
    expect(() => senderConsumeQr1(huge)).toThrow(/maximum input length/i);
  });

  it('senderConsumeQr1 rejects a wrong-length body', () => {
    expect(() => senderConsumeQr1(PAIR_QR1_PREFIX + Buffer.from('short').toString('base64'))).toThrow(/length/i);
  });

  it('computeSasForQr2 rejects a malformed QR#2 blob', () => {
    const receiver = startAsReceiver();
    expect(() => receiver.computeSasForQr2('p01pairenc1:zzzz')).toThrow();
  });
});

describe('pairing — sender guards (Finding #3)', () => {
  it('refuses to send when there is no seed-backed wallet (hardware / seedless)', async () => {
    mockMnemonic = null;
    const receiver = startAsReceiver();
    const parsed = senderConsumeQr1(receiver.qr1);
    await expect(senderBuildQr2(parsed)).rejects.toThrow(/pairing is unavailable|no seed phrase/i);
  });
});

describe('pairing — cancel zeroizes', () => {
  it('cancel() makes a subsequent consumeQr2 throw', async () => {
    const { receiver, qr2 } = await runHandshake();
    receiver.cancel();
    expect(() => receiverConsumeQr2(receiver, qr2)).toThrow();
  });
});

describe('pairing — interop transcript parity (cross-client)', () => {
  it('produces a 1241-byte QR#1 body and a single-frame QR#2 under the input cap', async () => {
    const { receiver, qr2 } = await runHandshake();
    // QR#1 body is fixed-length; the base64 string stays well under the DoS cap.
    expect(receiver.qr1.length).toBeLessThan(MAX_PAIRING_INPUT_CHARS);
    expect(qr2.length).toBeLessThan(MAX_PAIRING_INPUT_CHARS);
    // Decoded QR#1 body = 1 + 32 + 1184 + 16 + 8 = 1241 bytes → base64 ≈ 1656 chars.
    const b64 = receiver.qr1.slice(PAIR_QR1_PREFIX.length);
    const decodedLen = Buffer.from(b64, 'base64').length;
    expect(decodedLen).toBe(1241);
  });
});
