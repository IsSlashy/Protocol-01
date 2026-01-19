/**
 * useReceive - Generate receive addresses and QR codes
 * @module hooks/wallet/useReceive
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useWallet } from './useWallet';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';

export interface ReceiveAddress {
  address: string;
  type: 'standard' | 'stealth';
  label?: string;
  createdAt: number;
  usedAt?: number;
  amount?: string;
  token?: {
    address: string;
    symbol: string;
  };
}

export interface QRCodeData {
  uri: string; // EIP-681 URI
  address: string;
  amount?: string;
  token?: string;
  chainId: number;
}

interface UseReceiveReturn {
  standardAddress: string | null;
  stealthAddress: string | null;
  isGeneratingstealth: boolean;
  error: Error | null;
  generateStealthAddress: () => Promise<string | null>;
  createPaymentRequest: (options: PaymentRequestOptions) => QRCodeData | null;
  recentAddresses: ReceiveAddress[];
  clearAddressHistory: () => Promise<void>;
}

interface PaymentRequestOptions {
  amount?: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  label?: string;
  usestealth?: boolean;
  chainId?: number;
}

const DEFAULT_CHAIN_ID = 1; // Ethereum mainnet

export function useReceive(): UseReceiveReturn {
  const { wallet } = useWallet();
  const [stealthAddress, setStealthAddress] = useState<string | null>(null);
  const [isGeneratingStealth, setIsGeneratingStealth] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const {
    value: recentAddresses,
    setValue: setRecentAddresses,
  } = useAsyncStorage<ReceiveAddress[]>({
    key: `${ASYNC_KEYS.RECENT_TRANSACTIONS}_receive_addresses`,
    defaultValue: [],
  });

  const standardAddress = useMemo(() => {
    return wallet?.address ?? null;
  }, [wallet]);

  // Generate a new stealth address for receiving private payments
  const generateStealthAddress = useCallback(async (): Promise<string | null> => {
    if (!wallet) {
      setError(new Error('Wallet not unlocked'));
      return null;
    }

    setIsGeneratingStealth(true);
    setError(null);

    try {
      // In real implementation:
      // 1. Get stealth meta-address from wallet
      // 2. Generate new ephemeral keypair
      // 3. Derive stealth address using ERC-5564 scheme
      // 4. Store ephemeral key for later scanning

      // Placeholder - generate random stealth address
      const randomBytes = new Uint8Array(20);
      crypto.getRandomValues(randomBytes);
      const newStealthAddress = '0x' + Array.from(randomBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      setStealthAddress(newStealthAddress);

      // Save to history
      const newAddress: ReceiveAddress = {
        address: newStealthAddress,
        type: 'stealth',
        createdAt: Date.now(),
      };

      const updatedAddresses = [
        newAddress,
        ...(recentAddresses ?? []).slice(0, 49), // Keep last 50
      ];
      await setRecentAddresses(updatedAddresses);

      return newStealthAddress;
    } catch (err) {
      const error = err instanceof Error
        ? err
        : new Error('Failed to generate stealth address');
      setError(error);
      return null;
    } finally {
      setIsGeneratingStealth(false);
    }
  }, [wallet, recentAddresses, setRecentAddresses]);

  // Generate stealth address on mount if wallet is available
  useEffect(() => {
    if (wallet && !stealthAddress) {
      generateStealthAddress();
    }
  }, [wallet, stealthAddress, generateStealthAddress]);

  // Create EIP-681 payment request URI
  const createPaymentRequest = useCallback((
    options: PaymentRequestOptions
  ): QRCodeData | null => {
    const {
      amount,
      tokenAddress,
      tokenSymbol,
      label,
      usestealth = false,
      chainId = DEFAULT_CHAIN_ID,
    } = options;

    const address = usestealth ? stealthAddress : standardAddress;

    if (!address) {
      setError(new Error('No address available'));
      return null;
    }

    // Build EIP-681 URI
    // Format: ethereum:address[@chainId][/function]?[params]
    let uri = `ethereum:${address}`;

    // Add chain ID if not mainnet
    if (chainId !== 1) {
      uri += `@${chainId}`;
    }

    // For token transfers, use transfer function
    if (tokenAddress) {
      uri += `/transfer`;
    }

    // Build query params
    const params: string[] = [];

    if (amount) {
      if (tokenAddress) {
        // Token amount (in smallest unit)
        // Note: Real implementation should convert based on decimals
        params.push(`uint256=${amount}`);
        params.push(`address=${tokenAddress}`);
      } else {
        // Native amount in wei
        const weiAmount = BigInt(parseFloat(amount) * 1e18);
        params.push(`value=${weiAmount}`);
      }
    }

    if (label) {
      params.push(`label=${encodeURIComponent(label)}`);
    }

    if (params.length > 0) {
      uri += `?${params.join('&')}`;
    }

    // Save to history
    const newAddress: ReceiveAddress = {
      address,
      type: usestealth ? 'stealth' : 'standard',
      label,
      createdAt: Date.now(),
      amount,
      token: tokenAddress ? { address: tokenAddress, symbol: tokenSymbol ?? 'TOKEN' } : undefined,
    };

    const updatedAddresses = [
      newAddress,
      ...(recentAddresses ?? []).filter(a => a.address !== address).slice(0, 49),
    ];
    setRecentAddresses(updatedAddresses);

    return {
      uri,
      address,
      amount,
      token: tokenSymbol,
      chainId,
    };
  }, [standardAddress, stealthAddress, recentAddresses, setRecentAddresses]);

  const clearAddressHistory = useCallback(async () => {
    await setRecentAddresses([]);
  }, [setRecentAddresses]);

  return {
    standardAddress,
    stealthAddress,
    isGeneratingstealth: isGeneratingStealth,
    error,
    generateStealthAddress,
    createPaymentRequest,
    recentAddresses: recentAddresses ?? [],
    clearAddressHistory,
  };
}

// Utility to generate QR code content
export function generateQRContent(data: QRCodeData): string {
  return data.uri;
}

// Utility to parse QR code content
export function parseQRContent(content: string): Partial<QRCodeData> | null {
  if (!content.startsWith('ethereum:')) {
    return null;
  }

  try {
    const withoutPrefix = content.slice(9);
    const [addressPart, queryPart] = withoutPrefix.split('?');

    // Parse address and optional chain ID
    const addressMatch = addressPart.match(/^(0x[a-fA-F0-9]{40})(?:@(\d+))?/);
    if (!addressMatch) {
      return null;
    }

    const result: Partial<QRCodeData> = {
      address: addressMatch[1],
      chainId: addressMatch[2] ? parseInt(addressMatch[2], 10) : 1,
    };

    // Parse query params
    if (queryPart) {
      const params = new URLSearchParams(queryPart);

      const value = params.get('value');
      if (value) {
        result.amount = (BigInt(value) / BigInt(1e18)).toString();
      }
    }

    result.uri = content;
    return result;
  } catch {
    return null;
  }
}
