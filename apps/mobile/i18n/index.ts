/**
 * i18n — Internationalization for Protocol 01
 *
 * Supported: English (en), French (fr), Japanese (ja)
 * Auto-detects device language, falls back to English.
 *
 * Usage:
 *   import { t } from '@/i18n';
 *   <Text>{t('wallet.send')}</Text>
 *
 * Or with the hook (for reactive language changes):
 *   import { useT } from '@/i18n';
 *   const t = useT();
 */

import { I18n } from 'i18n-js';
import { getLocales } from 'expo-localization';
import { create } from 'zustand';
import en from './en';
import fr from './fr';
import ja from './ja';

export type SupportedLocale = 'en' | 'fr' | 'ja';

const i18n = new I18n({ en, fr, ja });
i18n.defaultLocale = 'en';
i18n.enableFallback = true;

// Detect device language
const deviceLocale = getLocales()[0]?.languageCode ?? 'en';
i18n.locale = ['en', 'fr', 'ja'].includes(deviceLocale) ? deviceLocale : 'en';

/** Global translation function */
export function t(key: string, options?: Record<string, any>): string {
  return i18n.t(key, options);
}

/** Language store — allows changing language at runtime */
interface LangStore {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
}

export const useLangStore = create<LangStore>((set) => ({
  locale: i18n.locale as SupportedLocale,
  setLocale: (locale) => {
    i18n.locale = locale;
    set({ locale });
  },
}));

/** Hook for reactive translations (re-renders when language changes) */
export function useT() {
  const { locale } = useLangStore();
  // locale in deps forces re-render on language change
  return (key: string, options?: Record<string, any>) => i18n.t(key, options);
}

/** Get current locale */
export function getLocale(): SupportedLocale {
  return i18n.locale as SupportedLocale;
}

/** Available languages for settings UI */
export const LANGUAGES: { id: SupportedLocale; label: string; native: string }[] = [
  { id: 'en', label: 'English', native: 'English' },
  { id: 'fr', label: 'French', native: 'Fran\u00e7ais' },
  { id: 'ja', label: 'Japanese', native: '\u65e5\u672c\u8a9e' },
];

export { i18n };
