/**
 * Mnemonic → Solana Keypair, byte-identical to the mobile app and extension:
 *   bip39.mnemonicToSeed (PBKDF2-SHA512) → ed25519-hd-key m/44'/501'/0'/0'
 * (see apps/extension/src/shared/services/wallet.ts). The mnemonic string is
 * used once and never stored; the caller keeps only the Keypair in memory.
 */
import { Buffer } from 'buffer';
if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}

import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';

const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export async function keypairFromMnemonic(mnemonic: string): Promise<Keypair> {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(normalized)) {
    throw new Error('The paired phone sent an invalid recovery phrase.');
  }
  const seed = await bip39.mnemonicToSeed(normalized);
  const derived = derivePath(SOLANA_DERIVATION_PATH, seed.toString('hex')).key;
  return Keypair.fromSeed(new Uint8Array(derived));
}
