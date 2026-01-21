/**
 * Transaction Privacy Store for Specter Protocol
 *
 * Manages privacy settings for transactions including:
 * - Default privacy level (standard, enhanced, maximum)
 * - Decoy transaction preferences
 * - Fee estimates and warnings
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PrivacyLevel,
  PRIVACY_LEVELS,
  DecoyProgress,
  calculateDecoyFees,
  getPrivacyLevelDescription,
} from '../services/solana/decoyTransactions';

// Storage keys
const STORAGE_KEYS = {
  PRIVACY_LEVEL: 'settings_privacy_level',
  PRIVATE_DEFAULT: 'settings_private_default',
  SHOW_FEE_WARNING: 'settings_show_decoy_fee_warning',
};

export interface TransactionPrivacyState {
  // Settings
  privacyLevel: PrivacyLevel;
  privateByDefault: boolean;
  showFeeWarning: boolean;

  // Current transaction state
  isPrivateTransaction: boolean;
  currentProgress: DecoyProgress | null;

  // Initialization
  initialized: boolean;

  // Actions
  initialize: () => Promise<void>;
  setPrivacyLevel: (level: PrivacyLevel) => Promise<void>;
  setPrivateByDefault: (value: boolean) => Promise<void>;
  setShowFeeWarning: (value: boolean) => Promise<void>;
  setCurrentProgress: (progress: DecoyProgress | null) => void;
  setIsPrivateTransaction: (value: boolean) => void;

  // Helpers
  getDecoyCount: () => number;
  getEstimatedFees: (amount: number) => { totalFees: number; decoyFees: number; networkFee: number };
  getPrivacyDescription: () => string;
}

export const useTransactionPrivacyStore = create<TransactionPrivacyState>((set, get) => ({
  // Default values
  privacyLevel: 'enhanced',
  privateByDefault: true,
  showFeeWarning: true,
  isPrivateTransaction: false,
  currentProgress: null,
  initialized: false,

  // Initialize from storage
  initialize: async () => {
    try {
      const [level, privateDefault, showWarning] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.PRIVACY_LEVEL),
        AsyncStorage.getItem(STORAGE_KEYS.PRIVATE_DEFAULT),
        AsyncStorage.getItem(STORAGE_KEYS.SHOW_FEE_WARNING),
      ]);

      set({
        privacyLevel: (level as PrivacyLevel) || 'enhanced',
        privateByDefault: privateDefault !== 'false', // Default to true
        showFeeWarning: showWarning !== 'false', // Default to true
        initialized: true,
      });
    } catch (error) {
      console.error('Failed to load transaction privacy settings:', error);
      set({ initialized: true });
    }
  },

  // Set privacy level
  setPrivacyLevel: async (level: PrivacyLevel) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.PRIVACY_LEVEL, level);
      set({ privacyLevel: level });
    } catch (error) {
      console.error('Failed to save privacy level:', error);
    }
  },

  // Set private by default
  setPrivateByDefault: async (value: boolean) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.PRIVATE_DEFAULT, value.toString());
      set({ privateByDefault: value });
    } catch (error) {
      console.error('Failed to save private default setting:', error);
    }
  },

  // Set fee warning preference
  setShowFeeWarning: async (value: boolean) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.SHOW_FEE_WARNING, value.toString());
      set({ showFeeWarning: value });
    } catch (error) {
      console.error('Failed to save fee warning setting:', error);
    }
  },

  // Set current progress
  setCurrentProgress: (progress: DecoyProgress | null) => {
    set({ currentProgress: progress });
  },

  // Set is private transaction
  setIsPrivateTransaction: (value: boolean) => {
    set({ isPrivateTransaction: value });
  },

  // Get decoy count for current privacy level
  getDecoyCount: () => {
    const { privacyLevel } = get();
    return PRIVACY_LEVELS[privacyLevel].decoyCount;
  },

  // Get estimated fees for current privacy level
  getEstimatedFees: (amount: number) => {
    const { privacyLevel } = get();
    const { totalFees, perTxFee, decoyCount } = calculateDecoyFees(privacyLevel, amount);
    return {
      totalFees: totalFees + perTxFee, // Include real tx fee
      decoyFees: totalFees,
      networkFee: perTxFee,
    };
  },

  // Get human-readable privacy description
  getPrivacyDescription: () => {
    const { privacyLevel } = get();
    return getPrivacyLevelDescription(privacyLevel);
  },
}));

// Selectors for common use cases
export const selectPrivacyLevel = (state: TransactionPrivacyState) => state.privacyLevel;
export const selectIsPrivateTransaction = (state: TransactionPrivacyState) => state.isPrivateTransaction;
export const selectCurrentProgress = (state: TransactionPrivacyState) => state.currentProgress;
export const selectDecoyCount = (state: TransactionPrivacyState) =>
  PRIVACY_LEVELS[state.privacyLevel].decoyCount;

export default useTransactionPrivacyStore;
