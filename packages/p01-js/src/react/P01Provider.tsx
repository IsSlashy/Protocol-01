/**
 * Protocol 01 React Provider
 *
 * Provides P-01 SDK context to child components.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Protocol01 } from '../protocol01';
import type { Subscription, MerchantConfig } from '../types';
import type { P01ProviderProps, P01ContextValue, WidgetTheme } from './types';
import { DEFAULT_THEME } from './types';

// ============ Context ============

const P01Context = createContext<P01ContextValue | null>(null);
const P01SDKContext = createContext<Protocol01 | null>(null);
const P01ThemeContext = createContext<WidgetTheme>(DEFAULT_THEME);

// ============ Provider Component ============

export function P01Provider({ config, children, theme }: P01ProviderProps) {
  const [sdk, setSdk] = useState<Protocol01 | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isP01Wallet, setIsP01Wallet] = useState(false);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Merge theme with defaults
  const mergedTheme = { ...DEFAULT_THEME, ...theme };

  // Initialize SDK
  useEffect(() => {
    const p01 = new Protocol01(config);
    setSdk(p01);

    // Wait for SDK to be ready
    const checkReady = async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        setIsReady(true);

        // Check if already connected
        if (p01.isConnected()) {
          setIsConnected(true);
          setPublicKey(p01.getPublicKey());
          await loadSubscriptions(p01);
        }
      } catch (err) {
        console.error('Error initializing P01 SDK:', err);
      }
    };

    checkReady();

    return () => {
      // Cleanup if needed
    };
  }, [config]);

  // Load subscriptions
  const loadSubscriptions = async (instance: Protocol01) => {
    if (!instance.isConnected()) return;

    setLoadingSubscriptions(true);
    try {
      const subs = await instance.getSubscriptions();
      setSubscriptions(subs);
    } catch (err) {
      console.error('Error loading subscriptions:', err);
    } finally {
      setLoadingSubscriptions(false);
    }
  };

  // Connect wallet
  const connect = useCallback(async () => {
    if (!sdk) {
      setError(new Error('SDK not initialized'));
      return;
    }

    try {
      setError(null);
      const result = await sdk.connect();
      setIsConnected(true);
      setPublicKey(result.publicKey);
      setIsP01Wallet(result.supportsProtocol01);
      await loadSubscriptions(sdk);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Connection failed'));
      throw err;
    }
  }, [sdk]);

  // Disconnect wallet
  const disconnect = useCallback(async () => {
    if (!sdk) return;

    try {
      await sdk.disconnect();
      setIsConnected(false);
      setPublicKey(null);
      setIsP01Wallet(false);
      setSubscriptions([]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Disconnect failed'));
    }
  }, [sdk]);

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Context value
  const contextValue: P01ContextValue = {
    isReady,
    isConnected,
    publicKey,
    isP01Wallet,
    connect,
    disconnect,
    subscriptions,
    loadingSubscriptions,
    error,
    clearError,
  };

  return (
    <P01SDKContext.Provider value={sdk}>
      <P01ThemeContext.Provider value={mergedTheme}>
        <P01Context.Provider value={contextValue}>
          {children}
        </P01Context.Provider>
      </P01ThemeContext.Provider>
    </P01SDKContext.Provider>
  );
}

// ============ Hooks ============

/**
 * Use P-01 context
 * @returns P01 context value
 * @throws Error if used outside of P01Provider
 */
export function useP01(): P01ContextValue {
  const context = useContext(P01Context);
  if (!context) {
    throw new Error('useP01 must be used within a P01Provider');
  }
  return context;
}

/**
 * Use P-01 SDK instance
 * @returns Protocol01 SDK instance
 * @throws Error if used outside of P01Provider
 */
export function useP01SDK(): Protocol01 | null {
  return useContext(P01SDKContext);
}

/**
 * Use P-01 wallet state
 * @returns Wallet connection state and methods
 */
export function useP01Wallet() {
  const { isConnected, publicKey, isP01Wallet, connect, disconnect, error } = useP01();

  return {
    isConnected,
    publicKey,
    isP01Wallet,
    connect,
    disconnect,
    error,
  };
}

/**
 * Use P-01 subscriptions
 * @returns Subscriptions state and methods
 */
export function useP01Subscriptions() {
  const { subscriptions, loadingSubscriptions, isConnected } = useP01();
  const sdk = useP01SDK();

  const cancelSubscription = useCallback(async (subscriptionId: string) => {
    if (!sdk) {
      throw new Error('SDK not initialized');
    }
    await sdk.cancelSubscription(subscriptionId);
  }, [sdk]);

  return {
    subscriptions,
    loading: loadingSubscriptions,
    isConnected,
    cancelSubscription,
  };
}

/**
 * Use P-01 theme
 * @returns Widget theme
 */
export function useP01Theme(): WidgetTheme {
  return useContext(P01ThemeContext);
}
