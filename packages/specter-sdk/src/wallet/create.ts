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
import { kemGenerateKeypair, deriveKemSeed, ed25519PublicKeyToX25519 } from '../utils/crypto';

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
 * Generate stealth keys from seed.
 *
 * P4.1 (2026-04-17): v2 hybrid is now the default and the only supported
 * production mode. `enableHybrid=false` is retained strictly as a legacy
 * interop hook and will throw unless the caller also passes
 * `allowLegacyV1: true`.
 *
 * @param seed - 64-byte seed from mnemonic
 * @param enableHybrid - Generate ML-KEM-768 keypair for post-quantum hybrid mode (default true)
 * @param options.allowLegacyV1 - Opt-in escape hatch for legacy v1 generation (tests only)
 */
function generateStealthKeys(
  seed: Buffer,
  enableHybrid: boolean = true,
  options: { allowLegacyV1?: boolean } = {},
): {
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
  // The viewing keypair is HD-derived as Ed25519, but stealth ECDH is X25519.
  // Publish the Montgomery form so senders derive the same shared secret the
  // recipient recovers with `ed25519SecretKeyToX25519(viewing seed)`.
  const viewingPubKey = ed25519PublicKeyToX25519(viewingKeypair.publicKey.toBytes());

  if (enableHybrid) {
    // Derive the ML-KEM keypair deterministically from the wallet seed so the
    // secret key is recoverable from the mnemonic (createWallet and
    // createWalletState must produce the identical keypair, or the recipient
    // can never decapsulate the KEM ciphertext to scan).
    const kem = kemGenerateKeypair(deriveKemSeed(seed));
    const stealthMetaAddress: StealthMetaAddress = {
      spendingPubKey,
      viewingPubKey,
      kemPubKey: kem.publicKey,
      encoded: encodeStealthMetaAddress(spendingPubKey, viewingPubKey, kem.publicKey),
    };
    return { spendingKeypair, viewingKeypair, stealthMetaAddress, kemSecretKey: kem.secretKey };
  }

  if (!options.allowLegacyV1) {
    throw new SpecterError(
      SpecterErrorCode.WALLET_CREATION_FAILED,
      'Legacy v1 stealth meta-address generation is disabled. ' +
        'Omit `enableHybrid: false` or pass `allowLegacyV1: true` for legacy tests only.',
    );
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
    enableHybrid = true,
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
  enableHybrid: boolean = true
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
