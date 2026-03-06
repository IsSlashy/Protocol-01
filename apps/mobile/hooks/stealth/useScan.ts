/**
 * useScan - Scan blockchain for incoming stealth payments
 * @module hooks/stealth/useScan
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useStealth, StealthPayment } from './useStealth';
import { useNetwork } from '../common/useNetwork';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';

export interface ScanProgress {
  currentBlock: number;
  startBlock: number;
  endBlock: number;
  percentage: number;
  foundPayments: number;
}

export interface ScanResult {
  payments: StealthPayment[];
  scannedBlocks: number;
  duration: number;
  errors: string[];
}

interface UseScanOptions {
  autoScan?: boolean;
  scanInterval?: number; // ms
  blocksPerBatch?: number;
}

interface UseScanReturn {
  isScanning: boolean;
  progress: ScanProgress | null;
  payments: StealthPayment[];
  unclaimedPayments: StealthPayment[];
  lastScanBlock: number;
  error: Error | null;
  startScan: (fromBlock?: number) => Promise<ScanResult | null>;
  stopScan: () => void;
  claimPayment: (payment: StealthPayment) => Promise<string | null>;
  refreshPayments: () => Promise<void>;
}

const DEFAULT_SCAN_INTERVAL = 60000; // 1 minute
const DEFAULT_BLOCKS_PER_BATCH = 1000;

// ERC-5564 Announcer contract event signature
const ANNOUNCEMENT_TOPIC = '0x' + 'a'.repeat(64); // Placeholder

export function useScan(options: UseScanOptions = {}): UseScanReturn {
  const {
    autoScan = true,
    scanInterval = DEFAULT_SCAN_INTERVAL,
    blocksPerBatch = DEFAULT_BLOCKS_PER_BATCH,
  } = options;

  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [payments, setPayments] = useState<StealthPayment[]>([]);
  const [lastScanBlock, setLastScanBlock] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  const scanAbortRef = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const isScanningRef = useRef(false);
  const startScanRef = useRef<(fromBlock?: number) => Promise<ScanResult | null>>(null as any);

  const { stealthMetaAddress, getViewingPrivateKey } = useStealth();
  const { isConnected, provider, chainId } = useNetwork();

  const {
    value: cachedPayments,
    setValue: setCachedPayments,
  } = useAsyncStorage<StealthPayment[]>({
    key: `${ASYNC_KEYS.RECENT_TRANSACTIONS}_stealth_payments`,
    defaultValue: [],
  });

  const {
    value: savedLastBlock,
    setValue: setSavedLastBlock,
  } = useAsyncStorage<number>({
    key: `${ASYNC_KEYS.LAST_SYNC}_stealth_scan_${chainId}`,
    defaultValue: 0,
  });

  // Load cached payments on mount
  useEffect(() => {
    if (cachedPayments) {
      setPayments(cachedPayments);
    }
    if (savedLastBlock) {
      setLastScanBlock(savedLastBlock);
    }
  }, [cachedPayments, savedLastBlock]);

  // Filter unclaimed payments
  const unclaimedPayments = payments.filter(p => !p.claimed);

  const scanBlocks = useCallback(async (
    fromBlock: number,
    toBlock: number,
    viewingKey: string
  ): Promise<StealthPayment[]> => {
    const foundPayments: StealthPayment[] = [];

    // In real implementation:
    // 1. Query ERC-5564 Announcer contract for Announcement events
    // 2. Filter by view tag for efficiency
    // 3. For matching events, compute stealth address
    // 4. Check if we control that address

    // Placeholder - simulate finding payments
    if (Math.random() > 0.9) {
      foundPayments.push({
        id: `payment-${Date.now()}`,
        stealthAddress: '0x' + Math.random().toString(16).slice(2).padEnd(40, '0'),
        ephemeralPublicKey: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'),
        amount: BigInt('100000000000000000'), // 0.1 ETH
        amountFormatted: '0.1',
        timestamp: Date.now(),
        claimed: false,
      });
    }

    return foundPayments;
  }, []);

  const startScan = useCallback(async (
    fromBlock?: number
  ): Promise<ScanResult | null> => {
    if (!stealthMetaAddress || !isConnected) {
      setError(new Error('Not ready to scan'));
      return null;
    }

    const viewingKey = await getViewingPrivateKey();
    if (!viewingKey) {
      setError(new Error('Viewing key not available'));
      return null;
    }

    setIsScanning(true);
    isScanningRef.current = true;
    setError(null);
    scanAbortRef.current = false;

    const startTime = Date.now();
    const allFoundPayments: StealthPayment[] = [];
    const errors: string[] = [];

    try {
      // Get current block
      // In real implementation: const currentBlock = await provider.getBlockNumber();
      const currentBlock = 18000000; // Placeholder

      // Determine start block
      const startBlock = fromBlock ?? (lastScanBlock || (currentBlock - 10000));
      const endBlock = currentBlock;

      let scannedBlocks = 0;

      // Scan in batches
      for (let batch = startBlock; batch < endBlock && !scanAbortRef.current; batch += blocksPerBatch) {
        const batchEnd = Math.min(batch + blocksPerBatch - 1, endBlock);

        // Update progress
        setProgress({
          currentBlock: batch,
          startBlock,
          endBlock,
          percentage: ((batch - startBlock) / (endBlock - startBlock)) * 100,
          foundPayments: allFoundPayments.length,
        });

        try {
          const batchPayments = await scanBlocks(batch, batchEnd, viewingKey);
          allFoundPayments.push(...batchPayments);
          scannedBlocks += batchEnd - batch + 1;
        } catch (err) {
          errors.push(`Failed to scan blocks ${batch}-${batchEnd}`);
        }

        // Small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Update state with found payments
      if (allFoundPayments.length > 0) {
        const updatedPayments = [...allFoundPayments, ...payments];
        setPayments(updatedPayments);
        await setCachedPayments(updatedPayments);
      }

      // Update last scanned block
      setLastScanBlock(endBlock);
      await setSavedLastBlock(endBlock);

      const result: ScanResult = {
        payments: allFoundPayments,
        scannedBlocks,
        duration: Date.now() - startTime,
        errors,
      };

      return result;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Scan failed'));
      return null;
    } finally {
      setIsScanning(false);
      isScanningRef.current = false;
      setProgress(null);
    }
  }, [
    stealthMetaAddress,
    isConnected,
    getViewingPrivateKey,
    lastScanBlock,
    blocksPerBatch,
    scanBlocks,
    payments,
    setCachedPayments,
    setSavedLastBlock,
  ]);

  // Keep ref in sync so the interval closure always calls the latest version
  startScanRef.current = startScan;

  const stopScan = useCallback(() => {
    scanAbortRef.current = true;
  }, []);

  const claimPayment = useCallback(async (
    payment: StealthPayment
  ): Promise<string | null> => {
    setError(null);

    try {
      // Claim flow using the specter-sdk:
      // 1. Derive the stealth private key from viewing + spending keys
      //    via deriveStealthPrivateKey(spendingPubKey, viewingPrivateKey, ephemeralPubKey)
      // 2. Build an Ed25519 claim proof: the stealth private key signs a
      //    deterministic challenge = SHA-256("p01:claim:v1" || stealthAddr || spendingKey)
      //    using buildClaimProof(stealthKeypair, spendingPubKey) from @p01/specter-sdk
      // 3. Submit the claim_stealth instruction with the 64-byte signature
      //
      // TODO: Wire up Solana connection and wallet keys from the mobile
      // stealth key provider once the full SDK integration is in place.
      throw new Error('Claim not yet wired to Solana SDK — see buildClaimProof in @p01/specter-sdk');
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to claim payment'));
      return null;
    }
  }, [payments, setCachedPayments]);

  const refreshPayments = useCallback(async () => {
    // Reload from cache
    if (cachedPayments) {
      setPayments(cachedPayments);
    }
  }, [cachedPayments]);

  // Auto-scan on interval (uses refs to avoid re-subscribing on every state change)
  useEffect(() => {
    if (!autoScan || !stealthMetaAddress || !isConnected) {
      return;
    }

    // Initial scan
    startScanRef.current();

    // Set up interval
    intervalRef.current = setInterval(() => {
      if (!isScanningRef.current) {
        startScanRef.current();
      }
    }, scanInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoScan, stealthMetaAddress, isConnected, scanInterval]);

  return {
    isScanning,
    progress,
    payments,
    unclaimedPayments,
    lastScanBlock,
    error,
    startScan,
    stopScan,
    claimPayment,
    refreshPayments,
  };
}
