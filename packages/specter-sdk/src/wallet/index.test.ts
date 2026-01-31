import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Hoisted constants – available inside vi.mock() factories
// ---------------------------------------------------------------------------

const { MOCK_MNEMONIC, MOCK_SEED } = vi.hoisted(() => ({
  MOCK_MNEMONIC:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  MOCK_SEED: Buffer.alloc(64, 0xab),
}));

// ---------------------------------------------------------------------------
// Mock bip39 so we can control mnemonic generation and validation
// ---------------------------------------------------------------------------

vi.mock('bip39', () => ({
  generateMnemonic: vi.fn().mockReturnValue(MOCK_MNEMONIC),
  mnemonicToSeed: vi.fn().mockResolvedValue(MOCK_SEED),
  validateMnemonic: vi.fn().mockImplementation((m: string) => {
    // Accept both the mock mnemonic and the 24-word test mnemonic
    const normalised = m.trim().toLowerCase().replace(/\s+/g, ' ');
    const words = normalised.split(' ');
    return words.length === 12 || words.length === 24;
  }),
  wordlists: {
    english: Array.from({ length: 2048 }, (_, i) => `word${i}`),
  },
}));

// Mock ed25519-hd-key so derivePath returns deterministic results
vi.mock('ed25519-hd-key', () => ({
  derivePath: vi.fn().mockImplementation((_path: string, _seed: string) => {
    // Return a 32-byte deterministic key seeded from the path string
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      key[i] = (i + _path.charCodeAt(i % _path.length)) % 256;
    }
    return { key };
  }),
}));

// Provide SpecterError / SpecterErrorCode / SpecterWallet aliases
vi.mock('../types', async () => {
  const actual = await vi.importActual<typeof import('../types')>('../types');
  return {
    ...actual,
    SpecterError: actual.P01Error,
    SpecterErrorCode: actual.P01ErrorCode,
    // SpecterWallet is a type alias for P01Wallet - used as type only
  };
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import * as bip39 from 'bip39';

import {
  createWallet,
  createWalletState,
  generateMnemonic,
  validateMnemonic,
  getWordList,
  deriveKeypair,
} from './create';

import {
  importFromSeedPhrase,
  importFromPrivateKey,
  importWalletState,
  recoverAddresses,
} from './import';

import type { WalletState } from './types';

// ===========================================================================
// wallet/create.ts
// ===========================================================================

describe('wallet/create', () => {
  // -----------------------------------------------------------------------
  // generateMnemonic
  // -----------------------------------------------------------------------
  describe('generateMnemonic', () => {
    it('returns a string', () => {
      const mnemonic = generateMnemonic();
      expect(typeof mnemonic).toBe('string');
      expect(mnemonic.length).toBeGreaterThan(0);
    });

    it('calls bip39.generateMnemonic with default strength', () => {
      generateMnemonic();
      expect(bip39.generateMnemonic).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // validateMnemonic
  // -----------------------------------------------------------------------
  describe('validateMnemonic', () => {
    it('returns true for a valid 12-word mnemonic', () => {
      expect(validateMnemonic(MOCK_MNEMONIC)).toBe(true);
    });

    it('returns false for invalid mnemonic', () => {
      vi.mocked(bip39.validateMnemonic).mockReturnValueOnce(false);
      expect(validateMnemonic('hello')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getWordList
  // -----------------------------------------------------------------------
  describe('getWordList', () => {
    it('returns an array of strings', () => {
      const words = getWordList();
      expect(Array.isArray(words)).toBe(true);
      expect(words.length).toBe(2048);
      expect(typeof words[0]).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // deriveKeypair
  // -----------------------------------------------------------------------
  describe('deriveKeypair', () => {
    it('derives a keypair from seed and path', () => {
      const seed = Buffer.alloc(64, 0x42);
      const result = deriveKeypair(seed, "m/44'/501'/0'/0'");

      expect(result.keypair).toBeInstanceOf(Keypair);
      expect(result.publicKey).toBeInstanceOf(PublicKey);
      expect(result.privateKey).toBeInstanceOf(Uint8Array);
      expect(result.privateKey.length).toBe(32);
    });

    it('different derivation paths produce different keypairs', () => {
      const seed = Buffer.alloc(64, 0x42);
      const a = deriveKeypair(seed, "m/44'/501'/0'/0'");
      const b = deriveKeypair(seed, "m/44'/501'/1'/0'");

      expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
    });
  });

  // -----------------------------------------------------------------------
  // createWallet
  // -----------------------------------------------------------------------
  describe('createWallet', () => {
    it('creates a wallet with all expected properties', async () => {
      const wallet = await createWallet();

      expect(wallet.publicKey).toBeInstanceOf(PublicKey);
      expect(wallet.keypair).toBeInstanceOf(Keypair);
      expect(wallet.seedPhrase).toBe(MOCK_MNEMONIC);
      expect(wallet.derivationPath).toBe("m/44'/501'/0'/0'");
      expect(wallet.stealthMetaAddress).toBeDefined();
      expect(wallet.stealthMetaAddress.spendingPubKey.length).toBe(32);
      expect(wallet.stealthMetaAddress.viewingPubKey.length).toBe(32);
      expect(typeof wallet.stealthMetaAddress.encoded).toBe('string');
    });

    it('creates a wallet with custom derivation path', async () => {
      const wallet = await createWallet({
        derivationPath: "m/44'/501'/1'/0'",
      });

      expect(wallet.derivationPath).toBe("m/44'/501'/1'/0'");
    });

    it('stealth meta-address encoded string starts with "st"', async () => {
      const wallet = await createWallet();
      expect(wallet.stealthMetaAddress.encoded.startsWith('st')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // createWalletState
  // -----------------------------------------------------------------------
  describe('createWalletState', () => {
    it('produces WalletState with all stealth keypairs', async () => {
      const state = await createWalletState(MOCK_MNEMONIC);

      expect(state.keypair).toBeInstanceOf(Keypair);
      expect(state.spendingKeypair).toBeInstanceOf(Keypair);
      expect(state.viewingKeypair).toBeInstanceOf(Keypair);
      expect(state.stealthMetaAddress).toBeDefined();
      expect(state.seedPhrase).toBe(MOCK_MNEMONIC);
      expect(state.derivationPath).toBe("m/44'/501'/0'/0'");
    });

    it('spending and viewing keypairs are distinct from the main keypair', async () => {
      const state = await createWalletState(MOCK_MNEMONIC);

      expect(state.keypair.publicKey.toBase58()).not.toBe(
        state.spendingKeypair.publicKey.toBase58()
      );
      expect(state.keypair.publicKey.toBase58()).not.toBe(
        state.viewingKeypair.publicKey.toBase58()
      );
      expect(state.spendingKeypair.publicKey.toBase58()).not.toBe(
        state.viewingKeypair.publicKey.toBase58()
      );
    });

    it('accepts a custom derivation path', async () => {
      const state = await createWalletState(
        MOCK_MNEMONIC,
        "m/44'/501'/2'/0'"
      );

      expect(state.derivationPath).toBe("m/44'/501'/2'/0'");
    });
  });
});

// ===========================================================================
// wallet/import.ts
// ===========================================================================

describe('wallet/import', () => {
  // -----------------------------------------------------------------------
  // importFromSeedPhrase
  // -----------------------------------------------------------------------
  describe('importFromSeedPhrase', () => {
    it('imports a wallet from a valid seed phrase', async () => {
      const wallet = await importFromSeedPhrase(MOCK_MNEMONIC);

      expect(wallet.publicKey).toBeInstanceOf(PublicKey);
      expect(wallet.keypair).toBeInstanceOf(Keypair);
      expect(wallet.stealthMetaAddress).toBeDefined();
      expect(typeof wallet.seedPhrase).toBe('string');
    });

    it('normalises whitespace in the seed phrase', async () => {
      const messy = '  ' + MOCK_MNEMONIC.replace(/ /g, '   ') + '  ';
      const wallet = await importFromSeedPhrase(messy);

      expect(wallet.seedPhrase).toBe(MOCK_MNEMONIC);
    });

    it('throws for an invalid seed phrase', async () => {
      vi.mocked(bip39.validateMnemonic).mockReturnValueOnce(false);

      await expect(importFromSeedPhrase('invalid phrase')).rejects.toThrow();
    });

    it('accepts custom import options', async () => {
      const wallet = await importFromSeedPhrase(MOCK_MNEMONIC, {
        derivationPath: "m/44'/501'/5'/0'",
      });

      expect(wallet.derivationPath).toBe("m/44'/501'/5'/0'");
    });
  });

  // -----------------------------------------------------------------------
  // importFromPrivateKey
  // -----------------------------------------------------------------------
  describe('importFromPrivateKey', () => {
    it('imports from a Uint8Array secret key', () => {
      const original = Keypair.generate();
      const imported = importFromPrivateKey(original.secretKey);

      expect(imported.publicKey.toBase58()).toBe(
        original.publicKey.toBase58()
      );
    });

    it('throws for an invalid private key', () => {
      expect(() =>
        importFromPrivateKey(new Uint8Array(10))
      ).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // importWalletState
  // -----------------------------------------------------------------------
  describe('importWalletState', () => {
    it('returns a full WalletState from seed phrase', async () => {
      const state = await importWalletState(MOCK_MNEMONIC);

      expect(state.keypair).toBeInstanceOf(Keypair);
      expect(state.spendingKeypair).toBeInstanceOf(Keypair);
      expect(state.viewingKeypair).toBeInstanceOf(Keypair);
      expect(state.stealthMetaAddress).toBeDefined();
    });

    it('throws for an invalid seed phrase', async () => {
      vi.mocked(bip39.validateMnemonic).mockReturnValueOnce(false);

      await expect(importWalletState('bad phrase')).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // recoverAddresses
  // -----------------------------------------------------------------------
  describe('recoverAddresses', () => {
    it('recovers multiple addresses for different derivation indices', async () => {
      const addresses = await recoverAddresses(MOCK_MNEMONIC, 3);

      expect(addresses).toHaveLength(3);
      for (const entry of addresses) {
        expect(typeof entry.path).toBe('string');
        expect(typeof entry.address).toBe('string');
        expect(entry.path).toMatch(/^m\/44'\/501'\/\d+'\/0'$/);
      }
    });

    it('recovered addresses are all unique', async () => {
      const addresses = await recoverAddresses(MOCK_MNEMONIC, 5);
      const uniqueAddrs = new Set(addresses.map((a) => a.address));
      expect(uniqueAddrs.size).toBe(5);
    });

    it('defaults to 10 addresses when count is not specified', async () => {
      const addresses = await recoverAddresses(MOCK_MNEMONIC);
      expect(addresses).toHaveLength(10);
    });

    it('throws for invalid seed phrase', async () => {
      vi.mocked(bip39.validateMnemonic).mockReturnValueOnce(false);

      await expect(recoverAddresses('not valid')).rejects.toThrow();
    });
  });
});
