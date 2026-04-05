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
import { kemGenerateKeypair } from '../utils/crypto';

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
 * @param enableHybrid - Generate ML-KEM-768 keypair for post-quantum hybrid mode
 */
function generateStealthKeys(seed: Buffer, enableHybrid: boolean = false): {
  spendingKeypair: Keypair;
  viewingKeypair: Keypair;
  stealthMetaAddress: StealthMetaAddress;
  kemSecretKey?: Uint8Array;
} {
  const spendingResult = deriveKeypair(seed, STEALTH_DERIVATION.SPENDING_KEY_PATH);
  const spendingKeypair = spendingResult.keypair;

  const viewingResult = deriveKeypair(seed, STEALTH_DERIVATION.VIEWING_KEY_PATH);
  const viewingKeypair = viewingResult.keypair;

  const spendingPubKey = spendingKeypair.publicKey.toBytes();
  const viewingPubKey = viewingKeypair.publicKey.toBytes();

  if (enableHybrid) {
    const kem = kemGenerateKeypair();
    const stealthMetaAddress: StealthMetaAddress = {
      spendingPubKey,
      viewingPubKey,
      kemPubKey: kem.publicKey,
      encoded: encodeStealthMetaAddress(spendingPubKey, viewingPubKey, kem.publicKey),
    };
    return { spendingKeypair, viewingKeypair, stealthMetaAddress, kemSecretKey: kem.secretKey };
  }

  const stealthMetaAddress: StealthMetaAddress = {
    spendingPubKey,
    viewingPubKey,
    encoded: encodeStealthMetaAddress(spendingPubKey, viewingPubKey),
  };

  return { spendingKeypair, viewingKeypair, stealthMetaAddress };
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
    enableHybrid = false,
  } = options;

  try {
    const mnemonic = bip39.generateMnemonic(strength);
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const mainResult = deriveKeypair(Buffer.from(seed), derivationPath);
    const { stealthMetaAddress } = generateStealthKeys(Buffer.from(seed), enableHybrid);

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
  derivationPath: string = DEFAULT_DERIVATION_PATH,
  enableHybrid: boolean = false
): Promise<WalletState> {
  try {
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const seedBuffer = Buffer.from(seed);
    const mainResult = deriveKeypair(seedBuffer, derivationPath);

    const { spendingKeypair, viewingKeypair, stealthMetaAddress, kemSecretKey } =
      generateStealthKeys(seedBuffer, enableHybrid);

    return {
      keypair: mainResult.keypair,
      spendingKeypair,
      viewingKeypair,
      stealthMetaAddress,
      kemSecretKey,
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
