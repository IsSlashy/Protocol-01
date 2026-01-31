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

vi.mock('./stealth/scan', () => ({
  StealthScanner: vi.fn().mockImplementation(() => ({
    scan: vi.fn().mockResolvedValue([]),
    checkViewTag: vi.fn().mockReturnValue(false),
    verifyAndDeriveKey: vi.fn().mockReturnValue({ isOwner: false }),
  })),
  subscribeToPayments: vi.fn().mockReturnValue({
    unsubscribe: vi.fn(),
  }),
}));

vi.mock('./stealth/derive', () => ({
  deriveStealthPrivateKey: vi.fn().mockReturnValue(Keypair.generate()),
}));

// ---------------------------------------------------------------------------
// Mock transfer modules
// ---------------------------------------------------------------------------

vi.mock('./transfer/send', () => ({
  sendPrivate: vi.fn().mockResolvedValue({
    signature: MOCK_SIGNATURE,
    stealthAddress: MOCK_STEALTH_ADDRESS_PK,
    ephemeralPubKey: new Uint8Array(32),
    confirmed: true,
    fee: 5000n,
  }),
  sendPublic: vi.fn().mockResolvedValue({ signature: MOCK_SIGNATURE }),
  estimateTransferFee: vi.fn().mockResolvedValue(5000n),
}));

vi.mock('./transfer/claim', () => ({
  claimStealth: vi.fn().mockResolvedValue({
    signature: MOCK_SIGNATURE,
    amount: 1_000_000_000n,
    destination: MOCK_KEYPAIR.publicKey,
    confirmed: true,
  }),
  getStealthBalance: vi.fn().mockResolvedValue(1_000_000_000n),
  canClaim: vi.fn().mockResolvedValue({ canClaim: true, balance: 1_000_000_000n }),
}));

// ---------------------------------------------------------------------------
// Mock stream modules
// ---------------------------------------------------------------------------

vi.mock('./streams/create', () => ({
  createStream: vi.fn().mockResolvedValue({
    id: MOCK_STREAM_PDA,
    sender: MOCK_KEYPAIR.publicKey,
    recipient: Keypair.generate().publicKey,
    totalAmount: 1_000_000_000n,
    withdrawnAmount: 0n,
    startTime: new Date(),
    endTime: new Date(Date.now() + 86_400_000),
    tokenMint: null,
    status: 'active',
    withdrawableAmount: 0n,
    privacyLevel: 'standard',
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  calculateWithdrawableAmount: vi.fn().mockReturnValue(500_000_000n),
  getStreamProgress: vi.fn().mockReturnValue(50),
}));

vi.mock('./streams/withdraw', () => ({
  withdrawStream: vi.fn().mockResolvedValue({
    signature: MOCK_SIGNATURE,
    amountWithdrawn: 500_000_000n,
    remainingBalance: 500_000_000n,
  }),
  getStream: vi.fn().mockResolvedValue({
    id: MOCK_STREAM_PDA,
    sender: MOCK_KEYPAIR.publicKey,
    recipient: MOCK_KEYPAIR.publicKey,
    totalAmount: 1_000_000_000n,
    withdrawnAmount: 0n,
    startTime: new Date(),
    endTime: new Date(Date.now() + 86_400_000),
    tokenMint: null,
    status: 'active',
    withdrawableAmount: 500_000_000n,
    privacyLevel: 'standard',
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  getUserStreams: vi.fn().mockResolvedValue([]),
}));

vi.mock('./streams/cancel', () => ({
  cancelStream: vi.fn().mockResolvedValue({
    signature: MOCK_SIGNATURE,
    refundedToSender: 500_000_000n,
    sentToRecipient: 500_000_000n,
  }),
  pauseStream: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
  resumeStream: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks)
// ---------------------------------------------------------------------------

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
  describe('scanForIncoming', () => {
    it('throws when no wallet is connected', async () => {
      await expect(client.scanForIncoming()).rejects.toThrow(/connect/i);
    });

    it('returns payments array when connected', async () => {
      await client.connect(MOCK_P01_WALLET);
      const payments = await client.scanForIncoming();

      expect(Array.isArray(payments)).toBe(true);
    });
  });

  describe('subscribeToIncoming', () => {
    it('throws when no wallet is connected', () => {
      expect(() => client.subscribeToIncoming(vi.fn())).toThrow(
        /connect/i
      );
    });

    it('returns an unsubscribe function when connected', async () => {
      await client.connect(MOCK_P01_WALLET);
      const unsubscribe = client.subscribeToIncoming(vi.fn());

      expect(typeof unsubscribe).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // Transfer methods
  // -----------------------------------------------------------------------
  describe('sendPrivate', () => {
    it('throws when not connected', async () => {
      await expect(
        client.sendPrivate('st_recipient', 1.0)
      ).rejects.toThrow(/connect/i);
    });

    it('sends a private transfer and returns signature', async () => {
      await client.connect(MOCK_P01_WALLET);
      const sig = await client.sendPrivate('st_recipient', 1.0);

      expect(sig).toBe(MOCK_SIGNATURE);
    });
  });

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

  describe('claimStealth', () => {
    it('throws when not connected', async () => {
      await expect(client.claimStealth('someAddress')).rejects.toThrow(
        /connect/i
      );
    });

    it('claims a payment by address string', async () => {
      await client.connect(MOCK_P01_WALLET);
      const sig = await client.claimStealth(
        Keypair.generate().publicKey.toBase58()
      );

      expect(sig).toBe(MOCK_SIGNATURE);
    });

    it('claims a payment from a StealthPayment object', async () => {
      await client.connect(MOCK_P01_WALLET);

      const payment = {
        stealthAddress: Keypair.generate().publicKey,
        ephemeralPubKey: new Uint8Array(32),
        amount: 1_000_000_000n,
        tokenMint: null,
        signature: 'paymentSig',
        blockTime: Date.now(),
        claimed: false,
        viewTag: 10,
      };

      const sig = await client.claimStealth(payment);
      expect(sig).toBe(MOCK_SIGNATURE);
    });
  });

  describe('estimateFee', () => {
    it('returns a bigint fee', async () => {
      const fee = await client.estimateFee('standard');
      expect(typeof fee).toBe('bigint');
    });
  });

  // -----------------------------------------------------------------------
  // Stream methods
  // -----------------------------------------------------------------------
  describe('createStream', () => {
    it('throws when not connected', async () => {
      await expect(
        client.createStream('recipient', 1.0, 30)
      ).rejects.toThrow(/connect/i);
    });

    it('creates a stream and returns a Stream object', async () => {
      await client.connect(MOCK_P01_WALLET);
      const stream = await client.createStream('st_recipient', 1.0, 30);

      expect(stream.id).toEqual(MOCK_STREAM_PDA);
      expect(typeof stream.totalAmount).toBe('bigint');
      expect(stream.status).toBe('active');
    });
  });

  describe('withdrawStream', () => {
    it('throws when not connected', async () => {
      await expect(
        client.withdrawStream(MOCK_STREAM_PDA)
      ).rejects.toThrow(/connect/i);
    });

    it('withdraws from a stream with PublicKey', async () => {
      await client.connect(MOCK_P01_WALLET);
      const sig = await client.withdrawStream(MOCK_STREAM_PDA);

      expect(sig).toBe(MOCK_SIGNATURE);
    });

    it('withdraws from a stream with string ID', async () => {
      await client.connect(MOCK_P01_WALLET);
      const sig = await client.withdrawStream(MOCK_STREAM_PDA.toBase58());

      expect(sig).toBe(MOCK_SIGNATURE);
    });
  });

  describe('cancelStream', () => {
    it('throws when not connected', async () => {
      await expect(
        client.cancelStream(MOCK_STREAM_PDA)
      ).rejects.toThrow(/connect/i);
    });

    it('cancels a stream and returns signature', async () => {
      await client.connect(MOCK_P01_WALLET);
      const sig = await client.cancelStream(MOCK_STREAM_PDA);

      expect(sig).toBe(MOCK_SIGNATURE);
    });
  });

  describe('getStream', () => {
    it('returns a stream or null', async () => {
      const result = await client.getStream(MOCK_STREAM_PDA);
      // getStream does not require wallet connection
      expect(result).toBeDefined();
    });

    it('accepts string stream ID', async () => {
      const result = await client.getStream(MOCK_STREAM_PDA.toBase58());
      expect(result).toBeDefined();
    });
  });

  describe('getMyStreams', () => {
    it('throws when not connected', async () => {
      await expect(client.getMyStreams()).rejects.toThrow(/connect/i);
    });

    it('returns array of streams', async () => {
      await client.connect(MOCK_P01_WALLET);
      const streams = await client.getMyStreams();
      expect(Array.isArray(streams)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Event methods
  // -----------------------------------------------------------------------
  describe('event system', () => {
    it('registers and triggers an event listener', () => {
      const listener = vi.fn();
      client.on('payment_received', listener);

      // Trigger via private emit -- access through bracket notation
      const event = {
        type: 'payment_received' as const,
        timestamp: new Date(),
        payment: {
          stealthAddress: Keypair.generate().publicKey,
          ephemeralPubKey: new Uint8Array(32),
          amount: 1n,
          tokenMint: null,
          signature: '',
          blockTime: 0,
          claimed: false,
          viewTag: 0,
        },
      };

      // Call private emit
      (client as any).emit(event);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(event);
    });

    it('removes a listener with off()', () => {
      const listener = vi.fn();
      client.on('payment_received', listener);
      client.off('payment_received', listener);

      (client as any).emit({
        type: 'payment_received',
        timestamp: new Date(),
        payment: {} as any,
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it('multiple listeners on the same event all fire', () => {
      const a = vi.fn();
      const b = vi.fn();
      client.on('stream_created', a);
      client.on('stream_created', b);

      (client as any).emit({
        type: 'stream_created',
        timestamp: new Date(),
        stream: {} as any,
      });

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('listener errors are caught and do not propagate', () => {
      const badListener = vi.fn(() => {
        throw new Error('listener boom');
      });
      const goodListener = vi.fn();

      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      client.on('payment_received', badListener);
      client.on('payment_received', goodListener);

      expect(() =>
        (client as any).emit({
          type: 'payment_received',
          timestamp: new Date(),
          payment: {} as any,
        })
      ).not.toThrow();

      expect(goodListener).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
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

    it('getProgramId returns a PublicKey', () => {
      const pid = client.getProgramId();
      expect(pid).toBeInstanceOf(PublicKey);
    });

    it('setCluster updates the cluster and connection', () => {
      client.setCluster('mainnet-beta');
      // getProgramId should now reflect mainnet
      expect(client.getProgramId()).toBeInstanceOf(PublicKey);
    });
  });
});
