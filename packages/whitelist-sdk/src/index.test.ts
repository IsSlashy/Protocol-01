import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Connection } from '@solana/web3.js';
import * as nacl from 'tweetnacl';
import * as naclUtil from 'tweetnacl-util';

import {
  WhitelistStatus,
  WhitelistSDK,
  WHITELIST_PROGRAM_ID,
  ADMIN_ENCRYPTION_PUBKEY,
  getWhitelistPDA,
  getWhitelistEntryPDA,
  encryptForAdmin,
  decryptAsAdmin,
  uploadToIPFS,
  fetchFromIPFS,
  generateAdminKeyPair,
  statusToString,
} from './index';

// ============================================================
// WhitelistStatus enum
// ============================================================
describe('WhitelistStatus', () => {
  it('should define all four statuses with correct numeric values', () => {
    expect(WhitelistStatus.Pending).toBe(0);
    expect(WhitelistStatus.Approved).toBe(1);
    expect(WhitelistStatus.Rejected).toBe(2);
    expect(WhitelistStatus.Revoked).toBe(3);
  });
});

// ============================================================
// statusToString
// ============================================================
describe('statusToString', () => {
  it('should return "Pending" for WhitelistStatus.Pending', () => {
    expect(statusToString(WhitelistStatus.Pending)).toBe('Pending');
  });

  it('should return "Approved" for WhitelistStatus.Approved', () => {
    expect(statusToString(WhitelistStatus.Approved)).toBe('Approved');
  });

  it('should return "Rejected" for WhitelistStatus.Rejected', () => {
    expect(statusToString(WhitelistStatus.Rejected)).toBe('Rejected');
  });

  it('should return "Revoked" for WhitelistStatus.Revoked', () => {
    expect(statusToString(WhitelistStatus.Revoked)).toBe('Revoked');
  });

  it('should return "Unknown" for an unrecognized status value', () => {
    expect(statusToString(99 as WhitelistStatus)).toBe('Unknown');
  });
});

// ============================================================
// Constants
// ============================================================
describe('Constants', () => {
  it('WHITELIST_PROGRAM_ID should be a valid PublicKey', () => {
    expect(WHITELIST_PROGRAM_ID).toBeInstanceOf(PublicKey);
    expect(WHITELIST_PROGRAM_ID.toBase58()).toBeTruthy();
  });

  it('ADMIN_ENCRYPTION_PUBKEY should be a 32-byte Uint8Array', () => {
    expect(ADMIN_ENCRYPTION_PUBKEY).toBeInstanceOf(Uint8Array);
    expect(ADMIN_ENCRYPTION_PUBKEY.length).toBe(32);
  });
});

// ============================================================
// PDA Derivation
// ============================================================
describe('PDA Derivation', () => {
  describe('getWhitelistPDA', () => {
    it('should return a tuple of [PublicKey, bump]', () => {
      const result = getWhitelistPDA();
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(PublicKey);
      expect(typeof result[1]).toBe('number');
    });

    it('should be deterministic (same seeds produce same PDA)', () => {
      const [pda1, bump1] = getWhitelistPDA();
      const [pda2, bump2] = getWhitelistPDA();
      expect(pda1.equals(pda2)).toBe(true);
      expect(bump1).toBe(bump2);
    });
  });

  describe('getWhitelistEntryPDA', () => {
    it('should return a tuple of [PublicKey, bump] for a wallet', () => {
      const wallet = PublicKey.unique();
      const result = getWhitelistEntryPDA(wallet);
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(PublicKey);
      expect(typeof result[1]).toBe('number');
    });

    it('should be deterministic for the same wallet', () => {
      const wallet = PublicKey.unique();
      const [pda1, bump1] = getWhitelistEntryPDA(wallet);
      const [pda2, bump2] = getWhitelistEntryPDA(wallet);
      expect(pda1.equals(pda2)).toBe(true);
      expect(bump1).toBe(bump2);
    });

    it('should produce different PDAs for different wallets', () => {
      const wallet1 = PublicKey.unique();
      const wallet2 = PublicKey.unique();
      const [pda1] = getWhitelistEntryPDA(wallet1);
      const [pda2] = getWhitelistEntryPDA(wallet2);
      expect(pda1.equals(pda2)).toBe(false);
    });
  });
});

// ============================================================
// Encryption / Decryption
// ============================================================
describe('Encryption and Decryption', () => {
  // Generate a real admin keypair for testing encryption round-trips
  const adminKeyPair = nacl.box.keyPair();

  describe('encryptForAdmin', () => {
    it('should return an object with nonce and encrypted fields as base64 strings', () => {
      const request = {
        email: 'dev@example.com',
        projectName: 'TestProject',
      };
      const result = encryptForAdmin(request);
      expect(result).toHaveProperty('nonce');
      expect(result).toHaveProperty('encrypted');
      expect(typeof result.nonce).toBe('string');
      expect(typeof result.encrypted).toBe('string');

      // Both should be valid base64
      expect(() => naclUtil.decodeBase64(result.nonce)).not.toThrow();
      expect(() => naclUtil.decodeBase64(result.encrypted)).not.toThrow();
    });

    it('should produce different ciphertexts for the same input (random nonce/ephemeral key)', () => {
      const request = {
        email: 'dev@example.com',
        projectName: 'TestProject',
      };
      const result1 = encryptForAdmin(request);
      const result2 = encryptForAdmin(request);
      // Extremely unlikely to collide
      expect(result1.nonce).not.toBe(result2.nonce);
    });

    it('should include ephemeral public key prepended in encrypted data', () => {
      const request = {
        email: 'test@test.com',
        projectName: 'Test',
      };
      const result = encryptForAdmin(request);
      const combined = naclUtil.decodeBase64(result.encrypted);
      // Combined should contain at least the 32-byte ephemeral public key plus some ciphertext
      expect(combined.length).toBeGreaterThan(nacl.box.publicKeyLength);
    });

    it('should handle optional fields in AccessRequest', () => {
      const request = {
        email: 'dev@example.com',
        projectName: 'TestProject',
        projectDescription: 'A test project',
        website: 'https://example.com',
      };
      const result = encryptForAdmin(request);
      expect(result.nonce).toBeTruthy();
      expect(result.encrypted).toBeTruthy();
    });
  });

  describe('decryptAsAdmin (round-trip)', () => {
    // For round-trip testing, we temporarily swap the ADMIN_ENCRYPTION_PUBKEY
    // We cannot modify the const directly, so we test the decrypt path
    // by manually encrypting with a known admin key.

    it('should decrypt data encrypted with the matching admin public key', () => {
      const request = {
        email: 'roundtrip@example.com',
        projectName: 'RoundTrip',
        projectDescription: 'Testing round-trip',
      };

      // Manually encrypt using the test admin keypair
      const message = naclUtil.decodeUTF8(JSON.stringify(request));
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const ephemeral = nacl.box.keyPair();
      const encrypted = nacl.box(message, nonce, adminKeyPair.publicKey, ephemeral.secretKey);
      expect(encrypted).not.toBeNull();

      const combined = new Uint8Array(ephemeral.publicKey.length + encrypted!.length);
      combined.set(ephemeral.publicKey);
      combined.set(encrypted!, ephemeral.publicKey.length);

      const encryptedData = {
        nonce: naclUtil.encodeBase64(nonce),
        encrypted: naclUtil.encodeBase64(combined),
      };

      const decrypted = decryptAsAdmin(encryptedData, adminKeyPair.secretKey);
      expect(decrypted.email).toBe('roundtrip@example.com');
      expect(decrypted.projectName).toBe('RoundTrip');
      expect(decrypted.projectDescription).toBe('Testing round-trip');
    });

    it('should throw "Decryption failed" with a wrong secret key', () => {
      const request = { email: 'fail@test.com', projectName: 'Fail' };
      const message = naclUtil.decodeUTF8(JSON.stringify(request));
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const ephemeral = nacl.box.keyPair();
      const encrypted = nacl.box(message, nonce, adminKeyPair.publicKey, ephemeral.secretKey);

      const combined = new Uint8Array(ephemeral.publicKey.length + encrypted!.length);
      combined.set(ephemeral.publicKey);
      combined.set(encrypted!, ephemeral.publicKey.length);

      const encryptedData = {
        nonce: naclUtil.encodeBase64(nonce),
        encrypted: naclUtil.encodeBase64(combined),
      };

      // Use a different secret key
      const wrongKey = nacl.box.keyPair().secretKey;
      expect(() => decryptAsAdmin(encryptedData, wrongKey)).toThrow(
        'Decryption failed - invalid key or corrupted data'
      );
    });

    it('should throw on corrupted encrypted data', () => {
      const encryptedData = {
        nonce: naclUtil.encodeBase64(nacl.randomBytes(nacl.box.nonceLength)),
        encrypted: naclUtil.encodeBase64(nacl.randomBytes(100)),
      };
      expect(() => decryptAsAdmin(encryptedData, adminKeyPair.secretKey)).toThrow();
    });
  });
});

// ============================================================
// generateAdminKeyPair
// ============================================================
describe('generateAdminKeyPair', () => {
  it('should return an object with publicKey and secretKey as base64 strings', () => {
    const keyPair = generateAdminKeyPair();
    expect(keyPair).toHaveProperty('publicKey');
    expect(keyPair).toHaveProperty('secretKey');
    expect(typeof keyPair.publicKey).toBe('string');
    expect(typeof keyPair.secretKey).toBe('string');
  });

  it('should produce valid base64 keys of correct length', () => {
    const keyPair = generateAdminKeyPair();
    const pub = naclUtil.decodeBase64(keyPair.publicKey);
    const sec = naclUtil.decodeBase64(keyPair.secretKey);
    expect(pub.length).toBe(32);
    expect(sec.length).toBe(32);
  });

  it('should generate different keys each time', () => {
    const kp1 = generateAdminKeyPair();
    const kp2 = generateAdminKeyPair();
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
    expect(kp1.secretKey).not.toBe(kp2.secretKey);
  });
});

// ============================================================
// IPFS functions (mocked fetch)
// ============================================================
describe('IPFS functions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('uploadToIPFS', () => {
    it('should POST encrypted data to web3.storage and return the CID', async () => {
      const mockCid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ cid: mockCid }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const data = { nonce: 'dGVzdA==', encrypted: 'ZW5jcnlwdGVk' };
      const cid = await uploadToIPFS(data);

      expect(cid).toBe(mockCid);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.web3.storage/upload',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        })
      );
    });

    it('should throw if the upload response is not ok', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Unauthorized',
      });
      vi.stubGlobal('fetch', mockFetch);

      const data = { nonce: 'abc', encrypted: 'def' };
      await expect(uploadToIPFS(data)).rejects.toThrow('IPFS upload failed: Unauthorized');
    });
  });

  describe('fetchFromIPFS', () => {
    it('should try gateways and return data from the first successful one', async () => {
      const expectedData = { nonce: 'nonce123', encrypted: 'enc456' };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(expectedData),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchFromIPFS('testcid123');
      expect(result).toEqual(expectedData);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // Should use the first gateway
      expect(mockFetch).toHaveBeenCalledWith('https://w3s.link/ipfs/testcid123');
    });

    it('should fall through to next gateway on failure', async () => {
      const expectedData = { nonce: 'n', encrypted: 'e' };
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(expectedData),
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchFromIPFS('cid2');
      expect(result).toEqual(expectedData);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://w3s.link/ipfs/cid2');
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://ipfs.io/ipfs/cid2');
    });

    it('should fall through when a gateway returns a non-ok response', async () => {
      const expectedData = { nonce: 'n', encrypted: 'e' };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(expectedData),
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchFromIPFS('cid3');
      expect(result).toEqual(expectedData);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should throw if all gateways fail', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('fail'));
      vi.stubGlobal('fetch', mockFetch);

      await expect(fetchFromIPFS('badcid')).rejects.toThrow(
        'Failed to fetch from IPFS: badcid'
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});

// ============================================================
// WhitelistSDK
// ============================================================
describe('WhitelistSDK', () => {
  let sdk: WhitelistSDK;
  let mockConnection: Connection;

  beforeEach(() => {
    mockConnection = {
      getAccountInfo: vi.fn(),
      getProgramAccounts: vi.fn(),
    } as unknown as Connection;
    sdk = new WhitelistSDK(mockConnection);
  });

  describe('constructor', () => {
    it('should accept a Connection and use default program ID', () => {
      const s = new WhitelistSDK(mockConnection);
      expect(s).toBeInstanceOf(WhitelistSDK);
    });

    it('should accept a custom program ID', () => {
      const customId = PublicKey.unique();
      const s = new WhitelistSDK(mockConnection, customId);
      expect(s).toBeInstanceOf(WhitelistSDK);
    });
  });

  describe('checkAccess', () => {
    it('should return { hasAccess: false } when no account exists', async () => {
      (mockConnection.getAccountInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const wallet = PublicKey.unique();
      const result = await sdk.checkAccess(wallet);
      expect(result).toEqual({ hasAccess: false });
    });

    it('should return { hasAccess: true } when account exists with Approved status', async () => {
      const wallet = PublicKey.unique();
      const data = buildWhitelistEntryBuffer(wallet, WhitelistStatus.Approved);
      (mockConnection.getAccountInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: WHITELIST_PROGRAM_ID,
      });

      const result = await sdk.checkAccess(wallet);
      expect(result.hasAccess).toBe(true);
      expect(result.entry).toBeDefined();
      expect(result.entry!.status).toBe(WhitelistStatus.Approved);
    });

    it('should return { hasAccess: false } when account exists but status is Pending', async () => {
      const wallet = PublicKey.unique();
      const data = buildWhitelistEntryBuffer(wallet, WhitelistStatus.Pending);
      (mockConnection.getAccountInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: WHITELIST_PROGRAM_ID,
      });

      const result = await sdk.checkAccess(wallet);
      expect(result.hasAccess).toBe(false);
      expect(result.entry).toBeDefined();
      expect(result.entry!.status).toBe(WhitelistStatus.Pending);
    });

    it('should return { hasAccess: false } when getAccountInfo throws', async () => {
      (mockConnection.getAccountInfo as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('RPC error')
      );

      const wallet = PublicKey.unique();
      const result = await sdk.checkAccess(wallet);
      expect(result).toEqual({ hasAccess: false });
    });
  });

  describe('getEntry', () => {
    it('should return null when no account exists', async () => {
      (mockConnection.getAccountInfo as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const wallet = PublicKey.unique();
      const result = await sdk.getEntry(wallet);
      expect(result).toBeNull();
    });

    it('should return parsed entry when account exists', async () => {
      const wallet = PublicKey.unique();
      const data = buildWhitelistEntryBuffer(wallet, WhitelistStatus.Rejected, 'bafytest', 'MyProject');
      (mockConnection.getAccountInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
        data,
        executable: false,
        lamports: 0,
        owner: WHITELIST_PROGRAM_ID,
      });

      const result = await sdk.getEntry(wallet);
      expect(result).not.toBeNull();
      expect(result!.wallet.equals(wallet)).toBe(true);
      expect(result!.status).toBe(WhitelistStatus.Rejected);
      expect(result!.ipfsCid).toBe('bafytest');
      expect(result!.projectName).toBe('MyProject');
    });

    it('should return null on RPC error', async () => {
      (mockConnection.getAccountInfo as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network')
      );

      const wallet = PublicKey.unique();
      const result = await sdk.getEntry(wallet);
      expect(result).toBeNull();
    });
  });

  describe('getPendingRequests', () => {
    it('should return only entries with Pending status', async () => {
      const wallet1 = PublicKey.unique();
      const wallet2 = PublicKey.unique();
      const wallet3 = PublicKey.unique();

      (mockConnection.getProgramAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          pubkey: PublicKey.unique(),
          account: {
            data: buildWhitelistEntryBuffer(wallet1, WhitelistStatus.Pending),
            executable: false,
            lamports: 0,
            owner: WHITELIST_PROGRAM_ID,
          },
        },
        {
          pubkey: PublicKey.unique(),
          account: {
            data: buildWhitelistEntryBuffer(wallet2, WhitelistStatus.Approved),
            executable: false,
            lamports: 0,
            owner: WHITELIST_PROGRAM_ID,
          },
        },
        {
          pubkey: PublicKey.unique(),
          account: {
            data: buildWhitelistEntryBuffer(wallet3, WhitelistStatus.Pending),
            executable: false,
            lamports: 0,
            owner: WHITELIST_PROGRAM_ID,
          },
        },
      ]);

      const pending = await sdk.getPendingRequests();
      expect(pending).toHaveLength(2);
      expect(pending.every((e) => e.status === WhitelistStatus.Pending)).toBe(true);
    });

    it('should return an empty array when no pending requests exist', async () => {
      (mockConnection.getProgramAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const pending = await sdk.getPendingRequests();
      expect(pending).toEqual([]);
    });
  });
});

// ============================================================
// Helper: build a fake WhitelistEntry buffer matching the
// on-chain layout parsed by parseWhitelistEntry.
// ============================================================
function buildWhitelistEntryBuffer(
  wallet: PublicKey,
  status: WhitelistStatus,
  ipfsCid: string = 'bafydefault',
  projectName: string = 'DefaultProject',
  requestedAt: number = 1700000000,
  reviewedAt: number = 0
): Buffer {
  // Layout:
  //   8   discriminator
  //  32   wallet pubkey
  //   4   ipfsCid length (u32 LE)
  //  64   ipfsCid data (padded to max_len=64)
  //   4   projectName length (u32 LE)
  //  64   projectName data (padded to max_len=64)
  //   1   status (u8)
  //   8   requestedAt (i64 LE)
  //   8   reviewedAt (i64 LE)
  // Total: 193 but the parser uses a 1-byte padding at end; we allocate enough.
  const totalSize = 8 + 32 + 4 + 64 + 4 + 64 + 1 + 8 + 8 + 1;
  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Discriminator (8 bytes, arbitrary)
  buf.fill(0, offset, offset + 8);
  offset += 8;

  // Wallet (32 bytes)
  wallet.toBuffer().copy(buf, offset);
  offset += 32;

  // ipfsCid length (u32 LE)
  buf.writeUInt32LE(ipfsCid.length, offset);
  offset += 4;

  // ipfsCid data (max 64 bytes)
  Buffer.from(ipfsCid).copy(buf, offset);
  offset += 64;

  // projectName length (u32 LE)
  buf.writeUInt32LE(projectName.length, offset);
  offset += 4;

  // projectName data (max 64 bytes)
  Buffer.from(projectName).copy(buf, offset);
  offset += 64;

  // Status (1 byte)
  buf.writeUInt8(status, offset);
  offset += 1;

  // requestedAt (i64 LE)
  buf.writeBigInt64LE(BigInt(requestedAt), offset);
  offset += 8;

  // reviewedAt (i64 LE)
  buf.writeBigInt64LE(BigInt(reviewedAt), offset);

  return buf;
}
