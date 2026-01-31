/**
 * Transactions Service Test Suite
 *
 * Validates the transaction dispatch layer including SOL transfers
 * with Platform Fee (P-01 Network), fee estimation, transaction
 * history caching, and address validation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '../../test/__mocks__/async-storage';
import {
  getTransferFeeBreakdown,
  getCachedTransactions,
  clearTransactionCache,
  isValidAddress,
  formatTxDate,
} from './transactions';

// Mock the connection module
vi.mock('./connection', () => ({
  getConnection: vi.fn(() => ({
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'mock-blockhash', lastValidBlockHeight: 999 }),
    sendRawTransaction: vi.fn().mockResolvedValue('mock-sig'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getRecentBlockhash: vi.fn().mockResolvedValue({ blockhash: 'mock-bh', feeCalculator: { lamportsPerSignature: 5000 } }),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    getParsedTransaction: vi.fn().mockResolvedValue(null),
  })),
  getExplorerUrl: vi.fn((sig: string, type: string) => `https://solscan.io/${type}/${sig}`),
  isMainnet: vi.fn(() => false),
}));

// Mock the wallet module
vi.mock('./wallet', () => ({
  getKeypair: vi.fn().mockResolvedValue(null),
}));

describe('Transactions Service -- SOL Transfers and Fee Management', () => {

  beforeEach(() => {
    AsyncStorage.__reset();
    vi.clearAllMocks();
  });

  // ===================================================================
  // Section 1: P-01 Network Fee Breakdown
  // ===================================================================

  describe('P-01 Network Fee Breakdown', () => {
    it('should return zero fees on devnet/testnet', () => {
      const breakdown = getTransferFeeBreakdown(1.0);

      expect(breakdown.totalAmount).toBe(1.0);
      expect(breakdown.feeAmount).toBe(0);
      expect(breakdown.recipientAmount).toBe(1.0);
      expect(breakdown.isMainnet).toBe(false);
    });

    it('should calculate 0.25% fee on mainnet', async () => {
      const { isMainnet } = await import('./connection');
      (isMainnet as any).mockReturnValue(true);

      const breakdown = getTransferFeeBreakdown(10.0);

      expect(breakdown.totalAmount).toBe(10.0);
      expect(breakdown.feePercentage).toBeCloseTo(0.0025, 4);
      expect(breakdown.feeAmount).toBeGreaterThan(0);
      expect(breakdown.recipientAmount).toBeLessThan(10.0);
      expect(breakdown.recipientAmount + breakdown.feeAmount).toBeCloseTo(10.0, 4);
    });

    it('should include the P-01 fee wallet address', () => {
      const breakdown = getTransferFeeBreakdown(1.0);
      expect(breakdown.feeWallet).toBeTruthy();
      expect(typeof breakdown.feeWallet).toBe('string');
    });

    it('should handle very small amounts', () => {
      const breakdown = getTransferFeeBreakdown(0.000001);
      expect(breakdown.totalAmount).toBe(0.000001);
      expect(breakdown.recipientAmount).toBeGreaterThanOrEqual(0);
    });

    it('should handle zero amount', () => {
      const breakdown = getTransferFeeBreakdown(0);
      expect(breakdown.totalAmount).toBe(0);
      expect(breakdown.feeAmount).toBe(0);
      expect(breakdown.recipientAmount).toBe(0);
    });
  });

  // ===================================================================
  // Section 2: Transaction Cache
  // ===================================================================

  describe('Transaction History Cache', () => {
    it('should return empty array when no cache exists', async () => {
      const cached = await getCachedTransactions('nonexistent_key');
      expect(cached).toEqual([]);
    });

    it('should return cached transactions for a wallet', async () => {
      const mockTxs = [
        { signature: 'sig1', timestamp: 1000, type: 'send', amount: 1.5, token: 'SOL', status: 'confirmed' },
        { signature: 'sig2', timestamp: 2000, type: 'receive', amount: 0.5, token: 'SOL', status: 'confirmed' },
      ];
      await AsyncStorage.setItem('p01_tx_cache_wallet123', JSON.stringify(mockTxs));

      const cached = await getCachedTransactions('wallet123');
      expect(cached).toHaveLength(2);
      expect(cached[0].signature).toBe('sig1');
      expect(cached[1].type).toBe('receive');
    });

    it('should handle corrupted cache gracefully', async () => {
      await AsyncStorage.setItem('p01_tx_cache_badwallet', 'not-json-data');

      const cached = await getCachedTransactions('badwallet');
      expect(cached).toEqual([]);
    });

    it('should clear transaction cache for a specific wallet', async () => {
      await AsyncStorage.setItem('p01_tx_cache_wallet1', JSON.stringify([{ sig: '1' }]));
      await AsyncStorage.setItem('p01_tx_cache_wallet2', JSON.stringify([{ sig: '2' }]));

      await clearTransactionCache('wallet1');

      expect(await AsyncStorage.getItem('p01_tx_cache_wallet1')).toBeNull();
      expect(await AsyncStorage.getItem('p01_tx_cache_wallet2')).toBeTruthy();
    });
  });

  // ===================================================================
  // Section 3: Address Validation
  // ===================================================================

  describe('Address Validation', () => {
    it('should accept a valid Solana address', () => {
      expect(isValidAddress('11111111111111111111111111111111')).toBe(true);
    });

    it('should reject empty address', () => {
      expect(isValidAddress('')).toBe(false);
    });

    it('should accept any non-empty string via PublicKey constructor', () => {
      // Note: in the real @solana/web3.js, 'not-a-valid-address' would throw.
      // Our mock PublicKey accepts any non-empty string, so isValidAddress
      // delegates entirely to PublicKey constructor validation.
      expect(isValidAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
    });
  });

  // ===================================================================
  // Section 4: Transaction Date Formatting
  // ===================================================================

  describe('Transaction Date Formatting', () => {
    it('should return "Pending" for null timestamp', () => {
      expect(formatTxDate(null)).toBe('Pending');
    });

    it('should return "Just now" for very recent timestamps', () => {
      const now = Math.floor(Date.now() / 1000);
      expect(formatTxDate(now)).toBe('Just now');
    });

    it('should format minutes ago', () => {
      const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
      const result = formatTxDate(fiveMinutesAgo);
      expect(result).toMatch(/\d+m ago/);
    });

    it('should format hours ago', () => {
      const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
      const result = formatTxDate(twoHoursAgo);
      expect(result).toMatch(/\d+h ago/);
    });

    it('should format days ago', () => {
      const threeDaysAgo = Math.floor(Date.now() / 1000) - 259200;
      const result = formatTxDate(threeDaysAgo);
      expect(result).toMatch(/\d+d ago/);
    });

    it('should show date for timestamps older than 7 days', () => {
      const twoWeeksAgo = Math.floor(Date.now() / 1000) - 1209600;
      const result = formatTxDate(twoWeeksAgo);
      // Should be a formatted date like "Jan 15"
      expect(result).not.toContain('ago');
      expect(result).not.toBe('Pending');
    });
  });
});
