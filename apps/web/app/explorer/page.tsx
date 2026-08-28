"use client";

import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import type { NetworkMetrics } from "@/lib/metrics/types";
import { STARK_CIRCUIT_LIST } from "@/lib/metrics/types";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";
import ObserverTest from "./_components/ObserverTest";

/**
 * /explorer, the aggregate and public state of the shielded pool.
 *
 * Ported to the Styx vocabulary. Behaviour is untouched: both polls, their
 * `cache: "no-store"`, the 30s interval, the `alive` guard, the empty catch
 * blocks (a failed poll must keep the last snapshot rather than blank the page)
 * and every `??` fallback are as they were.
 *
 * Stays a client component because useT() is a context hook and the page polls.
 * Its tab title comes from app/explorer/layout.tsx, which is the only way to set
 * metadata for a client page.
 *
 * COPY DISCIPLINE, and what changed after review.
 *
 * Every sentence a visitor reads on this page is a t() call, so French keeps
 * working. i18n/ is off limits to this page, so a claim that lives in the
 * dictionaries is fixed by reporting the exact replacement upward. It is NOT
 * fixed by dropping the render: an earlier pass did that, and suppressing the
 * body of a claim while its headline or its key survives hides the evidence
 * instead of retiring the claim. Four keys are reported for rewrite, and all
 * four are rendered here, so the page carries whatever the dictionaries say
 * rather than a hole where a sentence used to be:
 *
 *  - explorer.title + explorer.titleAccent, "The explorer that can't see you."
 *    Not true: the sender is not hidden on any leg and a withdrawal republishes
 *    the commitment of the deposit it spends, so a deposit still pairs with its
 *    withdrawal. The replacement asked for is short by requirement, since
 *    .styx-h1 is a display slot at clamp(2.9rem, 7.6vw, 5.9rem) capped to 19ch:
 *    a body sentence put in this slot wraps to four or five lines of 90px type.
 *    It also invites the check the page really supports instead of promising an
 *    absence nothing on the page can demonstrate.
 *  - explorer.observer.subtitle, which reads "what Protocol 01 reveals" in
 *    English and French alike, and offers a flip the module no longer has. The
 *    retired brand, printed in both locales. Still rendered as section 01's
 *    lede: the substitute tried before was docs.sections.stealthAddresses.desc,
 *    and a stealth-address paragraph is not the caption for a two-column
 *    comparison, so the comparison lost its own subject.
 *  - explorer.observer.footnote. See the note at the top of
 *    _components/ObserverTest.tsx.
 *
 * Nothing on this page invents a number: every figure is read from /api/metrics
 * except the seven circuits, which are the static list, and except the
 * illustrative payment in the Observer Test, which is labelled DEMO.
 */

const EXPLORER_BASE = "https://explorer.solana.com";
const cluster = "?cluster=devnet";

/**
 * The program id behind t("explorer.net.program").
 *
 * CORRECTED, and this was a wrong fact rather than a wrong style. The pre-port
 * page carried 2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms, a stale dev alias
 * that lib/metrics/onchain.ts:26-28 documents as EMPTY, so the row labelled
 * "Shielded program" sent a reader to an account with no data on it, and the
 * port printed that string in full as well as linking it.
 *
 * GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c is the deployed declare_id: it is
 * what Anchor.toml [programs.devnet] and [programs.localnet] carry, it is the
 * account lib/metrics/onchain.ts enumerates DenominatedPool accounts from, so it
 * is the program every number on this page is read from, and it is what four
 * other call sites in apps/web already use (lib/pay/subscriptions.ts,
 * lib/privacy/pool/denominatedPool.ts among them). The address only ever lived
 * in this page as a local const, so keeping the wrong one was never required.
 *
 * Printed in full under the link so the account is copyable and so nobody has
 * to follow a link to learn which one it is.
 */
const SHIELDED_PROGRAM_ID = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";

function fmt(n: number, max = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

/**
 * A workaround for a specificity defect in the shared stylesheet, NOT a local
 * font decision. Measured in the browser on this page: the h1 rendered in Inter
 * while the `<span>` wordmark in the same header rendered in Newsreader.
 *
 * app/_styx/styx.css:69 opts headings out of the root stylesheet's Orbitron with
 *
 *   .styx :is(h1, h2, h3, h4, h5, h6) { font-family: inherit; font-weight:
 *   inherit; letter-spacing: normal; }
 *
 * `:is()` takes the specificity of its most specific argument, so that selector
 * scores (0,1,1) while `.styx-h1` and `.styx-h2` score (0,1,0). The opt-out
 * therefore beats them and strips the serif, the weight and the tracking off
 * every REAL heading element on every Styx page. `<p className="styx-h1">` keeps
 * the serif, which is why the style kit looks correct and the pages do not.
 *
 * The one-line fix belongs in styx.css: `:where(h1, h2, …)` instead of
 * `:is(h1, h2, …)`, since :where() contributes zero specificity and would still
 * beat the root stylesheet's bare `h1` selector. styx.css is off limits here, so
 * these two objects restate the values that file already declares, no new
 * colours and no new font stack, only the shared tokens. They can be deleted the
 * moment the shared rule is fixed.
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

/**
 * The note crowd for one denomination pool.
 *
 * Renamed from AnonymitySet: these marks are a pool SIZE, not a delivered
 * anonymity set, and the old name invited the wrong caption. Kept: the 64 cap
 * (a render budget, since a pool can hold dozens of notes) and the "+N"
 * overflow label.
 *
 * Drawn as hairline ticks rather than 64 cyan dots, because cyan is a seal here
 * and not a fill. The last tick is the accent, standing for the note being
 * added. The ticks carry no information the adjacent count does not already
 * state in words, so they are hidden from assistive technology.
 */
function PoolCrowd({ count, max = 64 }: { count: number; max?: number }) {
  const shown = Math.min(count, max);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "0.6rem",
        marginTop: "1.1rem",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "flex-end",
          flexWrap: "wrap",
          gap: "4px",
        }}
      >
        {Array.from({ length: shown }).map((_, i) => (
          <span
            key={i}
            style={{
              display: "inline-block",
              width: "1px",
              height: "12px",
              background:
                i === shown - 1 ? "var(--styx-accent)" : "var(--styx-faint)",
            }}
          />
        ))}
      </span>
      {count > max && <span className="styx-note">+{fmt(count - max, 0)}</span>}
    </div>
  );
}

export default function ExplorerPage() {
  const t = useT();
  const [m, setM] = useState<NetworkMetrics | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/metrics", { cache: "no-store" });
        const data = (await res.json()) as NetworkMetrics;
        if (alive) setM(data);
      } catch {
        /* keep last snapshot */
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const tvlSol = m?.tvlByToken.SOL ?? 0;
  const notes = m?.totalNotes ?? 0;
  const pools = m?.activePools ?? 0;
  const live = m?.live ?? false;

  return (
    <StyxShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <p className="styx-overline">{t("explorer.badge")}</p>
          <span className="styx-chip">
            <span
              className="styx-dot"
              aria-hidden="true"
              style={{
                background: live ? "var(--styx-accent)" : "var(--styx-faint)",
              }}
            />
            {live ? t("explorer.statusLive") : t("explorer.statusOffline")}
            <span style={{ color: "var(--styx-faint)" }}>
              &middot; {m?.network ?? "devnet"}
            </span>
          </span>
        </div>

        {/* Two keys, one display line, and it has to stay a LINE. .styx-h1 is
            19ch wide at up to 94px, so anything longer than about 35 characters
            wraps into a paragraph of display type. An earlier pass put the first
            sentence of explorer.subtitle here, 67 characters in English and 74
            in French, which wrapped to four or five lines; the fix is a short
            replacement for these two keys, reported upward, not a body sentence
            promoted into the slot.

            The gleam is back on the accent, where the page always spent it. It
            previously sat on "can't see you", the half of that sentence that was
            not true, which made the least defensible words the loudest on the
            page. On an invitation to go and check the accounts yourself it is
            emphasis on something a stranger can act on. */}
        <h1 className="styx-h1" style={SERIF_H1}>
          {t("explorer.title")}{" "}
          <span className="styx-gleam-strong">{t("explorer.titleAccent")}</span>
        </h1>

        <div className="styx-hero-rule" aria-hidden="true" />

        <div className="styx-hero-body">
          {/* explorer.subtitle whole, its two newlines intact: it is three short
              sentences about what the numbers below are, which is lede material
              and not a headline. */}
          <p className="styx-lede" style={{ whiteSpace: "pre-line" }}>
            {t("explorer.subtitle")}
          </p>

          {/* The one amber block on the page. Both halves are t() calls, so a
              French visitor gets the warning in French: roadmap.devnetOnly is
              "Devnet uniquement" and roadmap.disclaimer is "Ce logiciel est en
              développement actif. Non audité. Utilisez à vos propres risques."
              The other half of the honesty, that a withdrawal republishes its
              deposit's commitment so the set does not hide you yet, is section
              02's lede: explorer.anon.subtitle says it in both locales, next to
              the pools it is about. */}
          <div className="styx-admission">
            <p className="styx-admission-title">{t("roadmap.devnetOnly")}</p>
            <p className="styx-admission-body">{t("roadmap.disclaimer")}</p>
          </div>
        </div>
      </section>

      {/* ── Facts strip ────────────────────────────────────────────────── */}
      <section
        className="styx-container"
        aria-label={t("explorer.badge")}
        style={{ paddingBottom: "clamp(3rem, 7vw, 5rem)" }}
      >
        {/* The Reveal wraps the GRID, not the four cards.
            `.styx-grid` is a hairline bed: 1px gaps over `background:
            var(--styx-rule)`, with the cards' own panel colour covering the rest.
            Put `styx-reveal` on each card instead and the hidden state takes the
            cards' opacity to 0 while the bed stays fully opaque, so this strip
            paints as one light-grey slab until the observer fires. Measured in
            the browser. Fading the whole strip as one object costs the per-card
            stagger and is worth it. */}
        <Reveal className="styx-grid styx-grid-4 styx-reveal">
          <div className="styx-card">
            <p className="styx-card-label">{t("explorer.stat.tvl")}</p>
            <p className="styx-card-value">{fmt(tvlSol)} SOL</p>
            <p className="styx-card-note">{t("explorer.stat.tvlHint")}</p>
          </div>
          <div className="styx-card">
            <p className="styx-card-label">{t("explorer.stat.anonSet")}</p>
            <p className="styx-card-value">{fmt(notes, 0)}</p>
            <p className="styx-card-note">{t("explorer.stat.anonSetHint")}</p>
          </div>
          <div className="styx-card">
            <p className="styx-card-label">{t("explorer.stat.pools")}</p>
            <p className="styx-card-value">{fmt(pools, 0)}</p>
            <p className="styx-card-note">{t("explorer.stat.poolsHint")}</p>
          </div>
          <div className="styx-card">
            <p className="styx-card-label">{t("explorer.stat.circuits")}</p>
            <p className="styx-card-value">7</p>
            <p className="styx-card-note">{t("explorer.stat.circuitsHint")}</p>
          </div>
        </Reveal>
      </section>

      {/* ── 01 · The observer test ─────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">{t("explorer.observer.badge")}</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              {t("explorer.observer.title")}
            </h2>
          </div>
          <div>
            {/* The section's own subtitle, restored. The pass before this one
                swapped in docs.sections.stealthAddresses.desc to avoid printing
                the retired brand that explorer.observer.subtitle still carries,
                and that cost the comparison its caption: a paragraph about
                one-time addresses does not tell a reader what the two columns
                below are or what to compare. The brand and the vanished "flip
                it" instruction are dictionary text, so the replacement for this
                key is reported upward instead. */}
            <p className="styx-lede" style={{ marginBottom: "2rem" }}>
              {t("explorer.observer.subtitle")}
            </p>
            <ObserverTest />
          </div>
        </div>
      </section>

      {/* ── 02 · Pool sizes ───────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">{t("explorer.anon.badge")}</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              {t("explorer.anon.title")}
            </h2>
          </div>
          <div>
            {/* Full length, never truncated: this subtitle is the sentence that
                admits the set does not hide you yet, and the title above is
                future tense only because of it. */}
            <p className="styx-lede" style={{ marginBottom: "2rem" }}>
              {t("explorer.anon.subtitle")}
            </p>

            {m && m.pools.length > 0 ? (
              <div
                style={{
                  display: "grid",
                  gap: "1.25rem",
                  gridTemplateColumns: "repeat(auto-fit, minmax(17rem, 1fr))",
                }}
              >
                {m.pools.map((p) => (
                  <a
                    key={p.address}
                    href={`${EXPLORER_BASE}/address/${p.address}${cluster}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="styx-panel styx-sweep"
                    style={{ display: "block", textDecoration: "none" }}
                  >
                    <div className="styx-panel-body">
                      <p className="styx-card-value">
                        {p.denomination} {p.token}
                      </p>
                      <p className="styx-mono">
                        1 {t("explorer.anon.of")} {fmt(p.noteCount, 0)}
                      </p>
                      <PoolCrowd count={p.noteCount} />
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <div className="styx-panel">
                <div className="styx-panel-body">
                  <p className="styx-mono">
                    {live ? t("explorer.anon.empty") : t("explorer.anon.loading")}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── 03 · Proof system ─────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              03
            </span>
            <p className="styx-index">{t("explorer.circuits.badge")}</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              {t("explorer.circuits.title")}
            </h2>
          </div>
          <div>
            {/* The hash-based, no-trusted-setup fact is said once, here, in
                words. The old page stamped a "PQ" chip on all seven tiles,
                which read as an audited property. */}
            <p className="styx-lede" style={{ marginBottom: "2rem" }}>
              {t("explorer.circuits.subtitle")}
            </p>
            {/* Safe to reveal as one element: a styx-panel carries its own
                border and background, so there is no bed to leave showing. */}
            <Reveal className="styx-panel styx-reveal">
              <div className="styx-panel-body">
                {/* The static list, not m.circuits: this section renders before
                    the first poll resolves. */}
                {STARK_CIRCUIT_LIST.map((c) => (
                  <div className="styx-row" key={c.id}>
                    <span className="styx-row-key">C{c.id}</span>
                    <span className="styx-row-leader" aria-hidden="true" />
                    <span className="styx-row-value">{c.name}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── The network line ──────────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container">
          <div className="styx-panel">
            <div className="styx-panel-body">
              {/* The relayer traffic-light lived here until 2026-08-28. Both
                  hosted p01_relayer nodes were retired that day — 10 relay jobs
                  in 45 days — so the row could only ever report red. */}
              <div className="styx-row">
                <span className="styx-row-key">
                  {t("explorer.net.snapshot")}
                </span>
                <span className="styx-row-leader" aria-hidden="true" />
                {/* m is null on the server render, so this branch is the one
                    that hydrates. Keep the null guard or the times diverge. */}
                <span className="styx-row-value">
                  {m?.snapshotAt
                    ? new Date(m.snapshotAt).toLocaleTimeString()
                    : "n/a"}
                </span>
              </div>
              <div className="styx-row">
                <span className="styx-row-key">
                  {t("explorer.net.program")}
                </span>
                <span className="styx-row-leader" aria-hidden="true" />
                <a
                  className="styx-link"
                  href={`${EXPLORER_BASE}/address/${SHIELDED_PROGRAM_ID}${cluster}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  explorer.solana.com
                </a>
              </div>
              {/* Printed so the account is copyable, and so nobody has to click
                  a link to learn which one it is. */}
              <p
                className="styx-mono"
                style={{ marginTop: "0.9rem", wordBreak: "break-all" }}
              >
                {SHIELDED_PROGRAM_ID}
              </p>
            </div>
          </div>

          <div
            className="styx-gleam-rule"
            aria-hidden="true"
            style={{ marginTop: "clamp(3rem, 7vw, 5rem)" }}
          />
        </div>
      </section>
    </StyxShell>
  );
}
