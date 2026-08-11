"use client";

import Link from "next/link";
import { useT } from "@/i18n";
import StyxShell from "../../_styx/StyxShell";
import Reveal from "../../_styx/Reveal";

/*
 * /waitlist/confirmed, the post-confirmation landing.
 *
 * ROUTE IS AN UPSTREAM CONTRACT. app/api/waitlist/confirm/route.ts issues
 * `NextResponse.redirect(new URL("/waitlist/confirmed", req.url), 302)` twice:
 * once after the record flips to status "confirmed", and again idempotently when
 * the same link is clicked a second time. Every confirmation email already sent
 * points at this literal path, and apps/web/WAITLIST.md documents it. Do not
 * rename this directory or this file.
 *
 * The redirect carries no token and no query string, so this page reads no
 * searchParams, no cookie and no record. It fetches nothing, guards nothing and
 * calls nothing third-party: there is zero network behaviour here, which is why
 * the port is presentation only.
 *
 * It stays "use client" for exactly one reason: useT() is useContext, so the
 * copy has to be read inside a client component. The tab title therefore comes
 * from ./layout.tsx, which is metadata and nothing else.
 *
 * Ported OFF app/waitlist/WaitlistResult.tsx rather than through it. That file
 * sits outside this directory and was shared with /waitlist/invalid and
 * /waitlist/removed, so it is left byte-for-byte intact and simply no longer
 * imported here. Its two other consumers have since been ported the same way,
 * which leaves it orphaned; deleting it belongs to whoever owns app/waitlist,
 * not to this page.
 *
 * Copy discipline: every sentence on the page is a t() call with its original
 * key, so French keeps working. Nothing new is asserted. In particular the port
 * adds no "your data is safe", no "spot reserved forever", no wave date and no
 * count of people ahead: none of that is knowable from here.
 *
 * BRAND LEAK, handled here without editing the dictionary:
 * t("waitlist.confirmedBody") still reads "the Protocol 01 waitlist" in
 * en.ts:367 and fr.ts:368, and that sentence is the first thing a visitor reads
 * after clicking a confirmation link. i18n/ is shared, so the key stays and the
 * retired name is swapped at render time by rebrand() below; hardcoding an
 * English sentence here would have dropped French. The dictionary edit is still
 * the real fix and is reported upward. The day it lands, rebrand() finds nothing
 * to replace and can be deleted with no visible change.
 */
/**
 * WORKAROUND, and the only thing on this page that is not pure vocabulary.
 * Delete both constants the day styx.css is fixed.
 *
 * app/_styx/styx.css:69 opts headings out of the root stylesheet's display face
 * with `.styx :is(h1, h2, h3, h4, h5, h6) { font-family: inherit; font-weight:
 * inherit; letter-spacing: normal }`. That selector has specificity (0,1,1) and
 * `.styx-h1` / `.styx-h2` only (0,1,0), so on a real heading ELEMENT the reset
 * wins and the serif voice is lost. Measured in Chrome on 2026-08-11 on this
 * route: `h1.styx-h1` computed to Inter 400, while `span.styx-h1` in the same
 * scope computed to Newsreader 300.
 *
 * The reset is also broader than it needs to be. What it is defending against,
 * app/globals.css:140 `h1..h6 { font-family: var(--font-display) }`, sits inside
 * `@layer base` of a Tailwind v4 sheet (`@import "tailwindcss"` at globals.css:4
 * registers the layer), and styx.css is unlayered, so ANY styx rule already beat
 * it on layer order alone, specificity never entering it. The reset therefore
 * earns its keep only for headings inside .styx that carry no styx- class at
 * all. The right fix is to narrow it to exactly those,
 * `.styx :is(h1,h2,h3,h4,h5,h6):not([class*="styx-"])`, rather than to raise
 * every type class; raising the classes would leave the same trap set for the
 * next heading style someone adds. Either way it is one edit in styx.css, which
 * eight ported pages are currently working around inline, so it is reported
 * upward rather than forked further here.
 *
 * Until then: restore the three declarations the reset overwrites, with the
 * exact values styx.css already gives .styx-h1 and .styx-h2. Existing tokens
 * only, no new colour, no new font stack, and the elements stay <h1>/<h2> so the
 * document outline is unchanged.
 */
const SERIF_DISPLAY = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-display)",
  letterSpacing: "-0.022em",
} as const;

const SERIF_TITLE = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-title)",
  letterSpacing: "-0.01em",
} as const;

/**
 * The retired product name, swapped for the current one at render time.
 *
 * Both dictionaries wrap the literal "Protocol 01" inside an otherwise correct
 * sentence (en.ts:367, fr.ts:368) and i18n/ is shared, so the choice is between
 * shipping the retired brand on the flagship post-confirmation page or rewriting
 * a translated sentence. Replacing the two words keeps each locale's grammar
 * intact: "the Styx Protocol waitlist", "la liste d'attente Styx Protocol".
 *
 * Display copy only. This never touches a storage key, an HKDF info string, a
 * PDA seed or an on-chain memo prefix: none of those contain the spaced,
 * capitalised form, and nothing here is written anywhere. If a locale is ever
 * reworded so the two words no longer appear, the replace finds nothing and that
 * locale renders exactly as it does today.
 */
function rebrand(copy: string): string {
  return copy.replace(/Protocol 01/g, "Styx Protocol");
}

export default function WaitlistConfirmedPage() {
  const t = useT();

  return (
    <StyxShell>
      {/* ── The confirmation ──────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        <div className="styx-btn-row" style={{ alignItems: "center" }}>
          <p className="styx-overline">Styx Protocol</p>
          {/* The seal, and the whole of it: a cyan tick in a hairline chip.
              The old view framed a lucide icon in a rounded, tinted tile.
              Rounded corners and colour washes are both out, and the tick says
              the same thing in one glyph. */}
          <span className="styx-chip">
            <span
              className="styx-check"
              aria-hidden="true"
              style={{ marginRight: 0 }}
            >
              &#10003;
            </span>
            {t("waitlist.badge")}
          </span>
        </div>

        {/* One translated string, never split: a word wrapped in styx-em or a
            gleam would have to cut the sentence, and the cut point differs per
            locale. */}
        <h1 className="styx-h1" style={SERIF_DISPLAY}>
          {t("waitlist.confirmedTitle")}
        </h1>

        <div className="styx-hero-rule" aria-hidden="true" />

        <div className="styx-hero-body">
          {/* Same key as the old view, so both locales keep the whole sentence;
              rebrand() only takes the retired name out of it. */}
          <p className="styx-lede">{rebrand(t("waitlist.confirmedBody"))}</p>
          <div className="styx-btn-row">
            {/* Unchanged: next/link, href="/", same i18n key. Kept as Link
                rather than a bare anchor so prefetch and soft navigation behave
                exactly as they did through WaitlistResult. The destination is
                deliberately not changed to /waitlist: sending a visitor who just
                confirmed back to the signup form is the wrong exit, and "/" is
                what the emails' readers have always landed on. */}
            <Link href="/" className="styx-btn">
              {t("waitlist.backHome")}
            </Link>
          </div>
        </div>

        {/* The page's entire motion budget, spent on a hairline rather than on
            words: the text gleam would have to land on a translated string, and
            the header already runs styx-gleam-strong on FOUNDER. */}
        <div
          className="styx-gleam-rule"
          aria-hidden="true"
          style={{ marginTop: "clamp(3rem, 7vw, 5rem)" }}
        />
      </section>

      {/* ── What the address is for ───────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">{t("waitlist.navLabel")}</p>
            <h2 className="styx-h2" style={SERIF_TITLE}>
              {t("waitlist.emailLabel")}
            </h2>
          </div>
          <div>
            <Reveal className="styx-panel styx-sweep styx-reveal">
              {/* waitlist.consent, and no prose of my own beside it. It is
                  already translated, and it is the one sentence here a reader
                  can check: the unsubscribe link in every email resolves to
                  /api/waitlist/unsubscribe, which hard-deletes the record.
                  waitlist.subtitle2 was the alternative and was rejected, since
                  "zero spam" is a promise rather than a fact, and
                  waitlist.subtitle1 was rejected because it pitches a signup to
                  someone who has just finished signing up. */}
              <div className="styx-panel-head">
                <div className="styx-prose">
                  <p>{t("waitlist.consent")}</p>
                </div>
              </div>
              {/* Evidence, in the mono voice, mono keys only. Each line is a
                  fact the reader can check rather than a sentence written to
                  fill the band: the confirm route redirects here only after the
                  record flips to "confirmed"; the programs are deployed to
                  Solana devnet and nowhere else; and there is no audit. No
                  count, no wave date, no queue position: none of that is
                  knowable from this page. */}
              <div className="styx-panel-body">
                <div className="styx-row">
                  <span className="styx-row-key">status</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">
                    <span className="styx-check" aria-hidden="true">
                      &#10003;
                    </span>
                    confirmed
                  </span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">network</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">solana devnet</span>
                </div>
                <div className="styx-row">
                  <span className="styx-row-key">audit</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">none</span>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>
    </StyxShell>
  );
}
