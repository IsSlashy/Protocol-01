"use client";

import Link from "next/link";
import { useT } from "@/i18n";
import Reveal from "../../_styx/Reveal";

/**
 * The body of /waitlist/invalid, in the Styx voice.
 *
 * Why this file exists at all: the copy has to come from useT(), which is a
 * hook, so the markup must live in a client component. page.tsx stays a server
 * component purely so it can export metadata. Nothing else moved.
 *
 * What is deliberately NOT here:
 *
 *  - No token, searchParams, cookie or record read. Two API routes 302 here
 *    (app/api/waitlist/confirm and .../unsubscribe) after they have already
 *    consumed the token, so this page receives nothing and must not pretend to.
 *  - No hardened copy. The 302 fires on five different branches, including the
 *    store being unavailable and a caught exception, so the page cannot know
 *    that the link expired or that it was already used. t("waitlist.invalidBody")
 *    hedges, and that hedge is the true sentence.
 *  - No claim of deletion. Nothing was written or deleted on this path; the
 *    record may still exist and still be confirmable with a fresh link. That is
 *    the sibling /waitlist/removed page's copy, not this one's.
 *  - No second "admission" band. The first port added one: a mono title plus
 *    three key/value rows ("reason / not disclosed", "this page / reads no
 *    token", "next / a fresh link"). Every word of it was hardcoded English,
 *    and i18n now ships two locales only, so a French visitor read a French
 *    hero followed by an English third of the page. There is no dictionary key
 *    for any of those labels and i18n/ is shared, off limits from a page, so
 *    the band is gone rather than half translated. It also said nothing the
 *    hero does not: invalidBody already declines to name a reason and already
 *    points at a fresh link. /waitlist/removed is hero only for the same
 *    reason. If those labels are ever wanted back, they need four keys in
 *    i18n/en.ts and i18n/fr.ts first.
 *
 * Every visible sentence is a t() call, so French keeps working. The only
 * English furniture left is the brand overline, which is a proper noun plus the
 * name of the list and is untranslatable either way.
 */
export default function InvalidResult() {
  const t = useT();

  return (
    <section className="styx-container-narrow styx-hero">
      <p className="styx-overline">Styx Protocol &middot; Waitlist</p>
      {/* MEASURED 2026-08-11, and the reason for the three inline properties:
          styx.css resets headings out of the root stylesheet's Orbitron with
          `.styx :is(h1,…) { font-family: inherit; font-weight: inherit;
          letter-spacing: normal }`. That selector scores (0,1,1); `.styx-h1`
          scores (0,1,0), so on a real <h1> the reset WINS and the hero
          statement renders in Inter 400 at normal tracking instead of
          Newsreader 300. Verified in the browser: computed font-family was
          "Inter" on this very element.

          No colour and no font is invented here: these are the tokens
          `.styx-h1` already asks for, restated so they survive the reset. The
          fix belongs in the shared file (scope the reset away from the styx-h*
          classes, or raise them to `.styx .styx-h1`); once it lands, delete
          this style prop and nothing changes. Reported upward. */}
      <h1
        className="styx-h1"
        style={{
          fontFamily: "var(--styx-serif)",
          fontWeight: "var(--styx-serif-display)",
          letterSpacing: "-0.022em",
        }}
      >
        {t("waitlist.invalidTitle")}
      </h1>
      {/* The sanctioned divider form of the gleam. The page spends no text
          gleam: the header already carries one on FOUNDER. */}
      <div
        className="styx-gleam-rule"
        aria-hidden="true"
        style={{ marginBlock: "clamp(2rem, 5vw, 3.25rem)" }}
      />
      {/* Stacked, not the two column styx-hero-body: with the band dropped
          there is one paragraph left, and a grid would push the buttons into an
          empty right hand column. Same shape as /waitlist/removed. The reveal
          is the page's whole motion budget. */}
      <Reveal className="styx-stack-lg styx-reveal">
        <p className="styx-lede">{t("waitlist.invalidBody")}</p>
        <div className="styx-btn-row">
          {/* next/link, href="/" : unchanged, primary, same key as before. */}
          <Link href="/" className="styx-btn">
            {t("waitlist.backHome")}
          </Link>
          {/* The one thing invalidBody actually asks the reader to do is join
              again, so the route that carries the form gets a quiet second
              button. /waitlist is a real page (app/waitlist/page.tsx) and the
              shared header already links to it. Existing key, both locales, no
              new claim. */}
          <Link href="/waitlist" className="styx-btn-ghost">
            {t("waitlist.heroCta")}
          </Link>
        </div>
      </Reveal>
    </section>
  );
}
