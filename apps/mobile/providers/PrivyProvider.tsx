/**
 * Privy Provider for Protocol 01 Mobile App
 *
 * Wraps the application with Privy authentication context.
 * Integrates with the existing wallet store for unified state management.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from 'react';
import { PRIVY_APP_ID, PRIVY_ENABLED, privyConfig } from '../config/privy';
import { useWalletStore, setPrivySigner } from '../stores/walletStore';

// Static import of Privy SDK
import {
  PrivyProvider as PrivySDKProvider,
  usePrivy,
  useLoginWithEmail,
  useLoginWithSMS,
  useEmbeddedSolanaWallet,
  useLoginWithOAuth,
} from '@privy-io/expo';

const PRIVY_SDK_AVAILABLE = true;

console.log('[Privy] SDK imported successfully, PRIVY_ENABLED:', PRIVY_ENABLED, 'APP_ID:', PRIVY_APP_ID);

// Types
export interface PrivyUser {
  id: string;
  createdAt: Date;
  email?: { address: string; verified: boolean };
  phone?: { number: string; verified: boolean };
  google?: { email: string; name?: string; subject: string };
  apple?: { email: string; subject: string };
  twitter?: { username: string; subject: string };
  wallet?: { address: string; chainType: 'solana' | 'ethereum' };
  linkedAccounts: Array<{
    type: string;
    address?: string;
    email?: string;
    username?: string;
  }>;
}

export interface SolanaWallet {
  address: string;
  publicKey: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  signTransaction: (tx: any) => Promise<any>;
  signAllTransactions: (txs: any[]) => Promise<any[]>;
}

export interface PrivyContextType {
  // State
  ready: boolean;
  authenticated: boolean;
  user: PrivyUser | null;
  solanaWallet: SolanaWallet | null;

  // Auth methods
  login: {
    email: (email: string) => Promise<void>;
    phone: (phone: string) => Promise<void>;
    google: () => Promise<void>;
    apple: () => Promise<void>;
    twitter: () => Promise<void>;
    wallet: () => Promise<void>;
  };
  verifyOtp: (otp: string) => Promise<void>;
  logout: () => Promise<void>;

  // Wallet methods
  createWallet: () => Promise<SolanaWallet>;
  exportWallet: () => Promise<string>; // Returns private key

  // Linking
  linkEmail: (email: string) => Promise<void>;
  linkPhone: (phone: string) => Promise<void>;
  linkWallet: () => Promise<void>;
  unlinkAccount: (accountId: string) => Promise<void>;
}

const PrivyContext = createContext<PrivyContextType | null>(null);

interface PrivyProviderProps {
  children: React.ReactNode;
}

/**
 * Main Privy Provider
 */
export function P01PrivyProvider({ children }: PrivyProviderProps) {
  // Use real Privy if SDK is available and configured
  if (PRIVY_SDK_AVAILABLE && PRIVY_ENABLED) {
    console.log('[Privy] Using real Privy SDK with App ID:', PRIVY_APP_ID);
    return (
      <PrivySDKProvider
        appId={PRIVY_APP_ID}
        clientId="client-WY6VAkfDmcFDEpJKtgxwSkJ7CBe8pFbTJhCi4hXBPFN1X"
      >
        <PrivyBridge>{children}</PrivyBridge>
      </PrivySDKProvider>
    );
  }

  console.log('[Privy] Using mock implementation (SDK not available or not configured)');
  // Fallback to mock implementation
  return <MockPrivyProvider>{children}</MockPrivyProvider>;
}

/**
 * Bridge between Privy SDK and our context
 */
function PrivyBridge({ children }: { children: React.ReactNode }) {
  const privy = usePrivy();
  const walletStore = useWalletStore();

  // Debug: log privy initialization
  useEffect(() => {
    console.log('[PrivyBridge] Initialized, isReady:', privy?.isReady, 'user:', !!privy?.user);
  }, [privy?.isReady, privy?.user]);

  // Email login hook
  const emailLogin = useLoginWithEmail();
  // SMS login hook
  const smsLogin = useLoginWithSMS();
  // OAuth login hook
  const oauthLogin = useLoginWithOAuth();
  // Solana wallet hook
  const solanaWallet = useEmbeddedSolanaWallet();

  const [pendingOtpType, setPendingOtpType] = useState<'email' | 'sms' | null>(null);

  // Determine authenticated state - Privy Expo SDK uses `user` presence
  const isAuthenticated = !!privy?.user?.id;

  // Get the first Solana wallet from the wallets array
  const solanaWalletFromArray = useMemo(() => {
    // Check wallets array first (plural - for existing wallets)
    const wallets = (solanaWallet as any)?.wallets;
    if (wallets && Array.isArray(wallets) && wallets.length > 0) {
      const wallet = wallets[0];
      console.log('[PrivyBridge] Found wallets array:', wallets.length, 'wallets');
      return wallet;
    }
    // Fallback to wallet property (singular)
    return solanaWallet?.wallet;
  }, [(solanaWallet as any)?.wallets, solanaWallet?.wallet]);

  // Get wallet address from various sources
  const privyWalletAddress = useMemo(() => {
    if (solanaWalletFromArray?.address) {
      return solanaWalletFromArray.address;
    }
    // Fallback: check linkedAccounts for Solana wallet
    const linkedWallet = privy?.user?.linkedAccounts?.find(
      (account: any) => account.type === 'wallet' && account.chainType === 'solana'
    );
    return linkedWallet?.address || null;
  }, [solanaWalletFromArray?.address, privy?.user?.linkedAccounts]);

  // Sync Privy wallet with wallet store
  useEffect(() => {
    if (solanaWalletFromArray?.address) {
      console.log('[Privy] Wallet synced:', solanaWalletFromArray.address);
      // Use initializeWithPrivy to properly sync the Privy wallet address
      walletStore.initializeWithPrivy(solanaWalletFromArray.address);
      // Set the Privy signer for transactions
      setPrivySigner(createSignTransaction);
      console.log('[Privy] Signer connected to walletStore');
    } else {
      setPrivySigner(null);
    }
  }, [solanaWalletFromArray?.address, createSignTransaction]);

  // Create proper signing functions that use Privy's provider pattern
  const createSignTransaction = useCallback(async (tx: any) => {
    if (!solanaWalletFromArray) {
      throw new Error('No Privy wallet available for signing');
    }
    console.log('[PrivyBridge] signTransaction called, getting provider...');
    const provider = await solanaWalletFromArray.getProvider();
    console.log('[PrivyBridge] Got provider, signing transaction...');
    const { signedTransaction } = await provider.request({
      method: 'signTransaction',
      params: { transaction: tx },
    });
    console.log('[PrivyBridge] Transaction signed successfully');
    return signedTransaction;
  }, [solanaWalletFromArray]);

  const createSignMessage = useCallback(async (message: Uint8Array) => {
    if (!solanaWalletFromArray) {
      throw new Error('No Privy wallet available for signing');
    }
    const provider = await solanaWalletFromArray.getProvider();
    const { signature } = await provider.request({
      method: 'signMessage',
      params: { message },
    });
    return signature;
  }, [solanaWalletFromArray]);

  // Debug: log privy state
  console.log('[PrivyBridge] privy state:', {
    isReady: privy?.isReady,
    ready: (privy as any)?.ready,
    user: !!privy?.user
  });

  const contextValue = useMemo<PrivyContextType>(() => ({
    ready: privy?.isReady ?? (privy as any)?.ready ?? !!privy?.user,
    authenticated: isAuthenticated,
    user: privy?.user as PrivyUser | null,
    // Use wallet from wallets array with proper signing functions
    solanaWallet: solanaWalletFromArray ? {
      address: solanaWalletFromArray.address,
      publicKey: solanaWalletFromArray.address,
      signMessage: createSignMessage,
      signTransaction: createSignTransaction,
      signAllTransactions: async (txs: any[]) => {
        const signed = [];
        for (const tx of txs) {
          signed.push(await createSignTransaction(tx));
        }
        return signed;
      },
    } : (privyWalletAddress ? {
      address: privyWalletAddress,
      publicKey: privyWalletAddress,
      signMessage: async () => { throw new Error('Wallet signing not available - wallet not fully loaded'); },
      signTransaction: async () => { throw new Error('Wallet signing not available - wallet not fully loaded'); },
      signAllTransactions: async () => { throw new Error('Wallet signing not available - wallet not fully loaded'); },
    } : null),

    login: {
      email: async (email: string) => {
        console.log('[Privy] Sending OTP to email:', email);
        console.log('[Privy] isReady:', privy?.isReady, 'emailLogin:', !!emailLogin, 'sendCode:', !!emailLogin?.sendCode);
        if (!privy?.isReady) {
          throw new Error('Privy not ready yet. Please wait.');
        }
        setPendingOtpType('email');
        await emailLogin?.sendCode?.({ email });
      },
      phone: async (phone: string) => {
        console.log('[Privy] Sending OTP to phone:', phone);
        setPendingOtpType('sms');
        await smsLogin?.sendCode?.({ phone });
      },
      google: async () => {
        console.log('[Privy] Login with Google');
        await oauthLogin?.login?.({ provider: 'google' });
      },
      apple: async () => {
        console.log('[Privy] Login with Apple');
        await oauthLogin?.login?.({ provider: 'apple' });
      },
      twitter: async () => {
        console.log('[Privy] Login with Twitter');
        await oauthLogin?.login?.({ provider: 'twitter' });
      },
      wallet: async () => {
        console.log('[Privy] Connect wallet');
        // For connecting external wallets
        await privy?.connectWallet?.();
      },
    },

    verifyOtp: async (otp: string) => {
      console.log('[Privy] Verifying OTP, type:', pendingOtpType);
      if (pendingOtpType === 'email') {
        await emailLogin?.loginWithCode?.({ code: otp });
      } else if (pendingOtpType === 'sms') {
        await smsLogin?.loginWithCode?.({ code: otp });
      }
      setPendingOtpType(null);
    },

    logout: async () => {
      console.log('[Privy] Logging out');
      await privy?.logout?.();
      await walletStore.logout();
    },

    createWallet: async () => {
      console.log('[Privy] Creating embedded wallet');
      const wallet = await solanaWallet?.create?.();
      if (wallet?.address) {
        await walletStore.initialize();
      }
      return wallet;
    },

    exportWallet: async () => {
      console.log('[Privy] Exporting wallet');
      return await solanaWallet?.wallet?.export?.() ?? '';
    },

    linkEmail: async (email: string) => {
      console.log('[Privy] Linking email:', email);
      await privy?.linkEmail?.(email);
    },

    linkPhone: async (phone: string) => {
      console.log('[Privy] Linking phone:', phone);
      await privy?.linkPhone?.(phone);
    },

    linkWallet: async () => {
      console.log('[Privy] Linking wallet');
      await privy?.linkWallet?.();
    },

    unlinkAccount: async (accountId: string) => {
      console.log('[Privy] Unlinking account:', accountId);
      await privy?.unlinkAccount?.(accountId);
    },
  }), [privy, solanaWallet, solanaWalletFromArray, privyWalletAddress, createSignTransaction, createSignMessage, isAuthenticated, emailLogin, smsLogin, oauthLogin, pendingOtpType, walletStore]);

  return (
    <PrivyContext.Provider value={contextValue}>
      {children}
    </PrivyContext.Provider>
  );
}

/**
 * Mock Privy Provider for development/testing
 */
function MockPrivyProvider({ children }: { children: React.ReactNode }) {
  const walletStore = useWalletStore();
  const [state, setState] = useState({
    ready: false,
    authenticated: false,
    user: null as PrivyUser | null,
  });
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);

  useEffect(() => {
    // Simulate initialization
    const timer = setTimeout(() => {
      setState(prev => ({ ...prev, ready: true }));
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const mockLogin = useCallback(async (type: string, value?: string) => {
    console.log(`[MockPrivy] Login with ${type}:`, value);

    if (type === 'email') {
      setPendingEmail(value || null);
      return; // Wait for OTP
    }

    if (type === 'sms') {
      setPendingPhone(value || null);
      return; // Wait for OTP
    }

    // Simulate OAuth login
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create mock wallet
    const wallet = await walletStore.createNewWallet?.();

    setState(prev => ({
      ...prev,
      authenticated: true,
      user: {
        id: `mock-${Date.now()}`,
        createdAt: new Date(),
        [type]: type === 'google' ? { email: 'user@gmail.com', subject: 'mock' } :
                type === 'apple' ? { email: 'user@icloud.com', subject: 'mock' } :
                type === 'twitter' ? { username: 'mockuser', subject: 'mock' } :
                { address: walletStore.publicKey || 'mock-address' },
        linkedAccounts: [],
      },
    }));
  }, [walletStore]);

  const mockVerifyOtp = useCallback(async (otp: string) => {
    console.log('[MockPrivy] Verify OTP:', otp);

    // Simulate OTP verification
    await new Promise(resolve => setTimeout(resolve, 500));

    if (otp !== '123456' && otp.length !== 6) {
      throw new Error('Invalid verification code');
    }

    // Create wallet after successful verification
    await walletStore.createNewWallet?.();

    setState(prev => ({
      ...prev,
      authenticated: true,
      user: {
        id: `mock-${Date.now()}`,
        createdAt: new Date(),
        email: pendingEmail ? { address: pendingEmail, verified: true } : undefined,
        phone: pendingPhone ? { number: pendingPhone, verified: true } : undefined,
        linkedAccounts: [],
      },
    }));

    setPendingEmail(null);
    setPendingPhone(null);
  }, [pendingEmail, pendingPhone, walletStore]);

  const contextValue = useMemo<PrivyContextType>(() => ({
    ready: state.ready,
    authenticated: state.authenticated,
    user: state.user,
    solanaWallet: null, // Use wallet store instead

    login: {
      email: async (email) => mockLogin('email', email),
      phone: async (phone) => mockLogin('sms', phone),
      google: async () => mockLogin('google'),
      apple: async () => mockLogin('apple'),
      twitter: async () => mockLogin('twitter'),
      wallet: async () => mockLogin('wallet'),
    },

    verifyOtp: mockVerifyOtp,

    logout: async () => {
      setState(prev => ({
        ...prev,
        authenticated: false,
        user: null,
      }));
      await walletStore.logout();
    },

    createWallet: async () => {
      await walletStore.createNewWallet?.();
      return {
        address: walletStore.publicKey || '',
        publicKey: walletStore.publicKey || '',
        signMessage: async () => new Uint8Array(),
        signTransaction: async (tx: any) => tx,
        signAllTransactions: async (txs: any[]) => txs,
      };
    },

    exportWallet: async () => {
      console.log('[MockPrivy] Export wallet not available in mock mode');
      return '';
    },

    linkEmail: async () => { console.log('[MockPrivy] linkEmail'); },
    linkPhone: async () => { console.log('[MockPrivy] linkPhone'); },
    linkWallet: async () => { console.log('[MockPrivy] linkWallet'); },
    unlinkAccount: async () => { console.log('[MockPrivy] unlinkAccount'); },
  }), [state, mockLogin, mockVerifyOtp, walletStore]);

  return (
    <PrivyContext.Provider value={contextValue}>
      {children}
    </PrivyContext.Provider>
  );
}

/**
 * Hook to access Privy context
 */
export function usePrivyAuth(): PrivyContextType {
  const context = useContext(PrivyContext);
  if (!context) {
    throw new Error('usePrivyAuth must be used within P01PrivyProvider');
  }
  return context;
}

/**
 * Simplified hook for common auth operations
 */
export function useAuth() {
  const privy = usePrivyAuth();
  const walletStore = useWalletStore();

  return {
    // Auth state
    isReady: privy.ready,
    isAuthenticated: privy.authenticated,
    isLoading: !privy.ready,

    // User info
    user: privy.user,
    email: privy.user?.email?.address || null,
    phone: privy.user?.phone?.number || null,
    userId: privy.user?.id || null,

    // Wallet - prefer Privy wallet, fallback to local
    walletAddress: privy.solanaWallet?.address || walletStore.publicKey,
    hasWallet: Boolean(privy.solanaWallet?.address || walletStore.publicKey),

    // Actions
    login: privy.login,
    verifyOtp: privy.verifyOtp,
    logout: privy.logout,

    // Wallet actions
    createWallet: privy.createWallet,

    // Signing - use Privy wallet when available, fallback to local
    signMessage: privy.solanaWallet?.signMessage,
    signTransaction: privy.solanaWallet?.signTransaction,
  };
}

// Re-exports
export { PRIVY_ENABLED, PRIVY_APP_ID } from '../config/privy';
