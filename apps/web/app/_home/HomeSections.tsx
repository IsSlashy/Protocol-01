"use client";

import Link from "next/link";
import { useT } from "@/i18n";
import Reveal from "../_styx/Reveal";
import SerifHeading from "./SerifHeading";
import WaitlistPanel from "./WaitlistPanel";
import RiverCanvas from "../_styx/RiverCanvas";

/**
 * The home page, in the Styx vocabulary.
 *
 * WHY THIS FILE EXISTS. app/page.tsx has to export `metadata` so the tab stops
 * saying "PROTOCOL-01" (the root layout is off limits), and a "use client" file
 * cannot export metadata. So the page is a server component and every section
 * that needs useT() lives here.
 *
 * WHY NONE OF THE OLD COMPONENTS ARE IMPORTED. Hero, Trust, Problem, HowItWorks,
 * Features, ValueProp, Ecosystem and CTA are the old identity: Orbitron via
 * font-display, the chromatic glitch layers, pink #ff2d7a, neon box-shadow
 * halos, grid backgrounds, rounded-full pills, gradient clip-text and p01-*
 * colour classes. components/ is off limits for this port, so they could not be
 * fixed. Their CONTENT is re-composed here against t() keys, and
 * SiteHeader/Footer are replaced by the StyxShell chrome.
 *
 * EVERY SENTENCE ON THIS PAGE COMES FROM THE DICTIONARY. This is the rule the
 * first pass broke: about thirty-five sentences were written straight into the
 * JSX, which reads fine in English and silently deletes the French, because a
 * hardcoded string has no fr.ts entry to fall back to. i18n/ is off limits, so
 * no key could be added and none was: every claim below is an existing key,
 * chosen for what it says rather than for where it used to live. The only
 * literals left are protocol identifiers that are the same word in both
 * locales (X25519, ML-KEM-768, Poseidon, Merkle, the program and library names
 * in STACK) and the brand word "Styx Protocol".
 *
 * WHERE A KEY MOVED, AND WHY. Some slots used to hold a key this rebrand cannot
 * publish, so the slot now holds a different, truthful key:
 *  - hero.headline "NOTHING THEY CAN TRACE." and hero.traces ("Traces left
 *    on-chain" under a "0") are replaced by the amber admission, which carries
 *    docs.sections.denominatedPools.desc: the withdrawal republishes the
 *    commitment its deposit created, so the two ends can still be matched.
 *  - howItWorks.step4Desc "Withdraw to any wallet, zero trace" is replaced by
 *    docs.sections.denominatedPools.detail8, which states what the withdrawal
 *    leg actually leaks.
 *  - howItWorks.instantOps / shieldTime / zeroTraces (a "~5s shield" nobody
 *    benchmarked, plus "Zero traces") are replaced by one status chip,
 *    extensionPage.betaBadge under the four steps. Section 03 had a second chip
 *    saying "Devnet Only" again; the page states the position in the facts grid
 *    and in the footer, so the duplicate is gone.
 *  - cta.title + cta.titleHighlight "Ready to become invisible" is replaced by
 *    footer.ctaSubtitle as the section 06 heading.
 *  - features.badge "14 Privacy Modules" and features.title1 "Fourteen
 *    modules." cannot head six cards, so the index is nav.features.
 *  - hero.protocolActive / hero.ready were status theatre; the overline is the
 *    brand word plus nothing.
 *  - the ecosystem counters (26+/12/10/100%) are replaced by the four FACTS
 *    cards, all four of them dictionary keys.
 *  - four features.desc.* values state absolutes this page's own admission
 *    contradicts ("unlinkable address for every payment", a vault that pays
 *    "privately", a proof that reveals none of a payment's details, a
 *    withdrawal that "never reveals your total"). They are swapped for the
 *    docs.sections.* description of the same module, which is written to be
 *    checkable. See FEATURES.
 *
 * FOUR DICTIONARY VALUES ARE REWORDED, NOT BORROWED. The first pass could only
 * move slots between existing keys, and where no key fit it borrowed one from
 * another page, which is how a counter label from /explorer ended up captioning
 * half of a comparison. Four values in the two dictionaries are reworded
 * instead, all of them page copy this route is the only consumer of:
 * problem.without and problem.with (the retired brand, and the pair this
 * comparison needs), problem.anonymousStatus (it claimed the amount is hidden,
 * which a fixed-denomination pool publishes) and footer.ctaSubtitle (it
 * restated hero.desc3 + hero.desc4). waitlist.subtitle1 keeps its slot in
 * section 06 and its "Protocol 01" is reworded to the new brand. If those edits
 * are not in the dictionary yet, the assertions in
 * __tests__/pages/Homepage.test.tsx fail loudly rather than the page shipping
 * the old strings quietly.
 *
 * ALSO DELETED, AND STAYING DELETED: hero.desc2 ("Without revealing who you
 * are, what you bought, or how much"), problem.stat2 (an unsourced "73%
 * deanonymized"), problem.stat3, problem.stat4 (an unsourced "$4.3B"),
 * howItWorks.subtitle
 * ("untraceable transfers in under a minute"), eight of the fourteen feature
 * cards, the three valueProp bodies (invisible entries and exits, "no
 * compliance liability", "live in days, not quarters"), the DEVNET + MAINNET
 * pill pair, the CTA triple (100% / 0 / infinity), the Trust logo wall, and
 * PhoneMockup with every mockup.* key (fabricated balances, and an agent line
 * asserting that no chain observer can correlate an unshield with your main
 * wallet).
 *
 * INFRASTRUCTURE PRESERVED VERBATIM: the /api/waitlist POST and its whole form
 * (see ./WaitlistPanel.tsx), source="cta", the hero button's
 * getElementById('download').scrollIntoView({behavior:'smooth'}), the ids
 * #problem / #features / #download that components/Footer.tsx and that button
 * depend on, href="/app", the next/link to /docs, the Discord link with
 * target/rel, and the demo <video> attributes.
 */

/* WAITLIST MODE: direct downloads are disabled, restore at public launch.
   Carried across verbatim from components/Hero.tsx and components/CTA.tsx so the
   restore stays one un-comment instead of a hunt through git history.
   FROZEN LITERAL: the release path contains "protocol-01" and is load-bearing;
   do not rename it. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const APK_URL =
  "https://github.com/IsSlashy/Protocol-01/releases/download/v1.0.3/protocol-01-v1.0.3.apk";

type Fact = {
  labelKey: string;
  /** A dictionary key, when the value is a sentence. */
  valueKey?: string;
  /** A protocol identifier, when the value is the same word in both locales. */
  value?: string;
  noteKey: string;
};

/**
 * The four facts a stranger can check, in the order they matter, and
 * deliberately including the one that is not flattering.
 *
 * The labels are four ecosystem.* category names, so every card is read the
 * same way, and the notes are the docs.* sentences that describe the same
 * primitive, so a French visitor reads French here.
 *
 * CARD 1's NOTE IS SCOPED TO THE PROOF SYSTEM. It was
 * explorer.circuits.subtitle, which says "no trusted setup, no elliptic
 * curves. Each operation is verified on-chain by one of these". Half of that
 * is a contradiction on this page and half is a claim the page cannot carry:
 * the proof itself has no curve, but card 2 four lines below prints
 * X25519 + ML-KEM-768 and STACK prints Curve25519, Circom and ark-circom, so a
 * blanket "no elliptic curves" reads as false to anyone who scrolls; and "each
 * operation is verified on-chain" is a bigger capability statement than any
 * measurement here supports. docs.sections.zkProofs.detail7 states what is
 * measured, about the proof system only.
 *
 * CARD 4 STATES THE POSITION ONCE. It used to stack "Devnet Only" over "Beta
 * on Solana Devnet." over "Devnet only, not audited.", which is one fact
 * printed three times in one card. The label is now the category, the value is
 * the position, and the note is spent on the measurement nothing else on this
 * page carries: the WASM prover runs in a browser, and on a real phone the
 * withdrawal pair was measured past the worker timeout, so an on-device
 * withdrawal does not complete today.
 *
 * What is NOT stated: the transaction signature is Ed25519 and stays
 * classical. That is true and sayable, and the dictionary has no sentence for
 * it, so rather than write English into the JSX the card is spent on the Merkle
 * commitment structure instead. The page never claims a post-quantum
 * transaction anywhere, so nothing false fills the gap.
 */
const FACTS: Fact[] = [
  {
    labelKey: "ecosystem.zkProofSystem",
    valueKey: "explorer.circuits.title",
    noteKey: "docs.sections.zkProofs.detail7",
  },
  {
    labelKey: "ecosystem.postQuantumKEM",
    value: "X25519 + ML-KEM-768",
    noteKey: "docs.sections.stealthAddresses.detail6",
  },
  {
    labelKey: "ecosystem.dataStructure",
    value: "Poseidon + Merkle",
    noteKey: "docs.sections.merkleTree.desc",
  },
  {
    labelKey: "ecosystem.deployment",
    valueKey: "footer.copyright",
    noteKey: "docs.sections.zkProofs.detail5",
  },
];

/**
 * Four steps.
 *
 * Step 04 does not use howItWorks.step4Desc. That key reads "Withdraw to any
 * wallet, zero trace", which is the claim this rebrand exists to remove, so the
 * step borrows the docs sentence about the same leg: the withdrawal is funded by
 * your wallet and paid to your wallet, so both hops stay linkable to it.
 */
const STEPS: { n: string; titleKey: string; descKey: string }[] = [
  { n: "01", titleKey: "howItWorks.step1Title", descKey: "howItWorks.step1Desc" },
  { n: "02", titleKey: "howItWorks.step2Title", descKey: "howItWorks.step2Desc" },
  { n: "03", titleKey: "howItWorks.step3Title", descKey: "howItWorks.step3Desc" },
  {
    n: "04",
    titleKey: "howItWorks.step4Title",
    descKey: "docs.sections.denominatedPools.detail8",
  },
];

/**
 * Six module cards out of the old fourteen.
 *
 * Dropped, and why. The copy lives in i18n/ (off limits), so it could not be
 * reworded and dropping was the only honest lever:
 *  multiHopRouting  "no observer can trace the path end to end"
 *  stealthTransfers "a one-time address that nobody can link back"
 *  privateSubscriptions "without the merchant or the chain seeing your wallet or
 *                        the amount": a vault's amount is on-chain
 *  confidentialBalances  encrypted on-chain balances, not shipped on devnet
 *  autoShield, privacyRouter, aiAgent, tokenSwap: automatic behaviour and an
 *                        on-device assistant a visitor cannot exercise today
 *
 * Four of the six survivors keep their TITLE but not their features.desc.*
 * sentence, which promised an absolute the amber admission at the top of this
 * page contradicts. The replacement is the docs.sections.* description of the
 * same module, which is written for readers who will check:
 *  zkProofs             "without revealing any of its details" becomes the
 *                       transparency fact, no trusted setup
 *  stealthMetaAddresses "a fresh, unlinkable address for every payment" becomes
 *                       the receive-leg fact, the recipient's own address is not
 *                       the one that appears
 *  subscriptionVaults   "pays a merchant a fixed amount over time, privately"
 *                       becomes the two modes, one of which is public
 *  noteSplitting        "a withdrawal never reveals your total" becomes the
 *                       comparative claim, smaller and harder to trace
 * privacyPools and serviceRegistry keep their own descriptions: neither states
 * more than devnet delivers.
 */
const FEATURES: { titleKey: string; descKey: string }[] = [
  { titleKey: "features.privacyPools", descKey: "features.desc.privacyPools" },
  { titleKey: "features.zkProofs", descKey: "docs.sections.zkProofs.detail6" },
  {
    titleKey: "features.stealthMetaAddresses",
    descKey: "docs.sections.stealthAddresses.desc",
  },
  {
    titleKey: "features.subscriptionVaults",
    descKey: "docs.sections.subscriptionVaults.desc",
  },
  {
    titleKey: "features.noteSplitting",
    descKey: "docs.sections.noteSplitting.desc",
  },
  {
    titleKey: "features.serviceRegistry",
    descKey: "features.desc.serviceRegistry",
  },
];

/**
 * The stack, as a keyed list.
 *
 * The two marquees in components/Ecosystem.tsx animate against keyframes that
 * live in app/globals.css, which this port may not touch, so the rows are simply
 * listed. Read as leader rows rather than a table because a table wants a header
 * for its second column and the dictionary has no word for "role": inventing one
 * in English is exactly the regression this pass is fixing, and the name/value
 * pair needs no header to be read. Two chips are gone with the marquee:
 * "STARK · Quantum-Safe Proofs" and "Goldilocks · Quantum-Safe Field" claim more
 * than the sayable fact, which is the note printed under the list.
 */
const STACK: { name: string; roleKey: string }[] = [
  { name: "Solana", roleKey: "l1Blockchain" },
  { name: "Anchor", roleKey: "smartContracts" },
  { name: "Winterfell", roleKey: "starkProver" },
  { name: "Poseidon", roleKey: "zkHash" },
  { name: "Merkle Trees", roleKey: "dataStructure" },
  { name: "Nullifiers", roleKey: "antiDoubleSpend" },
  { name: "Blake3", roleKey: "friHash" },
  { name: "ML-KEM-768", roleKey: "postQuantumKEM" },
  { name: "Curve25519", roleKey: "ecdh" },
  { name: "Circom", roleKey: "zkCircuits" },
  { name: "ark-circom", roleKey: "rustProver" },
  { name: "React Native", roleKey: "mobile" },
  { name: "Expo", roleKey: "appPlatform" },
  { name: "Next.js", roleKey: "webFramework" },
  { name: "TypeScript", roleKey: "language" },
  { name: "Docker", roleKey: "deployment" },
  { name: "SPL Tokens", roleKey: "tokenStandard" },
];

const VALUE_PROP = ["traders", "merchants", "builders"];

export default function HomeSections() {
  const t = useT();

  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      {/* The stage exists only to give the river a positioned, full-bleed box
          behind the hero. The canvas is aria-hidden and sits at z-index -1, so
          it changes nothing for a screen reader or for pointer targets. */}
      <div className="styx-hero-stage">
        <RiverCanvas className="styx-river" />
        <section className="styx-container styx-hero">
        {/* Brand word only. It was "Styx Protocol · Formerly Protocol 01 ·
            Private payments on Solana", three English clauses above the fold
            with no dictionary entry, one of them the retired brand. What Styx
            is gets said one line down, in both locales, by hero.desc1. */}
        <p className="styx-overline">Styx Protocol</p>

        {/* hero.kicker names the data at stake. It used to set up
            "NOTHING THEY CAN TRACE."; on its own it is a subject, not a promise. */}
        <p className="styx-index" style={{ marginTop: "1.6rem" }}>
          {t("hero.kicker")}
        </p>

        {/* The statement line is a translated string and is never split: a gleam
            or an italic would have to cut it, and the cut point differs per
            locale. See ./SerifHeading.tsx for why the class is not on the
            <h1> itself. */}
        <SerifHeading level={1}>{t("hero.desc1")}</SerifHeading>

        <div className="styx-hero-rule" aria-hidden="true" />

        <div className="styx-hero-body">
          <div>
            <p className="styx-lede">
              {t("hero.desc3")} {t("hero.desc4")}{" "}
              <strong>{t("footer.disclaimer")}</strong>
            </p>
            <div className="styx-btn-row" style={{ marginTop: "2.25rem" }}>
              {/* Unchanged destination: the live app. */}
              <a className="styx-btn" href="/app">
                {t("hero.launchApp")}
              </a>
              {/* Unchanged handler. It depends on id="download" existing on this
                  page, which it does, at the last section. */}
              <button
                type="button"
                className="styx-btn-ghost"
                onClick={() => {
                  document
                    .getElementById("download")
                    ?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                {t("waitlist.heroCta")}
              </button>
            </div>
          </div>

          {/* The one amber on the page, above the fold, where hero.headline and
              hero.traces used to be. This is the page's credibility, so it is
              also the block that most needed a real dictionary key rather than
              a paragraph of English: the docs already say the thing, in both
              locales, and say it more precisely than the JSX did.

              The title was roadmap.current, the single word "Current", which
              labels a phase on /roadmap and does not read as a heading for a
              disclosure. careers.context.badge is "Where we stand" and it
              introduces the same kind of admission on /careers, so it keeps its
              meaning here and both locales keep a real sentence. */}
          <div className="styx-admission">
            <p className="styx-admission-title">{t("careers.context.badge")}</p>
            <p className="styx-admission-body">
              {t("docs.sections.denominatedPools.desc")}
            </p>
          </div>
        </div>

          <div
            className="styx-gleam-rule"
            aria-hidden="true"
            style={{ marginTop: "clamp(2.5rem, 6vw, 4rem)" }}
          />
        </section>
      </div>

      {/* ── Facts ─────────────────────────────────────────────────────── */}
      <section
        className="styx-container styx-strip"
      >
        <div className="styx-grid styx-grid-4">
          {FACTS.map((fact, i) => (
            <Reveal
              key={fact.labelKey}
              className="styx-card styx-sweep styx-reveal"
              delay={i * 80}
            >
              <p className="styx-card-label">{t(fact.labelKey)}</p>
              <p className="styx-card-value">
                {fact.valueKey ? t(fact.valueKey) : fact.value}
              </p>
              <p className="styx-card-note">{t(fact.noteKey)}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Demo ──────────────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container-narrow">
          <p className="styx-index">{t("demo.badge")}</p>
          <SerifHeading level={2}>{t("demo.title")}</SerifHeading>
          {/* The element is infrastructure: src, controls, playsInline,
              preload and poster are unchanged. Only the frame around it is.
              The recording predates the rename, so the interface in it still
              carries the Protocol 01 identity. That caveat was a sentence of
              English with no key behind it; a French visitor was reading it in
              the wrong language, and it says nothing a viewer cannot see. */}
          <div style={{ marginTop: "2rem" }}>
            <Reveal className="styx-panel styx-reveal">
              <video
                src="/demo.mp4"
                controls
                playsInline
                preload="metadata"
                poster="/icon.png"
                style={{
                  display: "block",
                  width: "100%",
                  aspectRatio: "16 / 9",
                  background: "var(--styx-ink)",
                }}
              />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── 01 · The problem ──────────────────────────────────────────── */}
      <section id="problem" className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">{t("problem.badge")}</p>
            <SerifHeading level={2}>
              {t("problem.title")} {t("problem.titleHighlight")}
            </SerifHeading>
          </div>
          <div>
            {/* Both dictionary values carry <strong> tags in every locale, so the
                HTML rendering is kept. styx-prose already styles strong. */}
            <Reveal className="styx-prose styx-reveal">
              <p dangerouslySetInnerHTML={{ __html: t("problem.subtitle1") }} />
              <p dangerouslySetInnerHTML={{ __html: t("problem.subtitle2") }} />
            </Reveal>

            {/* The one statistic on this page that needs no source: it is a
                property of a public ledger, and any explorer shows it. */}
            <div style={{ marginTop: "2.5rem" }}>
              <Reveal className="styx-panel styx-reveal" delay={60}>
                <div className="styx-panel-head">
                  <SerifHeading level={3} innerStyle={{ margin: 0 }}>
                    {t("problem.stat1Value")} {t("problem.stat1Label")}
                  </SerifHeading>
                </div>
                <div className="styx-panel-body">
                  <p className="styx-card-note">{t("problem.stat1Desc")}</p>
                </div>
              </Reveal>
            </div>

            {/* The two ledger captions are problem.without and problem.with,
                the pair this comparison was written for, reworded in the
                dictionary from "WITHOUT PROTOCOL 01" and "WITH PROTOCOL 01" to
                "Standard chain" and "Shielded pool". An earlier pass left the
                brand behind by borrowing two unrelated keys instead, and the
                second one was explorer.stat.anonSet, a counter label from
                /explorer: the comparison then read "Standard chain" against
                "Shielded Notes", which is not a pair. Renaming the two keys
                fixes both the brand and the parallel, since nothing else
                renders them (components/Problem.tsx is not imported anywhere). */}
            <div className="styx-grid styx-grid-2" style={{ marginTop: "2rem" }}>
              <Reveal className="styx-card styx-reveal">
                <p className="styx-card-label">{t("problem.without")}</p>
                <div style={{ display: "grid", gap: "0.45rem" }}>
                  <p className="styx-mono">{t("problem.sent100")}</p>
                  <p className="styx-mono">{t("problem.received50k")}</p>
                  <p className="styx-mono">{t("problem.identityExposed")}</p>
                </div>
                <p className="styx-note" style={{ marginTop: "1.15rem" }}>
                  {t("problem.exposedStatus")}
                </p>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={80}>
                <p className="styx-card-label">{t("problem.with")}</p>
                <div style={{ display: "grid", gap: "0.45rem" }}>
                  <p>
                    <span className="styx-mono styx-redacted">
                      {t("problem.hiddenSent")}
                    </span>
                  </p>
                  <p>
                    <span className="styx-mono styx-redacted">
                      {t("problem.hiddenReceived")}
                    </span>
                  </p>
                  <p>
                    <span className="styx-mono styx-redacted">
                      {t("problem.hiddenIdentity")}
                    </span>
                  </p>
                </div>
                {/* The closing line of the other card, in the same slot, so the
                    two cards end the same way: problem.exposedStatus states
                    what a transparent ledger shows, problem.anonymousStatus
                    states what the pool stores. It was a leader row reading
                    "Proof .... post-quantum, no trusted setup", a specification
                    fragment where the left card has a sentence, which broke the
                    parallel this whole panel is built on. */}
                <p className="styx-note" style={{ marginTop: "1.15rem" }}>
                  {t("problem.anonymousStatus")}
                </p>
              </Reveal>
            </div>

            {/* The redaction above is a data model, not a promise, and this is
                the sentence that says so in both locales: the set does not hide
                you yet, because a withdrawal still publishes the commitment of
                the deposit it spends. */}
            <p className="styx-note" style={{ marginTop: "1.25rem" }}>
              {t("explorer.anon.subtitle")}
            </p>
          </div>
        </div>
      </section>

      {/* ── 02 · How it works ─────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">{t("howItWorks.badge")}</p>
            <SerifHeading level={2}>
              {t("howItWorks.title")} {t("howItWorks.titleHighlight")}
            </SerifHeading>
          </div>
          <div>
            <ul className="styx-steps">
              {STEPS.map((step, i) => (
                <Reveal
                  as="li"
                  key={step.n}
                  className="styx-step styx-reveal"
                  delay={i * 60}
                >
                  <span className="styx-step-index">
                    {t("howItWorks.step")} {step.n}
                  </span>
                  <div>
                    <SerifHeading level={3}>{t(step.titleKey)}</SerifHeading>
                    <p className="styx-step-body">{t(step.descKey)}</p>
                  </div>
                </Reveal>
              ))}
            </ul>

            {/* Replaces the "Instant operations · ~5s shield · Zero traces"
                strip. No timing appears here until a benchmark can be published
                next to it, and the chip that remains is a dictionary key rather
                than three English words. */}
            <div
              className="styx-btn-row"
              style={{ marginTop: "2rem", alignItems: "center" }}
            >
              <span className="styx-chip">
                <span className="styx-dot" aria-hidden="true" />
                {t("extensionPage.betaBadge")}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── 03 · Modules ──────────────────────────────────────────────── */}
      <section id="features" className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              03
            </span>
            {/* features.badge is "14 Privacy Modules" and cannot head six
                cards, so the index borrows the nav's own word for this
                section. */}
            <p className="styx-index">{t("nav.features")}</p>
            <SerifHeading level={2}>{t("features.title2")}</SerifHeading>
          </div>
          <div>
            <div className="styx-grid styx-grid-3">
              {FEATURES.map((feature, i) => (
                <Reveal
                  key={feature.titleKey}
                  className="styx-card styx-sweep styx-reveal"
                  delay={(i % 3) * 80}
                >
                  <p className="styx-card-label">
                    {String(i + 1).padStart(2, "0")}
                  </p>
                  <p className="styx-card-value">{t(feature.titleKey)}</p>
                  <p className="styx-card-note">{t(feature.descKey)}</p>
                </Reveal>
              ))}
            </div>

            {/* One link, no chip. The chip here was docs.footerDevnet, "Devnet
                Only", which is the fourth print of the same two words on this
                page: the band above already carries extensionPage.betaBadge
                ("Beta · Devnet"), the facts grid states the position in full,
                and the footer states it again. The status is not more true for
                being repeated next to a link into /docs. */}
            <div
              className="styx-btn-row"
              style={{ marginTop: "2rem", alignItems: "center" }}
            >
              <Link className="styx-link" href="/docs">
                {t("features.exploreDocs")}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── 04 · Why it pays ──────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              04
            </span>
            <p className="styx-index">{t("valueProp.badge")}</p>
            <SerifHeading level={2}>
              {t("valueProp.titleLine1")} {t("valueProp.titleLine2")}
            </SerifHeading>
          </div>
          <div>
            {/* Tag and title only. All three bodies made claims that cannot be
                stood behind today (invisible entries and exits, "no compliance
                liability", "live in days, not quarters") and they live in i18n,
                so they are dropped rather than softened. */}
            <div className="styx-grid styx-grid-3">
              {VALUE_PROP.map((key, i) => (
                <Reveal
                  key={key}
                  className="styx-card styx-sweep styx-reveal"
                  delay={i * 80}
                >
                  <p className="styx-card-label">{t(`valueProp.${key}Tag`)}</p>
                  <SerifHeading level={3} innerStyle={{ margin: 0 }}>
                    {t(`valueProp.${key}Title`)}
                  </SerifHeading>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── 05 · The stack ────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              05
            </span>
            <p className="styx-index">{t("ecosystem.badge")}</p>
            <SerifHeading level={2}>
              {t("ecosystem.title")} {t("ecosystem.titleHighlight")}
            </SerifHeading>
          </div>
          <div>
            <div className="styx-panel">
              <div className="styx-panel-head">
                <p className="styx-card-label" style={{ margin: 0 }}>
                  {t("ecosystem.technologies")}
                </p>
              </div>
              <div className="styx-panel-body">
                {STACK.map((tech) => (
                  <div className="styx-row" key={tech.name}>
                    <span className="styx-row-key">{tech.name}</span>
                    <span className="styx-row-leader" />
                    <span className="styx-row-value">
                      {t(`ecosystem.${tech.roleKey}`)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {/* What sits in the repository, not a count and not a claim about
                what is shipped. On the part that gets asked about most, the
                dictionary already has the exact sentence. */}
            <p className="styx-note" style={{ marginTop: "1.25rem" }}>
              {t("docs.sections.poseidonHash.detail5")}
            </p>
          </div>
        </div>
      </section>

      {/* ── 06 · The invitation ───────────────────────────────────────── */}
      {/* id="download" is a contract: components/Footer.tsx links to #download
          from every other route, and the hero button scrolls to it. */}
      <section id="download" className="styx-section styx-section-alt">
        <div className="styx-container-narrow">
          <p className="styx-index">{t("waitlist.badge")}</p>
          {/* cta.title + cta.titleHighlight read "Ready to become invisible",
              which this rebrand does not publish. footer.ctaSubtitle takes the
              slot, and its value is reworded in the dictionary: it used to read
              "Self-custody, open source, no KYC. Live on devnet.", which is
              hero.desc3 + hero.desc4 said twice, so the closing section opened
              by repeating the top of the page instead of inviting anyone. This
              page is its only consumer.

              The body below keeps waitlist.subtitle1, whose value said
              "Protocol 01 opens in waves": the brand word is reworded in the
              dictionary, the sentence is not. /waitlist dropped the same key
              rather than publish the retired name (see
              app/waitlist/WaitlistJoin.tsx), which left this route as the last
              place it was served. */}
          <SerifHeading level={2}>{t("footer.ctaSubtitle")}</SerifHeading>
          <div className="styx-prose" style={{ marginTop: "1.75rem" }}>
            <p>{t("waitlist.subtitle1")}</p>
            <p>{t("waitlist.subtitle2")}</p>
          </div>

          <div style={{ marginTop: "2.5rem" }}>
            <WaitlistPanel source="cta" />
          </div>

          {/* WAITLIST MODE: the Android APK card and the Chrome extension card
              are paused while double opt-in signups run. Restore this block at
              public launch; it uses APK_URL above and the Link already imported.
          <div className="styx-grid styx-grid-2" style={{ marginTop: "2rem" }}>
            <a
              className="styx-card styx-sweep"
              href={APK_URL}
              download="protocol-01-v1.0.3.apk"
            >
              <p className="styx-card-label">{t("cta.android")}</p>
              <p className="styx-card-value">{t("cta.androidDesc")}</p>
              <p className="styx-card-note">{t("extensionPage.betaBadge")}</p>
            </a>
            <Link className="styx-card styx-sweep" href="/extension">
              <p className="styx-card-label">{t("cta.chromeExtension")}</p>
              <p className="styx-card-value">{t("cta.chromeDesc")}</p>
              <p className="styx-card-note">{t("extensionPage.compat")}</p>
            </Link>
          </div>
          WAITLIST MODE end */}

          <div className="styx-btn-row" style={{ marginTop: "2rem" }}>
            <a
              className="styx-btn-ghost"
              href="https://discord.gg/EfqnVmb2dV"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("cta.joinDiscord")}
            </a>
          </div>

          {/* The closing line was the page's one text gleam, on the brand word,
              over a sentence about the river the Greek gods swore by. It was
              also two sentences of English with no key behind them, so it is
              gone. StyxHeader still gleams FOUNDER, which keeps the gesture on
              the site. Restoring a closing line here needs a dictionary entry
              first, not a paragraph in the JSX. */}
        </div>
      </section>
    </>
  );
}
