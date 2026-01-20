import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import bs58 from 'bs58';
import type { SpecterWallet, WalletImportOptions } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import type { WalletState, ExportedWallet, SerializableWallet } from './types';
import { DEFAULT_DERIVATION_PATH } from '../constants';
import { createWalletState, deriveKeypair, validateMnemonic } from './create';
import { decryptWithPassword } from '../utils/crypto';
import { decodeStealthMetaAddress } from '../utils/helpers';

/**
 * Import a wallet from a seed phrase (mnemonic)
 * @param seedPhrase - BIP39 mnemonic phrase
 * @param options - Import options
 */
export async function importFromSeedPhrase(
  seedPhrase: string,
  options: WalletImportOptions = {}
): Promise<SpecterWallet> {
  const { derivationPath = DEFAULT_DERIVATION_PATH } = options;

  // Normalize the seed phrase
  const normalizedSeedPhrase = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');

  // Validate the mnemonic
  if (!validateMnemonic(normalizedSeedPhrase)) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_SEED_PHRASE,
      'Invalid seed phrase. Please check the words and try again.'
    );
  }

  try {
    // Create wallet state
    const walletState = await createWalletState(normalizedSeedPhrase, derivationPath);

    return {
      publicKey: walletState.keypair.publicKey,
      keypair: walletState.keypair,
      stealthMetaAddress: walletState.stealthMetaAddress,
      seedPhrase: normalizedSeedPhrase,
      derivationPath,
    };
  } catch (error) {
    if (error instanceof SpecterError) {
      throw error;
    }
    throw new SpecterError(
      SpecterErrorCode.DERIVATION_FAILED,
      'Failed to import wallet from seed phrase',
      error as Error
    );
  }
}

/**
 * Import a wallet from a private key
 * @param privateKey - Base58 encoded private key or Uint8Array
 */
export function importFromPrivateKey(privateKey: string | Uint8Array): Keypair {
  try {
    if (typeof privateKey === 'string') {
      // Try to decode as base58
      const decoded = bs58.decode(privateKey);
      return Keypair.fromSecretKey(decoded);
    }
    return Keypair.fromSecretKey(privateKey);
  } catch (error) {
    throw new SpecterError(
      SpecterErrorCode.DERIVATION_FAILED,
      'Invalid private key format',
      error as Error
    );
  }
}

/**
 * Import a wallet from an exported wallet file
 * @param exported - Exported wallet data
 * @param password - Password to decrypt (if encrypted)
 */
export async function importFromExport(
  exported: ExportedWallet,
  password?: string
): Promise<SpecterWallet> {
  if (exported.version !== 1) {
    throw new SpecterError(
      SpecterErrorCode.DERIVATION_FAILED,
      `Unsupported export version: ${exported.version}`
    );
  }

  // If encrypted data exists, decrypt it
  if (exported.encryptedData) {
    if (!password) {
      throw new SpecterError(
        SpecterErrorCode.DERIVATION_FAILED,
        'Password required to decrypt wallet'
      );
    }

    const encryptedBytes = bs58.decode(exported.encryptedData);
    const decrypted = decryptWithPassword(encryptedBytes, password);

    if (!decrypted) {
      throw new SpecterError(
        SpecterErrorCode.DERIVATION_FAILED,
        'Failed to decrypt wallet. Invalid password.'
      );
    }

    // The decrypted data is the seed phrase
    const seedPhrase = new TextDecoder().decode(decrypted);
    return importFromSeedPhrase(seedPhrase, {
      derivationPath: exported.derivationPath,
    });
  }

  throw new SpecterError(
    SpecterErrorCode.DERIVATION_FAILED,
    'No encrypted data found in export'
  );
}

/**
 * Import a wallet from serialized storage format
 * @param serialized - Serialized wallet data
 * @param password - Password to decrypt
 */
export async function importFromSerialized(
  serialized: SerializableWallet,
  password: string
): Promise<SpecterWallet> {
  try {
    const encryptedBytes = bs58.decode(serialized.encryptedSeedPhrase);
    const decrypted = decryptWithPassword(encryptedBytes, password);

    if (!decrypted) {
      throw new SpecterError(
        SpecterErrorCode.DERIVATION_FAILED,
        'Failed to decrypt wallet. Invalid password.'
      );
    }

    const seedPhrase = new TextDecoder().decode(decrypted);
    return importFromSeedPhrase(seedPhrase, {
      derivationPath: serialized.derivationPath,
    });
  } catch (error) {
    if (error instanceof SpecterError) {
      throw error;
    }
    throw new SpecterError(
      SpecterErrorCode.DERIVATION_FAILED,
      'Failed to import wallet from storage',
      error as Error
    );
  }
}

/**
 * Import wallet state with all stealth keys
 * @param seedPhrase - BIP39 mnemonic phrase
 * @param options - Import options
 */
export async function importWalletState(
  seedPhrase: string,
  options: WalletImportOptions = {}
): Promise<WalletState> {
  const { derivationPath = DEFAULT_DERIVATION_PATH } = options;

  // Normalize the seed phrase
  const normalizedSeedPhrase = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');

  // Validate the mnemonic
  if (!validateMnemonic(normalizedSeedPhrase)) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_SEED_PHRASE,
      'Invalid seed phrase. Please check the words and try again.'
    );
  }

  try {
    return await createWalletState(normalizedSeedPhrase, derivationPath);
  } catch (error) {
    if (error instanceof SpecterError) {
      throw error;
    }
    throw new SpecterError(
      SpecterErrorCode.DERIVATION_FAILED,
      'Failed to import wallet state',
      error as Error
    );
  }
}

/**
 * Recover wallet addresses from a seed phrase for multiple derivation paths
 * @param seedPhrase - BIP39 mnemonic phrase
 * @param count - Number of addresses to derive
 */
export async function recoverAddresses(
  seedPhrase: string,
  count: number = 10
): Promise<{ path: string; address: string }[]> {
  // Normalize the seed phrase
  const normalizedSeedPhrase = seedPhrase.trim().toLowerCase().replace(/\s+/g, ' ');

  // Validate the mnemonic
  if (!validateMnemonic(normalizedSeedPhrase)) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_SEED_PHRASE,
      'Invalid seed phrase'
    );
  }

  const seed = await bip39.mnemonicToSeed(normalizedSeedPhrase);
  const seedBuffer = Buffer.from(seed);
  const addresses: { path: string; address: string }[] = [];

  // Derive addresses for different account indices
  for (let i = 0; i < count; i++) {
    const path = `m/44'/501'/${i}'/0'`;
    const result = deriveKeypair(seedBuffer, path);
    addresses.push({
      path,
      address: result.publicKey.toBase58(),
    });
  }

  return addresses;
}
