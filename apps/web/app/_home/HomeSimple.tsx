"use client";

import { useT } from "@/i18n";
import { WalletProvider } from "@/components/WalletProvider";
import PayApp from "@/components/pay/PayApp";
import SerifHeading from "./SerifHeading";
import StyxField from "../_styx/StyxField";

/**
 * / — the product, first.
 *
 * WHAT CHANGED ON 2026-09-12 AND WHY. The landing page was 837 lines of
 * sections: hero, device mockup, film, problem, features, technology list,
 * partner logos, waitlist. The founder's brief, after looking at
 * umbraprivacy.com and pay.loofta.xyz: the visitor lands ON the solution, the
 * long copy goes, the docs explain themselves. So this page is three things:
 *
 *   1. one headline and one line under it;
 *   2. the devnet app itself — the same <PayApp> that /app frames, with the
 *      same <WalletProvider network="devnet"> (the prop is load-bearing: it
 *      picks the cluster and is signed into the key-derivation message);
 *   3. three quiet links: docs, SDK, roadmap.
 *
 * The amber devnet line stays under the app, one line, the same sentence
 * /app carries: a stranger must read "test tokens, not real funds" before
 * the first control, and nothing on this page may say more than the code does.
 *
 * Every string is a dictionary key, both locales; nothing here is a claim the
 * previous page did not already make. HomeSections.tsx is kept in the tree
 * (nothing imports it) so its sections can come back one at a time if wanted.
 */
export default function HomeSimple() {
  const t = useT();

  return (
    <>
      <StyxField />
      <div className="styx-hero-stage styx-hero-stage-simple">
        <section className="styx-container styx-hero styx-hero-simple">
          <p className="styx-overline">{t("pay.page.overline")}</p>
          <SerifHeading level={1}>{t("pay.page.h1")}</SerifHeading>
          <p className="styx-lede styx-hero-simple-lede">
            {t("hero.desc3")} {t("hero.desc4")}
          </p>
        </section>
      </div>

      {/* `styx-pay` is the founder's re-skin of the pay panels into the site's
          voice (app/_styx/styx.css): paper buttons, hairlines, no glow. /app
          wraps the app in it; the home page must too, or the panels come up in
          their old teal-glass dress — which is what happened on 2026-09-12. */}
      <section id="app" className="styx-container styx-home-app styx-pay">
        <WalletProvider network="devnet">
          <PayApp />
        </WalletProvider>
        <p className="styx-app-hero-warn styx-home-app-warn">
          <span className="styx-app-hero-warn-tag">{t("pay.page.devnetTag")}</span>
          {t("homeSimple.devnetShort")}
        </p>
      </section>

      <section className="styx-container" aria-label={t("homeSimple.linksLabel")}>
        <div className="styx-home-links">
        <a className="styx-home-link" href="/docs">
          <span className="styx-home-link-title">{t("nav.docs")}</span>
          <span className="styx-home-link-line">{t("homeSimple.docsLine")}</span>
        </a>
        <a className="styx-home-link" href="/sdk-demo">
          <span className="styx-home-link-title">SDK</span>
          <span className="styx-home-link-line">{t("homeSimple.sdkLine")}</span>
        </a>
        <a className="styx-home-link" href="/roadmap">
          <span className="styx-home-link-title">{t("nav.roadmap")}</span>
          <span className="styx-home-link-line">{t("homeSimple.roadmapLine")}</span>
        </a>
        </div>
      </section>
    </>
  );
}
