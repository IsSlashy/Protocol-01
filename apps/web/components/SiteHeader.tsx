"use client";

import { memo, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useT, LanguageSwitcher } from "@/i18n";

/**
 * SiteHeader — one shared, scroll-aware navigation bar for every page.
 *
 * Replaces the three divergent inline headers (landing / docs / roadmap) that
 * each drew a hard full-width `border-b`, which read as a strange "split" on
 * arrival and felt cramped.
 *
 * Behaviour:
 *  - Transparent and border-less at the very top, so landing heroes and doc
 *    content flow under it seamlessly (no hard band on arrival).
 *  - After ~8px of scroll it fades in a frosted background plus a soft hairline
 *    that fades out at both edges (a cyan-tinted gradient, never a hard line).
 *  - Fixed, so pages without a full-screen hero must reserve ~h-16 of top space.
 *
 * Keeps the art direction intact: cyan accent, uppercase monospace links, sharp
 * primary button.
 */
const LINKS: { href: string; i18nKey?: string; label?: string; dim?: boolean; glow?: boolean }[] = [
  // The app itself is no longer a nav link: it is the right-hand CTA button,
  // which is the one thing on this bar a visitor should be pulled towards.
  // A second, quieter "Pay" link next to it only split the same click.
  { href: "/docs", i18nKey: "nav.docs" },
  { href: "/roadmap", i18nKey: "nav.roadmap" },
  // Updates page kept at /updates but removed from the nav (replaced by SDK).
  // { href: "/updates", label: "Updates" },
  // /explorer is reached via the animated "Live" pulse in the right cluster,
  // so it intentionally has no separate nav link here.
  { href: "/sdk-demo", label: "SDK" },
  { href: "/careers", i18nKey: "nav.careers" },
  { href: "/founder", label: "Founder", glow: true },
];

function SiteHeader() {
  const t = useT();
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-colors duration-300 ${
        scrolled ? "bg-p01-void/70 backdrop-blur-xl" : "bg-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo (links home) */}
          <a href="/" className="flex items-center gap-2.5 shrink-0">
            <img src="/icon.png" alt="Protocol 01" className="w-7 h-7 rounded-md" />
            <span className="text-sm font-bold text-white tracking-wider hidden sm:inline">
              PROTOCOL 01
            </span>
          </a>

          {/* Primary nav */}
          <nav className="hidden md:flex items-center gap-7">
            {LINKS.map((l) => {
              if (l.glow) {
                return (
                  <a
                    key={l.href}
                    href={l.href}
                    className="founder-glow text-xs font-mono font-semibold uppercase tracking-wider"
                  >
                    {l.i18nKey ? t(l.i18nKey) : l.label}
                  </a>
                );
              }
              const active =
                pathname === l.href || (l.href !== "/" && !!pathname?.startsWith(l.href));
              const base = l.dim
                ? "text-p01-text-dim hover:text-p01-text-muted"
                : "text-p01-text-muted hover:text-white";
              return (
                <a
                  key={l.href}
                  href={l.href}
                  className={`text-xs font-mono uppercase tracking-wider transition-colors ${
                    active ? "text-p01-cyan" : base
                  }`}
                >
                  {l.i18nKey ? t(l.i18nKey) : l.label}
                </a>
              );
            })}
          </nav>

          {/* Right cluster */}
          <div className="flex items-center gap-3 shrink-0">
            {/* Live network pulse — strategic spot next to the languages */}
            <a
              href="/explorer"
              title={t("nav.explorer")}
              className="hidden sm:inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-p01-text-muted hover:text-[#39c5bb] transition-colors"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[#39c5bb] opacity-60 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#39c5bb]" />
              </span>
              {t("nav.live")}
            </a>
            <LanguageSwitcher className="hidden sm:flex" />
            {/* The bar's one strong CTA now opens the app instead of the
                waitlist form. The waitlist asks for an email before showing
                anything; the app is the thing being asked about, and it is
                live, so it is what the button offers. */}
            <a href="/app" className="btn-primary text-xs px-4 py-1.5">
              {t("nav.tryNow")}
            </a>
          </div>
        </div>
      </div>

      {/* Soft fading hairline — replaces the hard full-width border */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 right-0 h-px transition-opacity duration-300"
        style={{
          opacity: scrolled ? 1 : 0,
          background:
            "linear-gradient(90deg, transparent, rgba(57,197,187,0.28) 18%, rgba(57,197,187,0.28) 82%, transparent)",
        }}
      />
    </header>
  );
}

export default memo(SiteHeader);
