/**
 * useNetwork - Network connection status and RPC management
 * @module hooks/common/useNetwork
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNetInfo, NetInfoState } from '@react-native-community/netinfo';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';

export type NetworkType = 'mainnet' | 'goerli' | 'sepolia' | 'polygon' | 'arbitrum' | 'optimism' | 'base';

export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  isTestnet: boolean;
}

export const NETWORKS: Record<NetworkType, NetworkConfig> = {
  mainnet: {
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/',
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },
  goerli: {
    name: 'Goerli Testnet',
    chainId: 5,
    rpcUrl: 'https://eth-goerli.g.alchemy.com/v2/',
    explorerUrl: 'https://goerli.etherscan.io',
    nativeCurrency: { name: 'Goerli Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: true,
  },
  sepolia: {
    name: 'Sepolia Testnet',
    chainId: 11155111,
    rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/',
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: true,
  },
  polygon: {
    name: 'Polygon',
    chainId: 137,
    rpcUrl: 'https://polygon-mainnet.g.alchemy.com/v2/',
    explorerUrl: 'https://polygonscan.com',
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    isTestnet: false,
  },
  arbitrum: {
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: 'https://arb-mainnet.g.alchemy.com/v2/',
    explorerUrl: 'https://arbiscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },
  optimism: {
    name: 'Optimism',
    chainId: 10,
    rpcUrl: 'https://opt-mainnet.g.alchemy.com/v2/',
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },
  base: {
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
  },
};

export interface NetworkState {
  isConnected: boolean;
  isInternetReachable: boolean;
  connectionType: string;
  rpcConnected: boolean;
  latency: number | null; // ms
  blockNumber: number | null;
}

interface UseNetworkReturn {
  state: NetworkState;
  isConnected: boolean;
  network: NetworkConfig;
  networkType: NetworkType;
  chainId: number;
  provider: unknown; // Would be ethers.Provider or viem Client in real implementation
  switchNetwork: (networkType: NetworkType) => Promise<boolean>;
  setCustomRpc: (rpcUrl: string) => Promise<boolean>;
  checkConnection: () => Promise<boolean>;
  getExplorerUrl: (type: 'tx' | 'address' | 'block', hash: string) => string;
}

const DEFAULT_NETWORK: NetworkType = 'mainnet';

export function useNetwork(): UseNetworkReturn {
  const netInfo = useNetInfo();

  const [state, setState] = useState<NetworkState>({
    isConnected: false,
    isInternetReachable: false,
    connectionType: 'unknown',
    rpcConnected: false,
    latency: null,
    blockNumber: null,
  });

  const {
    value: savedNetworkType,
    setValue: setSavedNetworkType,
  } = useAsyncStorage<NetworkType>({
    key: ASYNC_KEYS.NETWORK_CONFIG,
    defaultValue: DEFAULT_NETWORK,
  });

  const {
    value: customRpcUrl,
    setValue: setCustomRpcUrl,
  } = useAsyncStorage<string | null>({
    key: `${ASYNC_KEYS.NETWORK_CONFIG}_custom_rpc`,
    defaultValue: null,
  });

  const networkType = savedNetworkType ?? DEFAULT_NETWORK;
  const network = NETWORKS[networkType];
  const chainId = network.chainId;

  // Mock provider - in real implementation, use ethers.js or viem
  const provider = useMemo(() => {
    // Return mock provider object
    return {
      getBlockNumber: async () => 18000000,
      getBalance: async () => BigInt(0),
    };
  }, [networkType, customRpcUrl]);

  // Update network state from netInfo
  useEffect(() => {
    setState(prev => ({
      ...prev,
      isConnected: netInfo.isConnected ?? false,
      isInternetReachable: netInfo.isInternetReachable ?? false,
      connectionType: netInfo.type ?? 'unknown',
    }));
  }, [netInfo]);

  // Check RPC connection
  const checkRpcConnection = useCallback(async (): Promise<boolean> => {
    const startTime = Date.now();

    try {
      // In real implementation, make an actual RPC call
      // const blockNumber = await provider.getBlockNumber();
      const blockNumber = 18000000; // Placeholder

      const latency = Date.now() - startTime;

      setState(prev => ({
        ...prev,
        rpcConnected: true,
        latency,
        blockNumber,
      }));

      return true;
    } catch (error) {
      setState(prev => ({
        ...prev,
        rpcConnected: false,
        latency: null,
        blockNumber: null,
      }));

      return false;
    }
  }, [provider]);

  // Check connection on mount and network changes
  useEffect(() => {
    if (state.isConnected) {
      checkRpcConnection();

      // Set up periodic checks
      const interval = setInterval(checkRpcConnection, 30000); // Every 30 seconds

      return () => clearInterval(interval);
    }
  }, [state.isConnected, networkType, checkRpcConnection]);

  const switchNetwork = useCallback(async (
    newNetworkType: NetworkType
  ): Promise<boolean> => {
    try {
      await setSavedNetworkType(newNetworkType);
      await setCustomRpcUrl(null); // Clear custom RPC when switching networks

      // Check connection on new network
      setTimeout(checkRpcConnection, 100);

      return true;
    } catch {
      return false;
    }
  }, [setSavedNetworkType, setCustomRpcUrl, checkRpcConnection]);

  const setCustomRpc = useCallback(async (rpcUrl: string): Promise<boolean> => {
    try {
      // Validate RPC URL
      if (!rpcUrl.startsWith('http://') && !rpcUrl.startsWith('https://')) {
        return false;
      }

      await setCustomRpcUrl(rpcUrl);

      // Check connection with new RPC
      setTimeout(checkRpcConnection, 100);

      return true;
    } catch {
      return false;
    }
  }, [setCustomRpcUrl, checkRpcConnection]);

  const checkConnection = useCallback(async (): Promise<boolean> => {
    return checkRpcConnection();
  }, [checkRpcConnection]);

  const getExplorerUrl = useCallback((
    type: 'tx' | 'address' | 'block',
    hash: string
  ): string => {
    const baseUrl = network.explorerUrl;

    switch (type) {
      case 'tx':
        return `${baseUrl}/tx/${hash}`;
      case 'address':
        return `${baseUrl}/address/${hash}`;
      case 'block':
        return `${baseUrl}/block/${hash}`;
      default:
        return baseUrl;
    }
  }, [network.explorerUrl]);

  const isConnected = state.isConnected && state.rpcConnected;

  return {
    state,
    isConnected,
    network,
    networkType,
    chainId,
    provider,
    switchNetwork,
    setCustomRpc,
    checkConnection,
    getExplorerUrl,
  };
}

// Hook for listening to specific network events
export function useNetworkStatus(): {
  isOnline: boolean;
  connectionType: string;
} {
  const netInfo = useNetInfo();

  return {
    isOnline: netInfo.isConnected ?? false,
    connectionType: netInfo.type ?? 'unknown',
  };
}
