"use client";

/**
 * Careers, ported to the Styx vocabulary.
 *
 * Presentation only. Everything load-bearing from the Protocol 01 version is
 * preserved: the Google JobPosting JSON-LD (same object, same
 * dangerouslySetInnerHTML mechanism, still the first thing rendered), both
 * application channels, the `#bd-cofounder` deep-link anchor that external job
 * boards and DMs point at, and `useT()` with the same i18n keys, which is the
 * only reason this file is a client component.
 *
 * framer-motion is gone, replaced 1:1 by Reveal + `styx-reveal`. Both were
 * purely decorative; Reveal degrades to always-visible.
 *
 * Every dictionary sentence the Protocol 01 page rendered is rendered again,
 * including `careers.context.p2`, which an earlier pass withheld for the claim
 * inside it. Two dictionary rewrites are filed against i18n/{en,fr}.ts, which a
 * page may not edit: `careers.context.p2` (it sold payments "a business can
 * install today" as private) and `careers.heroDesc` (it opens with the retired
 * product name). Until the heroDesc rewrite lands, the retired name is renamed
 * at render by `styxBrand`, see the marker on that function.
 */

import type { CSSProperties } from "react";
import {
  Briefcase,
  Clock,
  Mail,
  MapPin,
  MessageCircle,
  PieChart,
  Zap,
} from "lucide-react";
import { useT } from "@/i18n";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";

// Single source of truth for the application channels. The founder chose the
// direct personal address over careers@ so applications land in a mailbox that
// is known to work, and the public Discord as the second channel.
const APPLY_EMAIL = "amirramy.chatbi@gmail.com";
const APPLY_DISCORD = "https://discord.gg/EfqnVmb2dV";

// Internal target of the hero's primary link, and the id of section 04. A new
// anchor, not a replacement: `#bd-cofounder` is the one external job boards and
// DMs point at and it still marks section 02.
const APPLY_ANCHOR = "apply";

const MISSION_KEYS = ["m1", "m2", "m3", "m4", "m5", "m6"] as const;
const PROFILE_KEYS = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
const NOT_KEYS = ["n1", "n2", "n3"] as const;
const OFFER_KEYS = ["o1", "o2", "o3", "o4"] as const;

/**
 * The honest-state paragraphs, in render order.
 *
 * `p2` is back. An earlier pass dropped it here because it sold "private,
 * recurring on-chain payments a business can install today", which is not true:
 * a withdrawal republishes the deposit commitment, so pairing a deposit with its
 * withdrawal is trivial today and no client-side change closes it. Dropping the
 * paragraph was the wrong half of the fix though, because it also deleted the
 * true half (MIT open source) and left a section titled "The honest version"
 * quietly missing the one limitation a BD candidate has to be able to say out
 * loud. The rewrite that states the limitation is filed as a dictionary edit
 * against `careers.context.p2` in both locales.
 *
 * If that dictionary edit is ever reverted, this array goes back to
 * ["p1", "p3"] in the same commit: the old wording must not render.
 */
const CONTEXT_KEYS = ["p1", "p2", "p3"] as const;

/**
 * Google JobPosting structured data. `datePosted` is a literal, not `new Date()`:
 * a moving date would tell crawlers the posting is re-published on every render,
 * and Google demotes listings whose date keeps sliding.
 *
 * Only the two display strings were rebranded (`description`,
 * `hiringOrganization.name`), with the devnet/not-audited status added to the
 * description so the listing does not overstate either. `sameAs` and `logo`
 * carry the frozen "protocol-01" literal and are the real production domain:
 * they stay exactly as they are.
 */
const JOB_LD = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Co-founder, Business Development",
  description:
    "Co-founder role owning the entire commercial surface of Styx Protocol, a privacy layer for Solana running on devnet and not audited: first merchants on the payment SDK, ecosystem partnerships, narrative, and the fundraising track. Compensation is equity.",
  datePosted: "2026-08-06",
  employmentType: ["FULL_TIME", "PART_TIME"],
  hiringOrganization: {
    "@type": "Organization",
    name: "Styx Protocol",
    sameAs: "https://protocol-01.dev",
    logo: "https://protocol-01.dev/icon.png",
  },
  jobLocationType: "TELECOMMUTE",
  applicantLocationRequirements: { "@type": "Country", name: "Europe" },
  directApply: false,
};

/**
 * styx.css has `styx-check` and `styx-steps` but no plain bullet-list primitive,
 * so the list reset lives here. Layout only: no colour, font or spacing token is
 * invented locally. A shared `styx-list` / `styx-list-item` pair would delete
 * this from every ported page.
 */
const LIST_RESET: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.85rem",
};

/**
 * The role's facts (location, commitment, compensation, start) used to sit in
 * `styx-chip`s. Measured on 2026-08-11 at a 390px viewport: a chip is
 * `white-space: nowrap` with uppercase and 0.16em tracking, a primitive for
 * short status labels, and `careers.role.commitment` is a sentence in both
 * locales (43 chars in EN, 59 in FR). Because it cannot wrap it set the
 * min-content width of the section grid track and pushed the whole panel out of
 * the container: 39px off-screen in EN, 160px in FR, which also dragged every
 * mission paragraph past the right edge.
 *
 * So the facts are mono evidence lines instead, one per fact, wrapping freely.
 * Layout only: font, colour and size still come from `styx-mono`. The short
 * `careers.role.tag` stays a chip, which is what a chip is for.
 */
const META_ROW: CSSProperties = {
  listStyle: "none",
  margin: "0.9rem 0 0",
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem 1.5rem",
};

const META_ITEM: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  minWidth: 0,
};

/**
 * Every lucide icon on this page is a flex item: `styx-chip`, `styx-btn` and
 * `META_ITEM` are all flex lines. An `<svg>` keeps the default `flex-shrink: 1`,
 * so when the line is narrower than its content the icon, not the text, gives up
 * the pixels. Measured on 2026-08-11 in the running app: the Clock icon in the
 * meta row was 6.5px wide by 11px tall at a 390px viewport and 4.9px at 320px,
 * while desktop was clean, which is why it survived a desktop-only look. styx.css
 * fixes the same hazard on `.styx-dot` with `flex: none`; the icons say it too.
 * A shared `styx-icon` primitive would delete this from every ported page.
 */
const ICON_FIXED: CSSProperties = { flex: "none" };

/**
 * DICTIONARY LAG MARKER. Delete this function, its call site and this comment
 * together, the moment the `careers.heroDesc` rewrite lands.
 *
 * `careers.heroDesc` still opens with the retired product name in both locales
 * ("Protocol 01 is a privacy layer for Solana", fr: "Protocol 01 est une couche
 * de confidentialité pour Solana"), directly under an overline that says Styx
 * Protocol, on a page whose <title> and JobPosting organisation both say Styx
 * Protocol. This page may not edit i18n/{en,fr}.ts, and rewriting the sentence
 * in English here would silently drop the French. The brand token is byte for
 * byte identical in English and French, so renaming just the token is
 * locale-safe: no translated sentence is lost and no locale is favoured.
 *
 * Display copy only. The frozen literals are `p01`, `protocol-01`, `P01_` and
 * `com.protocol01` where they are storage keys, HKDF labels, PDA seeds or memo
 * prefixes. This touches none of them, and in particular not the `sameAs` and
 * `logo` URLs in JOB_LD, which are the real production domain.
 */
const RETIRED_PRODUCT_NAME = /Protocol 01/g;

function styxBrand(sentence: string): string {
  return sentence.replace(RETIRED_PRODUCT_NAME, "Styx Protocol");
}

export default function CareersPage() {
  const t = useT();

  // The dictionary supplies values without labels: the icon carries the meaning,
  // exactly as it did before.
  const meta = [
    {
      icon: <MapPin size={11} style={ICON_FIXED} aria-hidden />,
      value: t("careers.role.location"),
    },
    {
      icon: <Clock size={11} style={ICON_FIXED} aria-hidden />,
      value: t("careers.role.commitment"),
    },
    {
      icon: <PieChart size={11} style={ICON_FIXED} aria-hidden />,
      value: t("careers.role.comp"),
    },
    {
      icon: <Zap size={11} style={ICON_FIXED} aria-hidden />,
      value: t("careers.role.start"),
    },
  ];

  // heroTitle carries a literal "\n" in every locale. Line one states the fact,
  // line two is the thesis of the page and takes the single gleam this page
  // spends. If a locale ever loses the newline, the title still renders whole.
  const heroTitle = t("careers.heroTitle");
  const breakAt = heroTitle.indexOf("\n");
  const heroLead = breakAt === -1 ? heroTitle : heroTitle.slice(0, breakAt);
  const heroTail = breakAt === -1 ? null : heroTitle.slice(breakAt + 1);

  // Identical string to the one the Protocol 01 page built inline. One mailto on
  // the page, in the apply panel, labelled with the address it opens.
  const applyHref = `mailto:${APPLY_EMAIL}?subject=${encodeURIComponent(
    "Co-founder BD application",
  )}`;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JOB_LD) }}
      />

      <StyxShell>
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="styx-container styx-hero">
          <p className="styx-overline">
            Styx Protocol &middot; {t("careers.badge")}
          </p>
          <p style={{ margin: "1.1rem 0 0" }}>
            <span className="styx-chip">
              <span className="styx-dot" aria-hidden="true" />
              {t("careers.openCount")}
            </span>
          </p>
          <h1 className="styx-h1">
            {heroLead}
            {heroTail ? (
              <span className="styx-gleam-strong" style={{ display: "block" }}>
                {heroTail}
              </span>
            ) : null}
          </h1>

          <div className="styx-hero-rule" aria-hidden="true" />

          <div className="styx-hero-body">
            <p className="styx-lede">{styxBrand(t("careers.heroDesc"))}</p>
            <div className="styx-btn-row">
              {/* `careers.role.applyTitle` is the heading of section 04, so this
                  goes to that section instead of wearing its title as the label
                  of a mailto. A link whose accessible name is the heading it
                  lands on is the correct pattern; the same sentence printed once
                  as a heading and once as an email button was not, and the
                  address is the honest label for the mailto itself. */}
              <a className="styx-btn" href={`#${APPLY_ANCHOR}`}>
                {t("careers.role.applyTitle")}
              </a>
              <a
                className="styx-btn-ghost"
                href={APPLY_DISCORD}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle size={13} style={ICON_FIXED} aria-hidden />
                {t("careers.role.applyDiscordLabel")}
              </a>
            </div>
          </div>
        </section>

        {/* ── 01 · Where we stand ──────────────────────────────────────── */}
        <section className="styx-section">
          <div className="styx-container styx-section-grid">
            <div className="styx-section-label">
              <span className="styx-numeral" aria-hidden="true">
                01
              </span>
              <p className="styx-index">{t("careers.context.badge")}</p>
              <h2 className="styx-h2">{t("careers.context.title")}</h2>
            </div>
            <div className="styx-stack-lg">
              <Reveal className="styx-prose styx-reveal">
                {CONTEXT_KEYS.map((k) => (
                  <p key={k}>{t(`careers.context.${k}`)}</p>
                ))}
              </Reveal>
              {/* The status a candidate has to be comfortable selling. Reusing
                  the footer key keeps it translated instead of hardcoding it. */}
              <Reveal className="styx-btn-row styx-reveal" delay={80}>
                <span className="styx-chip">
                  <span className="styx-dot" aria-hidden="true" />
                  {t("footer.copyright")}
                </span>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── 02 · The role ────────────────────────────────────────────────
            id="bd-cofounder" is the external deep link. `.styx [id]` already
            reserves the scroll margin, so the old scroll-mt-24 is redundant. */}
        <section id="bd-cofounder" className="styx-section styx-section-alt">
          <div className="styx-container styx-section-grid">
            <div className="styx-section-label">
              <span className="styx-numeral" aria-hidden="true">
                02
              </span>
              <p className="styx-index">{t("careers.rolesTitle")}</p>
              <h2 className="styx-h2">{t("careers.role.title")}</h2>
            </div>
            <div>
              <Reveal className="styx-panel styx-sweep styx-reveal">
                <div className="styx-panel-head">
                  <span className="styx-chip">
                    <Briefcase size={11} style={ICON_FIXED} aria-hidden />
                    {t("careers.role.tag")}
                  </span>
                  <ul style={META_ROW}>
                    {meta.map((m) => (
                      <li className="styx-mono" style={META_ITEM} key={m.value}>
                        {m.icon}
                        <span style={{ minWidth: 0 }}>{m.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="styx-panel-body">
                  {/* The hero now carries careers.heroDesc, which says what the
                      product is. role.summary says what the ROLE is, so it moved
                      here, next to the mission list it introduces. Neither
                      translated sentence is dropped. */}
                  <div className="styx-prose">
                    <p>{t("careers.role.summary")}</p>
                  </div>
                  <h3 className="styx-h3" style={{ marginTop: "2rem" }}>
                    {t("careers.role.missionTitle")}
                  </h3>
                  <ul className="styx-steps">
                    {MISSION_KEYS.map((k, i) => (
                      <li className="styx-step" key={k}>
                        <span className="styx-step-index">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <p className="styx-step-body">
                          {t(`careers.role.mission.${k}`)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── 03 · Fit ─────────────────────────────────────────────────── */}
        <section className="styx-section">
          <div className="styx-container styx-stack-lg">
            {/* Chapter mark only. The two cards below carry the translated
                titles, so an index line here would just repeat
                careers.role.profileTitle a few pixels higher. */}
            <span className="styx-numeral" aria-hidden="true">
              03
            </span>

            <div className="styx-grid styx-grid-2">
              <Reveal className="styx-card styx-reveal">
                <h3 className="styx-h3">{t("careers.role.profileTitle")}</h3>
                <ul style={LIST_RESET}>
                  {PROFILE_KEYS.map((k) => (
                    <li className="styx-card-note" key={k}>
                      <span className="styx-check" aria-hidden="true">
                        &#10003;
                      </span>
                      {t(`careers.role.profile.${k}`)}
                    </li>
                  ))}
                </ul>
              </Reveal>
              <Reveal className="styx-card styx-reveal" delay={80}>
                <h3 className="styx-h3">{t("careers.role.offerTitle")}</h3>
                <ul style={LIST_RESET}>
                  {OFFER_KEYS.map((k) => (
                    <li className="styx-card-note" key={k}>
                      <span className="styx-check" aria-hidden="true">
                        &#10003;
                      </span>
                      {t(`careers.role.offer.${k}`)}
                    </li>
                  ))}
                </ul>
              </Reveal>
            </div>

            {/* The one amber block on the page: no funding yet, so no salary
                yet, is the admission a candidate must not miss. */}
            <Reveal className="styx-admission styx-reveal" delay={160}>
              <p className="styx-admission-title">
                {t("careers.role.notTitle")}
              </p>
              <div style={{ display: "grid", gap: "0.55rem" }}>
                {NOT_KEYS.map((k) => (
                  <p className="styx-admission-body" key={k}>
                    {t(`careers.role.not.${k}`)}
                  </p>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── 04 · Apply ─────────────────────────────────────────────────
            id={APPLY_ANCHOR} is the hero link's target. `.styx [id]` already
            reserves the scroll margin. */}
        <section id={APPLY_ANCHOR} className="styx-section styx-section-alt">
          <div className="styx-container-narrow">
            <div
              className="styx-gleam-rule"
              aria-hidden="true"
              style={{ marginBottom: "clamp(2rem, 5vw, 3rem)" }}
            />
            <Reveal className="styx-panel styx-sweep styx-reveal">
              <div className="styx-panel-body">
                <h2 className="styx-h2" style={{ margin: 0 }}>
                  {t("careers.role.applyTitle")}
                </h2>
                <div className="styx-prose" style={{ marginTop: "1rem" }}>
                  <p>{t("careers.role.applyDesc")}</p>
                </div>
                <div className="styx-btn-row" style={{ marginTop: "1.75rem" }}>
                  <a
                    className="styx-btn"
                    href={applyHref}
                    /* The button voice is uppercase mono; an address is not.
                       Case only, no colour or font of its own. */
                    style={{ textTransform: "none", letterSpacing: "0.04em" }}
                  >
                    <Mail size={14} style={ICON_FIXED} aria-hidden />
                    {/* An address has no spaces, so its min-content width is the
                        whole string: 192px of mono here, 246px with the button
                        padding, against 224px of panel body at a 320px viewport.
                        Measured on 2026-08-11: it left the panel by ~22px. It may
                        break mid-token rather than overflow. At 390px and up the
                        line still fits and nothing breaks. */}
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {APPLY_EMAIL}
                    </span>
                  </a>
                  <a
                    className="styx-btn-ghost"
                    href={APPLY_DISCORD}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <MessageCircle size={14} style={ICON_FIXED} aria-hidden />
                    {t("careers.role.applyDiscordLabel")}
                  </a>
                </div>
                <p
                  className="styx-mono styx-note"
                  style={{ marginTop: "1.5rem" }}
                >
                  {t("careers.role.applyNote")}
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── 05 · Nothing here fits ───────────────────────────────────── */}
        <section className="styx-section">
          <div className="styx-container-narrow styx-center">
            <h3 className="styx-h3">{t("careers.noOtherTitle")}</h3>
            <p className="styx-lede" style={{ marginInline: "auto" }}>
              {t("careers.noOtherDesc")}
            </p>
          </div>
        </section>
      </StyxShell>
    </>
  );
}
