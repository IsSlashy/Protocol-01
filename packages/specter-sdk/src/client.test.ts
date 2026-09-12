import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Hoisted constants – vi.hoisted() is lifted above vi.mock() so these values
// are available inside every mock factory below.
// ---------------------------------------------------------------------------

const {
  MOCK_SIGNATURE,
  MOCK_BLOCKHASH,
  MOCK_BALANCE_LAMPORTS,
  MOCK_MNEMONIC,
  MOCK_KEYPAIR,
  MOCK_SPENDING_KEYPAIR,
  MOCK_VIEWING_KEYPAIR,
  MOCK_WALLET_STATE,
  MOCK_P01_WALLET,
  MOCK_STEALTH_ADDRESS_PK,
  MOCK_STREAM_PDA,
} = vi.hoisted(() => {
  // We need Keypair / PublicKey inside the hoisted block.  Because vi.hoisted()
  // runs before any imports are resolved we must require the module directly.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair: Kp } = require('@solana/web3.js') as typeof import('@solana/web3.js');

  const MOCK_SIGNATURE = 'mockTxSignature1111111111111111111111111111111111111111111111111111';
  const MOCK_BLOCKHASH = 'mockBlockhash123456789ABCDEFGHIJKLMNOPQRSTUV';
  const MOCK_BALANCE_LAMPORTS = 5_000_000_000; // 5 SOL
  const MOCK_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  const MOCK_KEYPAIR = Kp.generate();
  const MOCK_SPENDING_KEYPAIR = Kp.generate();
  const MOCK_VIEWING_KEYPAIR = Kp.generate();

  const MOCK_WALLET_STATE = {
    keypair: MOCK_KEYPAIR,
    spendingKeypair: MOCK_SPENDING_KEYPAIR,
    viewingKeypair: MOCK_VIEWING_KEYPAIR,
    stealthMetaAddress: {
      spendingPubKey: MOCK_SPENDING_KEYPAIR.publicKey.toBytes(),
      viewingPubKey: MOCK_VIEWING_KEYPAIR.publicKey.toBytes(),
      encoded: 'st_mock_encoded',
    },
    seedPhrase: MOCK_MNEMONIC,
    derivationPath: "m/44'/501'/0'/0'",
  };

  const MOCK_P01_WALLET = {
    publicKey: MOCK_KEYPAIR.publicKey,
    keypair: MOCK_KEYPAIR,
    stealthMetaAddress: MOCK_WALLET_STATE.stealthMetaAddress,
    seedPhrase: MOCK_MNEMONIC,
    derivationPath: "m/44'/501'/0'/0'",
  };

  const MOCK_STEALTH_ADDRESS_PK = Kp.generate().publicKey;
  const MOCK_STREAM_PDA = Kp.generate().publicKey;

  return {
    MOCK_SIGNATURE,
    MOCK_BLOCKHASH,
    MOCK_BALANCE_LAMPORTS,
    MOCK_MNEMONIC,
    MOCK_KEYPAIR,
    MOCK_SPENDING_KEYPAIR,
    MOCK_VIEWING_KEYPAIR,
    MOCK_WALLET_STATE,
    MOCK_P01_WALLET,
    MOCK_STEALTH_ADDRESS_PK,
    MOCK_STREAM_PDA,
  };
});

// ---------------------------------------------------------------------------
// Mock @solana/web3.js
// ---------------------------------------------------------------------------

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>(
    '@solana/web3.js'
  );

  return {
    ...actual,
    sendAndConfirmTransaction: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: vi.fn().mockResolvedValue(MOCK_BALANCE_LAMPORTS),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: MOCK_BLOCKHASH,
        lastValidBlockHeight: 200,
      }),
      getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(890_880),
      sendRawTransaction: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getAccountInfo: vi.fn().mockResolvedValue(null),
      getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
      getProgramAccounts: vi.fn().mockResolvedValue([]),
    })),
  };
});

// ---------------------------------------------------------------------------
// Mock @solana/spl-token
// ---------------------------------------------------------------------------

vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: vi.fn().mockResolvedValue(
    Keypair.generate().publicKey
  ),
  createTransferInstruction: vi.fn().mockReturnValue({
    keys: [],
    programId: Keypair.generate().publicKey,
    data: Buffer.alloc(0),
  }),
  getAccount: vi.fn().mockResolvedValue({ amount: 1_000_000_000n }),
  TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  ASSOCIATED_TOKEN_PROGRAM_ID: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  createAssociatedTokenAccountInstruction: vi.fn().mockReturnValue({
    keys: [],
    programId: Keypair.generate().publicKey,
    data: Buffer.alloc(0),
  }),
}));

// ---------------------------------------------------------------------------
// Mock wallet module
// ---------------------------------------------------------------------------

vi.mock('./wallet/create', () => ({
  createWallet: vi.fn().mockResolvedValue(MOCK_P01_WALLET),
  createWalletState: vi.fn().mockResolvedValue(MOCK_WALLET_STATE),
}));

vi.mock('./wallet/import', () => ({
  importFromSeedPhrase: vi.fn().mockResolvedValue(MOCK_P01_WALLET),
  importWalletState: vi.fn().mockResolvedValue(MOCK_WALLET_STATE),
}));

// ---------------------------------------------------------------------------
// Mock stealth modules
// ---------------------------------------------------------------------------

vi.mock('./stealth/generate', () => ({
  generateStealthAddress: vi.fn().mockReturnValue({
    address: MOCK_STEALTH_ADDRESS_PK,
    ephemeralPubKey: new Uint8Array(32).fill(0x11),
    viewTag: 77,
    createdAt: new Date(),
    ephemeralPrivateKey: new Uint8Array(32).fill(0x22),
  }),
  generateStealthMetaAddress: vi.fn(),
}));

vi.mock('./stealth/derive', () => ({
  deriveStealthPrivateKey: vi.fn().mockReturnValue(Keypair.generate()),
}));

// ---------------------------------------------------------------------------
// Mock transfer modules
// ---------------------------------------------------------------------------

vi.mock('./transfer/send', () => ({
  sendPublic: vi.fn().mockResolvedValue({ signature: MOCK_SIGNATURE }),
}));

import { P01Client } from './client';

// ===========================================================================
// P01Client
// ===========================================================================

describe('P01Client', () => {
  let client: P01Client;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new P01Client({ cluster: 'devnet' });
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('creates a client with default config', () => {
      const c = new P01Client();
      expect(c).toBeInstanceOf(P01Client);
      expect(c.isConnected).toBe(false);
      expect(c.publicKey).toBeNull();
    });

    it('accepts custom cluster', () => {
      const c = new P01Client({ cluster: 'mainnet-beta' });
      expect(c).toBeInstanceOf(P01Client);
    });

    it('accepts custom RPC endpoint', () => {
      const c = new P01Client({
        rpcEndpoint: 'http://localhost:8899',
      });
      expect(c).toBeInstanceOf(P01Client);
    });

    it('accepts debug mode', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const c = new P01Client({ debug: true });
      expect(c).toBeInstanceOf(P01Client);
      spy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Static wallet methods
  // -----------------------------------------------------------------------
  describe('static wallet methods', () => {
    it('createWallet returns a wallet', async () => {
      const wallet = await P01Client.createWallet();

      expect(wallet.publicKey).toBeInstanceOf(PublicKey);
      expect(wallet.keypair).toBeDefined();
      expect(wallet.stealthMetaAddress).toBeDefined();
    });

    it('importWallet returns a wallet from seed phrase', async () => {
      const wallet = await P01Client.importWallet(MOCK_MNEMONIC);

      expect(wallet.publicKey).toBeInstanceOf(PublicKey);
    });
  });

  // -----------------------------------------------------------------------
  // Connection methods
  // -----------------------------------------------------------------------
  describe('connect / disconnect', () => {
    it('connecting with a P01Wallet sets isConnected and publicKey', async () => {
      await client.connect(MOCK_P01_WALLET);

      expect(client.isConnected).toBe(true);
      expect(client.publicKey).toEqual(MOCK_KEYPAIR.publicKey);
    });

    it('connecting with a raw Keypair sets isConnected', async () => {
      const kp = Keypair.generate();
      await client.connect(kp);

      expect(client.isConnected).toBe(true);
      expect(client.publicKey!.toBase58()).toBe(kp.publicKey.toBase58());
    });

    it('connecting with a WalletAdapter sets isConnected', async () => {
      const adapter = {
        publicKey: Keypair.generate().publicKey,
        signTransaction: vi.fn(),
        signAllTransactions: vi.fn(),
      };

      await client.connect(adapter);

      expect(client.isConnected).toBe(true);
      expect(client.publicKey!.toBase58()).toBe(
        adapter.publicKey.toBase58()
      );
    });

    it('disconnect clears the connected wallet', async () => {
      await client.connect(MOCK_P01_WALLET);
      expect(client.isConnected).toBe(true);

      client.disconnect();
      expect(client.isConnected).toBe(false);
      expect(client.publicKey).toBeNull();
    });

    it('stealthMetaAddress is available after connecting with P01Wallet', async () => {
      await client.connect(MOCK_P01_WALLET);
      expect(client.stealthMetaAddress).toBeDefined();
      expect(client.stealthMetaAddress!.encoded).toBe('st_mock_encoded');
    });

    it('stealthMetaAddress is null after disconnect', async () => {
      await client.connect(MOCK_P01_WALLET);
      client.disconnect();
      expect(client.stealthMetaAddress).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Balance
  // -----------------------------------------------------------------------
  describe('getBalance', () => {
    it('throws when no wallet is connected', async () => {
      await expect(client.getBalance()).rejects.toThrow(/connect/i);
    });

    it('returns balance info when connected', async () => {
      await client.connect(MOCK_P01_WALLET);
      const balance = await client.getBalance();

      expect(typeof balance.solBalance).toBe('bigint');
      expect(typeof balance.solFormatted).toBe('string');
      expect(Array.isArray(balance.tokens)).toBe(true);
      expect(balance.lastUpdated).toBeInstanceOf(Date);
    });
  });

  // -----------------------------------------------------------------------
  // Stealth address generation
  // -----------------------------------------------------------------------
  describe('generateStealthAddress', () => {
    it('throws when no wallet is connected', () => {
      expect(() => client.generateStealthAddress()).toThrow(/connect/i);
    });

    it('throws when connected with raw Keypair (no full wallet)', async () => {
      await client.connect(Keypair.generate());
      expect(() => client.generateStealthAddress()).toThrow(
        /full wallet/i
      );
    });

    it('returns a stealth address when connected with P01Wallet', async () => {
      await client.connect(MOCK_P01_WALLET);
      const result = client.generateStealthAddress();

      expect(result.address).toBeInstanceOf(PublicKey);
      expect(result.ephemeralPubKey).toBeInstanceOf(Uint8Array);
      expect(typeof result.viewTag).toBe('number');
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });

  // -----------------------------------------------------------------------
  // Scanning
  // -----------------------------------------------------------------------
  describe('sendPublic', () => {
    it('throws when not connected', async () => {
      await expect(
        client.sendPublic(Keypair.generate().publicKey.toBase58(), 1.0)
      ).rejects.toThrow(/connect/i);
    });

    it('sends a public transfer and returns signature', async () => {
      await client.connect(MOCK_P01_WALLET);
      const sig = await client.sendPublic(
        Keypair.generate().publicKey.toBase58(),
        0.5
      );

      expect(sig).toBe(MOCK_SIGNATURE);
    });
  });

  // -----------------------------------------------------------------------
  // Utility methods
  // -----------------------------------------------------------------------
  describe('utility methods', () => {
    it('getConnection returns a Connection instance', () => {
      const conn = client.getConnection();
      expect(conn).toBeDefined();
    });

    it('getRegistryProgramId and getRelayerProgramId return PublicKeys', () => {
      expect(client.getRegistryProgramId()).toBeInstanceOf(PublicKey);
      expect(client.getRelayerProgramId()).toBeInstanceOf(PublicKey);
    });

    it('setCluster updates the cluster and connection', () => {
      client.setCluster('mainnet-beta');
      // the registry id now reflects mainnet (PublicKey.default until deployed)
      expect(client.getRegistryProgramId()).toBeInstanceOf(PublicKey);
    });

    it('no method of the client names the closed specter program', () => {
      for (const gone of ['scanForIncoming', 'subscribeToIncoming', 'sendPrivate', 'claimStealth',
        'estimateFee', 'createStream', 'withdrawStream', 'cancelStream', 'getStream', 'getMyStreams',
        'getProgramId']) {
        expect((client as any)[gone]).toBeUndefined();
      }
    });
  });
});
