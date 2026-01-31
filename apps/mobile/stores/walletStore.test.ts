/**
 * Wallet Store Test Suite
 *
 * Validates the core wallet management functionality that underpins
 * the entire Protocol 01 mobile application. The wallet store governs
 * wallet creation, import, balance tracking, and transaction dispatch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __reset as resetSecureStore } from '../test/__mocks__/expo-secure-store';
import AsyncStorage from '../test/__mocks__/async-storage';

// Import mock modules so we can re-apply implementations after clearAllMocks
let walletMocks: any;
let balanceMocks: any;
let transactionMocks: any;
let connectionMocks: any;

vi.mock('../services/solana/wallet', () => {
  walletMocks = {
    walletExists: vi.fn().mockResolvedValue(false),
    getPublicKey: vi.fn().mockResolvedValue('MockPublicKey1234567890abcdef'),
    createWallet: vi.fn().mockResolvedValue({
      publicKey: 'NewWalletPublicKey123456789',
      mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
    }),
    importWallet: vi.fn().mockResolvedValue({
      publicKey: 'ImportedWalletPublicKey1234',
    }),
    deleteWallet: vi.fn().mockResolvedValue(undefined),
    getMnemonic: vi.fn().mockResolvedValue('abandon ability able about above absent absorb abstract absurd abuse access accident'),
    formatPublicKey: vi.fn((pk: string, chars: number) => `${pk.slice(0, chars)}...${pk.slice(-chars)}`),
  };
  return walletMocks;
});

vi.mock('../services/solana/balance', () => {
  balanceMocks = {
    getWalletBalance: vi.fn().mockResolvedValue({ sol: 5.25, tokens: [], totalUsd: 789.50 }),
    getCachedBalance: vi.fn().mockResolvedValue({ sol: 5.0, tokens: [], totalUsd: 750.0 }),
    clearBalanceCache: vi.fn().mockResolvedValue(undefined),
    formatBalance: vi.fn((sol: number) => sol.toFixed(4)),
    formatUsd: vi.fn((usd: number) => `$${usd.toFixed(2)}`),
  };
  return balanceMocks;
});

vi.mock('../services/solana/transactions', () => {
  transactionMocks = {
    getTransactionHistory: vi.fn().mockResolvedValue([]),
    getCachedTransactions: vi.fn().mockResolvedValue([]),
    clearTransactionCache: vi.fn().mockResolvedValue(undefined),
    sendSol: vi.fn().mockResolvedValue({ signature: 'mock-sig-123', explorerUrl: 'https://solscan.io/tx/123', success: true }),
    sendSolWithSigner: vi.fn().mockResolvedValue({ signature: 'mock-signer-sig', explorerUrl: 'https://solscan.io/tx/456', success: true }),
  };
  return transactionMocks;
});

vi.mock('../services/solana/connection', () => {
  connectionMocks = {
    requestAirdrop: vi.fn().mockResolvedValue('airdrop-sig-789'),
    isDevnet: vi.fn().mockReturnValue(true),
    isMainnet: vi.fn().mockReturnValue(false),
    initializeConnection: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue({}),
    getExplorerUrl: vi.fn((sig: string) => `https://solscan.io/tx/${sig}`),
    getCluster: vi.fn().mockReturnValue('devnet'),
    switchEndpoint: vi.fn(),
  };
  return connectionMocks;
});

// Dynamic import after mocks are set up
const { useWalletStore } = await import('./walletStore');

// Helper to re-apply default mock implementations after vi.clearAllMocks()
function reapplyMockDefaults() {
  walletMocks.walletExists.mockResolvedValue(false);
  walletMocks.getPublicKey.mockResolvedValue('MockPublicKey1234567890abcdef');
  walletMocks.createWallet.mockResolvedValue({
    publicKey: 'NewWalletPublicKey123456789',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
  });
  walletMocks.importWallet.mockResolvedValue({ publicKey: 'ImportedWalletPublicKey1234' });
  walletMocks.deleteWallet.mockResolvedValue(undefined);
  walletMocks.getMnemonic.mockResolvedValue('abandon ability able about above absent absorb abstract absurd abuse access accident');
  walletMocks.formatPublicKey.mockImplementation((pk: string, chars: number) => `${pk.slice(0, chars)}...${pk.slice(-chars)}`);

  balanceMocks.getWalletBalance.mockResolvedValue({ sol: 5.25, tokens: [], totalUsd: 789.50 });
  balanceMocks.getCachedBalance.mockResolvedValue({ sol: 5.0, tokens: [], totalUsd: 750.0 });
  balanceMocks.clearBalanceCache.mockResolvedValue(undefined);
  balanceMocks.formatBalance.mockImplementation((sol: number) => sol.toFixed(4));
  balanceMocks.formatUsd.mockImplementation((usd: number) => `$${usd.toFixed(2)}`);

  transactionMocks.getTransactionHistory.mockResolvedValue([]);
  transactionMocks.getCachedTransactions.mockResolvedValue([]);
  transactionMocks.clearTransactionCache.mockResolvedValue(undefined);
  transactionMocks.sendSol.mockResolvedValue({ signature: 'mock-sig-123', explorerUrl: 'https://solscan.io/tx/123', success: true });
  transactionMocks.sendSolWithSigner.mockResolvedValue({ signature: 'mock-signer-sig', explorerUrl: 'https://solscan.io/tx/456', success: true });

  connectionMocks.requestAirdrop.mockResolvedValue('airdrop-sig-789');
  connectionMocks.isDevnet.mockReturnValue(true);
  connectionMocks.isMainnet.mockReturnValue(false);
  connectionMocks.initializeConnection.mockResolvedValue(undefined);
  connectionMocks.getConnection.mockReturnValue({});
  connectionMocks.getExplorerUrl.mockImplementation((sig: string) => `https://solscan.io/tx/${sig}`);
  connectionMocks.getCluster.mockReturnValue('devnet');
}

describe('Wallet Store -- Core Wallet Management', () => {
  beforeEach(() => {
    // Reset the zustand store to its initial state
    useWalletStore.setState({
      initialized: false,
      loading: false,
      hasWallet: false,
      publicKey: null,
      balance: null,
      transactions: [],
      refreshing: false,
      error: null,
      isPrivyWallet: false,
    });
    resetSecureStore();
    AsyncStorage.__reset();
    vi.clearAllMocks();
    // Re-apply default implementations after clearing
    reapplyMockDefaults();
  });

  // ===================================================================
  // Section 1: Initial State
  // ===================================================================

  describe('Initial State', () => {
    it('should start with no wallet loaded', () => {
      const state = useWalletStore.getState();
      expect(state.initialized).toBe(false);
      expect(state.hasWallet).toBe(false);
      expect(state.publicKey).toBeNull();
      expect(state.balance).toBeNull();
      expect(state.transactions).toEqual([]);
      expect(state.error).toBeNull();
    });

    it('should not be in a loading state before any action is taken', () => {
      const state = useWalletStore.getState();
      expect(state.loading).toBe(false);
      expect(state.refreshing).toBe(false);
    });

    it('should default to non-Privy wallet mode', () => {
      const state = useWalletStore.getState();
      expect(state.isPrivyWallet).toBe(false);
    });
  });

  // ===================================================================
  // Section 2: Wallet Creation
  // ===================================================================

  describe('Wallet Creation', () => {
    it('should create a new wallet and return the mnemonic', async () => {
      const result = await useWalletStore.getState().createNewWallet();

      expect(result).toBeDefined();
      expect(result.mnemonic).toBeTruthy();
      expect(result.mnemonic.split(' ').length).toBe(12);
    });

    it('should update store state after wallet creation', async () => {
      await useWalletStore.getState().createNewWallet();

      const state = useWalletStore.getState();
      expect(state.hasWallet).toBe(true);
      expect(state.publicKey).toBe('NewWalletPublicKey123456789');
      expect(state.loading).toBe(false);
    });

    it('should clear previous errors upon successful creation', async () => {
      useWalletStore.setState({ error: 'previous error' });

      await useWalletStore.getState().createNewWallet();

      expect(useWalletStore.getState().error).toBeNull();
    });

    it('should set loading to true during creation and false after', async () => {
      const { createWallet } = await import('../services/solana/wallet');
      let loadingDuringCreation = false;

      (createWallet as any).mockImplementation(async () => {
        loadingDuringCreation = useWalletStore.getState().loading;
        return { publicKey: 'TestPK', mnemonic: 'test mnemonic words here' };
      });

      await useWalletStore.getState().createNewWallet();

      expect(loadingDuringCreation).toBe(true);
      expect(useWalletStore.getState().loading).toBe(false);
    });

    it('should propagate errors from the wallet service and set error state', async () => {
      const { createWallet } = await import('../services/solana/wallet');
      (createWallet as any).mockRejectedValueOnce(new Error('Entropy generation failed'));

      await expect(useWalletStore.getState().createNewWallet()).rejects.toThrow('Entropy generation failed');

      const state = useWalletStore.getState();
      expect(state.error).toBe('Entropy generation failed');
      expect(state.loading).toBe(false);
    });
  });

  // ===================================================================
  // Section 3: Wallet Import from Seed Phrase
  // ===================================================================

  describe('Wallet Import from Seed Phrase', () => {
    const VALID_MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

    it('should import a wallet from a valid mnemonic and update state', async () => {
      await useWalletStore.getState().importExistingWallet(VALID_MNEMONIC);

      const state = useWalletStore.getState();
      expect(state.hasWallet).toBe(true);
      expect(state.publicKey).toBe('ImportedWalletPublicKey1234');
      expect(state.loading).toBe(false);
    });

    it('should reset balance and transactions to empty after import', async () => {
      useWalletStore.setState({
        balance: { sol: 99, tokens: [], totalUsd: 1000 },
        transactions: [{ signature: 'old', timestamp: 0, type: 'send', status: 'confirmed' }] as any,
      });

      // Mock zero balance for this test to verify old cached values are cleared
      const { getWalletBalance } = await import('../services/solana/balance');
      (getWalletBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sol: 0, tokens: [], totalUsd: 0 });

      await useWalletStore.getState().importExistingWallet(VALID_MNEMONIC);

      const state = useWalletStore.getState();
      expect(state.balance).toEqual({ sol: 0, tokens: [], totalUsd: 0 });
      expect(state.transactions).toEqual([]);
    });

    it('should clear old wallet caches when replacing an existing wallet', async () => {
      const { clearBalanceCache } = await import('../services/solana/balance');
      const { clearTransactionCache } = await import('../services/solana/transactions');

      useWalletStore.setState({ publicKey: 'OldWalletKey123' });

      await useWalletStore.getState().importExistingWallet(VALID_MNEMONIC);

      expect(clearBalanceCache).toHaveBeenCalledWith('OldWalletKey123');
      expect(clearTransactionCache).toHaveBeenCalledWith('OldWalletKey123');
    });

    it('should propagate errors from invalid mnemonics', async () => {
      const { importWallet } = await import('../services/solana/wallet');
      (importWallet as any).mockRejectedValueOnce(new Error('Invalid mnemonic phrase'));

      await expect(
        useWalletStore.getState().importExistingWallet('invalid words here')
      ).rejects.toThrow('Invalid mnemonic phrase');

      expect(useWalletStore.getState().error).toBe('Invalid mnemonic phrase');
    });
  });

  // ===================================================================
  // Section 4: Wallet Initialization (App Startup)
  // ===================================================================

  describe('Wallet Initialization', () => {
    it('should mark as initialized even when no wallet exists', async () => {
      await useWalletStore.getState().initialize();

      const state = useWalletStore.getState();
      expect(state.initialized).toBe(true);
      expect(state.hasWallet).toBe(false);
      expect(state.loading).toBe(false);
    });

    it('should load cached balance and transactions when a wallet exists', async () => {
      const { walletExists } = await import('../services/solana/wallet');
      (walletExists as any).mockResolvedValueOnce(true);

      await useWalletStore.getState().initialize();

      const state = useWalletStore.getState();
      expect(state.hasWallet).toBe(true);
      expect(state.publicKey).toBeTruthy();
      expect(state.balance).toBeDefined();
      expect(state.initialized).toBe(true);
    });

    it('should handle initialization errors gracefully', async () => {
      const { initializeConnection } = await import('../services/solana/connection');
      (initializeConnection as any).mockRejectedValueOnce(new Error('Network unreachable'));

      await useWalletStore.getState().initialize();

      const state = useWalletStore.getState();
      expect(state.initialized).toBe(true);
      expect(state.error).toBe('Network unreachable');
    });
  });

  // ===================================================================
  // Section 5: Privy Wallet Integration
  // ===================================================================

  describe('Privy Wallet Integration', () => {
    it('should initialize with a Privy wallet address', async () => {
      const address = 'PrivyWalletAddress1234567890abcdef';
      await useWalletStore.getState().initializeWithPrivy(address);

      const state = useWalletStore.getState();
      expect(state.hasWallet).toBe(true);
      expect(state.publicKey).toBe(address);
      expect(state.isPrivyWallet).toBe(true);
      expect(state.initialized).toBe(true);
    });

    it('should handle Privy initialization failure', async () => {
      const { initializeConnection } = await import('../services/solana/connection');
      (initializeConnection as any).mockRejectedValueOnce(new Error('Privy init failed'));

      await useWalletStore.getState().initializeWithPrivy('addr');

      const state = useWalletStore.getState();
      expect(state.error).toBe('Privy init failed');
      expect(state.initialized).toBe(true);
    });
  });

  // ===================================================================
  // Section 6: Balance Refresh
  // ===================================================================

  describe('Balance Refresh', () => {
    it('should fetch and update balance for the current wallet', async () => {
      useWalletStore.setState({ publicKey: 'TestPK123' });

      await useWalletStore.getState().refreshBalance();

      const state = useWalletStore.getState();
      expect(state.balance).toEqual({ sol: 5.25, tokens: [], totalUsd: 789.50 });
      expect(state.refreshing).toBe(false);
    });

    it('should not fetch balance when no wallet is loaded', async () => {
      const { getWalletBalance } = await import('../services/solana/balance');

      useWalletStore.setState({ publicKey: null });
      await useWalletStore.getState().refreshBalance();

      expect(getWalletBalance).not.toHaveBeenCalled();
    });

    it('should set default balance on fetch error instead of crashing', async () => {
      const { getWalletBalance } = await import('../services/solana/balance');
      (getWalletBalance as any).mockRejectedValueOnce(new Error('RPC timeout'));

      useWalletStore.setState({ publicKey: 'TestPK', balance: { sol: 10, tokens: [], totalUsd: 100 } });
      await useWalletStore.getState().refreshBalance();

      const state = useWalletStore.getState();
      expect(state.balance).toEqual({ sol: 0, tokens: [], totalUsd: 0 });
      expect(state.refreshing).toBe(false);
    });
  });

  // ===================================================================
  // Section 7: Send Transaction
  // ===================================================================

  describe('Send Transaction', () => {
    it('should send SOL using local keypair for non-Privy wallets', async () => {
      const { sendSol } = await import('../services/solana/transactions');
      useWalletStore.setState({ publicKey: 'SenderPK', isPrivyWallet: false });

      const result = await useWalletStore.getState().sendTransaction('RecipientPK', 1.5);

      expect(sendSol).toHaveBeenCalledWith('RecipientPK', 1.5);
      expect(result.success).toBe(true);
      expect(result.signature).toBeTruthy();
    });

    it('should set loading to false after a successful transaction', async () => {
      useWalletStore.setState({ publicKey: 'SenderPK' });

      await useWalletStore.getState().sendTransaction('RecipientPK', 1.0);

      expect(useWalletStore.getState().loading).toBe(false);
    });

    it('should set error state when transaction fails', async () => {
      const { sendSol } = await import('../services/solana/transactions');
      (sendSol as any).mockRejectedValueOnce(new Error('Insufficient funds'));

      useWalletStore.setState({ publicKey: 'SenderPK' });

      await expect(
        useWalletStore.getState().sendTransaction('RecipientPK', 999)
      ).rejects.toThrow('Insufficient funds');

      expect(useWalletStore.getState().error).toBe('Insufficient funds');
      expect(useWalletStore.getState().loading).toBe(false);
    });
  });

  // ===================================================================
  // Section 8: Devnet Airdrop
  // ===================================================================

  describe('Devnet Airdrop', () => {
    it('should request airdrop on devnet', async () => {
      useWalletStore.setState({ publicKey: 'DevnetPK' });

      const sig = await useWalletStore.getState().requestDevnetAirdrop(2);

      expect(sig).toBe('airdrop-sig-789');
    });

    it('should reject airdrop when no wallet is loaded', async () => {
      useWalletStore.setState({ publicKey: null });

      await expect(
        useWalletStore.getState().requestDevnetAirdrop()
      ).rejects.toThrow('No wallet');
    });

    it('should reject airdrop when not on devnet', async () => {
      const { isDevnet } = await import('../services/solana/connection');
      (isDevnet as any).mockReturnValueOnce(false);

      useWalletStore.setState({ publicKey: 'MainnetPK' });

      await expect(
        useWalletStore.getState().requestDevnetAirdrop()
      ).rejects.toThrow('Airdrop only on devnet');
    });
  });

  // ===================================================================
  // Section 9: Logout
  // ===================================================================

  describe('Wallet Logout', () => {
    it('should clear all wallet state on logout', async () => {
      useWalletStore.setState({
        hasWallet: true,
        publicKey: 'WalletToDelete',
        balance: { sol: 10, tokens: [], totalUsd: 100 },
        transactions: [{ signature: 'tx1' }] as any,
      });

      await useWalletStore.getState().logout();

      const state = useWalletStore.getState();
      expect(state.hasWallet).toBe(false);
      expect(state.publicKey).toBeNull();
      expect(state.balance).toBeNull();
      expect(state.transactions).toEqual([]);
    });

    it('should call the wallet service delete function', async () => {
      const { deleteWallet } = await import('../services/solana/wallet');
      useWalletStore.setState({ hasWallet: true, publicKey: 'PK' });

      await useWalletStore.getState().logout();

      expect(deleteWallet).toHaveBeenCalled();
    });
  });

  // ===================================================================
  // Section 10: Error Handling
  // ===================================================================

  describe('Error Handling', () => {
    it('should clear errors on demand', () => {
      useWalletStore.setState({ error: 'Some error occurred' });

      useWalletStore.getState().clearError();

      expect(useWalletStore.getState().error).toBeNull();
    });

    it('should provide backup mnemonic from secure storage', async () => {
      const mnemonic = await useWalletStore.getState().getBackupMnemonic();
      expect(mnemonic).toBeTruthy();
      expect(typeof mnemonic).toBe('string');
    });
  });
});
