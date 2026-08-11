"use client";

import { memo } from "react";
import { usePathname } from "next/navigation";
import { useT } from "@/i18n";

/**
 * StyxHeader — the shared navigation bar, in the Styx voice.
 *
 * This is a restyle of components/SiteHeader.tsx, not a redesign of the
 * information architecture. Everything load-bearing is preserved verbatim:
 *
 *  - the same nav destinations, in the same order
 *  - `useT()` + the same i18n keys, so both locales keep working. A hardcoded
 *    English nav would quietly drop French.
 *  - the live-network pulse as the only route to /explorer
 *  - one strong CTA, pointing at /app
 *
 * Two deliberate changes:
 *  - /waitlist joins the nav, because the waitlist is a real page again rather
 *    than only a form buried in the home page CTA.
 *  - FOUNDER keeps its light sweep, now as `styx-gleam` — the Protocol 01
 *    gesture rebuilt in the Styx palette. See the GLEAM block in styx.css.
 *
 * Sticky rather than fixed: Styx pages open on a hero with generous top
 * padding, so there is no overlap to compensate for, and a sticky bar means no
 * page has to reserve a phantom 4rem of space.
 */
const LINKS: {
  href: string;
  i18nKey?: string;
  label?: string;
  gleam?: boolean;
}[] = [
  { href: "/docs", i18nKey: "nav.docs" },
  { href: "/roadmap", i18nKey: "nav.roadmap" },
  { href: "/sdk-demo", label: "SDK" },
  { href: "/careers", i18nKey: "nav.careers" },
  { href: "/waitlist", label: "Waitlist" },
  { href: "/founder", label: "Founder", gleam: true },
];

function StyxHeader() {
  const t = useT();
  const pathname = usePathname();

  return (
    <header className="styx-header">
      <div className="styx-container styx-header-inner">
        <a
          href="/"
          className="styx-wordmark"
          aria-label="Styx Protocol, home"
        >
          <span className="styx-wordmark-name">Styx</span>
          <span className="styx-wordmark-suffix">Protocol</span>
        </a>

        <nav className="styx-nav" aria-label="Sections">
          {LINKS.map((l) => {
            const label = l.i18nKey ? t(l.i18nKey) : l.label;
            if (l.gleam) {
              return (
                <a
                  key={l.href}
                  href={l.href}
                  className="styx-nav-link styx-gleam-strong"
                >
                  {label}
                </a>
              );
            }
            const active =
              pathname === l.href ||
              (l.href !== "/" && !!pathname?.startsWith(l.href));
            return (
              <a
                key={l.href}
                href={l.href}
                className="styx-nav-link"
                data-active={active ? "true" : undefined}
              >
                {label}
              </a>
            );
          })}
        </nav>

        <div className="styx-header-right">
          {/* The only route to /explorer, exactly as on the old bar. */}
          <a
            href="/explorer"
            title={t("nav.explorer")}
            className="styx-chip"
            style={{ borderColor: "transparent" }}
          >
            <span className="styx-dot" aria-hidden="true" />
            {t("nav.live")}
          </a>
          {/* No language switcher. The site ships English and French and picks
              by country (FR, CA, CH get French), so there is nothing to choose.
              See i18n/index.tsx and middleware.ts. */}
          <a href="/app" className="styx-btn" style={{ padding: "0.6rem 1.2rem" }}>
            {t("nav.tryNow")}
          </a>
        </div>
      </div>
    </header>
  );
}

export default memo(StyxHeader);
