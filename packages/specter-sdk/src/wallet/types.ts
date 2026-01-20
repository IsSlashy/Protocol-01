import { PublicKey, Keypair } from '@solana/web3.js';
import type { StealthMetaAddress } from '../types';

/**
 * Internal wallet state with sensitive data
 */
export interface WalletState {
  /** Main keypair for signing */
  keypair: Keypair;
  /** Spending keypair for stealth addresses */
  spendingKeypair: Keypair;
  /** Viewing keypair for scanning payments */
  viewingKeypair: Keypair;
  /** Derived stealth meta-address */
  stealthMetaAddress: StealthMetaAddress;
  /** Original seed phrase */
  seedPhrase: string;
  /** Derivation path used */
  derivationPath: string;
}

/**
 * Serializable wallet data for storage
 */
export interface SerializableWallet {
  /** Public key as base58 */
  publicKey: string;
  /** Encrypted seed phrase */
  encryptedSeedPhrase: string;
  /** Stealth meta-address encoded */
  stealthMetaAddress: string;
  /** Derivation path */
  derivationPath: string;
  /** Creation timestamp */
  createdAt: number;
  /** Wallet label */
  label?: string;
}

/**
 * Options for wallet export
 */
export interface WalletExportOptions {
  /** Include seed phrase in export */
  includeSeedPhrase?: boolean;
  /** Password to encrypt exported data */
  password?: string;
  /** Export format */
  format?: 'json' | 'keystore';
}

/**
 * Exported wallet data
 */
export interface ExportedWallet {
  /** Export version */
  version: number;
  /** Export format */
  format: 'json' | 'keystore';
  /** Public key */
  publicKey: string;
  /** Encrypted data (seed phrase or private key) */
  encryptedData?: string;
  /** Stealth meta-address */
  stealthMetaAddress: string;
  /** Derivation path */
  derivationPath: string;
  /** Export timestamp */
  exportedAt: number;
}

/**
 * HD derivation result
 */
export interface HDDerivationResult {
  /** Derived keypair */
  keypair: Keypair;
  /** Public key */
  publicKey: PublicKey;
  /** Private key bytes */
  privateKey: Uint8Array;
}
