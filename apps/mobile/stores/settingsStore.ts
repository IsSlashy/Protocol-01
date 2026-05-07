import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Currency = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'JPY' | 'CHF';

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'C$',
  AUD: 'A$',
  JPY: '¥',
  CHF: 'CHF',
};

export const CURRENCY_RATES: Record<Currency, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  CAD: 1.36,
  AUD: 1.53,
  JPY: 148.5,
  CHF: 0.88,
};

interface SettingsState {
  currency: Currency;
  initialized: boolean;

  // Privacy feature toggles (off by default — legacy features)
  shieldedWalletEnabled: boolean;
  confidentialBalanceEnabled: boolean;

  // Phase A — route V3 shield/unshield/transfer through p01_relayer
  // (hides RPC IP + outer fee_payer). Default ON; off only for debugging.
  relayerV3Enabled: boolean;

  // When `true` (default), if the relayer fails (timeout, no active relayers,
  // oversized inner tx, etc.) the transaction fails LOUDLY instead of silently
  // falling back to direct RPC submission (which would leak L19 — user IP).
  // Privacy-conscious users want fail-closed; users prioritising availability
  // over privacy can toggle this off.
  relayerStrictMode: boolean;

  // Actions
  initialize: () => Promise<void>;
  setCurrency: (currency: Currency) => Promise<void>;
  setShieldedWalletEnabled: (enabled: boolean) => Promise<void>;
  setConfidentialBalanceEnabled: (enabled: boolean) => Promise<void>;
  setRelayerV3Enabled: (enabled: boolean) => Promise<void>;
  setRelayerStrictMode: (enabled: boolean) => Promise<void>;

  // Helpers
  formatAmount: (usdAmount: number) => string;
  getCurrencySymbol: () => string;
}

const STORAGE_KEY = 'p01_settings_currency';
const PRIVACY_TOGGLES_KEY = 'p01_privacy_toggles';

export const useSettingsStore = create<SettingsState>((set, get) => ({
  currency: 'USD',
  initialized: false,
  shieldedWalletEnabled: false,
  confidentialBalanceEnabled: false,
  relayerV3Enabled: true,
  relayerStrictMode: true,

  initialize: async () => {
    try {
      const [stored, togglesRaw] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY),
        AsyncStorage.getItem(PRIVACY_TOGGLES_KEY),
      ]);
      const updates: Partial<SettingsState> = { initialized: true };
      if (stored && Object.keys(CURRENCY_SYMBOLS).includes(stored)) {
        updates.currency = stored as Currency;
      }
      if (togglesRaw) {
        try {
          const toggles = JSON.parse(togglesRaw);
          updates.shieldedWalletEnabled = toggles.shieldedWalletEnabled ?? false;
          updates.confidentialBalanceEnabled = toggles.confidentialBalanceEnabled ?? false;
          updates.relayerV3Enabled = toggles.relayerV3Enabled ?? true;
          updates.relayerStrictMode = toggles.relayerStrictMode ?? true;
        } catch {}
      }
      set(updates);
    } catch (error) {
      console.error('Failed to load settings:', error);
      set({ initialized: true });
    }
  },

  setCurrency: async (currency: Currency) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, currency);
      set({ currency });
    } catch (error) {
      console.error('Failed to save currency setting:', error);
    }
  },

  setShieldedWalletEnabled: async (enabled: boolean) => {
    set({ shieldedWalletEnabled: enabled });
    try {
      const raw = await AsyncStorage.getItem(PRIVACY_TOGGLES_KEY);
      const toggles = raw ? JSON.parse(raw) : {};
      toggles.shieldedWalletEnabled = enabled;
      await AsyncStorage.setItem(PRIVACY_TOGGLES_KEY, JSON.stringify(toggles));
    } catch (error) {
      console.error('Failed to save privacy toggle:', error);
    }
  },

  setConfidentialBalanceEnabled: async (enabled: boolean) => {
    set({ confidentialBalanceEnabled: enabled });
    try {
      const raw = await AsyncStorage.getItem(PRIVACY_TOGGLES_KEY);
      const toggles = raw ? JSON.parse(raw) : {};
      toggles.confidentialBalanceEnabled = enabled;
      await AsyncStorage.setItem(PRIVACY_TOGGLES_KEY, JSON.stringify(toggles));
    } catch (error) {
      console.error('Failed to save privacy toggle:', error);
    }
  },

  setRelayerV3Enabled: async (enabled: boolean) => {
    set({ relayerV3Enabled: enabled });
    try {
      const raw = await AsyncStorage.getItem(PRIVACY_TOGGLES_KEY);
      const toggles = raw ? JSON.parse(raw) : {};
      toggles.relayerV3Enabled = enabled;
      await AsyncStorage.setItem(PRIVACY_TOGGLES_KEY, JSON.stringify(toggles));
    } catch (error) {
      console.error('Failed to save privacy toggle:', error);
    }
  },

  setRelayerStrictMode: async (enabled: boolean) => {
    set({ relayerStrictMode: enabled });
    try {
      const raw = await AsyncStorage.getItem(PRIVACY_TOGGLES_KEY);
      const toggles = raw ? JSON.parse(raw) : {};
      toggles.relayerStrictMode = enabled;
      await AsyncStorage.setItem(PRIVACY_TOGGLES_KEY, JSON.stringify(toggles));
    } catch (error) {
      console.error('Failed to save privacy toggle:', error);
    }
  },

  formatAmount: (usdAmount: number) => {
    const { currency } = get();
    const symbol = CURRENCY_SYMBOLS[currency];
    const rate = CURRENCY_RATES[currency];
    const converted = usdAmount * rate;

    // Format based on currency
    if (currency === 'JPY') {
      return `${symbol}${Math.round(converted).toLocaleString()}`;
    }
    return `${symbol}${converted.toFixed(2)}`;
  },

  getCurrencySymbol: () => {
    return CURRENCY_SYMBOLS[get().currency];
  },
}));
