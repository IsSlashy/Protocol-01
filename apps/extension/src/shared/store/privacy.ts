/**
 * Privacy Zone Store
 *
 * Manages privacy zone configuration and statistics
 * Persisted to chrome.storage
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import {
  PrivacyZoneConfig,
  NoiseLevel,
  TransactionWithPrivacy,
  setPrivacyZone as setPrivacyZoneConfig,
  getBatchStatus,
  executeBatch,
  clearBatch,
  applyPrivacy,
  discoverNearbyUsers,
  NearbyUser,
  MixingPool,
  getAvailableMixingPools,
} from '../services/privacyZone';

// ============ Types ============

export interface PrivacyStats {
  totalProtectedTransactions: number;
  totalDecoysGenerated: number;
  totalMixedTransactions: number;
  totalBatchedTransactions: number;
  averagePrivacyScore: number;
  lastUpdated: number;
}

export interface PrivacyHistoryEntry {
  id: string;
  timestamp: number;
  type: 'send' | 'receive';
  amount: number;
  recipient?: string;
  privacyScore: number;
  techniques: string[];
  mixingPoolId?: string;
  batchId?: string;
}

export interface PrivacyState {
  // Configuration (synced with service)
  config: PrivacyZoneConfig;

  // Statistics
  stats: PrivacyStats;

  // Transaction history with privacy info
  history: PrivacyHistoryEntry[];

  // Wallet-level privacy score
  walletPrivacyScore: number;

  // Nearby users (simulated, for future Bluetooth)
  nearbyUsers: NearbyUser[];

  // Available mixing pools
  mixingPools: MixingPool[];

  // Batch status
  pendingBatchCount: number;

  // UI state
  isLoading: boolean;
  error: string | null;

  // Actions
  setEnabled: (enabled: boolean) => void;
  setNoiseLevel: (level: NoiseLevel) => void;
  setBatchingEnabled: (enabled: boolean) => void;
  setDecoyEnabled: (enabled: boolean) => void;
  setMixingEnabled: (enabled: boolean) => void;
  setAutoPrivacy: (enabled: boolean) => void;
  updateConfig: (config: Partial<PrivacyZoneConfig>) => void;

  // Privacy operations
  protectTransaction: (
    recipient: string,
    amount: number,
    highPrivacy?: boolean
  ) => TransactionWithPrivacy;
  executePendingBatch: () => Promise<string[]>;
  clearPendingBatch: () => void;

  // Data management
  addToHistory: (entry: Omit<PrivacyHistoryEntry, 'id' | 'timestamp'>) => void;
  refreshStats: () => void;
  refreshNearbyUsers: () => void;
  refreshMixingPools: () => void;
  clearHistory: () => void;
  clearError: () => void;
}

// ============ Initial State ============

const initialConfig: PrivacyZoneConfig = {
  enabled: false,
  noiseLevel: 'medium',
  batchingEnabled: true,
  decoyEnabled: true,
  mixingEnabled: true,
  autoPrivacy: false,
  minBatchSize: 3,
  maxBatchDelay: 60,
};

const initialStats: PrivacyStats = {
  totalProtectedTransactions: 0,
  totalDecoysGenerated: 0,
  totalMixedTransactions: 0,
  totalBatchedTransactions: 0,
  averagePrivacyScore: 0,
  lastUpdated: Date.now(),
};

// ============ Store ============

export const usePrivacyStore = create<PrivacyState>()(
  persist(
    (set, get) => ({
      // Initial state
      config: initialConfig,
      stats: initialStats,
      history: [],
      walletPrivacyScore: 50,
      nearbyUsers: [],
      mixingPools: [],
      pendingBatchCount: 0,
      isLoading: false,
      error: null,

      // Configuration actions
      setEnabled: (enabled: boolean) => {
        const newConfig = setPrivacyZoneConfig({ enabled });
        set({ config: newConfig });
        get().refreshStats();
      },

      setNoiseLevel: (noiseLevel: NoiseLevel) => {
        const newConfig = setPrivacyZoneConfig({ noiseLevel });
        set({ config: newConfig });
      },

      setBatchingEnabled: (batchingEnabled: boolean) => {
        const newConfig = setPrivacyZoneConfig({ batchingEnabled });
        set({ config: newConfig });
      },

      setDecoyEnabled: (decoyEnabled: boolean) => {
        const newConfig = setPrivacyZoneConfig({ decoyEnabled });
        set({ config: newConfig });
      },

      setMixingEnabled: (mixingEnabled: boolean) => {
        const newConfig = setPrivacyZoneConfig({ mixingEnabled });
        set({ config: newConfig });
      },

      setAutoPrivacy: (autoPrivacy: boolean) => {
        const newConfig = setPrivacyZoneConfig({ autoPrivacy });
        set({ config: newConfig });
      },

      updateConfig: (configUpdate: Partial<PrivacyZoneConfig>) => {
        const newConfig = setPrivacyZoneConfig(configUpdate);
        set({ config: newConfig });
      },

      // Privacy operations
      protectTransaction: (
        recipient: string,
        amount: number,
        highPrivacy: boolean = false
      ): TransactionWithPrivacy => {
        const result = applyPrivacy(recipient, amount, { highPrivacy });

        // Update batch count
        const batchStatus = getBatchStatus();
        set({ pendingBatchCount: batchStatus.pendingCount });

        // Add to history
        get().addToHistory({
          type: 'send',
          amount,
          recipient,
          privacyScore: result.privacyScore,
          techniques: result.appliedTechniques,
          mixingPoolId: result.mixingPoolId,
          batchId: result.batchId,
        });

        // Update stats
        const stats = get().stats;
        set({
          stats: {
            ...stats,
            totalProtectedTransactions: stats.totalProtectedTransactions + 1,
            totalDecoysGenerated: stats.totalDecoysGenerated + result.decoys.length,
            totalMixedTransactions: result.mixingPoolId
              ? stats.totalMixedTransactions + 1
              : stats.totalMixedTransactions,
            totalBatchedTransactions: result.batchId
              ? stats.totalBatchedTransactions + 1
              : stats.totalBatchedTransactions,
            lastUpdated: Date.now(),
          },
        });

        get().refreshStats();

        return result;
      },

      executePendingBatch: async (): Promise<string[]> => {
        set({ isLoading: true, error: null });
        try {
          const signatures = await executeBatch();
          set({
            pendingBatchCount: 0,
            isLoading: false,
          });
          return signatures;
        } catch (error) {
          set({
            isLoading: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      clearPendingBatch: () => {
        clearBatch();
        set({ pendingBatchCount: 0 });
      },

      // Data management
      addToHistory: (entry) => {
        const newEntry: PrivacyHistoryEntry = {
          ...entry,
          id: `ph-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: Date.now(),
        };

        set((state) => ({
          history: [newEntry, ...state.history].slice(0, 100), // Keep last 100
        }));
      },

      refreshStats: () => {
        const { history, config } = get();

        // Calculate average privacy score from history
        const scores = history
          .filter((h) => h.timestamp > Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
          .map((h) => h.privacyScore);

        const avgScore =
          scores.length > 0
            ? scores.reduce((a, b) => a + b, 0) / scores.length
            : config.enabled
            ? 50
            : 20;

        // Calculate wallet privacy score
        const walletScore = config.enabled
          ? Math.round(avgScore * 0.8 + 20) // Bonus for having privacy enabled
          : Math.round(avgScore * 0.5);

        set((state) => ({
          stats: {
            ...state.stats,
            averagePrivacyScore: Math.round(avgScore),
            lastUpdated: Date.now(),
          },
          walletPrivacyScore: Math.min(100, walletScore),
        }));
      },

      refreshNearbyUsers: () => {
        const nearbyUsers = discoverNearbyUsers();
        set({ nearbyUsers });
      },

      refreshMixingPools: () => {
        const mixingPools = getAvailableMixingPools();
        set({ mixingPools });
      },

      clearHistory: () => {
        set({
          history: [],
          stats: initialStats,
          walletPrivacyScore: get().config.enabled ? 50 : 20,
        });
      },

      clearError: () => {
        set({ error: null });
      },
    }),
    {
      name: 'p01-privacy',
      storage: createJSONStorage(() => chromeStorage),
      partialize: (state) => ({
        config: state.config,
        stats: state.stats,
        history: state.history,
      }),
      onRehydrateStorage: () => (state) => {
        // Sync service state with persisted config
        if (state?.config) {
          setPrivacyZoneConfig(state.config);
        }
      },
    }
  )
);

// ============ Selectors ============

/**
 * Get privacy zone status for quick display
 */
export const selectPrivacyStatus = (state: PrivacyState) => ({
  isActive: state.config.enabled,
  noiseLevel: state.config.noiseLevel,
  walletScore: state.walletPrivacyScore,
  pendingBatch: state.pendingBatchCount,
});

/**
 * Get privacy features summary
 */
export const selectPrivacyFeatures = (state: PrivacyState) => {
  const features: string[] = [];

  if (state.config.batchingEnabled) features.push('Batching');
  if (state.config.decoyEnabled) features.push('Decoys');
  if (state.config.mixingEnabled) features.push('Mixing');
  if (state.config.autoPrivacy) features.push('Auto');

  return features;
};

/**
 * Get privacy score color based on value
 */
export function getPrivacyScoreColor(score: number): string {
  if (score >= 80) return 'text-green-400';
  if (score >= 60) return 'text-p01-cyan';
  if (score >= 40) return 'text-yellow-400';
  if (score >= 20) return 'text-orange-400';
  return 'text-red-400';
}

/**
 * Get privacy score label
 */
export function getPrivacyScoreLabel(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Fair';
  if (score >= 20) return 'Low';
  return 'Minimal';
}

/**
 * Get noise level description
 */
export function getNoiseLevelDescription(level: NoiseLevel): string {
  switch (level) {
    case 'low':
      return 'Basic privacy with minimal delays';
    case 'medium':
      return 'Balanced privacy and speed';
    case 'high':
      return 'Maximum privacy with longer delays';
  }
}

export default usePrivacyStore;
