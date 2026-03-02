/**
 * Privacy feature toggles for the extension.
 * Stored in chrome.storage.local, loaded on init.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'p01-privacy-toggles';

interface SettingsState {
  shieldedWalletEnabled: boolean;
  confidentialBalanceEnabled: boolean;
  initialized: boolean;

  initialize: () => Promise<void>;
  setShieldedWalletEnabled: (enabled: boolean) => Promise<void>;
  setConfidentialBalanceEnabled: (enabled: boolean) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  shieldedWalletEnabled: false,
  confidentialBalanceEnabled: false,
  initialized: false,

  initialize: async () => {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        const data = JSON.parse(result[STORAGE_KEY]);
        set({
          shieldedWalletEnabled: data.shieldedWalletEnabled ?? false,
          confidentialBalanceEnabled: data.confidentialBalanceEnabled ?? false,
          initialized: true,
        });
      } else {
        set({ initialized: true });
      }
    } catch {
      set({ initialized: true });
    }
  },

  setShieldedWalletEnabled: async (enabled) => {
    set({ shieldedWalletEnabled: enabled });
    const { confidentialBalanceEnabled } = get();
    await chrome.storage.local.set({
      [STORAGE_KEY]: JSON.stringify({ shieldedWalletEnabled: enabled, confidentialBalanceEnabled }),
    });
  },

  setConfidentialBalanceEnabled: async (enabled) => {
    set({ confidentialBalanceEnabled: enabled });
    const { shieldedWalletEnabled } = get();
    await chrome.storage.local.set({
      [STORAGE_KEY]: JSON.stringify({ shieldedWalletEnabled, confidentialBalanceEnabled: enabled }),
    });
  },
}));
