import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { Specter, type SpecterConfig } from '../client';
import type { WalletInfo, SpecterError } from '../types';

interface SpecterContextValue {
  specter: Specter;
  isInstalled: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  publicKey: string | null;
  walletInfo: WalletInfo | null;
  error: SpecterError | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const SpecterContext = createContext<SpecterContextValue | null>(null);

interface SpecterProviderProps {
  children: React.ReactNode;
  config?: SpecterConfig;
  autoConnect?: boolean;
}

export function SpecterProvider({
  children,
  config,
  autoConnect = false,
}: SpecterProviderProps) {
  const [specter] = useState(() => new Specter(config));
  const [isInstalled, setIsInstalled] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [error, setError] = useState<SpecterError | null>(null);

  // Check if installed
  useEffect(() => {
    const checkInstalled = async () => {
      const installed = await Specter.waitForInstall(2000);
      setIsInstalled(installed);

      if (installed && autoConnect) {
        connect();
      }
    };

    checkInstalled();
  }, [autoConnect]);

  // Listen for wallet events
  useEffect(() => {
    const handleConnect = (event: { data: { publicKey: string } }) => {
      setIsConnected(true);
      setPublicKey(event.data.publicKey);
    };

    const handleDisconnect = () => {
      setIsConnected(false);
      setPublicKey(null);
      setWalletInfo(null);
    };

    specter.on('connect', handleConnect as never);
    specter.on('disconnect', handleDisconnect as never);

    return () => {
      specter.off('connect', handleConnect as never);
      specter.off('disconnect', handleDisconnect as never);
    };
  }, [specter]);

  const connect = useCallback(async () => {
    if (isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      const result = await specter.connect();
      setIsConnected(true);
      setPublicKey(result.publicKey);

      const info = await specter.getWalletInfo();
      setWalletInfo(info);
    } catch (err) {
      setError(err as SpecterError);
    } finally {
      setIsConnecting(false);
    }
  }, [specter, isConnecting]);

  const disconnect = useCallback(async () => {
    try {
      await specter.disconnect();
      setIsConnected(false);
      setPublicKey(null);
      setWalletInfo(null);
    } catch (err) {
      setError(err as SpecterError);
    }
  }, [specter]);

  const value = useMemo(
    () => ({
      specter,
      isInstalled,
      isConnected,
      isConnecting,
      publicKey,
      walletInfo,
      error,
      connect,
      disconnect,
    }),
    [
      specter,
      isInstalled,
      isConnected,
      isConnecting,
      publicKey,
      walletInfo,
      error,
      connect,
      disconnect,
    ]
  );

  return (
    <SpecterContext.Provider value={value}>{children}</SpecterContext.Provider>
  );
}

export function useSpecter(): SpecterContextValue {
  const context = useContext(SpecterContext);

  if (!context) {
    throw new Error('useSpecter must be used within a SpecterProvider');
  }

  return context;
}
