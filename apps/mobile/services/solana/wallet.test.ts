/**
 * Wallet Service Test Suite
 *
 * Validates the core wallet service layer that handles mnemonic generation,
 * BIP32-Ed25519 key derivation, wallet persistence to secure storage,
 * and wallet lifecycle management (create, import, export, delete).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as SecureStore from '../../test/__mocks__/expo-secure-store';
import {
  generateMnemonic,
  validateMnemonic,
  deriveKeypairFromMnemonic,
  createWallet,
  importWallet,
  walletExists,
  getPublicKey,
  getKeypair,
  getMnemonic,
  deleteWallet,
  formatPublicKey,
  getAssociatedTokenAddress,
  tokenAccountExists,
} from './wallet';

describe('Wallet Service -- Wallet Lifecycle and Key Derivation', () => {

  beforeEach(() => {
    SecureStore.__reset();
    vi.clearAllMocks();
  });

  // ===================================================================
  // Section 1: Mnemonic Generation
  // ===================================================================

  describe('Mnemonic Generation', () => {
    it('should generate a 12-word mnemonic', () => {
      const mnemonic = generateMnemonic();
      const words = mnemonic.split(' ');
      expect(words.length).toBe(12);
    });

    it('should generate unique mnemonics on each call', () => {
      const m1 = generateMnemonic();
      const m2 = generateMnemonic();
      expect(m1).not.toBe(m2);
    });

    it('should generate valid mnemonics', () => {
      const mnemonic = generateMnemonic();
      expect(validateMnemonic(mnemonic)).toBe(true);
    });
  });

  // ===================================================================
  // Section 2: Mnemonic Validation
  // ===================================================================

  describe('Mnemonic Validation', () => {
    it('should validate a correct mnemonic', () => {
      const mnemonic = generateMnemonic();
      expect(validateMnemonic(mnemonic)).toBe(true);
    });

    it('should reject an empty string', () => {
      expect(validateMnemonic('')).toBe(false);
    });

    it('should reject random words not forming a valid mnemonic', () => {
      expect(validateMnemonic('hello world test invalid mnemonic phrase here now')).toBe(false);
    });
  });

  // ===================================================================
  // Section 3: Key Derivation from Mnemonic
  // ===================================================================

  describe('Key Derivation from Mnemonic', () => {
    it('should derive a keypair with valid public and secret keys', async () => {
      const mnemonic = generateMnemonic();
      const keypair = await deriveKeypairFromMnemonic(mnemonic);

      expect(keypair).toBeDefined();
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.secretKey).toBeDefined();
      expect(keypair.secretKey.length).toBe(64);
    });

    it('should produce deterministic keypairs from the same mnemonic', async () => {
      const mnemonic = generateMnemonic();
      const kp1 = await deriveKeypairFromMnemonic(mnemonic);
      const kp2 = await deriveKeypairFromMnemonic(mnemonic);

      expect(kp1.publicKey.toBase58()).toBe(kp2.publicKey.toBase58());
    });

    it('should produce different keypairs from different mnemonics', async () => {
      const m1 = generateMnemonic();
      const m2 = generateMnemonic();
      const kp1 = await deriveKeypairFromMnemonic(m1);
      const kp2 = await deriveKeypairFromMnemonic(m2);

      expect(kp1.publicKey.toBase58()).not.toBe(kp2.publicKey.toBase58());
    });
  });

  // ===================================================================
  // Section 4: Wallet Creation
  // ===================================================================

  describe('Wallet Creation', () => {
    it('should create a new wallet and return public key and mnemonic', async () => {
      const wallet = await createWallet();

      expect(wallet.publicKey).toBeTruthy();
      expect(wallet.mnemonic).toBeTruthy();
      expect(wallet.mnemonic!.split(' ').length).toBe(12);
    });

    it('should store wallet data in secure storage', async () => {
      await createWallet();

      const store = SecureStore.__getStore();
      expect(store['p01_mnemonic']).toBeTruthy();
      expect(store['p01_private_key']).toBeTruthy();
      expect(store['p01_public_key']).toBeTruthy();
      expect(store['p01_wallet_exists']).toBe('true');
    });

    it('should make walletExists return true after creation', async () => {
      expect(await walletExists()).toBe(false);
      await createWallet();
      expect(await walletExists()).toBe(true);
    });
  });

  // ===================================================================
  // Section 5: Wallet Import
  // ===================================================================

  describe('Wallet Import from Mnemonic', () => {
    it('should import a wallet from a valid mnemonic', async () => {
      const mnemonic = generateMnemonic();
      const wallet = await importWallet(mnemonic);

      expect(wallet.publicKey).toBeTruthy();
    });

    it('should store imported wallet credentials in secure storage', async () => {
      const mnemonic = generateMnemonic();
      await importWallet(mnemonic);

      const store = SecureStore.__getStore();
      expect(store['p01_mnemonic']).toBeTruthy();
      expect(store['p01_wallet_exists']).toBe('true');
    });

    it('should normalize the mnemonic during import', async () => {
      const mnemonic = generateMnemonic();
      const uppercased = mnemonic.toUpperCase();
      const wallet = await importWallet(`  ${uppercased}  `);

      expect(wallet.publicKey).toBeTruthy();
    });

    it('should derive the same keypair as an extension wallet with the same mnemonic', async () => {
      const mnemonic = generateMnemonic();
      const importedWallet = await importWallet(mnemonic);
      const directKeypair = await deriveKeypairFromMnemonic(mnemonic.toLowerCase().trim());

      expect(importedWallet.publicKey).toBe(directKeypair.publicKey.toBase58());
    });

    it('should reject empty mnemonic', async () => {
      await expect(importWallet('')).rejects.toThrow();
    });

    it('should reject mnemonic with wrong word count', async () => {
      await expect(importWallet('one two three')).rejects.toThrow();
    });

    it('should reject invalid mnemonic checksum', async () => {
      // 12 words from wordlist but invalid checksum
      await expect(
        importWallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon')
      ).rejects.toThrow();
    });
  });

  // ===================================================================
  // Section 6: Wallet Retrieval
  // ===================================================================

  describe('Wallet Data Retrieval', () => {
    it('should retrieve the stored public key', async () => {
      const wallet = await createWallet();
      const pk = await getPublicKey();
      expect(pk).toBe(wallet.publicKey);
    });

    it('should retrieve the keypair from secure storage', async () => {
      await createWallet();
      const keypair = await getKeypair();
      expect(keypair).not.toBeNull();
      expect(keypair!.secretKey.length).toBe(64);
    });

    it('should return null keypair when no wallet exists', async () => {
      const keypair = await getKeypair();
      expect(keypair).toBeNull();
    });

    it('should retrieve the stored mnemonic', async () => {
      const wallet = await createWallet();
      const mnemonic = await getMnemonic();
      expect(mnemonic).toBeTruthy();
      expect(mnemonic!.split(' ').length).toBe(12);
    });
  });

  // ===================================================================
  // Section 7: Wallet Deletion
  // ===================================================================

  describe('Wallet Deletion', () => {
    it('should delete all wallet data from secure storage', async () => {
      await createWallet();
      expect(await walletExists()).toBe(true);

      await deleteWallet();
      expect(await walletExists()).toBe(false);
    });

    it('should clear mnemonic, private key, and public key', async () => {
      await createWallet();
      await deleteWallet();

      const store = SecureStore.__getStore();
      expect(store['p01_mnemonic']).toBeUndefined();
      expect(store['p01_private_key']).toBeUndefined();
      expect(store['p01_public_key']).toBeUndefined();
    });

    it('should also clear onboarding state', async () => {
      await SecureStore.setItemAsync('p01_onboarded', 'true');
      await createWallet();
      await deleteWallet();

      const onboarded = await SecureStore.getItemAsync('p01_onboarded');
      expect(onboarded).toBeNull();
    });
  });

  // ===================================================================
  // Section 8: Display Formatting
  // ===================================================================

  describe('Public Key Display Formatting', () => {
    it('should truncate with default 4 characters', () => {
      const address = 'AbCdEfGhIjKlMnOpQrStUvWxYz12345678';
      expect(formatPublicKey(address)).toBe('AbCd...5678');
    });

    it('should use custom character count', () => {
      const address = 'AbCdEfGhIjKlMnOpQrStUvWxYz12345678';
      expect(formatPublicKey(address, 6)).toBe('AbCdEf...345678');
    });

    it('should return short addresses unchanged', () => {
      expect(formatPublicKey('abc')).toBe('abc');
    });
  });
});
