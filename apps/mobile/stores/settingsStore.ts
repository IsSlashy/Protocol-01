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

  // Actions
  initialize: () => Promise<void>;
  setCurrency: (currency: Currency) => Promise<void>;

  // Helpers
  formatAmount: (usdAmount: number) => string;
  getCurrencySymbol: () => string;
}

const STORAGE_KEY = 'p01_settings_currency';

export const useSettingsStore = create<SettingsState>((set, get) => ({
  currency: 'USD',
  initialized: false,

  initialize: async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored && Object.keys(CURRENCY_SYMBOLS).includes(stored)) {
        set({ currency: stored as Currency, initialized: true });
      } else {
        set({ initialized: true });
      }
    } catch (error) {
      console.error('Failed to load currency setting:', error);
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
