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
  // OFF since 2026-08-28 — both hosted p01_relayer nodes were retired (10 relay
  // jobs in 45 days, lastPollCount 0 throughout). The extension falls back to
  // direct submission on any relayer error, so leaving this on would only cost
  // a failed round-trip per withdrawal. ⚠️ Direct submission re-opens the
  // submitter-IP (L19) + outer-fee-payer (L17) leaks; the relayer path stays
  // wired, flip back to `true` once a node is registered again.
  relayerEnabled: false,
  initialized: false,

  initialize: async () => {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        const data = JSON.parse(result[STORAGE_KEY]);
        set({
          shieldedWalletEnabled: data.shieldedWalletEnabled ?? false,
          confidentialBalanceEnabled: data.confidentialBalanceEnabled ?? false,
          // Not read back from storage while no node is registered on chain —
          // every profile from before 2026-08-28 has `true` here, which would
          // buy one failed relayer round-trip per withdrawal and nothing else.
          // Restore `data.relayerEnabled ?? false` when a node comes back.
          relayerEnabled: false,
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
