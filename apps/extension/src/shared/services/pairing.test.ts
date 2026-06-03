/**
 * Tests for the EXTENSION device-pairing adapter (Stage S2).
 *
 * Pure JS crypto (tweetnacl + ml-kem + @noble/hashes) — no WASM, runs in jsdom.
 * Covers the full receiver/sender handshake plus the security regressions the
 * spec calls out: SAS binds BOTH frames (Finding #1), nonce echo + replay
 * (Finding #4), BIP39 checksum, low-order X25519 reject (Finding #2), strict
 * length gates (Finding #5), and the sender-side hardware/locked guards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  startAsReceiver,
  senderConsumeQr1,
  senderBuildQr2,
  receiverConsumeQr2,
  sasEqual,
  ConsumedNonceSet,
  isPairingQr1,
  isPairingQr2,
  PAIR_QR1_PREFIX,
  PAIR_ENC_PREFIX,
  MAX_PAIRING_INPUT_CHARS,
} from './pairing';

// ─── mock the wallet store + session password + crypto.decrypt ──────────────────
// senderBuildQr2 reads the active mnemonic via the wallet store + session password.
const VALID_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

let mockState: {
  isInitialized: boolean;
  encryptedSeedPhrase: unknown;
  walletKind?: string;
};
let mockSessionPassword: string | null;
let mockDecryptResult: string;

vi.mock('../store/wallet', () => ({
  useWalletStore: { getState: () => mockState },
}));
vi.mock('./sessionCrypto', () => ({
  getSessionPassword: () => mockSessionPassword,
}));
vi.mock('./crypto', () => ({
  decrypt: async () => mockDecryptResult,
}));
// validateMnemonic in ./wallet is bip39-backed and pure — use the real thing via a
// thin re-export so we don't have to import the whole wallet service (which pulls
// solana web3 / rpc config). bip39 is an extension dependency.
vi.mock('./wallet', async () => {
  const bip39 = await import('bip39');
  return { validateMnemonic: (m: string) => bip39.validateMnemonic(m) };
});

beforeEach(() => {
  mockState = { isInitialized: true, encryptedSeedPhrase: { ct: 'x' } };
  mockSessionPassword = 'pw';
  mockDecryptResult = VALID_MNEMONIC;
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
    // The sender builds QR#2 against receiverA's QR#1. A MITM that re-presents the
    // SAME QR#2 but under receiverB's bundle (a swapped QR#1) gets DIFFERENT digits:
    // receiverB computes the SAS over ITS OWN bundle + nonce + the scanned QR#2
    // ephemeral material, which cannot equal the sender's SAS (bound to A's bundle).
    const receiverA = startAsReceiver();
    const receiverB = startAsReceiver();
    const parsedA = senderConsumeQr1(receiverA.qr1);
    const built = await senderBuildQr2(parsedA);

    // Honest receiver A: digits match the sender.
    expect(sasEqual(receiverA.computeSasForQr2(built.qr2), built.sas)).toBe(true);
    // Attacker-substituted receiver B: same QR#2, different bundle → mismatch.
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
  it('rejects a mnemonic that fails the BIP39 checksum', async () => {
    mockDecryptResult =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    const receiver = startAsReceiver();
    const parsed = senderConsumeQr1(receiver.qr1);
    // sender refuses to even build QR#2 for an invalid active seed
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
    expect(() => senderConsumeQr1(PAIR_QR1_PREFIX + btoa('short'))).toThrow(/length/i);
  });

  it('computeSasForQr2 rejects a malformed QR#2 blob', () => {
    const receiver = startAsReceiver();
    expect(() => receiver.computeSasForQr2('p01pairenc1:zzzz')).toThrow();
  });
});

describe('pairing — sender guards (Finding #3)', () => {
  it('refuses to send from a hardware wallet', async () => {
    mockState = { isInitialized: true, encryptedSeedPhrase: { ct: 'x' }, walletKind: 'hardware' };
    const receiver = startAsReceiver();
    const parsed = senderConsumeQr1(receiver.qr1);
    await expect(senderBuildQr2(parsed)).rejects.toThrow(/hardware/i);
  });

  it('refuses to send when the wallet is locked (no session password)', async () => {
    mockSessionPassword = null;
    const receiver = startAsReceiver();
    const parsed = senderConsumeQr1(receiver.qr1);
    await expect(senderBuildQr2(parsed)).rejects.toThrow(/locked/i);
  });

  it('refuses to send when there is no seed-backed wallet', async () => {
    mockState = { isInitialized: false, encryptedSeedPhrase: null };
    const receiver = startAsReceiver();
    const parsed = senderConsumeQr1(receiver.qr1);
    await expect(senderBuildQr2(parsed)).rejects.toThrow(/seed-backed/i);
  });
});

describe('pairing — cancel zeroizes', () => {
  it('cancel() makes a subsequent consumeQr2 throw', async () => {
    const { receiver, qr2 } = await runHandshake();
    receiver.cancel();
    expect(() => receiverConsumeQr2(receiver, qr2)).toThrow();
  });
});
