/**
 * Privacy feature toggles for the extension.
 * Stored in chrome.storage.local, loaded on init.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'p01-privacy-toggles';

interface SettingsState {
  shieldedWalletEnabled: boolean;
  confidentialBalanceEnabled: boolean;
  /** Route V3 unshield/transfer through the p01_relayer (hides submission IP +
   * outer fee-payer). Falls back to direct on any relayer error. Default ON. */
  relayerEnabled: boolean;
  initialized: boolean;

  initialize: () => Promise<void>;
  setShieldedWalletEnabled: (enabled: boolean) => Promise<void>;
  setConfidentialBalanceEnabled: (enabled: boolean) => Promise<void>;
  setRelayerEnabled: (enabled: boolean) => Promise<void>;
}

async function persist(state: Pick<SettingsState, 'shieldedWalletEnabled' | 'confidentialBalanceEnabled' | 'relayerEnabled'>) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: JSON.stringify({
      shieldedWalletEnabled: state.shieldedWalletEnabled,
      confidentialBalanceEnabled: state.confidentialBalanceEnabled,
      relayerEnabled: state.relayerEnabled,
    }),
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  shieldedWalletEnabled: false,
  confidentialBalanceEnabled: false,
  relayerEnabled: true,
  initialized: false,

  initialize: async () => {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        const data = JSON.parse(result[STORAGE_KEY]);
        set({
          shieldedWalletEnabled: data.shieldedWalletEnabled ?? false,
          confidentialBalanceEnabled: data.confidentialBalanceEnabled ?? false,
          relayerEnabled: data.relayerEnabled ?? true,
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
    await persist(get());
  },

  setConfidentialBalanceEnabled: async (enabled) => {
    set({ confidentialBalanceEnabled: enabled });
    await persist(get());
  },

  setRelayerEnabled: async (enabled) => {
    set({ relayerEnabled: enabled });
    await persist(get());
  },
}));
