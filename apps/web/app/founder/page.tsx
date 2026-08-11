"use client";

import { useT } from "@/i18n";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";

/**
 * /founder, the destination of the gleaming FOUNDER word in the nav.
 *
 * Presentation only. Nothing behavioural was touched:
 *  - `useT()` stays, and every sentence on this page comes out of a dictionary
 *    key, so French is whole. That is also why the page keeps "use client".
 *  - PROJECT_START, daysSinceStart and the six stat keys are unchanged.
 *  - the three external links keep their href, target and rel; the portrait
 *    keeps its src and alt; /#download keeps the waitlist label.
 * Reveal + `styx-reveal` replace the old framer-motion variants, which were
 * pure decoration. The dead `icon` fields went with them.
 *
 * COPY, and the two places it is still not clean:
 *
 *  1. Numbers. The stat cards are countable: 12 is the 13 ids under
 *     [programs.devnet] in Anchor.toml less p01_mugen, which belongs to another
 *     project, and 7 is the AIR modules under stark/src/air with mod.rs set
 *     aside. The dictionaries disagree: founder.bio and
 *     founder.timeline.protocol01.desc both still enumerate "14 Solana
 *     programs, 7 STARK circuits, 3 client apps, 11 SDKs". 14 is wrong, and 11
 *     SDKs cannot be counted from this repository at all. i18n/ is off limits
 *     from this page, so rather than print 14 a few centimetres above a card
 *     that says 12, the page drops that one sentence. See dropBuildInventory
 *     below, which is the only string surgery in this file and is meant to be
 *     deleted the day the dictionaries say 12.
 *
 *  2. founder.mission2 is no longer rendered. It claimed privacy "with
 *     cryptographic guarantees" that "doesn't depend on anyone keeping their
 *     promise", set against "mixers, relayers that see your data". The
 *     deployment does not support that: p01_relayer sits in the payment path,
 *     as the scope card below says out loud, and a withdrawal republishes the
 *     commitment its deposit created. The first port left the key in and put an
 *     English correction underneath it, which meant French visitors read the
 *     claim with nothing beside it. Dropping the key removes the claim in both
 *     locales. Restoring it needs a founder decision on the sentence itself,
 *     not a page edit.
 *
 * The page's one gleam is the word "Slashy" in the hero. Nothing else on this
 * page may take a styx-gleam class.
 */

const timeline = [
  { year: "2007", key: "origin" },
  { year: "2019", key: "coding" },
  { year: "2022", key: "ecommerce" },
  { year: "2023", key: "bachelor" },
  { year: "2023-24", key: "captnboat" },
  { year: "2025", key: "master" },
  { year: "2025", key: "freelance" },
  { year: "2026", key: "protocol01" },
];

// Project start: January 18, 2026
const PROJECT_START = new Date('2026-01-18');
const daysSinceStart = () => Math.floor((Date.now() - PROJECT_START.getTime()) / 86_400_000);

/**
 * Same six keys, same order. `programs` and `circuits` agree with what the
 * repository contains, and `source` names the file a stranger can open to check
 * the figure. Those tokens are paths and dates on purpose: they read the same in
 * English and in French, so no untranslated prose creeps back onto the page.
 */
const stats: { value: string; labelKey: string; source?: string }[] = [
  { value: "7+", labelKey: "yearsCode" },
  {
    value: "12",
    labelKey: "programs",
    source: "Anchor.toml [programs.devnet] - p01_mugen",
  },
  { value: "7", labelKey: "circuits", source: "stark/src/air/*.rs" },
  { value: String(daysSinceStart()), labelKey: "days", source: "2026-01-18" },
  { value: "1", labelKey: "dev" },
  { value: "3", labelKey: "apps", source: "mobile / extension / web" },
];

/**
 * The four scope cards. Every line here is checkable in the repository, and the
 * claims the old copy could not support are gone: no "hot path" without a
 * published benchmark, no "mixing", no "privacy pools", and the quantum card
 * says out loud where the classical half stays classical.
 *
 * `p01_relayer` is a frozen program name and is written verbatim.
 */
const built = [
  {
    titleKey: "onchain",
    items: [
      "Solana programs in Anchor and Rust",
      "Shielded pool with a STARK-gated unshield",
      "On-chain STARK verifier over Goldilocks, FRI included",
      "Registry, relayer and fee-splitter programs",
    ],
  },
  {
    titleKey: "clients",
    items: [
      "Mobile app in Expo and React Native",
      "Chrome extension on MV3",
      "This web app, on Next.js 16",
      "Merchant SDK demo and documentation",
    ],
  },
  {
    titleKey: "privacy",
    items: [
      "Stealth addresses: X25519 + ML-KEM-768 (FIPS 203)",
      "Denominated notes in one shielded pool",
      "p01_relayer, which submits the transaction on the payer's behalf",
      "A deposit can still be matched to the withdrawal that spends it",
    ],
  },
  {
    titleKey: "quantum",
    items: [
      "Proofs from Poseidon and Merkle trees, no elliptic curves",
      "Winternitz one-time signature vault (WOTS+)",
      "Hash-timelock vault",
      "Transaction signatures stay Ed25519: Solana verifies nothing else",
    ],
  },
];

/**
 * The dictionaries put real line breaks inside founder.bio and
 * founder.mission1/3, and the old page leaned on Tailwind's
 * `whitespace-pre-line` to honour them. styx.css has no such utility, so the
 * string is split and each line becomes a paragraph, which is what the copy
 * wanted in the first place. Never rewrite the strings to avoid this.
 */
function lines(value: string): string[] {
  return value.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Drops the one sentence that enumerates the build.
 *
 * founder.bio and founder.timeline.protocol01.desc both carry a stale
 * inventory: "14 Solana programs, 7 STARK circuits, 3 client apps, and 11 SDKs
 * on npm". Anchor.toml puts the program count at 12 and the SDK count is not
 * countable here, so the sentence is false in both locales while the stat card
 * beside it is right. i18n/ cannot be edited from this page, so the sentence is
 * withheld instead of contradicted.
 *
 * The marker is "STARK": in English and in French that word appears in the
 * inventory sentence and in no other sentence of founder.bio or of any
 * founder.timeline entry, which is what makes a locale-independent match
 * possible. Sentences are joined back with ". ", so only the separator is
 * rebuilt and the surviving text is verbatim dictionary copy.
 *
 * Delete this function, and its two call sites, the day the dictionaries say 12.
 */
const BUILD_INVENTORY_MARKER = "STARK";

function dropBuildInventory(text: string): string {
  return text
    .split(". ")
    .filter((sentence) => !sentence.includes(BUILD_INVENTORY_MARKER))
    .join(". ");
}

const LINK_ICON_SIZE = 15;

export default function FounderPage() {
  const t = useT();

  return (
    <StyxShell>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        {/* Brand name only. There is no dictionary key for a founder overline,
            and an English one here would go untranslated. */}
        <p className="styx-overline">Styx Protocol</p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1.25rem",
            flexWrap: "wrap",
            marginTop: "2rem",
          }}
        >
          {/* Hairline frame, no halo. src and alt are untouched. */}
          <div
            className="styx-panel"
            style={{ width: "8rem", height: "8rem", overflow: "hidden" }}
          >
            <img
              src="/images/founder-slashy.png"
              alt="Slashy"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          </div>
          {/* Replaces the old SOLO DEV badge. Built from the stat key so it
              speaks French too. */}
          <span className="styx-chip">
            <span className="styx-dot" aria-hidden="true" />
            1 {t('founder.stats.dev')}
          </span>
        </div>

        <h1 className="styx-h1">
          <span className="styx-gleam-strong">Slashy</span>
        </h1>

        <p className="styx-index" style={{ marginTop: "1.1rem" }}>
          {t('founder.role')}
        </p>

        <div className="styx-hero-rule" aria-hidden="true" />

        <div className="styx-hero-body">
          <div className="styx-prose">
            {lines(t('founder.bio'))
              .map(dropBuildInventory)
              .filter((line) => line.trim().length > 0)
              .map((line, i) => (
                <p key={`bio-${i}`}>{line}</p>
              ))}
          </div>

          <div>
            <div className="styx-btn-row">
              <a
                href="https://github.com/IsSlashy"
                target="_blank"
                rel="noopener noreferrer"
                className="styx-btn-ghost"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width={LINK_ICON_SIZE} height={LINK_ICON_SIZE} aria-hidden="true"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                GitHub
              </a>
              <a
                href="https://x.com/Slashy_fx"
                target="_blank"
                rel="noopener noreferrer"
                className="styx-btn-ghost"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width={LINK_ICON_SIZE} height={LINK_ICON_SIZE} aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                @Slashy_fx
              </a>
              {/* Same site, original domain. The URL is frozen DNS and Vercel
                  configuration, so it stays verbatim. The label is the old
                  page's "Website", taken from the one dictionary key that holds
                  that word, so the retired brand is not printed as text and the
                  label is not English-only. */}
              <a
                href="https://protocol-01.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="styx-btn-ghost"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width={LINK_ICON_SIZE} height={LINK_ICON_SIZE} aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                {t('sdkDemo.formWebsite')}
              </a>
            </div>
          </div>
        </div>

        {/* The one amber on this page. Nothing else may use it. Both halves are
            dictionary keys, so the admission survives in French. */}
        <div
          className="styx-admission"
          style={{ marginTop: "clamp(2.5rem, 6vw, 3.5rem)" }}
        >
          <p className="styx-admission-title">{t('roadmap.devnetOnly')}</p>
          <p className="styx-admission-body">{t('footer.disclaimer')}</p>
        </div>
      </section>

      {/* ── The figures ───────────────────────────────────────────────────
          A band, not a numbered chapter: the dictionaries have no key for a
          heading here, and an English one would not translate. The old page
          put these cards straight under the hero with no heading either. */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container">
          <div className="styx-grid styx-grid-3">
            {stats.map((s, i) => (
              <Reveal
                key={s.labelKey}
                className="styx-card styx-reveal"
                delay={i * 70}
              >
                <p className="styx-card-label">
                  {t(`founder.stats.${s.labelKey}`)}
                </p>
                <p className="styx-card-value">{s.value}</p>
                {s.source ? (
                  <p className="styx-mono" style={{ margin: 0 }}>
                    {s.source}
                  </p>
                ) : null}
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 01 · Mission ─────────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">{t('founder.missionBadge')}</p>
            <h2 className="styx-h2">{t('founder.missionTitle')}</h2>
          </div>
          <div>
            <Reveal className="styx-panel styx-sweep styx-reveal">
              <div className="styx-panel-body">
                <div className="styx-prose">
                  {lines(t('founder.mission1')).map((line, i) => (
                    <p key={`m1-${i}`}>{line}</p>
                  ))}
                  {/* founder.mission2 is deliberately not rendered. See the
                      note at the top of this file. */}
                  {lines(t('founder.mission3')).map((line, i) => (
                    <p key={`m3-${i}`}>
                      <strong>{line}</strong>
                    </p>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── 02 · Journey ─────────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">{t('founder.journeyBadge')}</p>
            <h2 className="styx-h2">{t('founder.journeyTitle')}</h2>
          </div>
          <div>
            <ul className="styx-steps">
              {timeline.map((item, i) => (
                <Reveal
                  key={item.key}
                  as="li"
                  className="styx-step styx-reveal"
                  delay={i * 60}
                >
                  <span className="styx-step-index">{item.year}</span>
                  <div>
                    <h3 className="styx-h3">
                      {t(`founder.timeline.${item.key}.title`)}
                    </h3>
                    <p className="styx-step-body">
                      {dropBuildInventory(
                        t(`founder.timeline.${item.key}.desc`),
                      )}
                    </p>
                  </div>
                </Reveal>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── 03 · Scope ───────────────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              03
            </span>
            <p className="styx-index">{t('founder.builtBadge')}</p>
            <h2 className="styx-h2">{t('founder.builtTitle')}</h2>
          </div>
          <div>
            <div className="styx-grid styx-grid-2">
              {built.map((card, i) => (
                <Reveal
                  key={card.titleKey}
                  className="styx-card styx-sweep styx-reveal"
                  delay={i * 80}
                >
                  <h3 className="styx-h3">
                    {t(`founder.built.${card.titleKey}`)}
                  </h3>
                  <ul
                    style={{
                      listStyle: "none",
                      display: "grid",
                      gap: "0.5rem",
                      margin: 0,
                      padding: 0,
                    }}
                  >
                    {card.items.map((item) => (
                      <li key={item} className="styx-mono">
                        <span className="styx-check" aria-hidden="true">
                          &#10003;
                        </span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="styx-gleam-rule" aria-hidden="true" />

      {/* ── The invitation ───────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container-narrow styx-center">
          <h2 className="styx-h2">{t('founder.cta')}</h2>
          <div
            className="styx-btn-row"
            style={{ justifyContent: "center", marginTop: "2.25rem" }}
          >
            <a
              className="styx-btn"
              href="https://x.com/Slashy_fx"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('founder.ctaTwitter')}
            </a>
            {/* WAITLIST MODE: label switched from founder.ctaDownload ("Try the App") to the waitlist CTA, restore at public launch */}
            <a className="styx-btn-ghost" href="/#download">
              {t('waitlist.heroCta')}
            </a>
          </div>
        </div>
      </section>
    </StyxShell>
  );
}
