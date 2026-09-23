/**
 * Privacy feature toggles for the extension.
 * Stored in chrome.storage.local, loaded on init.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'p01-privacy-toggles';

interface SettingsState {
  /** Route V3 unshield/transfer through the p01_relayer (hides submission IP +
   * outer fee-payer). Falls back to direct on any relayer error. Default ON. */
  relayerEnabled: boolean;
  initialized: boolean;

  initialize: () => Promise<void>;
  setRelayerEnabled: (enabled: boolean) => Promise<void>;
}

// The legacy V1 "shielded wallet" and zkSPL "confidential balance" toggles
// were removed on 2026-09-23 with the code they switched; an older profile may
// still carry those two fields in this key, and they are ignored.
async function persist(state: Pick<SettingsState, 'relayerEnabled'>) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: JSON.stringify({
      relayerEnabled: state.relayerEnabled,
    }),
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  // OFF since 2026-08-28 — both hosted p01_relayer nodes were retired (10 relay
  // jobs in 45 days, lastPollCount 0 throughout). The extension falls back to
  // direct submission on any relayer error, so leaving this on would only cost
  // a failed round-trip per withdrawal. ⚠️ Direct submission re-opens the
  // submitter-IP (L19) + outer-fee-payer (L17) leaks; the relayer path stays
  // wired, flip back to `true` once a node is registered again.
  relayerEnabled: false,
  initialized: false,

  initialize: async () => {
    // relayerEnabled is not read back from storage while no node is registered
    // on chain — every profile from before 2026-08-28 has `true` there, which
    // would buy one failed relayer round-trip per withdrawal and nothing else.
    // Read `relayerEnabled ?? false` from STORAGE_KEY again when a node comes
    // back. Nothing else in this key is live any more.
    set({ relayerEnabled: false, initialized: true });
  },

  setRelayerEnabled: async (enabled) => {
    set({ relayerEnabled: enabled });
    await persist(get());
  },
}));
