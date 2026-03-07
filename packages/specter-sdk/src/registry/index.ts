/**
 * Stealth Meta-Address Registry
 *
 * On-chain address book that lets users publish their stealth meta-address
 * so anyone can look them up by wallet and send private payments.
 *
 * Supports v1 (classical X25519) and v2 (hybrid X25519 + ML-KEM-768).
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
} from '@solana/web3.js';
import type { StealthMetaAddress, WalletAdapter } from '../types';
import { encodeStealthMetaAddress } from '../utils/helpers';

// Program ID (matches declare_id! in p01_registry)
export const REGISTRY_PROGRAM_ID = new PublicKey(
  'Hz4ZULacefgJzq94YJTSq3WmQAySyYuzCRiEzNXCA2sZ'
);

const USER_REGISTRY_SEED = Buffer.from('user_registry');

// KEM pubkey size (ML-KEM-768 per FIPS 203)
const KEM_PUBKEY_LEN = 1184;

// Max display name length
const MAX_NAME_LEN = 32;

// ── Types ─────────────────────────────────────────────────────────

export interface RegistryEntry {
  /** Owner wallet address */
  owner: PublicKey;
  /** Spending public key (Ed25519, 32 bytes) */
  spendingPubKey: Uint8Array;
  /** Viewing public key (X25519, 32 bytes) */
  viewingPubKey: Uint8Array;
  /** Meta-address version: 1 = classical, 2 = hybrid */
  version: number;
  /** Whether ML-KEM-768 key is present */
  hasKemKey: boolean;
  /** ML-KEM-768 public key (1184 bytes, only if version 2) */
  kemPubKey?: Uint8Array;
  /** Display name (max 32 bytes UTF-8) */
  name: string;
  /** Encoded stealth meta-address string (st:01... or st:02...) */
  encodedMetaAddress: string;
  /** Created timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

// ── PDA Derivation ────────────────────────────────────────────────

/**
 * Derive the registry PDA for a given wallet address.
 */
export function getRegistryPDA(
  wallet: PublicKey,
  programId: PublicKey = REGISTRY_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USER_REGISTRY_SEED, wallet.toBuffer()],
    programId
  );
}

// ── Lookup ────────────────────────────────────────────────────────

/**
 * Look up a user's stealth meta-address from the on-chain registry.
 *
 * @param connection - Solana connection
 * @param wallet - The wallet address to look up
 * @returns The registry entry, or null if not registered
 */
export async function lookupMetaAddress(
  connection: Connection,
  wallet: PublicKey,
  programId: PublicKey = REGISTRY_PROGRAM_ID
): Promise<RegistryEntry | null> {
  const [pda] = getRegistryPDA(wallet, programId);
  const accountInfo = await connection.getAccountInfo(pda);

  if (!accountInfo || !accountInfo.data) {
    return null;
  }

  return parseRegistryEntry(accountInfo.data, wallet);
}

/**
 * Look up multiple users' meta-addresses in a single RPC call.
 */
export async function lookupMultiple(
  connection: Connection,
  wallets: PublicKey[],
  programId: PublicKey = REGISTRY_PROGRAM_ID
): Promise<Map<string, RegistryEntry>> {
  const pdas = wallets.map((w) => getRegistryPDA(w, programId)[0]);
  const accounts = await connection.getMultipleAccountsInfo(pdas);

  const results = new Map<string, RegistryEntry>();
  for (let i = 0; i < wallets.length; i++) {
    const acc = accounts[i];
    if (acc && acc.data) {
      const wallet = wallets[i]!;
      const entry = parseRegistryEntry(acc.data, wallet);
      if (entry) {
        results.set(wallet.toBase58(), entry);
      }
    }
  }
  return results;
}

/**
 * Check if a wallet has a registry entry.
 */
export async function isRegistered(
  connection: Connection,
  wallet: PublicKey,
  programId: PublicKey = REGISTRY_PROGRAM_ID
): Promise<boolean> {
  const [pda] = getRegistryPDA(wallet, programId);
  const accountInfo = await connection.getAccountInfo(pda);
  return accountInfo !== null;
}

// ── Parsing ───────────────────────────────────────────────────────

function parseRegistryEntry(
  data: Buffer,
  wallet: PublicKey
): RegistryEntry | null {
  try {
    // Skip 8-byte Anchor discriminator
    let offset = 8;

    // owner: Pubkey (32)
    const owner = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;

    // spending_pub_key: [u8; 32]
    const spendingPubKey = new Uint8Array(data.subarray(offset, offset + 32));
    offset += 32;

    // viewing_pub_key: [u8; 32]
    const viewingPubKey = new Uint8Array(data.subarray(offset, offset + 32));
    offset += 32;

    // version: u8
    const version = data.readUInt8(offset);
    offset += 1;

    // has_kem_key: bool
    const hasKemKey = data.readUInt8(offset) === 1;
    offset += 1;

    // kem_pub_key: [u8; 1184]
    const kemPubKey = hasKemKey
      ? new Uint8Array(data.subarray(offset, offset + KEM_PUBKEY_LEN))
      : undefined;
    offset += KEM_PUBKEY_LEN;

    // name: String (Borsh: u32 length prefix + bytes)
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    const name = data.subarray(offset, offset + nameLen).toString('utf8');
    offset += MAX_NAME_LEN;

    // created_at: i64
    const createdAt = Number(data.readBigInt64LE(offset));
    offset += 8;

    // updated_at: i64
    const updatedAt = Number(data.readBigInt64LE(offset));
    offset += 8;

    // Encode the meta-address string
    const encodedMetaAddress = encodeStealthMetaAddress(
      spendingPubKey,
      viewingPubKey,
      kemPubKey
    );

    return {
      owner,
      spendingPubKey,
      viewingPubKey,
      version,
      hasKemKey,
      kemPubKey,
      name,
      encodedMetaAddress,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

// ── Convert to StealthMetaAddress ─────────────────────────────────

/**
 * Convert a registry entry to a StealthMetaAddress for use with
 * generateStealthAddress() and other SDK functions.
 */
export function entryToMetaAddress(entry: RegistryEntry): StealthMetaAddress {
  return {
    spendingPubKey: entry.spendingPubKey,
    viewingPubKey: entry.viewingPubKey,
    kemPubKey: entry.kemPubKey,
    encoded: entry.encodedMetaAddress,
  };
}

export type { StealthMetaAddress };
