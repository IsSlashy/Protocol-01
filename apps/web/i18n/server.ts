import { cookies, headers } from "next/headers";

import en from "./en";
import fr from "./fr";
import type { Locale } from "./index";

/**
 * The dictionary, on the server, for copy that must render without JavaScript.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `useT()`.
 *
 * `app/(pay)/app/page.tsx` states, in its own header and at length, that its
 * disclosures must render from HTML: "Gating those on JavaScript while the hero
 * renders from HTML would mean the claims survive a bad load and the caveats do
 * not, which is the exact failure this rebrand exists to correct." That page is
 * the heaviest client route on the site — five wallet adapters plus
 * @solana/web3.js plus the privacy stack — so hydration lands late and
 * sometimes not at all.
 *
 * Translating it with `useT()` would have made every caveat client-only and
 * traded that property away for a translation. This reads the same country
 * cookie the client provider reads, on the server, so the French visitor gets
 * French AND the caveats keep rendering with JavaScript switched off.
 *
 * WHAT IT COSTS. Calling `cookies()` opts the calling page out of static
 * rendering. middleware.ts avoids exactly this in the ROOT LAYOUT, on purpose,
 * because doing it there would make every page dynamic for one string. Here it
 * is one route, one that renders a wallet-connected app and is not usefully
 * cacheable anyway.
 *
 * 🚨 IT MUST FALL BACK THE SAME WAY THE CLIENT DOES, AND THE FIRST VERSION DID
 * NOT. The cookie is written from `x-vercel-ip-country`, which only exists on
 * Vercel. Reading the cookie alone answered English everywhere else — so on
 * localhost the page shell rendered in English directly above a panel rendering
 * in French, which is worse than either language on its own and is exactly what
 * a reviewer saw the first time this shipped. `resolveLocale()` in
 * i18n/index.tsx falls through to the browser language; the server equivalent is
 * `Accept-Language`, read below, and the two agree.
 *
 * WHAT THE SERVER STILL CANNOT SEE is the explicit stored choice
 * (`p01-web-locale`) in localStorage. The site ships no language switcher, so
 * nothing writes that key in normal use; if one is ever added it has to write a
 * cookie too, or this shell will disagree with the panels again.
 */
const FRENCH_COUNTRIES = new Set(["FR", "CA", "CH"]);
const COUNTRY_COOKIE = "styx-country";

const dictionaries = { en, fr } as const;

export async function getServerLocale(): Promise<Locale> {
  const store = await cookies();
  const country = store.get(COUNTRY_COOKIE)?.value?.toUpperCase();
  if (country) return FRENCH_COUNTRIES.has(country) ? "fr" : "en";

  // Same fall-through as resolveLocale() on the client: the region of a
  // language tag, then a bare `fr`. `Accept-Language` is the server's only view
  // of `navigator.languages`.
  const accept = (await headers()).get("accept-language") ?? "";
  for (const part of accept.split(",")) {
    const tag = part.split(";")[0]?.trim();
    if (!tag) continue;
    const [language, region] = tag.split("-");
    if (region && FRENCH_COUNTRIES.has(region.toUpperCase())) return "fr";
    if (language?.toLowerCase() === "fr") return "fr";
  }

  return "en";
}

function getNestedValue(obj: unknown, path: string): string {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return path;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : path;
}

/**
 * A `t` for server components. Same key shape as `useT()`, same fallback to
 * English rather than printing a raw key.
 */
export async function getServerT(): Promise<(key: string) => string> {
  const locale = await getServerLocale();
  return (key: string) => {
    const value = getNestedValue(dictionaries[locale], key);
    if (value !== key) return value;
    return getNestedValue(dictionaries.en, key);
  };
}
