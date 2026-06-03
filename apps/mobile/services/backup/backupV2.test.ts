/**
 * Backup v2 round-trip + KDF migration tests (spec §1C S5-T7, Finding #11).
 *
 * Covers:
 *   - v2 (PBKDF2-600k) encrypt → decrypt round-trip (seed + hardware payloads)
 *   - v1 (legacy SHA-512×100k) decrypt still works (read-compat) and is flagged
 *     `__legacy` so the UI re-encrypts at v2 on next save
 *   - wrong password → decryption fails
 *   - tamper → decryption fails
 *
 * Uses the test tweetnacl mock (AES-GCM-backed secretbox: a correct
 * authenticated round-trip) and the REAL @noble/hashes PBKDF2 (not mocked).
 */

import { describe, it, expect, vi } from 'vitest';

// Stub the heavy store/native import graph that index.ts pulls in at module load
// (denominatedPoolStore → zkspl → web3.js). These are NOT used by the pure
// encrypt/decrypt core under test; stubbing keeps the suite hermetic.
vi.mock('../../stores/denominatedPoolStore', () => ({
  useDenominatedPoolStore: { getState: () => ({ exportAllNotes: () => [], importNote: () => {} }) },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ currency: 'USD' }) },
}));
vi.mock('../solana/connection', () => ({ getCluster: () => 'devnet' }));
vi.mock('../solana/wallet', () => ({
  getMnemonic: async () => null,
  getPublicKey: async () => null,
  getWalletKind: async () => 'seed',
  setHardwareWallet: async () => {},
}));

import {
  encryptBackupPayload,
  decryptBackup,
  parseBackupMetadata,
  type BackupPayload,
} from './index';

function makeSeedPayload(): BackupPayload {
  return {
    version: 2,
    kind: 'seed',
    mnemonic: 'test test test test test test test test test test test junk',
    publicKey: 'SeedPubKey1111111111111111111111111111111111',
    notes: ['note-a', 'note-b'],
    settings: { currency: 'USD', network: 'devnet', hideBalanceByDefault: false },
    createdAt: 1_700_000_000_000,
  };
}

function makeHardwarePayload(): BackupPayload {
  return {
    version: 2,
    kind: 'hardware',
    p01SpendingSeed: 'aa'.repeat(32), // 32-byte RAW spending seed, hex
    ledgerPath: "44'/501'/0'/0'",
    publicKey: 'LedgerPubKey22222222222222222222222222222222',
    notes: ['hw-note'],
    settings: { currency: 'EUR', network: 'devnet', hideBalanceByDefault: false },
    createdAt: 1_700_000_001_000,
  };
}

describe('Backup v2 — PBKDF2-600k round-trip', () => {
  it('round-trips a SEED payload at v2', () => {
    const payload = makeSeedPayload();
    const encoded = encryptBackupPayload(payload, 'correct horse battery', 'hint', 2);
    const out = decryptBackup(encoded, 'correct horse battery');

    expect(out.__backupVersion).toBe(2);
    expect(out.__legacy).toBe(false);
    expect(out.kind).toBe('seed');
    expect(out.mnemonic).toBe(payload.mnemonic);
    expect(out.publicKey).toBe(payload.publicKey);
    expect(out.notes).toEqual(payload.notes);
  });

  it('round-trips a HARDWARE payload at v2 (RAW spending seed, no mnemonic)', () => {
    const payload = makeHardwarePayload();
    const encoded = encryptBackupPayload(payload, 'pw-pw-pw-pw', '', 2);
    const out = decryptBackup(encoded, 'pw-pw-pw-pw');

    expect(out.kind).toBe('hardware');
    expect(out.mnemonic).toBeUndefined();
    expect(out.p01SpendingSeed).toBe(payload.p01SpendingSeed);
    expect(out.ledgerPath).toBe("44'/501'/0'/0'");
    // RAW 32 bytes (spec §0): hex decodes to exactly 32 bytes.
    expect(Buffer.from(out.p01SpendingSeed!, 'hex').length).toBe(32);
  });

  it('rejects a wrong password', () => {
    const encoded = encryptBackupPayload(makeSeedPayload(), 'right-password', '', 2);
    expect(() => decryptBackup(encoded, 'wrong-password')).toThrow(/Wrong password/);
  });

  it('rejects a tampered ciphertext', () => {
    const encoded = encryptBackupPayload(makeSeedPayload(), 'pw-pw-pw-pw', '', 2);
    const env = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    // Flip one base64 char in the ciphertext.
    env.ct = env.ct.slice(0, -2) + (env.ct.slice(-2) === 'AA' ? 'AB' : 'AA');
    const tampered = Buffer.from(JSON.stringify(env)).toString('base64');
    expect(() => decryptBackup(tampered, 'pw-pw-pw-pw')).toThrow();
  });
});

describe('Backup v1 — legacy read-compat', () => {
  it('decrypts a v1 (SHA-512×100k) payload and flags it legacy', () => {
    // Encrypt at v1 using the same pure core, then decrypt via the dispatcher.
    const payload = makeSeedPayload();
    const encoded = encryptBackupPayload(payload, 'legacy-pass-1', 'old', 1);

    // Envelope must declare v:1.
    const env = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
    expect(env.v).toBe(1);

    const out = decryptBackup(encoded, 'legacy-pass-1');
    expect(out.__backupVersion).toBe(1);
    expect(out.__legacy).toBe(true); // UI should re-encrypt at v2 on next save
    expect(out.mnemonic).toBe(payload.mnemonic);
  });
});

describe('parseBackupMetadata — accepts v1 and v2', () => {
  it('parses a v2 envelope', () => {
    const encoded = encryptBackupPayload(makeSeedPayload(), 'pw-pw-pw-pw', 'my-hint', 2);
    const meta = parseBackupMetadata(encoded);
    expect(meta).not.toBeNull();
    expect(meta!.hint).toBe('my-hint');
  });

  it('parses a v1 envelope', () => {
    const encoded = encryptBackupPayload(makeSeedPayload(), 'pw-pw-pw-pw', 'old-hint', 1);
    const meta = parseBackupMetadata(encoded);
    expect(meta).not.toBeNull();
    expect(meta!.hint).toBe('old-hint');
  });
});
