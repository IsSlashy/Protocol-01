import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ArciumStatus } from '../services/arcium';

const STORAGE_KEY = 'p01_arcium_mpc_enabled';

interface ArciumState {
  /** User opted in to MPC-enhanced privacy */
  mpcEnabled: boolean;
  /** Current MPC subsystem status */
  status: ArciumStatus;
  /** Last error message (if status === 'error') */
  lastError: string | null;
  /** Whether the on-chain program was found */
  programAvailable: boolean;

  // Actions
  initialize: () => Promise<void>;
  setMpcEnabled: (enabled: boolean) => Promise<void>;
  setStatus: (status: ArciumStatus, error?: string) => void;
  setProgramAvailable: (available: boolean) => void;
}

export const useArciumStore = create<ArciumState>((set, get) => ({
  mpcEnabled: true,
  status: 'idle',
  lastError: null,
  programAvailable: false,

  initialize: async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      // MPC is enabled by default — only disable if user explicitly opted out
      if (stored === 'false') {
        set({ mpcEnabled: false });
      }
    } catch {
      // Silently continue — MPC stays enabled by default
    }
  },

  setMpcEnabled: async (enabled: boolean) => {
    set({ mpcEnabled: enabled, status: enabled ? 'idle' : 'disabled' });
    try {
      await AsyncStorage.setItem(STORAGE_KEY, enabled.toString());
    } catch {
      // Non-critical
    }
  },

  setStatus: (status: ArciumStatus, error?: string) => {
    set({ status, lastError: error ?? null });
  },

  setProgramAvailable: (available: boolean) => {
    set({ programAvailable: available });
  },
}));
