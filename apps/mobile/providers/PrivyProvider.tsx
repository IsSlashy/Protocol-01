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
import Constants from 'expo-constants';
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

const PRIVY_CLIENT_ID = Constants.expoConfig?.extra?.privyClientId || process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID || '';

const PRIVY_SDK_AVAILABLE = true;


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
    return (
      <PrivySDKProvider
        appId={PRIVY_APP_ID}
        clientId={PRIVY_CLIENT_ID}
      >
        <PrivyBridge>{children}</PrivyBridge>
      </PrivySDKProvider>
    );
  }

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
    // Check wallets array (plural - for existing wallets)
    const wallets = solanaWallet?.wallets;
    if (wallets && Array.isArray(wallets) && wallets.length > 0) {
      return wallets[0];
    }
    return undefined;
  }, [solanaWallet?.wallets]);

  // Get wallet address from various sources
  const privyWalletAddress = useMemo(() => {
    if (solanaWalletFromArray?.address) {
      return solanaWalletFromArray.address;
    }
    // Fallback: check linked_accounts for Solana wallet
    const linkedWallet = privy?.user?.linked_accounts?.find(
      (account: any) => account.type === 'wallet' && account.chain_type === 'solana'
    );
    return (linkedWallet as any)?.address || null;
  }, [solanaWalletFromArray?.address, privy?.user?.linked_accounts]);

  // Track last synced address to avoid re-initializing on every render
  const lastSyncedAddress = React.useRef<string | null>(null);

  // Auto-create embedded wallet if authenticated but no wallet exists
  // This handles the case where user logs in via Google/Apple OAuth
  // and the embedded Solana wallet hasn't been created yet.
  useEffect(() => {
    if (isAuthenticated && !solanaWalletFromArray?.address && solanaWallet?.create) {
      console.log('[Privy] Authenticated but no wallet — auto-creating embedded wallet...');
      solanaWallet.create().then(() => {
        console.log('[Privy] Embedded wallet created');
      }).catch((err: any) => {
        // Wallet may already exist — not a fatal error
        console.warn('[Privy] Auto-create wallet:', err.message?.slice(0, 80));
      });
    }
  }, [isAuthenticated, solanaWalletFromArray?.address, solanaWallet?.create]);

  // Sync Privy wallet with wallet store — only when address actually changes
  useEffect(() => {
    if (solanaWalletFromArray?.address) {
      if (lastSyncedAddress.current !== solanaWalletFromArray.address) {
        lastSyncedAddress.current = solanaWalletFromArray.address;
        walletStore.initializeWithPrivy(solanaWalletFromArray.address);
      }
      // Always update signer (cheap, no state change)
      setPrivySigner(createSignTransaction);
    } else {
      lastSyncedAddress.current = null;
      setPrivySigner(null);
    }
  }, [solanaWalletFromArray?.address]);

  // Create proper signing functions that use Privy's provider pattern
  const createSignTransaction = useCallback(async (tx: any) => {
    if (!solanaWalletFromArray) {
      throw new Error('No Privy wallet available for signing');
    }
    const provider = await solanaWalletFromArray.getProvider();
    const { signedTransaction } = await provider.request({
      method: 'signTransaction',
      params: { transaction: tx },
    });
    return signedTransaction;
  }, [solanaWalletFromArray]);

  const createSignMessage = useCallback(async (message: Uint8Array): Promise<Uint8Array> => {
    if (!solanaWalletFromArray) {
      throw new Error('No Privy wallet available for signing');
    }
    const provider = await solanaWalletFromArray.getProvider();
    // Privy provider expects message as a base64/utf8 string
    const messageStr = Buffer.from(message).toString('base64');
    const { signature } = await provider.request({
      method: 'signMessage',
      params: { message: messageStr },
    });
    // Convert the returned signature string (base64) back to Uint8Array
    return Uint8Array.from(Buffer.from(signature, 'base64'));
  }, [solanaWalletFromArray]);

  const contextValue = useMemo<PrivyContextType>(() => ({
    ready: privy?.isReady ?? (privy as any)?.ready ?? !!privy?.user,
    authenticated: isAuthenticated,
    user: (privy?.user as unknown as PrivyUser) ?? null,
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
        if (!privy?.isReady) {
          throw new Error('Privy not ready yet. Please wait.');
        }
        setPendingOtpType('email');
        await emailLogin?.sendCode?.({ email });
      },
      phone: async (phone: string) => {
        setPendingOtpType('sms');
        await smsLogin?.sendCode?.({ phone });
      },
      google: async () => {
        if (isAuthenticated) return; // Already logged in — redirect will handle it
        await oauthLogin?.login?.({ provider: 'google' });
      },
      apple: async () => {
        if (isAuthenticated) return;
        await oauthLogin?.login?.({ provider: 'apple' });
      },
      twitter: async () => {
        if (isAuthenticated) return;
        await oauthLogin?.login?.({ provider: 'twitter' });
      },
      wallet: async () => {
        // connectWallet was removed in newer Privy Expo SDK
        console.warn('[Privy] connectWallet is not available in the current Privy Expo SDK. Use useLoginWithOAuth or external wallet adapters.');
      },
    },

    verifyOtp: async (otp: string) => {
      if (pendingOtpType === 'email') {
        await emailLogin?.loginWithCode?.({ code: otp });
      } else if (pendingOtpType === 'sms') {
        await smsLogin?.loginWithCode?.({ code: otp });
      }
      setPendingOtpType(null);
    },

    logout: async () => {
      await privy?.logout?.();
      await walletStore.logout();
    },

    createWallet: async () => {
      const provider = await solanaWallet?.create?.();
      // After creation, the wallets array should be populated on re-render.
      // Build a SolanaWallet from the provider or from current state.
      const address = solanaWalletFromArray?.address ?? '';
      if (address) {
        await walletStore.initialize();
      }
      return {
        address,
        publicKey: address,
        signMessage: createSignMessage,
        signTransaction: createSignTransaction,
        signAllTransactions: async (txs: any[]) => {
          const signed = [];
          for (const tx of txs) {
            signed.push(await createSignTransaction(tx));
          }
          return signed;
        },
      } as SolanaWallet;
    },

    exportWallet: async () => {
      // wallet export is not directly available on the Privy Expo SDK's EmbeddedSolanaWalletState
      console.warn('[Privy] exportWallet is not supported in the current Privy Expo SDK.');
      return '';
    },

    linkEmail: async (_email: string) => {
      // linkEmail was removed from UsePrivy in newer Privy Expo SDK.
      // Use the useLinkEmail hook directly if needed.
      console.warn('[Privy] linkEmail is not available on UsePrivy. Use the useLinkEmail hook instead.');
    },

    linkPhone: async (_phone: string) => {
      // linkPhone was removed from UsePrivy in newer Privy Expo SDK.
      // Use the useLinkSMS hook directly if needed.
      console.warn('[Privy] linkPhone is not available on UsePrivy. Use the useLinkSMS hook instead.');
    },

    linkWallet: async () => {
      // linkWallet was removed from UsePrivy in newer Privy Expo SDK.
      // Use the useLinkWithSiwe/useLinkWithSiws hooks directly if needed.
      console.warn('[Privy] linkWallet is not available on UsePrivy. Use useLinkWithSiwe or useLinkWithSiws hooks instead.');
    },

    unlinkAccount: async (_accountId: string) => {
      // unlinkAccount was removed from UsePrivy in newer Privy Expo SDK.
      // Use useUnlinkEmail, useUnlinkWallet, etc. hooks directly if needed.
      console.warn('[Privy] unlinkAccount is not available on UsePrivy. Use specific unlink hooks (useUnlinkEmail, useUnlinkWallet, etc.) instead.');
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
