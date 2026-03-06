/**
 * useNetwork - Network connectivity status for Solana mobile app
 * @module hooks/common/useNetwork
 */

import { useNetInfo } from '@react-native-community/netinfo';

export interface NetworkState {
  isConnected: boolean;
  isInternetReachable: boolean;
  connectionType: string;
}

interface UseNetworkReturn {
  isConnected: boolean;
  isInternetReachable: boolean;
  connectionType: string;
}

export function useNetwork(): UseNetworkReturn {
  const netInfo = useNetInfo();

  const isConnected = netInfo.isConnected ?? false;
  const isInternetReachable = netInfo.isInternetReachable ?? false;
  const connectionType = netInfo.type ?? 'unknown';

  return {
    isConnected,
    isInternetReachable,
    connectionType,
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
