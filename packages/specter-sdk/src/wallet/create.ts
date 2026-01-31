import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import type { SpecterWallet, WalletCreateOptions, StealthMetaAddress } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import type { WalletState, HDDerivationResult } from './types';
import {
  DEFAULT_DERIVATION_PATH,
  DEFAULT_MNEMONIC_STRENGTH,
  STEALTH_DERIVATION,
} from '../constants';
import { encodeStealthMetaAddress } from '../utils/helpers';

/**
 * Derive a keypair from seed using HD derivation
 * @param seed - 64-byte seed from mnemonic
 * @param derivationPath - BIP44 derivation path
 */
export function deriveKeypair(seed: Buffer, derivationPath: string): HDDerivationResult {
  const derived = derivePath(derivationPath, seed.toString('hex'));
  const keypair = Keypair.fromSeed(derived.key);

  return {
    keypair,
    publicKey: keypair.publicKey,
    privateKey: derived.key,
  };
}

/**
 * Generate stealth keys from seed
 * @param seed - 64-byte seed from mnemonic
 */
function generateStealthKeys(seed: Buffer): {
  spendingKeypair: Keypair;
  viewingKeypair: Keypair;
  stealthMetaAddress: StealthMetaAddress;
} {
  // Derive spending keypair
  const spendingResult = deriveKeypair(seed, STEALTH_DERIVATION.SPENDING_KEY_PATH);
  const spendingKeypair = spendingResult.keypair;

  // Derive viewing keypair
  const viewingResult = deriveKeypair(seed, STEALTH_DERIVATION.VIEWING_KEY_PATH);
  const viewingKeypair = viewingResult.keypair;

  // Create stealth meta-address
  const stealthMetaAddress: StealthMetaAddress = {
    spendingPubKey: spendingKeypair.publicKey.toBytes(),
    viewingPubKey: viewingKeypair.publicKey.toBytes(),
    encoded: encodeStealthMetaAddress(
      spendingKeypair.publicKey.toBytes(),
      viewingKeypair.publicKey.toBytes()
    ),
  };

  return {
    spendingKeypair,
    viewingKeypair,
    stealthMetaAddress,
  };
}

/**
 * Create a new Specter wallet with a fresh seed phrase
 * @param options - Wallet creation options
 */
export async function createWallet(
  options: WalletCreateOptions = {}
): Promise<SpecterWallet> {
  const {
    derivationPath = DEFAULT_DERIVATION_PATH,
    strength = DEFAULT_MNEMONIC_STRENGTH,
  } = options;

  try {
    // Generate new mnemonic
    const mnemonic = bip39.generateMnemonic(strength);

    // Convert mnemonic to seed
    const seed = await bip39.mnemonicToSeed(mnemonic);

    // Derive main keypair
    const mainResult = deriveKeypair(Buffer.from(seed), derivationPath);

    // Generate stealth keys
    const { stealthMetaAddress } = generateStealthKeys(Buffer.from(seed));

    return {
      publicKey: mainResult.publicKey,
      keypair: mainResult.keypair,
      stealthMetaAddress,
      seedPhrase: mnemonic,
      derivationPath,
    };
  } catch (error) {
    throw new SpecterError(
      SpecterErrorCode.WALLET_CREATION_FAILED,
      'Failed to create wallet',
      error as Error
    );
  }
}

/**
 * Create internal wallet state with all keypairs
 * @param mnemonic - BIP39 mnemonic phrase
 * @param derivationPath - Derivation path for main keypair
 */
export async function createWalletState(
  mnemonic: string,
  derivationPath: string = DEFAULT_DERIVATION_PATH
): Promise<WalletState> {
  try {
    // Convert mnemonic to seed
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const seedBuffer = Buffer.from(seed);

    // Derive main keypair
    const mainResult = deriveKeypair(seedBuffer, derivationPath);

    // Generate stealth keys
    const { spendingKeypair, viewingKeypair, stealthMetaAddress } =
      generateStealthKeys(seedBuffer);

    return {
      keypair: mainResult.keypair,
      spendingKeypair,
      viewingKeypair,
      stealthMetaAddress,
      seedPhrase: mnemonic,
      derivationPath,
    };
  } catch (error) {
    throw new SpecterError(
      SpecterErrorCode.DERIVATION_FAILED,
      'Failed to derive wallet keys',
      error as Error
    );
  }
}

/**
 * Generate a valid BIP39 mnemonic
 * @param strength - Entropy bits (128, 160, 192, 224, or 256)
 */
export function generateMnemonic(
  strength: 128 | 160 | 192 | 224 | 256 = DEFAULT_MNEMONIC_STRENGTH
): string {
  return bip39.generateMnemonic(strength);
}

/**
 * Validate a mnemonic phrase
 * @param mnemonic - Mnemonic to validate
 */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic);
}

/**
 * Get word list for mnemonic generation
 */
export function getWordList(): string[] {
  return bip39.wordlists.english ?? [];
}
