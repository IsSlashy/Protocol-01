"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useT } from "@/i18n";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";

/**
 * /extension: how the browser extension gets installed, and why you cannot
 * install it yet.
 *
 * Ported from the Protocol 01 identity to Styx. Presentation only: the two
 * navigations (/#download and /), the version literal and every i18n key that
 * survived the honesty pass behave exactly as before.
 *
 * The 0.5.0 archive itself (public/protocol01-extension-0.5.0.zip) was DELETED
 * on 2026-09-23, with its paused download block, the ZIP and FOLDER literals
 * and the extensionPage.download key. It shipped Groth16 artifacts and a STARK
 * worker without circuit 7, which the chain has rejected since 2026-08-04, so
 * it could never be offered again. A new build ships its own archive; the
 * install steps below name no file.
 *
 * TRANSLATION RULE FOR THIS PAGE, after the first port shipped eleven English
 * strings into the French build: every visible string resolves through a key
 * that exists in both en.ts and fr.ts. Two keys are borrowed from other
 * sections, the way the first port already borrowed waitlist.*, footer.* and
 * notFound.*:
 *
 *  - hero.desc3           the product statement. fr: "Preuves post-quantiques,
 *                         adresses furtives, pools blindés. En ligne sur
 *                         devnet." No claim in it is on the forbidden list.
 *  - sdkDemo.installTitle "Install" / "Installation", the build panel row key.
 *
 * No English field label is left on the page: the "Archive" row left with the
 * archive.
 *
 * Three strings from the old page are still deliberately NOT rendered, and none
 * of them can be fixed here because i18n/ is shared:
 *
 *  - extensionPage.subtitle claims "cross-device recurring subscriptions" as a
 *    shipped extension feature. It is a design document, not a shipped path.
 *  - extensionPage.trust    "It never leaves your browser", an absolute
 *    security guarantee about code that has never been audited.
 *  - extensionPage.back     the retired site brand plus an arrow glyph. The same
 *    link now carries notFound.returnHome, which exists in both locales, so the
 *    destination and the translation both survive.
 *
 * extensionPage.title ("Install Protocol 01" / "Installer Protocol 01") IS
 * rendered again, as the heading of section 02, because the page had stopped
 * naming the thing it is about. "Protocol 01" is not the site brand there, it is
 * the artifact's own name: the manifest.json of the 0.5.0 build reads
 * {"name": "Protocol 01"} (read out of its archive on 2026-08-11), so that is
 * the label Chrome prints in the extensions list of anyone who installed it,
 * and the one step 5 tells the reader to pin.
 */

/* The version of the last build that was handed out, the one the amber
   warning below is about. */
const VERSION = "0.5.0";

/* Inline evidence: a file extension, a folder name, a browser URL. styx.css has
   no inline-code token, so this composes the two shared classes that come
   closest: mono at evidence size, in paper rather than muted. Reported as a
   gap; nothing local is forked for it. */
const codeCls = "styx-mono styx-code-name";

/**
 * MEASURED DEFECT IN THE SHARED SHEET, worked around here, reported upstream.
 *
 * styx.css:69 opts headings out of the root stylesheet's Orbitron with
 * `.styx :is(h1, h2, h3, h4, h5, h6) { font-family: inherit; font-weight:
 * inherit; letter-spacing: normal }`. `:is()` takes the specificity of its most
 * specific argument, so that selector is (0,1,1) and it BEATS `.styx-h1`,
 * `.styx-h2` and `.styx-h3`, which are (0,1,0), whatever the source order. On
 * this page the symptom was one class printing two typefaces: the `<p
 * className="styx-h3">` in the build panel came out in the serif because a `<p>`
 * is not covered by the opt-out, while the five step `<h3 className="styx-h3">`
 * a screen below came out in Inter.
 *
 * The one-line fix belongs in styx.css (`:where(h1, ...)` instead of
 * `:is(h1, ...)`, since :where() contributes zero specificity and still beats
 * the root sheet's bare `h1`). app/_styx is off limits to this port, so the
 * sheet's own tokens are re-applied inline, where nothing can outrank them.
 * Nothing is invented: every value is read out of styx.css, by variable wherever
 * one exists, so a change to the tokens still reaches this page.
 * app/(pay)/app/page.tsx, app/explorer/page.tsx, app/privacy/page.tsx and
 * app/admin/page.tsx reached the same workaround with the same constant names,
 * so one shared fix deletes all of them at once.
 *
 * Swapping the headings for `<p>` would also restore the serif, and is refused:
 * a five step install procedure is exactly the content that needs a real
 * heading outline.
 */
const SERIF_H1 = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-display)",
  letterSpacing: "-0.022em",
} as const;

const SERIF_H2 = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-title)",
  letterSpacing: "-0.01em",
} as const;

const SERIF_H3 = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-small)",
  letterSpacing: "-0.005em",
} as const;

export default function ExtensionPage() {
  const t = useT();

  /* The five steps, verbatim in their translated strings and in their <code>
     literals: chrome://extensions and its three siblings are instructions, not
     copy. The titles already carry their own "1 ·" … "5 ·" numbering in every
     locale, which is why the list below adds no second numeral column. */
  const steps: { title: string; body: ReactNode }[] = [
    {
      title: t("extensionPage.step1Title"),
      body: (
        <>
          {t("extensionPage.step1a")} <code className={codeCls}>.zip</code>{" "}
          {t("extensionPage.step1b")}
        </>
      ),
    },
    {
      title: t("extensionPage.step2Title"),
      body: (
        <>
          {t("extensionPage.step2a")}{" "}
          <code className={codeCls}>chrome://extensions</code> (Opera:{" "}
          <code className={codeCls}>opera://extensions</code>, Edge:{" "}
          <code className={codeCls}>edge://extensions</code>, Brave:{" "}
          <code className={codeCls}>brave://extensions</code>).
        </>
      ),
    },
    {
      title: t("extensionPage.step3Title"),
      body: (
        <>
          {t("extensionPage.step3a")} <strong>{t("extensionPage.step3mode")}</strong>{" "}
          {t("extensionPage.step3b")}
        </>
      ),
    },
    {
      title: t("extensionPage.step4Title"),
      body: (
        <>
          {t("extensionPage.step4a")} <strong>{t("extensionPage.step4action")}</strong>{" "}
          {t("extensionPage.step4b")}.
        </>
      ),
    },
    {
      title: t("extensionPage.step5Title"),
      body: <>{t("extensionPage.step5")}</>,
    },
  ];

  return (
    <StyxShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        {/* The overline is where the page says what it is, in a translated
            string, before it says anything else. */}
        <p className="styx-overline">
          Styx Protocol &middot; {t("extensionPage.badge")}
        </p>
        {/* The first true thing a visitor needs, not a headline about a
            download that is switched off. */}
        <h1 className="styx-h1" style={SERIF_H1}>
          {t("waitlist.extensionNoticeTitle")}
        </h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        <div className="styx-hero-body">
          <div>
            <p className="styx-lede">{t("waitlist.extensionNoticeBody")}</p>
            {/* What the extension DOES. The old subtitle carried this job and
                sold "cross-device recurring subscriptions", which the extension
                does not ship, so the statement is rebuilt out of a key that is
                true and translated. Nothing here is a privacy guarantee: it
                names the mechanisms and the network, and stops. */}
            <div className="styx-prose" style={{ marginTop: "1.35rem" }}>
              <p>{t("hero.desc3")}</p>
            </div>
            {/* Nobody NEW can install 0.5.0 from here: the download was
                paused for the waitlist and the archive was deleted on
                2026-09-23. The exposure is the other direction: whoever
                installed the build before the pause has had a client the chain
                rejects since 2026-08-04 with no way to learn it from us. So the
                warning is the first thing under the lede, in the same amber the
                /app page uses for its own admission, and it carries the web app
                as the way out rather than leaving the reader with only bad
                news. */}
            <div className="styx-admission" style={{ marginTop: "1.75rem" }}>
              <p className="styx-admission-title">
                {t("waitlist.extensionIncompatTitle")}
              </p>
              <p className="styx-admission-body">
                {t("waitlist.extensionIncompatBody")}
              </p>
            </div>
            <div className="styx-btn-row" style={{ marginTop: "2rem" }}>
              {/* The page's real action. Same component, same href, same label
                  key as the Protocol 01 page. */}
              <Link href="/#download" className="styx-btn">
                {t("waitlist.extensionNoticeCta")}
              </Link>
              <Link href="/app" className="styx-btn">
                {t("waitlist.extensionIncompatCta")}
              </Link>
            </div>
          </div>

          <aside className="styx-panel styx-sweep">
            <div className="styx-panel-head">
              {/* Beta and devnet in one translated string, which is also the
                  build's whole status. */}
              <p className="styx-overline">{t("extensionPage.betaBadge")}</p>
              {/* A <p>, not a heading, so the shared heading opt-out never
                  reaches it. The serif class alone is enough here. */}
              <p className="styx-h3" style={{ margin: "0.5rem 0 0" }}>
                v{VERSION}
              </p>
            </div>
            <div className="styx-panel-body">
              <div className="styx-row">
                <span className="styx-row-key">
                  {t("sdkDemo.installTitle")}
                </span>
                <span className="styx-row-leader" />
                <span className="styx-row-value">
                  {t("extensionPage.step3mode")}
                </span>
              </div>
              <p className="styx-note" style={{ marginTop: "1.35rem" }}>
                {t("extensionPage.compat")}
              </p>
            </div>
          </aside>
        </div>
      </section>

      {/* ── 01 · What this build is ─────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          {/* No .styx-index line above the h2, here or in section 02: every
              candidate label was either untranslated English (the first port's
              "Current state" and "Installation") or a duplicate of a string
              already on screen. The numeral plus the translated h2 is the whole
              section label. */}
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <h2 className="styx-h2" style={SERIF_H2}>
              {t("extensionPage.betaTitle")}
            </h2>
          </div>
          <div>
            {/* The one amber block on the page, and the only place this build's
                limits are stated. Three translated facts: devnet only and not
                audited, then test SOL and no Chrome Web Store listing, then the
                site-wide disclaimer. The first port put the last two of those
                into English-only cards beside this block, which is how a French
                visitor lost them. */}
            <div className="styx-admission">
              <p className="styx-admission-title">{t("footer.copyright")}</p>
              <p className="styx-admission-body">{t("extensionPage.betaBody")}</p>
              <p
                className="styx-admission-body"
                style={{ marginTop: "0.75rem" }}
              >
                {t("footer.disclaimer")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 02 · Install ────────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <h2 className="styx-h2" style={SERIF_H2}>
              {t("extensionPage.title")}
            </h2>
          </div>
          <div>
            {/* Step 1 says to download the build's .zip. No archive is offered
                while downloads are paused, so the localized notice repeats
                here: it is the honest label for a procedure nobody can run
                yet. */}
            <p className="styx-overline" id="extension-steps-paused">
              {t("waitlist.extensionNoticeTitle")}
            </p>

            {/* The caveat is wired to the list so a screen reader hears it as
                the description of the procedure, not as a stray line. */}
            <ul className="styx-steps" aria-describedby="extension-steps-paused">
              {steps.map((step, i) => (
                <Reveal
                  as="li"
                  key={step.title}
                  className="styx-step styx-reveal"
                  delay={i * 60}
                >
                  {/* One cell across both columns. .styx-step reserves a 3.5rem
                      numeral gutter, and the frozen titles already number
                      themselves in every locale, so a styx-step-index here
                      would print the number twice. */}
                  <div style={{ gridColumn: "1 / -1" }}>
                    <h3 className="styx-h3" style={SERIF_H3}>
                      {step.title}
                    </h3>
                    {/* styx-prose, not styx-step-body: the emphasised words in
                        steps 3 and 4 need the paper colour that .styx-prose
                        strong gives them. */}
                    <div className="styx-prose">
                      <p>{step.body}</p>
                    </div>
                  </div>
                </Reveal>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── Close ──────────────────────────────────────────────────────── */}
      <section
        className="styx-container"
        style={{ paddingBlock: "clamp(3rem, 7vw, 5rem)" }}
      >
        <div className="styx-gleam-rule" aria-hidden="true" />
        <div className="styx-btn-row" style={{ marginTop: "2.25rem" }}>
          <Link href="/" className="styx-btn-ghost">
            {t("notFound.returnHome")}
          </Link>
        </div>
      </section>
    </StyxShell>
  );
}
