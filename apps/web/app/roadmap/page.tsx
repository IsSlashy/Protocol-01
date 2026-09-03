"use client";

import { useState } from "react";
import { useT } from "@/i18n";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";
import { ChevronDown, FileText, Download } from "lucide-react";

/* Presentation comes from app/_styx/styx.css. The old Protocol 01 THEME object
   (pink #ff77a8, #0a0a0c, tinted icon tiles) and PHASE_STYLES lived here and are
   gone: a Styx page writes no colours of its own. */

type PhaseStatus = "shipped" | "next" | "future";

/* Every item used to carry an `icon` field holding a lucide element. This design
   carries status in a hairline and a check mark and renders no icon tiles, so all
   56 of those elements were built at module load and thrown away: a dead field,
   not a reserved one. Field, values and the seventeen icon imports are gone,
   leaving the three lucide glyphs this page actually renders. */
interface RoadmapItem {
  title: string;
  description: string;
}

interface RoadmapPhase {
  id: string;
  status: PhaseStatus;
  title: string;
  subtitle: string;
  items: RoadmapItem[];
}

const PHASE_LABELS: Record<PhaseStatus, string> = {
  shipped: "roadmap.shipped",
  next: "roadmap.inProgress",
  future: "roadmap.planned",
};

// ── Shipped-item categorization ────────────────────────────────
// Keyed by the item's i18n key stem (roadmap.items.<stem>.title) so the
// data array below stays untouched.
type CategoryKey =
  | "privacyCore"
  | "poolsNotes"
  | "payments"
  | "infrastructure"
  | "appsSdk"
  | "ecosystem";

const CATEGORY_ORDER: CategoryKey[] = [
  "privacyCore",
  "poolsNotes",
  "payments",
  "infrastructure",
  "appsSdk",
  "ecosystem",
];

const SHIPPED_CATEGORY: Record<string, CategoryKey> = {
  stealthAddresses: "privacyCore",
  zkShieldedPool: "privacyCore",
  instantZk: "privacyCore",
  advancedPrivacy: "privacyCore",
  starkMigration: "privacyCore",
  autoShieldReceive: "privacyCore",
  stealthMetaAddresses: "privacyCore",
  multiHopRouter: "privacyCore",
  fullStealthUnshield: "privacyCore",
  stealthAirdrops: "privacyCore",
  complianceZk: "privacyCore",
  deterministicStealth: "privacyCore",
  v3StarkE2E: "privacyCore",
  uniformStarkProofs: "privacyCore",
  denominatedPools: "poolsNotes",
  confidentialBalances: "poolsNotes",
  p2pNoteSharing: "poolsNotes",
  crossPoolSplitting: "poolsNotes",
  perWalletNotes: "poolsNotes",
  poolV2Migration: "poolsNotes",
  poolV4Migration: "poolsNotes",
  paymentStreams: "payments",
  subscriptionVaults: "payments",
  subscribePrivateV3: "payments",
  onChainRelayer: "infrastructure",
  onChainContracts: "infrastructure",
  onChainRegistry: "infrastructure",
  rpcFallback: "infrastructure",
  instantUnshield: "infrastructure",
  multiLayoutDecoder: "infrastructure",
  txOpacityRelayer: "infrastructure",
  txOpacityEvents: "infrastructure",
  multiRelayerRotation: "infrastructure",
  securityHardening: "infrastructure",
  mobileApp: "appsSdk",
  aiAgent: "appsSdk",
  privacySdkNpm: "appsSdk",
  jupiterSwap: "appsSdk",
  colosseumFrontier: "ecosystem",
};

// Extract the stem from a "roadmap.items.<stem>.title" key.
const itemStem = (titleKey: string): string => titleKey.split(".")[2] ?? "";

/**
 * Descriptions this page does not print.
 *
 * The rebrand exists because the old site said more than it could show. The
 * dictionaries (i18n/en.ts, i18n/fr.ts) are not this page's to edit: a hardcoded
 * English replacement here would silently delete the French, so the corrections
 * available in this file are to stop rendering a sentence or to drop the item
 * that carries the claim, and a false string that has to keep rendering is
 * handed to the i18n pass as a rewrite in both locales instead.
 *
 * A description is withheld only when it asserts something a reader cannot
 * check AND the item's title is a plain feature name. Where the claim was in
 * the TITLE, the item is dropped from the list instead: see the note above
 * `roadmap`. Hiding the detail under a headline that repeats the claim kept the
 * claim and buried the evidence, which is worse than either extreme.
 *
 * A measurement is not checkable just because it names devnet. "809,812 CU
 * measured on devnet" ships with no published benchmark a reader can open, which
 * is the same objection that took "370+ Automated Tests" off this page, so the
 * two descriptions carrying that figure are withheld again here. They were
 * printed by an earlier pass; no test asked for them, and the deleted test-count
 * item makes keeping them indefensible.
 *
 * What still prints: colosseumFrontier carries its own date, which is what makes
 * it a record rather than current standing; quantumWallet is a design sketch in
 * the PLANNED phase and reads as one; onChainContracts is held on screen by
 * __tests__/pages/RoadmapPage.test.tsx, and its counts and its "no server
 * required" line are going out through a dictionary rewrite instead, because the
 * assertion only needs the phrase "Permissionless privacy on the core path"
 *
 * Four entries below are withheld pending a dictionary rewrite that has been
 * handed to the i18n pass: zkShieldedPool, starkMigration, instantZk and
 * advancedPrivacy. Once those strings say something true, drop the stem from
 * this set so the sentence prints. The keys are untouched in both locales, so a
 * stem added to or removed from this set is the whole edit.
 *
 * Reason per entry:
 *   onChainRelayer ....... "no backend server"; two hosted relayers are running
 *   aiAgent .............. "no data leaves your phone", unverifiable absolute
 *   instantZk ............ "~3 seconds"; on-device proving has been measured
 *                          past 180 s, and it also credits a Winterfell WASM
 *                          prover that zkShieldedPool says was dropped
 *   zkShieldedPool ....... "809,812 CU measured on devnet", "7 AIRs"; no
 *                          benchmark is published next to either number
 *   starkMigration ....... the same CU figure, "~9-15KB proofs" and a
 *                          DEEP-ALI-on-every-circuit soundness claim
 *   advancedPrivacy ...... "defeat chain analysis"; decoys are a FUTURE item
 *   stealthMetaAddresses . "Both sides hidden on-chain"; the sender is not
 *                          hidden on any leg
 *   fullStealthUnshield .. "wallet never appears on-chain"; the withdrawal
 *                          republishes the deposit commitment, so the pairing
 *                          is trivial and there is no client-side fix
 *   txOpacityRelayer ..... "IP no longer correlatable", an absolute negative
 *   txOpacityEvents ...... names indexing firms and asserts what they cannot see
 *   uniformStarkProofs ... "fingerprinting eliminated"; the size channel is one
 *                          of six, and closing it alone buys nothing
 *   relayerHealth ........ "withdrawals never stall"; the keeper retry bug is open,
 *                          and MEASURED 2026-08-28 both hosted relayers were
 *                          retired after 10 relay jobs in 45 days. The title now
 *                          carries the date; the entry stays because deleting a
 *                          shipped item is rewriting history, not correcting it.
 */
const WITHHELD_DESC = new Set<string>([
  "onChainRelayer",
  "aiAgent",
  "instantZk",
  "zkShieldedPool",
  "starkMigration",
  "advancedPrivacy",
  "stealthMetaAddresses",
  "fullStealthUnshield",
  "txOpacityRelayer",
  "txOpacityEvents",
  "uniformStarkProofs",
  "relayerHealth",
]);

/**
 * The old identity prefixed its overlines with a terminal chevron ("> BUILD
 * WITH US"). Strip it rather than drop the translated string: the prefix is the
 * same in every locale, so this keeps French intact.
 */
const stripChevron = (s: string): string => s.replace(/^>\s*/, "");

/**
 * Four shipped entries are not in this list, and the omission is the point.
 *
 * "370+ Automated Tests", "AI Agent: 56 Tools", "0 TypeScript Errors" and
 * "i18n (EN/FR/JA)" put the claim in the TITLE. Withholding their descriptions
 * left the headline number on screen with the detail hidden, so the page made a
 * claim it could not support and removed the only text that said anything
 * specific. The numbers count files in a repository whose source is not public,
 * so a reader has nothing to check them against; "All passing" dates from a
 * green run nobody can point at; and the Japanese dictionary was deleted on
 * 2026-08-11, which makes EN/FR/JA false as written.
 *
 * The dictionary keys still exist untouched in en.ts and fr.ts. Restoring an
 * entry is a title rewrite in both locales plus one object here, not an
 * archaeology exercise. Counts, the ring percentage and the category totals are
 * all derived from this array, so they follow automatically.
 */
const roadmap: RoadmapPhase[] = [
  {
    id: "current",
    status: "shipped",
    title: "roadmap.current",
    subtitle: "roadmap.currentSub",
    items: [
      {
        title: "roadmap.items.stealthAddresses.title",
        description: "roadmap.items.stealthAddresses.desc",
      },
      {
        title: "roadmap.items.zkShieldedPool.title",
        description: "roadmap.items.zkShieldedPool.desc",
      },
      {
        title: "roadmap.items.onChainRelayer.title",
        description: "roadmap.items.onChainRelayer.desc",
      },
      {
        title: "roadmap.items.paymentStreams.title",
        description: "roadmap.items.paymentStreams.desc",
      },
      {
        title: "roadmap.items.jupiterSwap.title",
        description: "roadmap.items.jupiterSwap.desc",
      },
      {
        title: "roadmap.items.mobileApp.title",
        description: "roadmap.items.mobileApp.desc",
      },
      {
        title: "roadmap.items.aiAgent.title",
        description: "roadmap.items.aiAgent.desc",
      },
      {
        title: "roadmap.items.instantZk.title",
        description: "roadmap.items.instantZk.desc",
      },
      {
        title: "roadmap.items.onChainContracts.title",
        description: "roadmap.items.onChainContracts.desc",
      },
      {
        title: "roadmap.items.advancedPrivacy.title",
        description: "roadmap.items.advancedPrivacy.desc",
      },
      {
        title: "roadmap.items.denominatedPools.title",
        description: "roadmap.items.denominatedPools.desc",
      },
      {
        title: "roadmap.items.confidentialBalances.title",
        description: "roadmap.items.confidentialBalances.desc",
      },
      {
        title: "roadmap.items.subscriptionVaults.title",
        description: "roadmap.items.subscriptionVaults.desc",
      },
      {
        title: "roadmap.items.p2pNoteSharing.title",
        description: "roadmap.items.p2pNoteSharing.desc",
      },
      {
        title: "roadmap.items.starkMigration.title",
        description: "roadmap.items.starkMigration.desc",
      },
      {
        title: "roadmap.items.onChainRegistry.title",
        description: "roadmap.items.onChainRegistry.desc",
      },
      {
        title: "roadmap.items.securityHardening.title",
        description: "roadmap.items.securityHardening.desc",
      },
      {
        title: "roadmap.items.rpcFallback.title",
        description: "roadmap.items.rpcFallback.desc",
      },
      {
        title: "roadmap.items.autoShieldReceive.title",
        description: "roadmap.items.autoShieldReceive.desc",
      },
      {
        title: "roadmap.items.stealthMetaAddresses.title",
        description: "roadmap.items.stealthMetaAddresses.desc",
      },
      {
        title: "roadmap.items.multiHopRouter.title",
        description: "roadmap.items.multiHopRouter.desc",
      },
      {
        title: "roadmap.items.crossPoolSplitting.title",
        description: "roadmap.items.crossPoolSplitting.desc",
      },
      {
        title: "roadmap.items.fullStealthUnshield.title",
        description: "roadmap.items.fullStealthUnshield.desc",
      },
      {
        title: "roadmap.items.stealthAirdrops.title",
        description: "roadmap.items.stealthAirdrops.desc",
      },
      {
        title: "roadmap.items.complianceZk.title",
        description: "roadmap.items.complianceZk.desc",
      },
      {
        title: "roadmap.items.privacySdkNpm.title",
        description: "roadmap.items.privacySdkNpm.desc",
      },
      // ── v0.9.9 Frost release (2026-04-23) ─────────────────────
      {
        title: "roadmap.items.instantUnshield.title",
        description: "roadmap.items.instantUnshield.desc",
      },
      {
        title: "roadmap.items.perWalletNotes.title",
        description: "roadmap.items.perWalletNotes.desc",
      },
      {
        title: "roadmap.items.deterministicStealth.title",
        description: "roadmap.items.deterministicStealth.desc",
      },
      {
        title: "roadmap.items.poolV2Migration.title",
        description: "roadmap.items.poolV2Migration.desc",
      },
      {
        title: "roadmap.items.multiLayoutDecoder.title",
        description: "roadmap.items.multiLayoutDecoder.desc",
      },
      // ── Ecosystem / product surface ───────────────────────────
      {
        title: "roadmap.items.colosseumFrontier.title",
        description: "roadmap.items.colosseumFrontier.desc",
      },
      // ── May 2026 sprint shipping wave ─────────────────────────
      {
        title: "roadmap.items.v3StarkE2E.title",
        description: "roadmap.items.v3StarkE2E.desc",
      },
      {
        title: "roadmap.items.txOpacityRelayer.title",
        description: "roadmap.items.txOpacityRelayer.desc",
      },
      {
        title: "roadmap.items.txOpacityEvents.title",
        description: "roadmap.items.txOpacityEvents.desc",
      },
      {
        title: "roadmap.items.uniformStarkProofs.title",
        description: "roadmap.items.uniformStarkProofs.desc",
      },
      {
        title: "roadmap.items.multiRelayerRotation.title",
        description: "roadmap.items.multiRelayerRotation.desc",
      },
      {
        title: "roadmap.items.poolV4Migration.title",
        description: "roadmap.items.poolV4Migration.desc",
      },
      {
        title: "roadmap.items.subscribePrivateV3.title",
        description: "roadmap.items.subscribePrivateV3.desc",
      },
      // ── June 2026 — Privy removal & extension parity ──────────
      {
        title: "roadmap.items.privyRemoval.title",
        description: "roadmap.items.privyRemoval.desc",
      },
      {
        title: "roadmap.items.extensionParity.title",
        description: "roadmap.items.extensionParity.desc",
      },
      {
        title: "roadmap.items.licenseKeys.title",
        description: "roadmap.items.licenseKeys.desc",
      },
      {
        title: "roadmap.items.relayerHealth.title",
        description: "roadmap.items.relayerHealth.desc",
      },
      {
        title: "roadmap.items.v102Release.title",
        description: "roadmap.items.v102Release.desc",
      },
      // ── Reconciled from "Next" — verified shipped in code ─────
      {
        title: "roadmap.items.leafInsertedCanonical.title",
        description: "roadmap.items.leafInsertedCanonical.desc",
      },
      {
        title: "roadmap.items.fiatOnRamp.title",
        description: "roadmap.items.fiatOnRamp.desc",
      },
    ],
  },
  {
    id: "next",
    status: "next",
    title: "roadmap.next",
    subtitle: "roadmap.nextSub",
    items: [
      {
        title: "roadmap.items.networkMapping.title",
        description: "roadmap.items.networkMapping.desc",
      },
      {
        title: "roadmap.items.securityAudit.title",
        description: "roadmap.items.securityAudit.desc",
      },
      {
        title: "roadmap.items.mainnetLaunch.title",
        description: "roadmap.items.mainnetLaunch.desc",
      },
      {
        title: "roadmap.items.iosBuild.title",
        description: "roadmap.items.iosBuild.desc",
      },
      {
        title: "roadmap.items.subscriptionOneWay.title",
        description: "roadmap.items.subscriptionOneWay.desc",
      },
    ],
  },
  {
    id: "future",
    status: "future",
    title: "roadmap.future",
    subtitle: "roadmap.futureSub",
    items: [
      {
        title: "roadmap.items.quantumWallet.title",
        description: "roadmap.items.quantumWallet.desc",
      },
      {
        title: "roadmap.items.coverTraffic.title",
        description: "roadmap.items.coverTraffic.desc",
      },
      {
        title: "roadmap.items.desktopApp.title",
        description: "roadmap.items.desktopApp.desc",
      },
      {
        title: "roadmap.items.cliTool.title",
        description: "roadmap.items.cliTool.desc",
      },
    ],
  },
];

/**
 * One shipped entry: a cyan check, the title, and the description only when the
 * description is something a reader can check (see WITHHELD_DESC).
 *
 * The `icon` field on every item is left unrendered on purpose. Coloured icon
 * tiles were the old identity's chrome; this design carries status in a hairline
 * and a check mark, so the data array keeps its icons and the page ignores them.
 */
function ItemCard({
  item,
  index,
  t,
}: {
  item: RoadmapItem;
  index: number;
  t: (k: string) => string;
}) {
  const showDesc = !WITHHELD_DESC.has(itemStem(item.title));
  return (
    <Reveal
      className="styx-card styx-sweep styx-reveal"
      delay={Math.min(index * 60, 240)}
    >
      <p className="styx-card-value" style={{ fontSize: "1.05rem" }}>
        <span className="styx-check" aria-hidden="true">
          &#10003;
        </span>
        {t(item.title)}
      </p>
      {showDesc ? <p className="styx-card-note">{t(item.description)}</p> : null}
    </Reveal>
  );
}

export default function RoadmapPage() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<PhaseStatus>("next");
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({ privacyCore: true });

  const shippedPhase = roadmap.find((p) => p.status === "shipped")!;
  const nextPhase = roadmap.find((p) => p.status === "next")!;
  const futurePhase = roadmap.find((p) => p.status === "future")!;
  const counts: Record<PhaseStatus, number> = {
    shipped: shippedPhase.items.length,
    next: nextPhase.items.length,
    future: futurePhase.items.length,
  };
  const total = counts.shipped + counts.next + counts.future;
  const pct = Math.round((counts.shipped / total) * 100);
  const activePhase = roadmap.find((p) => p.status === activeTab)!;
  const focusItem = nextPhase.items[0];

  // Group shipped items by category (ordered).
  const shippedByCat = CATEGORY_ORDER.reduce(
    (acc, c) => ({ ...acc, [c]: [] as RoadmapItem[] }),
    {} as Record<CategoryKey, RoadmapItem[]>,
  );
  shippedPhase.items.forEach((it) => {
    const cat = SHIPPED_CATEGORY[itemStem(it.title)] ?? "ecosystem";
    shippedByCat[cat].push(it);
  });

  const TABS: PhaseStatus[] = ["shipped", "next", "future"];
  const RING_R = 34;
  const RING_C = 2 * Math.PI * RING_R;

  return (
    <StyxShell>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        {/* The one gleam on this page, and the slot `roadmap.heroSubtitle` has
            always filled. A previous pass hardcoded "Styx Protocol" here because
            the key still read "> PROTOCOL 01 // DEVELOPMENT ROADMAP": that left
            half the line untranslated and the key dead in both dictionaries. The
            key is rewritten to name Styx in the i18n pass, so the t() call comes
            back and the whole line is localized again. stripChevron survives for
            older wordings; the new strings carry no chevron, so it is a no-op. */}
        <p className="styx-overline styx-gleam">
          {stripChevron(t('roadmap.heroSubtitle'))}
        </p>
        {/* h1, not h2: this is the page title. The page had NO h1 at all after
            commit 97339ea6 folded the old page header into SiteHeader, which
            contains no heading element, an a11y and SEO defect, since a
            document should expose exactly one top-level heading. StyxHeader has
            no heading element either, so this remains the only h1. */}
        <h1 className="styx-h1">{t('roadmap.heroTitle')}</h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        <div className="styx-hero-body">
          <p className="styx-lede">{t('roadmap.heroDesc')}</p>
          {/* The page's single amber element, and the only thing on it the
              reader must not miss. Both strings already exist in en and fr. */}
          <div className="styx-admission">
            <p className="styx-admission-title">{t('roadmap.devnetOnly')}</p>
            <p className="styx-admission-body">{t('roadmap.disclaimer')}</p>
          </div>
        </div>
      </section>

      {/* ── Dashboard: the arc, and the counts as phase tabs ─────────────── */}
      <section className="styx-section">
        <div className="styx-container">
          <Reveal className="styx-reveal">
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "clamp(1.5rem, 4vw, 3rem)",
              }}
            >
              {/* Hand-rolled arc: styx.css has no gauge primitive, so the SVG
                  survives from the old page with its strokes swapped to tokens
                  and thinned to a hairline. RING_R / RING_C are unchanged. */}
              <div style={{ position: "relative", width: 96, height: 96, flex: "none" }}>
                <svg
                  width="96"
                  height="96"
                  viewBox="0 0 96 96"
                  aria-hidden="true"
                  style={{ transform: "rotate(-90deg)" }}
                >
                  <circle
                    cx="48"
                    cy="48"
                    r={RING_R}
                    fill="none"
                    stroke="var(--styx-rule)"
                    strokeWidth="2"
                  />
                  <circle
                    cx="48"
                    cy="48"
                    r={RING_R}
                    fill="none"
                    stroke="var(--styx-accent)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={RING_C}
                    strokeDashoffset={RING_C * (1 - pct / 100)}
                  />
                </svg>
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span className="styx-card-value" style={{ margin: 0, fontSize: "1.4rem" }}>
                    {pct}%
                  </span>
                </div>
              </div>
              {/* The percentage is only as honest as its denominator, so the
                  denominator is printed beside it. Both numbers are counted off
                  the array below at render time, never typed in, so the reader
                  can check them against the list on the same screen. */}
              <div>
                <p className="styx-card-label" style={{ margin: 0 }}>
                  {t('roadmap.overallProgress')}
                </p>
                <p className="styx-mono" style={{ margin: "0.4rem 0 0" }}>
                  {counts.shipped} / {total} {t('roadmap.shippedLabel')}
                </p>
              </div>
            </div>
          </Reveal>

          {/* Stat tiles = phase tabs */}
          <div className="styx-grid styx-grid-3" style={{ marginTop: "2.5rem" }}>
            {TABS.map((status) => {
              const active = activeTab === status;
              return (
                <button
                  key={status}
                  onClick={() => setActiveTab(status)}
                  type="button"
                  className="styx-card styx-sweep"
                  aria-pressed={active}
                  style={{
                    /* styx.css has no selected state for a card used as a tab;
                       the accent hairline is the whole affordance. */
                    border: `1px solid ${active ? "var(--styx-accent)" : "transparent"}`,
                    textAlign: "left",
                    cursor: "pointer",
                    color: "inherit",
                    font: "inherit",
                  }}
                >
                  <p
                    className="styx-card-label"
                    style={{
                      margin: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                    }}
                  >
                    {active ? <span className="styx-dot" aria-hidden="true" /> : null}
                    {t(PHASE_LABELS[status])}
                  </p>
                  <p
                    className="styx-card-value"
                    style={{ margin: "0.7rem 0 0", fontSize: "2rem" }}
                  >
                    {counts[status]}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Current focus */}
          {focusItem && (
            <div
              style={{
                marginTop: "2rem",
                paddingTop: "1.25rem",
                borderTop: "1px solid var(--styx-rule)",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "baseline",
                gap: "0.75rem",
              }}
            >
              <span className="styx-card-label" style={{ margin: 0 }}>
                {t('roadmap.currentFocus')}
              </span>
              <span className="styx-mono">{t(focusItem.title)}</span>
            </div>
          )}
        </div>
      </section>

      {/* ── The active chapter ───────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            {/* The chapter is titled by its phase name and marked by the
                numeral. It deliberately does NOT repeat the phase label: the
                tab above already prints SHIPPED / IN PROGRESS / PLANNED, and
                printing it a second time here put the same word on screen
                twice, a few hundred pixels apart. The numeral carries the
                chapter, the h2 names it. */}
            <span className="styx-numeral" aria-hidden="true">
              {String(TABS.indexOf(activeTab) + 1).padStart(2, "0")}
            </span>
            <h2 className="styx-h2">{t(activePhase.title)}</h2>
            {/* The shipped phase's own subtitle key is `roadmap.currentSub`,
                which reads "Live in production". There is no mainnet
                deployment, so that string is not rendered. Its replacement is
                `roadmap.builtFromScratch`, an existing key in both
                dictionaries, rather than `roadmap.devnetOnly`: devnetOnly is
                already the amber admission in the hero, and using it twice put
                the same two words on screen twice on this tab. The other two
                phases print their subtitle as written. */}
            <p className="styx-note" style={{ marginTop: "1rem" }}>
              {activeTab === "shipped"
                ? t('roadmap.builtFromScratch')
                : t(activePhase.subtitle)}
            </p>
          </div>

          <div>
            {activeTab === "shipped" ? (
              <div className="styx-stack">
                {CATEGORY_ORDER.map((cat) => {
                  const items = shippedByCat[cat];
                  if (!items.length) return null;
                  const open = openCats[cat];
                  return (
                    <div key={cat} className="styx-panel">
                      {/* styx.css has no disclosure-trigger class, so a button
                          wearing styx-panel-head needs the UA button styling
                          reset inline. The bottom hairline belongs to the open
                          state only. */}
                      <button
                        onClick={() => setOpenCats((p) => ({ ...p, [cat]: !p[cat] }))}
                        type="button"
                        className="styx-panel-head"
                        aria-expanded={!!open}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "1rem",
                          width: "100%",
                          background: "none",
                          borderWidth: 0,
                          borderBottomWidth: open ? "1px" : 0,
                          textAlign: "left",
                          cursor: "pointer",
                          color: "inherit",
                          font: "inherit",
                        }}
                      >
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.9rem",
                            minWidth: 0,
                          }}
                        >
                          <h3 className="styx-h3" style={{ margin: 0 }}>
                            {t(`roadmap.categories.${cat}`)}
                          </h3>
                          <span className="styx-chip">{items.length}</span>
                        </span>
                        <ChevronDown
                          size={14}
                          aria-hidden="true"
                          style={{
                            flex: "none",
                            color: "var(--styx-faint)",
                            transform: open ? "rotate(180deg)" : undefined,
                            transition: "transform 0.25s ease",
                          }}
                        />
                      </button>
                      {open && (
                        <div className="styx-panel-body">
                          <div className="styx-grid styx-grid-2">
                            {items.map((it, i) => (
                              <ItemCard key={it.title} item={it} index={i} t={t} />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Five items and four items: an index reads better than a card
                 grid at that count. */
              <ul className="styx-steps">
                {activePhase.items.map((it, i) => (
                  <Reveal
                    as="li"
                    key={it.title}
                    className="styx-step styx-reveal"
                    delay={Math.min(i * 80, 240)}
                  >
                    <span className="styx-step-index">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <h3 className="styx-h3">{t(it.title)}</h3>
                      {WITHHELD_DESC.has(itemStem(it.title)) ? null : (
                        <p className="styx-step-body">{t(it.description)}</p>
                      )}
                    </div>
                  </Reveal>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ── CTA, then the document ───────────────────────────────────────── */}
      <section className="styx-section">
        <div className="styx-container styx-center">
          <p className="styx-overline">{stripChevron(t('roadmap.buildWithUs'))}</p>
          <h2 className="styx-h2">{t('roadmap.shapeFuture')}</h2>
          <p
            className="styx-lede"
            style={{ marginInline: "auto", marginTop: "1.5rem" }}
          >
            {t('roadmap.joinCommunity')}
          </p>
          <div
            className="styx-btn-row"
            style={{ justifyContent: "center", marginTop: "2.5rem" }}
          >
            <a
              className="styx-btn"
              href="https://github.com/IsSlashy/Protocol-01-releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <a
              className="styx-btn-ghost"
              href="https://discord.gg/EfqnVmb2dV"
              target="_blank"
              rel="noopener noreferrer"
            >
              Discord
            </a>
          </div>

          <div
            className="styx-gleam-rule"
            aria-hidden="true"
            style={{ marginTop: "clamp(3rem, 7vw, 4.5rem)" }}
          />

          {/* The href and the asset name keep "protocol-01": the file at
              public/protocol-01-design-document.pdf is a frozen path. */}
          <div
            className="styx-btn-row"
            style={{ justifyContent: "center", marginTop: "2.5rem" }}
          >
            <a className="styx-btn-ghost" href="/protocol-01-design-document.pdf" download>
              <FileText size={14} aria-hidden="true" />
              {t('roadmap.designDoc')}
              <span
                className="styx-mono"
                style={{ color: "inherit", fontSize: "inherit" }}
              >
                PDF
              </span>
              <Download size={13} aria-hidden="true" />
            </a>
          </div>
          {/* `roadmap.lastRevision` dates the PDF above it, not this page, and
              it sat directly under the same download link before the port. It
              is printed here for that reason, tight to the button, where the
              referent is unambiguous: the reader can open the document and
              check the revision for themselves. */}
          <p
            className="styx-mono"
            style={{ marginTop: "1.25rem", letterSpacing: "0.06em" }}
          >
            {t('roadmap.lastRevision')}
          </p>
        </div>
      </section>
    </StyxShell>
  );
}
