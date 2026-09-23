"use client";

import { useLocale, useT } from "@/i18n";

/**
 * The white paper page is a static server component (it is rendered from
 * docs/WHITEPAPER.md at build time), while the site's locale is resolved in the
 * browser by I18nProvider. These two leaves carry the page's own UI strings
 * (buttons, labels, the "being finalised" notice) in English and French. The
 * paper itself is English only, and the page says so.
 */
export function WpText({ k }: { k: string }) {
  const t = useT();
  return <>{t(k)}</>;
}

/** "13,000 words · 57 min read", in the visitor's locale. */
export function WpReadingMeta({ words }: { words: number }) {
  const t = useT();
  const { locale } = useLocale();
  const rounded = words >= 1000 ? Math.round(words / 100) * 100 : words;
  const minutes = Math.max(1, Math.round(words / 230));
  const fmt = new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US");
  return (
    <>
      {fmt.format(rounded)} {t("whitepaper.words")} &middot; {fmt.format(minutes)}{" "}
      {t("whitepaper.minutes")}
    </>
  );
}
