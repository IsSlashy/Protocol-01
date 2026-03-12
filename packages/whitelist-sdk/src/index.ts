import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import * as nacl from 'tweetnacl';
import * as naclUtil from 'tweetnacl-util';

// Program ID (deployed on devnet)
export const WHITELIST_PROGRAM_ID = new PublicKey('AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE');

// Admin public key for encrypting emails (Volta Team)
// This is the X25519 public key that can decrypt the email data.
// Secret key stored offline — NEVER commit the secret key.
// Generated: nacl.box.keyPair() on 2026-03-11 (audit round 4)
export const ADMIN_ENCRYPTION_PUBKEY = new Uint8Array([
  0xd6, 0x2e, 0x0f, 0x63, 0xc8, 0xf2, 0xf7, 0xe6,
  0xdc, 0x07, 0x68, 0x8f, 0x8e, 0xbf, 0x57, 0xa4,
  0xd0, 0xef, 0x29, 0x1d, 0x70, 0x0d, 0x63, 0xfa,
  0xb8, 0x4c, 0x47, 0xe1, 0x5f, 0xb0, 0x23, 0x75,
]);

// Runtime guard: never allow all-zeros encryption key
if (ADMIN_ENCRYPTION_PUBKEY.every(b => b === 0)) {
  throw new Error('ADMIN_ENCRYPTION_PUBKEY is all zeros — whitelist encryption is broken');
}

// ============ Types ============

export enum WhitelistStatus {
  Pending = 0,
  Approved = 1,
  Rejected = 2,
  Revoked = 3,
}

export interface WhitelistEntry {
  wallet: PublicKey;
  ipfsCid: string;
  projectName: string;
  status: WhitelistStatus;
  requestedAt: number;
  reviewedAt: number;
}

export interface AccessRequest {
  email: string;
  projectName: string;
  projectDescription?: string;
  website?: string;
}

export interface EncryptedData {
  nonce: string; // base64
  encrypted: string; // base64
}

// ============ PDA Derivation ============

export function getWhitelistPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('whitelist')],
    WHITELIST_PROGRAM_ID
  );
}

export function getWhitelistEntryPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('entry'), wallet.toBuffer()],
    WHITELIST_PROGRAM_ID
  );
}

// ============ Encryption ============

/**
 * Encrypt data using nacl box (asymmetric encryption)
 * Only the admin can decrypt this data
 */
export function encryptForAdmin(data: AccessRequest): EncryptedData {
  if (ADMIN_ENCRYPTION_PUBKEY.every(b => b === 0)) {
    throw new Error('Admin encryption key not configured — set ADMIN_ENCRYPTION_PUBKEY before use');
  }

  const message = naclUtil.decodeUTF8(JSON.stringify(data));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  // Generate ephemeral keypair for this encryption
  const ephemeralKeyPair = nacl.box.keyPair();

  // Encrypt using admin's public key
  const encrypted = nacl.box(
    message,
    nonce,
    ADMIN_ENCRYPTION_PUBKEY,
    ephemeralKeyPair.secretKey
  );

  if (!encrypted) {
    throw new Error('Encryption failed');
  }

  // Combine ephemeral public key with encrypted data
  const combined = new Uint8Array(ephemeralKeyPair.publicKey.length + encrypted.length);
  combined.set(ephemeralKeyPair.publicKey);
  combined.set(encrypted, ephemeralKeyPair.publicKey.length);

  return {
    nonce: naclUtil.encodeBase64(nonce),
    encrypted: naclUtil.encodeBase64(combined),
  };
}

/**
 * Decrypt data (admin only - requires secret key)
 */
export function decryptAsAdmin(
  encryptedData: EncryptedData,
  adminSecretKey: Uint8Array
): AccessRequest {
  const nonce = naclUtil.decodeBase64(encryptedData.nonce);
  const combined = naclUtil.decodeBase64(encryptedData.encrypted);

  // Extract ephemeral public key and encrypted message
  const ephemeralPubKey = combined.slice(0, nacl.box.publicKeyLength);
  const encrypted = combined.slice(nacl.box.publicKeyLength);

  const decrypted = nacl.box.open(
    encrypted,
    nonce,
    ephemeralPubKey,
    adminSecretKey
  );

  if (!decrypted) {
    throw new Error('Decryption failed - invalid key or corrupted data');
  }

  return JSON.parse(naclUtil.encodeUTF8(decrypted));
}

// ============ IPFS ============

const IPFS_GATEWAYS = [
  'https://w3s.link/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

/**
 * Upload encrypted data to IPFS via web3.storage
 */
export async function uploadToIPFS(data: EncryptedData): Promise<string> {
  // Using web3.storage API
  const response = await fetch('https://api.web3.storage/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getWeb3StorageToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(`IPFS upload failed: ${response.statusText}`);
  }

  const result = await response.json();
  return result.cid;
}

/**
 * Fetch encrypted data from IPFS
 */
export async function fetchFromIPFS(cid: string): Promise<EncryptedData> {
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const response = await fetch(`${gateway}${cid}`);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      continue;
    }
  }
  throw new Error(`Failed to fetch from IPFS: ${cid}`);
}

function getWeb3StorageToken(): string {
  // In production, this should come from environment variables
  // For hackathon, we'll use a demo approach
  if (typeof window !== 'undefined') {
    return (window as unknown as { P01_WEB3_STORAGE_TOKEN?: string }).P01_WEB3_STORAGE_TOKEN || '';
  }
  return process.env.WEB3_STORAGE_TOKEN || '';
}

// ============ SDK Client ============

export class WhitelistSDK {
  private connection: Connection;
  private programId: PublicKey;

  constructor(connection: Connection, programId: PublicKey = WHITELIST_PROGRAM_ID) {
    this.connection = connection;
    this.programId = programId;
  }

  /**
   * Check if a wallet has developer access
   */
  async checkAccess(wallet: PublicKey): Promise<{ hasAccess: boolean; entry?: WhitelistEntry }> {
    try {
      const [entryPDA] = getWhitelistEntryPDA(wallet);
      const accountInfo = await this.connection.getAccountInfo(entryPDA);

      if (!accountInfo) {
        return { hasAccess: false };
      }

      const entry = this.parseWhitelistEntry(accountInfo.data);
      return {
        hasAccess: entry.status === WhitelistStatus.Approved,
        entry,
      };
    } catch {
      return { hasAccess: false };
    }
  }

  /**
   * Get whitelist entry for a wallet
   */
  async getEntry(wallet: PublicKey): Promise<WhitelistEntry | null> {
    try {
      const [entryPDA] = getWhitelistEntryPDA(wallet);
      const accountInfo = await this.connection.getAccountInfo(entryPDA);

      if (!accountInfo) {
        return null;
      }

      return this.parseWhitelistEntry(accountInfo.data);
    } catch {
      return null;
    }
  }

  /**
   * Get all pending requests (admin only)
   */
  async getPendingRequests(): Promise<WhitelistEntry[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: 8 + 32 + 4 + 64 + 4 + 64 + 1 + 8 + 8 + 1 }, // WhitelistEntry size
      ],
    });

    return accounts
      .map((acc) => this.parseWhitelistEntry(acc.account.data))
      .filter((entry) => entry.status === WhitelistStatus.Pending);
  }

  /**
   * Parse whitelist entry from account data
   */
  private parseWhitelistEntry(data: Buffer): WhitelistEntry {
    // Skip 8-byte discriminator
    let offset = 8;

    // wallet: Pubkey (32 bytes)
    const wallet = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    // ipfs_cid: String (4 bytes length + content)
    const ipfsCidLen = data.readUInt32LE(offset);
    offset += 4;
    const ipfsCid = data.slice(offset, offset + ipfsCidLen).toString('utf8');
    offset += 64; // max_len

    // project_name: String (4 bytes length + content)
    const projectNameLen = data.readUInt32LE(offset);
    offset += 4;
    const projectName = data.slice(offset, offset + projectNameLen).toString('utf8');
    offset += 64; // max_len

    // status: enum (1 byte)
    const status = data.readUInt8(offset) as WhitelistStatus;
    offset += 1;

    // requested_at: i64 (8 bytes)
    const requestedAt = Number(data.readBigInt64LE(offset));
    offset += 8;

    // reviewed_at: i64 (8 bytes)
    const reviewedAt = Number(data.readBigInt64LE(offset));

    return {
      wallet,
      ipfsCid,
      projectName,
      status,
      requestedAt,
      reviewedAt,
    };
  }
}

// ============ Helper Functions ============

/**
 * Generate admin encryption keypair (run once, save securely)
 */
export function generateAdminKeyPair(): { publicKey: string; secretKey: string } {
  const keyPair = nacl.box.keyPair();
  return {
    publicKey: naclUtil.encodeBase64(keyPair.publicKey),
    secretKey: naclUtil.encodeBase64(keyPair.secretKey),
  };
}

/**
 * Status to human-readable string
 */
export function statusToString(status: WhitelistStatus): string {
  switch (status) {
    case WhitelistStatus.Pending:
      return 'Pending';
    case WhitelistStatus.Approved:
      return 'Approved';
    case WhitelistStatus.Rejected:
      return 'Rejected';
    case WhitelistStatus.Revoked:
      return 'Revoked';
    default:
      return 'Unknown';
  }
}
