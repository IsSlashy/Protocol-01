"use client";

import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import en from "./en";
import fr from "./fr";
import ja from "./ja";
import type { Translations } from "./en";

export type Locale = "en" | "fr" | "ja";

const dictionaries: Record<Locale, Translations> = { en, fr, ja };

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
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const saved = localStorage.getItem("p01-web-locale") as Locale | null;
    if (saved && dictionaries[saved]) {
      setLocaleState(saved);
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem("p01-web-locale", l);
    document.documentElement.lang = l;
  }, []);

  const t = useCallback(
    (key: string): string => {
      const val = getNestedValue(dictionaries[locale], key);
      if (val !== key) return val;
      // Fallback to English
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

/** Compact language switcher component */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const locales: Locale[] = ["en", "fr", "ja"];

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
