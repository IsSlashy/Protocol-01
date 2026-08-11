"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import en from "./en";
import fr from "./fr";
import type { Translations } from "./en";

/**
 * Two languages, chosen by location.
 *
 * French for visitors in France, Canada and Switzerland. English everywhere
 * else. There is no language switcher in the header: the site follows the
 * visitor rather than asking.
 *
 * Japanese was removed on 2026-08-11. The dictionary is not deleted from
 * history, it lives in the Protocol 01 identity archive under
 * D:\Protocol-01-HQ\Archive\protocol-01-identity-2026-08-11, so restoring it is
 * a file copy plus three lines here.
 */
export type Locale = "en" | "fr";

const dictionaries: Record<Locale, Translations> = { en, fr };

/**
 * The countries that get French. ISO 3166-1 alpha-2.
 *
 * Canada is here by product decision, not by majority language: a visitor from
 * Toronto gets French too. If that turns out to be wrong, the fix is to drop
 * "CA" from this list and let Canadian visitors fall through to the browser
 * language check below, which reads fr-CA as French and en-CA as English.
 */
const FRENCH_COUNTRIES = new Set(["FR", "CA", "CH"]);

/** Set by middleware.ts from the Vercel geo header. Absent in local dev. */
const COUNTRY_COOKIE = "styx-country";

/**
 * Persisted manual override. The key keeps its historical `p01-` name on
 * purpose: renaming a storage key silently discards what visitors already have
 * stored under it.
 */
const LOCALE_STORAGE_KEY = "p01-web-locale";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Resolution order, most specific first:
 *  1. an explicit stored choice, if one was ever made
 *  2. the country from the Vercel geo header, via the middleware cookie
 *  3. the browser's own language region, which is the only signal available in
 *     local development (fr-CA and en-CA both carry the CA region, so this
 *     agrees with the country rule above for Canada)
 *  4. English
 */
function resolveLocale(): Locale {
  if (typeof window === "undefined") return "en";

  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "en" || saved === "fr") return saved;
  } catch {
    // Private browsing can throw on localStorage access. Keep going.
  }

  const country = readCookie(COUNTRY_COOKIE)?.toUpperCase();
  if (country) return FRENCH_COUNTRIES.has(country) ? "fr" : "en";

  const tags = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
  for (const tag of tags) {
    if (!tag) continue;
    const parts = tag.split("-");
    const region = parts[1]?.toUpperCase();
    if (region && FRENCH_COUNTRIES.has(region)) return "fr";
    if (parts[0]?.toLowerCase() === "fr") return "fr";
  }

  return "en";
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  setLocale: () => {},
  t: (key: string) => key,
});

function getNestedValue(obj: any, path: string): string {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null) return path;
    current = current[part];
  }
  return typeof current === "string" ? current : path;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  /**
   * Starts on English so the server-rendered markup and the first client render
   * agree; the real locale is resolved in the effect below. Resolving during
   * render would read cookies and navigator during hydration and mismatch.
   */
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const resolved = resolveLocale();
    setLocaleState(resolved);
    document.documentElement.lang = resolved;
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, l);
    } catch {
      // Non-fatal: the choice just will not survive a reload.
    }
    document.documentElement.lang = l;
  }, []);

  const t = useCallback(
    (key: string): string => {
      const val = getNestedValue(dictionaries[locale], key);
      if (val !== key) return val;
      // Fallback to English rather than showing a raw key.
      return getNestedValue(dictionaries.en, key);
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  const { t } = useContext(I18nContext);
  return t;
}

export function useLocale() {
  return useContext(I18nContext);
}

/**
 * Compact language switcher.
 *
 * Deliberately NOT rendered in the Styx header: the locale follows the
 * visitor's country. Kept exported because components/SiteHeader.tsx (the old
 * Protocol 01 bar) still imports it, and because a footer switcher is a
 * plausible thing to want back. Japanese is gone, so it offers two languages.
 */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const locales: Locale[] = ["en", "fr"];

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {locales.map((l) => (
        <button
          key={l}
          onClick={() => setLocale(l)}
          className={`px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors ${
            locale === l
              ? "text-[#39c5bb] border border-[#39c5bb]/40 bg-[#39c5bb]/10"
              : "text-[#555560] hover:text-[#888892]"
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
