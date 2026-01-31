/**
 * Settings Store Test Suite
 *
 * Validates currency management, locale-aware formatting, and
 * persistence of user preferences to AsyncStorage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '../test/__mocks__/async-storage';

const { useSettingsStore, CURRENCY_SYMBOLS, CURRENCY_RATES } = await import('./settingsStore');

describe('Settings Store -- Currency and Preferences', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      currency: 'USD',
      initialized: false,
    });
    AsyncStorage.__reset();
    vi.clearAllMocks();
  });

  // ===================================================================
  // Section 1: Default State
  // ===================================================================

  describe('Default State', () => {
    it('should default to USD currency', () => {
      expect(useSettingsStore.getState().currency).toBe('USD');
    });

    it('should not be initialized before calling initialize()', () => {
      expect(useSettingsStore.getState().initialized).toBe(false);
    });
  });

  // ===================================================================
  // Section 2: Initialization from Persistent Storage
  // ===================================================================

  describe('Initialization from Persistent Storage', () => {
    it('should load saved currency from AsyncStorage', async () => {
      await AsyncStorage.setItem('p01_settings_currency', 'EUR');

      await useSettingsStore.getState().initialize();

      expect(useSettingsStore.getState().currency).toBe('EUR');
      expect(useSettingsStore.getState().initialized).toBe(true);
    });

    it('should default to USD when no stored currency exists', async () => {
      await useSettingsStore.getState().initialize();

      expect(useSettingsStore.getState().currency).toBe('USD');
      expect(useSettingsStore.getState().initialized).toBe(true);
    });

    it('should default to USD when stored value is not a valid currency', async () => {
      await AsyncStorage.setItem('p01_settings_currency', 'INVALID');

      await useSettingsStore.getState().initialize();

      expect(useSettingsStore.getState().currency).toBe('USD');
    });

    it('should set initialized to true even on storage errors', async () => {
      vi.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('Storage corrupted'));

      await useSettingsStore.getState().initialize();

      expect(useSettingsStore.getState().initialized).toBe(true);
    });
  });

  // ===================================================================
  // Section 3: Currency Selection
  // ===================================================================

  describe('Currency Selection', () => {
    it('should update the currency in state and persist to AsyncStorage', async () => {
      await useSettingsStore.getState().setCurrency('GBP');

      expect(useSettingsStore.getState().currency).toBe('GBP');
      const stored = await AsyncStorage.getItem('p01_settings_currency');
      expect(stored).toBe('GBP');
    });

    it('should support all defined currencies', async () => {
      const currencies = Object.keys(CURRENCY_SYMBOLS);

      for (const currency of currencies) {
        await useSettingsStore.getState().setCurrency(currency as any);
        expect(useSettingsStore.getState().currency).toBe(currency);
      }
    });
  });

  // ===================================================================
  // Section 4: Currency Formatting
  // ===================================================================

  describe('Currency Formatting', () => {
    it('should format USD amounts with dollar sign and two decimals', () => {
      useSettingsStore.setState({ currency: 'USD' });
      expect(useSettingsStore.getState().formatAmount(100)).toBe('$100.00');
    });

    it('should convert USD to EUR using the exchange rate', () => {
      useSettingsStore.setState({ currency: 'EUR' });
      const formatted = useSettingsStore.getState().formatAmount(100);
      const expected = (100 * CURRENCY_RATES.EUR).toFixed(2);
      expect(formatted).toBe(`\u20AC${expected}`);
    });

    it('should format JPY without decimal places', () => {
      useSettingsStore.setState({ currency: 'JPY' });
      const formatted = useSettingsStore.getState().formatAmount(100);
      const expected = Math.round(100 * CURRENCY_RATES.JPY).toLocaleString();
      expect(formatted).toBe(`\u00A5${expected}`);
    });

    it('should format GBP with pound symbol', () => {
      useSettingsStore.setState({ currency: 'GBP' });
      const formatted = useSettingsStore.getState().formatAmount(50);
      const expected = (50 * CURRENCY_RATES.GBP).toFixed(2);
      expect(formatted).toBe(`\u00A3${expected}`);
    });

    it('should return the correct currency symbol', () => {
      useSettingsStore.setState({ currency: 'CHF' });
      expect(useSettingsStore.getState().getCurrencySymbol()).toBe('CHF');

      useSettingsStore.setState({ currency: 'AUD' });
      expect(useSettingsStore.getState().getCurrencySymbol()).toBe('A$');
    });
  });

  // ===================================================================
  // Section 5: Currency Constants Integrity
  // ===================================================================

  describe('Currency Constants', () => {
    it('should have matching keys in CURRENCY_SYMBOLS and CURRENCY_RATES', () => {
      const symbolKeys = Object.keys(CURRENCY_SYMBOLS).sort();
      const rateKeys = Object.keys(CURRENCY_RATES).sort();
      expect(symbolKeys).toEqual(rateKeys);
    });

    it('should have USD rate equal to 1 (base currency)', () => {
      expect(CURRENCY_RATES.USD).toBe(1);
    });

    it('should have all rates as positive numbers', () => {
      Object.values(CURRENCY_RATES).forEach(rate => {
        expect(rate).toBeGreaterThan(0);
        expect(typeof rate).toBe('number');
      });
    });
  });
});
