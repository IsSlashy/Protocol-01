"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useT } from "@/i18n";
import StyxShell from "../_styx/StyxShell";

/**
 * /privacy, the privacy policy, in the Styx voice.
 *
 * Presentation only. The page has no fetch, no state, no guard: the single piece
 * of infrastructure is `useT()`, which is why the file is a client component and
 * why it stays one. Every visible string comes from a t() key spelled exactly as
 * it was before, so English and French both keep their copy. Nothing on this page
 * is written in English by hand: a hand-written paragraph on a translated page
 * silently deletes the French for a French reader.
 *
 * THE PAGE FILTERS THE DICTIONARY, AND THE FILTER FAILS CLOSED. i18n/ is off
 * limits from this directory, so a paragraph that is true except for one clause
 * has that clause cut and keeps every other word, in whichever language the
 * visitor reads (CLAUSE_CUTS below). What is new is the second stage: after the
 * cut, the same untrue idea is looked for again as a pattern (UNTRUE_RESIDUE),
 * and a string that still carries it is not rendered at all, heading included.
 *
 * That second stage is the whole point. The first version of this filter cut six
 * verbatim literals and shipped whatever came out, so a reworded dictionary
 * string, and two copy sweeps crossed every locale in the three days before this
 * was written, would have silently put a false clause back into a legal document
 * with nothing watching. The worst case is now a missing paragraph instead of a
 * false one, and __tests__/pages/PrivacyPage.test.tsx renders both locales, fails
 * if an untrue idea reaches the page, and fails if a disclosure that should have
 * survived the cut went missing because a literal drifted.
 *
 * The permanent fix is still a rewrite in i18n/en.ts and i18n/fr.ts, and it is
 * proposed alongside this change. Because the filter is a gate and not a
 * rewriter, every key below renders itself the moment honest text lands there,
 * and renders nothing until then. No wording is invented in this file.
 *
 * FILTERED, ONE CLAUSE CUT, THE REST OF THE PARAGRAPH SURVIVES TRANSLATED:
 *
 *   privacyPolicy.s3.sub32p, section 3.2
 *     lists "decoy mechanisms" among the shipped defences. No decoy and no
 *     cover-traffic mechanism exists; that design is parked. Everything else in
 *     the paragraph, including the admission that transaction signatures and
 *     timestamps are inherently public, is true and stays: that admission is the
 *     disclosure which protects the reader. Dropping the whole subsection, as the
 *     first port did, also left the document numbered 3.1, 3.3, 3.4, and a
 *     numbering gap in a policy reads as a redaction.
 *
 *   privacyPolicy.s4.keys.k2.desc
 *     "preventing observers from linking payments to a single wallet" is an
 *     unlinkability claim. One-time addresses do exist, so that half stays.
 *
 *   privacyPolicy.s4.keys.k4.desc
 *     "In both cases, your secret data (nullifiers, note secrets) never leaves
 *     your control unencrypted" is false for the remote prover, which receives
 *     them. The disclosure that a prover service exists at all is the half worth
 *     keeping, so the sentence goes and the disclosure stays.
 *
 * WITHHELD ENTIRELY, TERM AND DESCRIPTION TOGETHER, until the dictionary is
 * honest. A suppressed description under a kept heading is the worst of the three
 * outcomes, because the headline keeps the claim and the evidence is gone, so
 * honest() returns null and the caller renders no row at all:
 *
 *   privacyPolicy.s4.keys.k1.term / .desc, shielded pools
 *     "quantum-resistant" STARK and "the link between depositor and withdrawer is
 *     cryptographically broken". It is not broken: the withdrawal republishes the
 *     deposit commitment, so the pairing is trivial and there is no client-side
 *     fix. This is the exact claim the rebrand was called to stop making.
 *
 *   privacyPolicy.s4.keys.k3.term / .desc, Merkle commitments
 *     "computationally infeasible to determine which commitment belongs to which
 *     user". Same defect as above, and feasible today.
 *
 *   privacyPolicy.s6.i3
 *     "We do not operate user databases." lib/waitlist/store.ts is a real user
 *     store, keyed by email, behind KV_REST_API_URL / UPSTASH_REDIS_REST_URL, and
 *     it counts a country code per record.
 *
 * NOT RENDERED AND NOT COMING BACK:
 *
 *   privacyPolicy.s2.keys.k4.term / .desc
 *     "does not log IP addresses or track your physical location", sitting under
 *     the heading "Information We Do NOT Collect". middleware.ts reads
 *     x-vercel-ip-country on every request to this very page and writes the
 *     readable `styx-country` cookie; app/api/waitlist/route.ts reads x-real-ip /
 *     x-forwarded-for for a salted-hash hourly cap and stores the country code.
 *     The claim cannot be made true where it sits, so the key is proposed for
 *     deletion, and the honest version of that disclosure, together with Vercel
 *     hosting and the two Vercel scripts this page loads, is proposed for
 *     s5.outro, a string this page already renders.
 *
 *   privacyPolicy.s3.sub33i1 / .sub33i2
 *     "processed in memory only, never persisted" and "discarded immediately".
 *     Server-side behaviour with no published artifact: a reader cannot check
 *     either, so this page does not assert them.
 *
 * RESTORED, after the first port dropped it and left the reader with less
 * disclosure than the old page gave:
 *
 *   privacyPolicy.s6.i1, keys in Android Keystore / iOS Keychain
 *     Dropped in the first port as true of the mobile app only. The policy's
 *     declared scope IS the mobile app, the extension and the SDK (s1.p2), and
 *     apps/mobile writes `p01_mnemonic` through expo-secure-store, which is
 *     Keystore on Android and Keychain on iOS. Section 2 keeps the same class of
 *     claim in s2.keys.k1, so deleting this one left section 6 silent on key
 *     storage while section 2 still spoke.
 *
 * Jupiter (s5) was checked and KEPT: apps/mobile/services/jupiter/index.ts and
 * apps/extension/src/shared/services/jupiter.ts both use it, and the policy's
 * scope is the mobile app, the extension and the SDK, not this website alone.
 *
 * NO Reveal ON THIS PAGE, deliberately. Reveal renders data-revealed="false" on
 * the server and flips it in an effect, and styx.css:1081 sets that state to
 * opacity 0 wherever motion is welcome. With JavaScript off the effect never
 * runs, so a visitor would get the hero, ten numerals, ten headings and none of
 * the policy text. A legal document is the one page that has to be readable
 * without JavaScript, so the section bodies are plain divs and the scroll
 * animation is given up here. The fix that keeps both belongs in Reveal.
 *
 * Still owed, and not fixable from inside this directory: the body copy says
 * "Protocol 01" and "P-01" while the hero directly above it says Styx Protocol,
 * and the policy is dated February 23, 2026 although its text is being rewritten
 * now. Section 5 discloses Privy, Helius and Jupiter but not Vercel,
 * @vercel/analytics or @vercel/speed-insights, all three of which load on this
 * page. Writing any of that here would ship English into the French page, so all
 * three go up as dictionary edits instead of being patched into this file.
 */

/**
 * MEASURED DEFECT IN THE SHARED SHEET, worked around here, reported upstream.
 *
 * styx.css:69 opts headings out of the root stylesheet's Orbitron with
 * `.styx :is(h1, h2, h3, h4, h5, h6) { font-family: inherit; font-weight:
 * inherit; letter-spacing: normal }`. `:is()` takes the specificity of its most
 * specific argument, so that selector is (0,1,1) and it BEATS `.styx-h1`,
 * `.styx-h2` and `.styx-h3`, which are (0,1,0). Measured on this page in Chrome
 * at 1440px on 2026-08-11: `<h1 class="styx-h1">` computed to Inter while
 * `.styx-numeral` beside it, a `<span>` and so untouched by the opt-out, computed
 * to Newsreader. The sheet's own comment ("the serif is applied per class") is
 * not what ships, and every real heading on every Styx page is affected.
 *
 * The one-line fix belongs in styx.css (`:where(h1, …)` instead of
 * `:is(h1, …)`, since :where() contributes zero specificity and still beats the
 * root sheet's bare `h1`). app/_styx is off limits here, so the sheet's own
 * tokens are re-applied inline, where nothing can outrank them. Nothing is
 * invented: every value is read out of styx.css by variable wherever one exists.
 * app/explorer/page.tsx and app/(pay)/app/page.tsx reached the same workaround
 * with the same constant names, so one shared fix deletes all three at once.
 *
 * Dropping the semantic h1/h2/h3 for `<p className="styx-h1">` would also
 * restore the serif, and is refused: a policy of ten numbered sections is
 * exactly the document that needs a real heading outline.
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

/**
 * Stage one: the clauses cut out of the dictionary strings before rendering,
 * verbatim, English then French. A false clause may not ship in either language,
 * so the clause is cut and the rest of the paragraph survives translated. Nothing
 * else is touched: no word is added, no word is reordered. Which paragraph each
 * clause belongs to, and why the remainder is worth keeping, is in the file
 * header.
 *
 * These literals are fragile on purpose: matching a whole clause is what lets the
 * translated remainder through untouched. Their fragility is contained by stage
 * two, which does not depend on them at all.
 */
const CLAUSE_CUTS: readonly string[] = [
  ", and decoy mechanisms",
  " et des mécanismes de leurres",
  ", preventing observers from linking payments to a single wallet",
  ", empêchant les observateurs de relier les paiements à un seul wallet",
  " In both cases, your secret data (nullifiers, note secrets) never leaves your control unencrypted.",
  " Dans les deux cas, vos données secrètes (nullifiers, secrets de notes) ne quittent jamais votre contrôle en clair.",
];

/**
 * Stage two: the untrue ideas themselves, as patterns, English then French.
 *
 * Checked AFTER the cuts, and this is what makes the filter fail closed. A
 * literal in CLAUSE_CUTS stops matching the moment someone repunctuates or
 * rewords the dictionary, and the earlier version of this file then shipped the
 * false clause with no signal. Now a string whose untrue idea survived the cut is
 * refused, so the reader loses a paragraph instead of being told something false.
 *
 * Three of these patterns also gate strings that carry NO cut, because no clause
 * of them can be saved: they render only once i18n says something true. Nothing
 * in this list is a wording preference; each one is a claim measured false or
 * unverifiable, listed with its evidence in the file header.
 */
const UNTRUE_RESIDUE: readonly RegExp[] = [
  // s3.sub32p: decoys and cover traffic are parked, not shipped.
  /decoy/i,
  /leurre/i,
  // s4.keys.k2.desc: unlinkability of a payment to a wallet.
  /preventing observers/i,
  /empêchant les observateurs/i,
  // s4.keys.k4.desc: the remote prover does receive the secret inputs.
  /never leaves your control/i,
  /ne quittent jamais votre contrôle/i,
  // s4.keys.k1.desc, withheld whole: the deposit-to-withdrawal pairing is
  // trivial today, and the proof is hash-based rather than "quantum-resistant".
  /cryptographically broken/i,
  /cryptographiquement rompu/i,
  /quantum-resistant/i,
  /résistantes? au quantique/i,
  // s4.keys.k3.desc, withheld whole: the same pairing, feasible today.
  /computationally infeasible/i,
  /computationnellement infaisable/i,
  // s6.i3, withheld whole: lib/waitlist/store.ts is a user store keyed by email.
  /do not operate user databases/i,
  /n['’]exploitons aucune base de données/i,
];

/**
 * The dictionary string as this page is willing to print it, or null.
 *
 * null means "render nothing for this item, its heading included". A caller must
 * not print a term whose description came back null: a headline that keeps the
 * claim while the body that carried the evidence disappears is worse than either
 * printing both or printing neither.
 */
function honest(text: string): string | null {
  // A key that does not resolve comes back from t() as the key path itself, which
  // would print "privacyPolicy.s6.i3" at a reader. Deleted, renamed and not yet
  // written all land here, and all three count as absent rather than as copy.
  if (/^privacyPolicy\./.test(text)) return null;

  const cut = CLAUSE_CUTS.reduce(
    (out, clause) => out.split(clause).join(""),
    text,
  );

  return UNTRUE_RESIDUE.some((residue) => residue.test(cut)) ? null : cut;
}

/**
 * A section's heading, and the marginal numeral that repeats its number.
 *
 * THE NUMBER IS PRINTED IN THE HEADING, and that is deliberate after a measured
 * regression. The ten heading strings carry their own ordinal in both
 * dictionaries ("1. Our Commitment to Privacy", "1. Notre engagement pour la
 * confidentialité"). An earlier pass moved that ordinal out of the h2 and into
 * `.styx-numeral` alone, plus a clipped `.styx-sr-only` copy, to stop the number
 * appearing twice. What that actually shipped: `.styx-numeral` declares
 * `color: var(--styx-rule)`, which is rgba(234, 231, 223, 0.14) on #070709, near
 * 1.35:1, so on a ten-section policy that cites its own numbers (3.1 to 3.4 sit
 * inside section 3, and readers say "section 4") no sighted reader could read a
 * section number at all, while a screen reader still could.
 *
 * So the h2 prints the dictionary string whole, ordinal included, at
 * --styx-paper on --styx-ink, near 18:1. The oversized numeral stays, aria-hidden
 * and faint, and it is now genuinely what the sheet calls it: an editorial
 * gesture that repeats text already visible beside it, which is the one case
 * where a 1.35:1 mark is not withholding information from anybody. Nothing here
 * touches the shared sheet, and no ordinal is hardcoded: if a heading ever loses
 * its number, no numeral renders and the heading is still whole.
 */
function SectionLabel({ heading }: { heading: string }) {
  const ordinal = /^\s*(\d+)\./.exec(heading)?.[1] ?? null;

  return (
    <div className="styx-section-label">
      {ordinal ? (
        <span className="styx-numeral" aria-hidden="true">
          {ordinal.padStart(2, "0")}
        </span>
      ) : null}
      <h2 className="styx-h2" style={SERIF_H2}>
        {heading}
      </h2>
    </div>
  );
}

function TermStep({
  index,
  term,
  desc,
}: {
  index: string;
  term: string;
  desc: ReactNode;
}) {
  return (
    <li className="styx-step">
      <span className="styx-step-index">{index}</span>
      <div>
        <h3 className="styx-h3" style={SERIF_H3}>
          {term}
        </h3>
        <p className="styx-step-body">{desc}</p>
      </div>
    </li>
  );
}

export default function PrivacyPolicy() {
  const t = useT();

  /**
   * Section 4 is built from its keys rather than from four hand-placed rows,
   * because the step numbers have to follow what actually renders. Two of the four
   * descriptions are refused today, and hardcoded "01".."04" would have printed 01
   * then 02 for the third and fourth rows while claiming to be a list of four.
   * Each term travels with its own description, so a refused description takes its
   * heading out with it, and a term whose key does not resolve is dropped too.
   */
  const architecture = ["k1", "k2", "k3", "k4"]
    .map((k) => ({
      term: t(`privacyPolicy.s4.keys.${k}.term`),
      desc: honest(t(`privacyPolicy.s4.keys.${k}.desc`)),
    }))
    .filter(
      (row): row is { term: string; desc: string } =>
        row.desc !== null && !/^privacyPolicy\./.test(row.term),
    );

  /** The other two filtered strings, resolved once so each null is handled once. */
  const onChainData = honest(t("privacyPolicy.s3.sub32p"));
  const waitlistStore = honest(t("privacyPolicy.s6.i3"));

  return (
    <StyxShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        <p className="styx-overline">
          Styx Protocol &middot; {t("privacyPolicy.legalBadge")}
        </p>
        <h1 className="styx-h1" style={SERIF_H1}>
          {t("privacyPolicy.title")}
        </h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        {/* An amber admission used to sit beside this date, written in English by
            hand. It was the one untranslated block on a page where every other
            string is t(), so a French reader met English prose. It is gone rather
            than restyled: the honest lines it carried about devnet, the absent
            audit and the republished commitment need i18n keys this directory
            cannot add, and the shared footer states the devnet and audit status on
            every page already. */}
        <div className="styx-hero-body">
          {/* A date is evidence, so it sits in mono, not in a lede. */}
          <p className="styx-mono">
            {t("privacyPolicy.lastUpdatedLabel")}{" "}
            {t("privacyPolicy.lastUpdatedDate")}
          </p>
        </div>
      </section>

      {/* ── 1 · Commitment ─────────────────────────────────────────────── */}
      <section id="s1" className="styx-section">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s1.heading")} />
          <div>
            <div className="styx-prose">
              <p>{t("privacyPolicy.s1.p1")}</p>
              <p>{t("privacyPolicy.s1.p2")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 2 · What is not collected ──────────────────────────────────── */}
      <section id="s2" className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s2.heading")} />
          <div>
            <div className="styx-prose">
              <p>
                {t("privacyPolicy.s2.introBefore")}{" "}
                <strong>{t("privacyPolicy.s2.introWord")}</strong>{" "}
                {t("privacyPolicy.s2.introAfter")}
              </p>
            </div>
            <ul className="styx-steps">
              <TermStep
                index="01"
                term={t("privacyPolicy.s2.keys.k1.term")}
                desc={t("privacyPolicy.s2.keys.k1.desc")}
              />
              <TermStep
                index="02"
                term={t("privacyPolicy.s2.keys.k2.term")}
                desc={t("privacyPolicy.s2.keys.k2.desc")}
              />
              <TermStep
                index="03"
                term={t("privacyPolicy.s2.keys.k3.term")}
                desc={t("privacyPolicy.s2.keys.k3.desc")}
              />
              <TermStep
                index="04"
                term={t("privacyPolicy.s2.keys.k5.term")}
                desc={t("privacyPolicy.s2.keys.k5.desc")}
              />
            </ul>
          </div>
        </div>
      </section>

      {/* ── 3 · What is collected ──────────────────────────────────────── */}
      <section id="s3" className="styx-section">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s3.heading")} />
          <div>
            <div className="styx-stack-lg">
              <div>
                <h3 className="styx-h3" style={SERIF_H3}>
                  {t("privacyPolicy.s3.sub31Title")}
                </h3>
                <div className="styx-prose">
                  <p>{t("privacyPolicy.s3.sub31p")}</p>
                </div>
              </div>

              {/* 3.2. The paragraph's own subsection number lives inside the
                  string, so this document numbers 3.1, 3.2, 3.3, 3.4 again. The
                  decoy clause is cut and the metadata admission stays. If the
                  filter ever refuses the paragraph, the 3.2 heading goes with it:
                  a subsection title over nothing tells the reader there was
                  something here without telling them what. */}
              {onChainData ? (
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    {t("privacyPolicy.s3.sub32Title")}
                  </h3>
                  <div className="styx-prose">
                    <p>{onChainData}</p>
                  </div>
                </div>
              ) : null}

              <div>
                <h3 className="styx-h3" style={SERIF_H3}>
                  {t("privacyPolicy.s3.sub33Title")}
                </h3>
                <div className="styx-prose">
                  <p>{t("privacyPolicy.s3.sub33p")}</p>
                  <p>
                    <span className="styx-check" aria-hidden="true">
                      &#10003;
                    </span>
                    {t("privacyPolicy.s3.sub33i3")}
                  </p>
                </div>
              </div>

              <div>
                <h3 className="styx-h3" style={SERIF_H3}>
                  {t("privacyPolicy.s3.sub34Title")}
                </h3>
                <div className="styx-prose">
                  <p>{t("privacyPolicy.s3.sub34p")}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 4 · Architecture ───────────────────────────────────────────── */}
      <section id="s4" className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s4.heading")} />
          <div>
            <div className="styx-prose">
              <p>{t("privacyPolicy.s4.intro")}</p>
            </div>
            <ul className="styx-steps">
              {architecture.map((row, i) => (
                <TermStep
                  key={row.term}
                  index={String(i + 1).padStart(2, "0")}
                  term={row.term}
                  desc={row.desc}
                />
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── 5 · Third parties ──────────────────────────────────────────── */}
      <section id="s5" className="styx-section">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s5.heading")} />
          <div>
            <div className="styx-stack-lg">
              <div className="styx-prose">
                <p>{t("privacyPolicy.s5.intro")}</p>
              </div>

              <div className="styx-grid styx-grid-3">
                <div className="styx-card">
                  <p className="styx-card-value">
                    {t("privacyPolicy.s5.privyTerm")}
                  </p>
                  <p className="styx-card-note">
                    {t("privacyPolicy.s5.privyDescBefore")}{" "}
                    <a
                      href="https://privy.io/privacy"
                      className="styx-link"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t("privacyPolicy.s5.privyLink")}
                    </a>
                    .
                  </p>
                </div>
                <div className="styx-card">
                  <p className="styx-card-value">
                    {t("privacyPolicy.s5.heliusTerm")}
                  </p>
                  <p className="styx-card-note">
                    {t("privacyPolicy.s5.heliusDesc")}
                  </p>
                </div>
                <div className="styx-card">
                  <p className="styx-card-value">
                    {t("privacyPolicy.s5.jupiterTerm")}
                  </p>
                  <p className="styx-card-note">
                    {t("privacyPolicy.s5.jupiterDesc")}
                  </p>
                </div>
              </div>

              <div className="styx-prose">
                <p>{t("privacyPolicy.s5.outro")}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 6 · Storage ────────────────────────────────────────────────── */}
      <section id="s6" className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s6.heading")} />
          <div>
            <div className="styx-prose">
              <p>
                <span className="styx-check" aria-hidden="true">
                  &#10003;
                </span>
                {t("privacyPolicy.s6.i1")}
              </p>
              <p>
                <span className="styx-check" aria-hidden="true">
                  &#10003;
                </span>
                {t("privacyPolicy.s6.i2")}
              </p>
              {/* No check mark on this one. The other two bullets are protections
                  and the tick reads as reassurance; this line, once the dictionary
                  is honest, discloses a store that exists, and a disclosure
                  dressed as a reassurance is how the old copy went wrong. */}
              {waitlistStore ? <p>{waitlistStore}</p> : null}
            </div>
          </div>
        </div>
      </section>

      {/* ── 7 · Rights ─────────────────────────────────────────────────── */}
      <section id="s7" className="styx-section">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s7.heading")} />
          <div>
            <div className="styx-prose">
              <p>{t("privacyPolicy.s7.intro")}</p>
            </div>
            <ul className="styx-steps">
              <TermStep
                index="01"
                term={t("privacyPolicy.s7.keys.k1.term")}
                desc={t("privacyPolicy.s7.keys.k1.desc")}
              />
              <TermStep
                index="02"
                term={t("privacyPolicy.s7.keys.k2.term")}
                desc={t("privacyPolicy.s7.keys.k2.desc")}
              />
              <TermStep
                index="03"
                term={t("privacyPolicy.s7.keys.k3.term")}
                desc={t("privacyPolicy.s7.keys.k3.desc")}
              />
            </ul>
          </div>
        </div>
      </section>

      {/* ── 8 · Children ───────────────────────────────────────────────── */}
      <section id="s8" className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s8.heading")} />
          <div>
            <div className="styx-prose">
              <p>{t("privacyPolicy.s8.p")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 9 · Changes ────────────────────────────────────────────────── */}
      <section id="s9" className="styx-section">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s9.heading")} />
          <div>
            <div className="styx-prose">
              <p>{t("privacyPolicy.s9.p")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 10 · Contact ───────────────────────────────────────────────── */}
      <section id="s10" className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <SectionLabel heading={t("privacyPolicy.s10.heading")} />
          <div>
            <div className="styx-prose">
              <p>
                {t("privacyPolicy.s10.contactBefore")}{" "}
                {/* FROZEN LITERAL: this mailbox is what exists. Do not rename
                    the address to a styx-protocol.com one. */}
                <a className="styx-link" href="mailto:privacy@protocol-01.com">
                  privacy@protocol-01.com
                </a>
              </p>
              <p>
                {t("privacyPolicy.s10.socialBefore")}{" "}
                <a
                  href="https://x.com/Protocol01_"
                  className="styx-link"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("privacyPolicy.s10.socialTwitter")}
                </a>{" "}
                {t("privacyPolicy.s10.socialOr")}{" "}
                <a
                  href="https://discord.gg/EfqnVmb2dV"
                  className="styx-link"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("privacyPolicy.s10.socialDiscord")}
                </a>
                .
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Closing links ──────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container">
          {/* The page's single gleam. A policy should not sparkle anywhere else. */}
          <div className="styx-gleam-rule" aria-hidden="true" />
          <div className="styx-btn-row" style={{ marginTop: "2.5rem" }}>
            <Link href="/terms" className="styx-btn-ghost">
              {t("privacyPolicy.footer.terms")}
            </Link>
            <Link href="/licenses" className="styx-btn-ghost">
              {t("privacyPolicy.footer.licenses")}
            </Link>
            <Link href="/" className="styx-btn-ghost">
              {t("privacyPolicy.footer.home")}
            </Link>
          </div>
        </div>
      </section>
    </StyxShell>
  );
}
