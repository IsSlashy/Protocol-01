/**
 * Transaction Privacy Store Test Suite
 *
 * Validates the Specter Protocol privacy settings management including
 * privacy levels (standard, enhanced, maximum), decoy transaction
 * configuration, and fee estimation for private transfers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '../test/__mocks__/async-storage';

// Mock the decoy transactions module (matching real PRIVACY_LEVELS from source)
vi.mock('../services/solana/decoyTransactions', () => ({
  PRIVACY_LEVELS: {
    standard: { name: 'Standard', decoyCount: 1, minDelay: 500, maxDelay: 1500, amountNoisePercent: 10, useSelfTransfers: true, useTimingObfuscation: false },
    enhanced: { name: 'Enhanced', decoyCount: 5, minDelay: 1000, maxDelay: 3000, amountNoisePercent: 20, useSelfTransfers: true, useTimingObfuscation: true },
    maximum: { name: 'Maximum', decoyCount: 10, minDelay: 2000, maxDelay: 5000, amountNoisePercent: 30, useSelfTransfers: true, useTimingObfuscation: true },
  },
  calculateDecoyFees: vi.fn((level: string, _amount: number) => {
    const counts: Record<string, number> = { standard: 1, enhanced: 5, maximum: 10 };
    const count = counts[level] || 0;
    const perTxFee = 0.000005;
    return { totalFees: count * perTxFee, perTxFee, decoyCount: count };
  }),
  getPrivacyLevelDescription: vi.fn((level: string) => {
    const descs: Record<string, string> = {
      standard: 'Standard privacy - 1 decoy transaction',
      enhanced: 'Enhanced privacy - 5 decoy transactions',
      maximum: 'Maximum privacy - 10 decoy transactions',
    };
    return descs[level] || 'Unknown';
  }),
}));

const {
  useTransactionPrivacyStore,
  selectPrivacyLevel,
  selectIsPrivateTransaction,
  selectDecoyCount,
} = await import('./transactionPrivacyStore');

describe('Transaction Privacy Store -- Specter Protocol Settings', () => {
  beforeEach(() => {
    useTransactionPrivacyStore.setState({
      privacyLevel: 'enhanced',
      privateByDefault: true,
      showFeeWarning: true,
      isPrivateTransaction: false,
      currentProgress: null,
      initialized: false,
    });
    AsyncStorage.__reset();
    vi.clearAllMocks();
  });

  // ===================================================================
  // Section 1: Default Privacy Configuration
  // ===================================================================

  describe('Default Privacy Configuration', () => {
    it('should default to enhanced privacy level', () => {
      expect(useTransactionPrivacyStore.getState().privacyLevel).toBe('enhanced');
    });

    it('should default to private-by-default mode', () => {
      expect(useTransactionPrivacyStore.getState().privateByDefault).toBe(true);
    });

    it('should show fee warnings by default', () => {
      expect(useTransactionPrivacyStore.getState().showFeeWarning).toBe(true);
    });

    it('should not have an active private transaction by default', () => {
      expect(useTransactionPrivacyStore.getState().isPrivateTransaction).toBe(false);
    });
  });

  // ===================================================================
  // Section 2: Privacy Level Management
  // ===================================================================

  describe('Privacy Level Management', () => {
    it('should persist privacy level to AsyncStorage', async () => {
      await useTransactionPrivacyStore.getState().setPrivacyLevel('maximum');

      expect(useTransactionPrivacyStore.getState().privacyLevel).toBe('maximum');
      const stored = await AsyncStorage.getItem('settings_privacy_level');
      expect(stored).toBe('maximum');
    });

    it('should update from enhanced to standard', async () => {
      await useTransactionPrivacyStore.getState().setPrivacyLevel('standard');
      expect(useTransactionPrivacyStore.getState().privacyLevel).toBe('standard');
    });

    it('should return correct decoy count for each privacy level', () => {
      useTransactionPrivacyStore.setState({ privacyLevel: 'standard' });
      expect(useTransactionPrivacyStore.getState().getDecoyCount()).toBe(1);

      useTransactionPrivacyStore.setState({ privacyLevel: 'enhanced' });
      expect(useTransactionPrivacyStore.getState().getDecoyCount()).toBe(5);

      useTransactionPrivacyStore.setState({ privacyLevel: 'maximum' });
      expect(useTransactionPrivacyStore.getState().getDecoyCount()).toBe(10);
    });
  });

  // ===================================================================
  // Section 3: Fee Estimation
  // ===================================================================

  describe('Fee Estimation for Private Transactions', () => {
    it('should include decoy fees at standard privacy level (1 decoy)', () => {
      useTransactionPrivacyStore.setState({ privacyLevel: 'standard' });
      const fees = useTransactionPrivacyStore.getState().getEstimatedFees(1.0);

      expect(fees.decoyFees).toBeGreaterThan(0);
      expect(fees.networkFee).toBeGreaterThan(0);
    });

    it('should include decoy fees at enhanced privacy level', () => {
      useTransactionPrivacyStore.setState({ privacyLevel: 'enhanced' });
      const fees = useTransactionPrivacyStore.getState().getEstimatedFees(1.0);

      expect(fees.decoyFees).toBeGreaterThan(0);
      expect(fees.totalFees).toBeGreaterThan(fees.networkFee);
    });

    it('should estimate higher fees at maximum privacy than enhanced', () => {
      useTransactionPrivacyStore.setState({ privacyLevel: 'enhanced' });
      const enhancedFees = useTransactionPrivacyStore.getState().getEstimatedFees(10);

      useTransactionPrivacyStore.setState({ privacyLevel: 'maximum' });
      const maximumFees = useTransactionPrivacyStore.getState().getEstimatedFees(10);

      expect(maximumFees.decoyFees).toBeGreaterThan(enhancedFees.decoyFees);
    });
  });

  // ===================================================================
  // Section 4: Initialization from Saved Preferences
  // ===================================================================

  describe('Initialization from Saved Preferences', () => {
    it('should load saved privacy level from storage', async () => {
      await AsyncStorage.setItem('settings_privacy_level', 'maximum');
      await AsyncStorage.setItem('settings_private_default', 'false');
      await AsyncStorage.setItem('settings_show_decoy_fee_warning', 'false');

      await useTransactionPrivacyStore.getState().initialize();

      const state = useTransactionPrivacyStore.getState();
      expect(state.privacyLevel).toBe('maximum');
      expect(state.privateByDefault).toBe(false);
      expect(state.showFeeWarning).toBe(false);
      expect(state.initialized).toBe(true);
    });

    it('should fallback to defaults when no stored preferences exist', async () => {
      await useTransactionPrivacyStore.getState().initialize();

      const state = useTransactionPrivacyStore.getState();
      expect(state.privacyLevel).toBe('enhanced');
      expect(state.privateByDefault).toBe(true);
      expect(state.showFeeWarning).toBe(true);
    });
  });

  // ===================================================================
  // Section 5: Transaction State Management
  // ===================================================================

  describe('Transaction State Management', () => {
    it('should toggle private transaction mode', () => {
      useTransactionPrivacyStore.getState().setIsPrivateTransaction(true);
      expect(useTransactionPrivacyStore.getState().isPrivateTransaction).toBe(true);

      useTransactionPrivacyStore.getState().setIsPrivateTransaction(false);
      expect(useTransactionPrivacyStore.getState().isPrivateTransaction).toBe(false);
    });

    it('should update decoy progress during a private transaction', () => {
      const progress = { stage: 'generating', current: 2, total: 5 };
      useTransactionPrivacyStore.getState().setCurrentProgress(progress as any);
      expect(useTransactionPrivacyStore.getState().currentProgress).toEqual(progress);
    });

    it('should clear progress when set to null', () => {
      useTransactionPrivacyStore.getState().setCurrentProgress({ stage: 'done' } as any);
      useTransactionPrivacyStore.getState().setCurrentProgress(null);
      expect(useTransactionPrivacyStore.getState().currentProgress).toBeNull();
    });
  });

  // ===================================================================
  // Section 6: Privacy Description
  // ===================================================================

  describe('Privacy Level Description', () => {
    it('should return a human-readable description', () => {
      useTransactionPrivacyStore.setState({ privacyLevel: 'enhanced' });
      const desc = useTransactionPrivacyStore.getState().getPrivacyDescription();
      expect(desc).toContain('Enhanced');
    });
  });

  // ===================================================================
  // Section 7: Selectors
  // ===================================================================

  describe('Selectors', () => {
    it('selectPrivacyLevel should return the current privacy level', () => {
      const state = useTransactionPrivacyStore.getState();
      expect(selectPrivacyLevel(state)).toBe('enhanced');
    });

    it('selectIsPrivateTransaction should return the current private tx state', () => {
      useTransactionPrivacyStore.setState({ isPrivateTransaction: true });
      expect(selectIsPrivateTransaction(useTransactionPrivacyStore.getState())).toBe(true);
    });

    it('selectDecoyCount should return count based on privacy level', () => {
      useTransactionPrivacyStore.setState({ privacyLevel: 'maximum' });
      expect(selectDecoyCount(useTransactionPrivacyStore.getState())).toBe(10);
    });
  });
});
