import type { Metadata } from "next";
import StyxShell from "../../_styx/StyxShell";
import { WalletProvider } from "@/components/WalletProvider";
import PayApp from "@/components/pay/PayApp";
import { getServerT } from "@/i18n/server";

/**
 * /app: the devnet money surface, in the Styx voice.
 *
 * WHAT THIS FILE IS. A frame. Every pixel of the actual app lives in
 * components/pay/* (PayApp and its panels), which this port does not touch: the
 * shield -> withdraw -> sweep -> subscription flow is the one proven on devnet
 * and its mechanics are frozen. Nothing below changes a transaction, a hook, an
 * effect, a state machine or a disabled condition. In particular:
 *
 *   · `<WalletProvider network="devnet">` is copied across verbatim. The prop is
 *     load-bearing: it picks the cluster for RpcConnectionManager, and PayApp
 *     signs `solana:devnet` into the key-derivation message.
 *   · PayApp keeps its own `mx-auto w-full max-w-md lg:max-w-5xl`, and the
 *     wrapper here carries a matching width. Measured earlier: inside a 448px
 *     box every two-column grid in the panels collapses and the content
 *     truncates ("Bitward...", "communicatio..."). The app therefore sits in a
 *     full-container band of its own rather than in the 8fr column of a
 *     section grid, which would have cost it ~330px per column.
 *   · No `styx-sweep` on the app panel. A hover streak crossing a live tab bar
 *     and a funded form is the wrong gesture.
 *
 * WHAT THE COPY MAY SAY, and why. The rebrand exists because the old page
 * overstated, so each line here is pinned to something a stranger can check.
 *
 *   · A stealth send names a one-time address as the payee, not a wallet:
 *     `SystemProgram.transfer({ toPubkey: stealth.address })`,
 *     packages/pay-core/src/worker/workerCore.ts:352. Scoped to the send on
 *     purpose: a pool withdrawal pays a per-note DERIVED payout address
 *     (PoolPanel.tsx:286-295), which is not the same object.
 *   · On a STEALTH SEND the sender is not hidden: the transfer carries
 *     `fromPubkey: sender`, every tx in the batch sets `tx.feePayer = sender`
 *     (workerCore.ts:352, 363), and this browser submits them itself
 *     (PayApp.tsx:151-172). No relayer stands in that leg.
 *   · ⚠️ THE POOL LEGS STOPPED WORKING THAT WAY ON 2026-08-21 AND THIS PAGE
 *     USED TO SAY OTHERWISE. A deposit no longer pre-funds the single-use
 *     signer from the wallet. The wallet signs ONE visible transfer to this
 *     deployment's collection address plus a 1% operator fee in the same
 *     transaction (lib/privacy/pool/ephemeralFunder.ts, the relayed branch),
 *     and the deployment's float funds the signer from a different address —
 *     so the transaction that touches the pool does not name the buyer. A
 *     deposit that cannot be relayed REFUSES; it never falls back silently.
 *     A withdrawal or a subscription may be paid entirely by the deployment,
 *     in which case the wallet is on no transaction at all, and the outcome
 *     reports `fundedBy` so the screen can say which happened.
 *   · The commitment linkage is CONDITIONAL as of 2026-08-25 and this page must
 *     stay conditional with it. On circuit 7, which this app tries first, the
 *     spend publishes no commitment at all and there is nothing to match against
 *     the deposit. A note circuit 7 cannot prove falls back to the C1 + C3 pair,
 *     which DOES republish it: devnet leaf 16, commitment 8901821612542787864,
 *     present in both transactions. What is unconditional is the fee payer, and
 *     P6 fails on it structurally and always will.
 *   · The proof system is hash-based: Poseidon and Merkle trees, no elliptic
 *     curves. The stealth address is hybrid X25519 + ML-KEM-768 (FIPS 203).
 *     Transaction signatures are Ed25519 and stay classical, so the page says
 *     "hybrid post-quantum stealth addresses", never "post-quantum payments".
 *
 * WHAT IT MAY NOT SAY: untraceable, anonymous, zero traces, audited, mainnet,
 * any user/volume/TVL number, any performance figure. Dropped from the old
 * hero for being uncheckable: "No indexer" (the RPC endpoint sees every query
 * and the P01 pairing flow polls /api/pair/:id on this origin) and the bare
 * "Hybrid PQ" chip, replaced by the literal primitive names.
 *
 * NO SCROLL REVEAL ON THIS PAGE, DELIBERATELY. `_styx/Reveal` renders
 * `data-revealed="false"`, and styx.css takes that to `opacity: 0` whenever
 * motion is welcome, so the content only appears once the client effect runs.
 * Measured on 2026-08-11 at 1440x945: with the four fact cards sitting 275px
 * into the viewport, all eight reveal targets were still `false` at
 * `opacity: 0`. This is the heaviest client route on the site, five wallet
 * adapters plus @solana/web3.js and the privacy stack, so hydration lands late,
 * and if a chunk never lands it does not land at all. Reveal's docstring
 * promises it "cannot leave a page permanently blank", which holds for a missing
 * IntersectionObserver but NOT for a missing hydration.
 *
 * Everything this page puts in a card or a step is a disclosure: not audited, no
 * mainnet, your wallet signs every transaction it sends and is named on a
 * stealth send, a deposit detours through this deployment, and a withdrawal can
 * be paired with its deposit. Gating those on JavaScript while the hero renders from HTML would
 * mean the claims survive a bad load and the caveats do not, which is the exact
 * failure this rebrand exists to correct. The motion signature is carried
 * instead by devices that cannot fail: the hero rule draw, `styx-sweep` on
 * hover, the one gleam word and the gleam rule. All CSS, all degrade to static.
 *
 * THE OLD NAME ON THE PROMPT. `buildDerivationMessage()` still opens with
 * "Protocol 01 - Private Payment Keys" (lib/privacy/message.ts) and that string
 * IS the seed of every stealth spending, viewing and ML-KEM key. Rebranding it
 * would silently re-derive every user's keys and orphan their notes and
 * subscription vaults, so it is frozen for life. The page warns the reader
 * about it instead of pretending the prompt says Styx.
 */
/**
 * MEASURED DEFECT IN THE SHARED SHEET, worked around here, reported upstream.
 *
 * styx.css opts headings out of the root stylesheet's Orbitron with
 * `.styx :is(h1, h2, h3, h4, h5, h6) { font-family: inherit; font-weight:
 * inherit; letter-spacing: normal }`. `:is()` takes the specificity of its most
 * specific argument, so that selector is (0,1,1) and it BEATS `.styx-h1`,
 * `.styx-h2` and `.styx-h3`, which are (0,1,0). The consequence, measured in
 * Chrome at 1440px on 2026-08-11: a real `<h1 class="styx-h1">` renders in Inter
 * at weight 400 with normal tracking, while `.styx-wordmark-name`, a `<span>`
 * and so untouched by the opt-out, renders correctly in Newsreader. Every heading
 * on every Styx page is currently affected; the intent in the sheet's own
 * comment ("the serif is applied per class") is not what ships.
 *
 * The fix belongs in styx.css and app/_styx is off limits to this port, so the
 * sheet's own tokens are re-applied inline, where nothing can outrank them.
 * Nothing here is invented: every value is read straight out of styx.css, by
 * variable wherever one exists, so a change to the tokens still reaches this
 * page. app/explorer/page.tsx arrived at the same workaround independently and
 * uses the same constant names. When the shared selector is fixed these become
 * redundant duplicates rather than a divergence.
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

const TITLE = "Devnet app · Styx Protocol";

const DESCRIPTION =
  "Shield, withdraw and subscribe on Solana devnet. Recipients stand behind one-time hybrid stealth addresses, X25519 with ML-KEM-768, whose keys are derived from your Ed25519 wallet key. Your wallet signs every transaction it sends, and a deposit is paid through this deployment rather than straight into the pool. Not audited, and there is no mainnet deployment.";

/* A link preview is shorter than a meta description and gets read on its own,
   so it leads with the two disclosures rather than the primitives. */
/* ⚠️ THIS SAID "Depositing names your address" UNTIL 2026-08-22, six lines
   below a DESCRIPTION that already said the opposite and said it correctly.
   A link preview is the one string that TRAVELS: it is read by people who
   never open the page, so a falsehood here outlives every correction made
   inside the app. The relayed deposit landed on 2026-08-21 and this was
   missed because the audit that day walked the rendered screens, and a meta
   tag renders nowhere. */
const SOCIAL_DESCRIPTION =
  "The devnet money surface: shield, withdraw, subscribe. Your wallet signs one public payment to this deployment, which funds the key that touches the pool; a spend can still be paired with the deposit it spends. Not audited. No mainnet deployment.";

/**
 * WHY openGraph, twitter AND keywords ARE ALL RESTATED HERE.
 *
 * Next.js resolves metadata by segment and a child inherits every field it does
 * not set itself. app/layout.tsx still carries the retired brand: og:title and
 * twitter:title "PROTOCOL-01", both descriptions reading "The ultimate
 * privacy-first protocol for secure transactions and anonymous interactions",
 * and a keywords list containing "anonymous", "protocol 01" and "p01"
 * (app/layout.tsx:43-80). Setting only `title` and `description` left this route
 * serving that sentence verbatim to every crawler and chat unfurl, so the page
 * body said the sender is not hidden while its own link preview promised
 * anonymity. app/layout.tsx is outside this port, which is why the correction is
 * stated per route, exactly as app/docs/layout.tsx and app/explorer/layout.tsx
 * already do.
 *
 * openGraph and twitter are replaced whole rather than merged field by field, so
 * leaving `images` out here also keeps the old /01-miku.png asset from following
 * this route into a preview. Picking a replacement image is a layout-level asset
 * decision and stays upstream; the twitter card is therefore `summary`, which
 * does not require one, instead of the inherited `summary_large_image`.
 *
 * The keywords describe what a reader will actually find: devnet, a shielded
 * pool, the two named primitives. Nothing in the frozen-literal set is touched,
 * these are search terms, not seeds.
 */
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "styx protocol",
    "solana devnet",
    "shielded pool",
    "stealth addresses",
    "X25519",
    "ML-KEM-768",
    "STARK proofs",
    "poseidon",
  ],
  openGraph: {
    title: TITLE,
    description: SOCIAL_DESCRIPTION,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: SOCIAL_DESCRIPTION,
  },
};

/**
 * ⚠️ SERVER-SIDE TRANSLATION, AND THE REASON IT IS NOT `useT()`.
 *
 * Every sentence below moved into `pay.page.*` on 2026-09-09, because the site
 * serves French by country and this page was hardcoded English. It reads the
 * dictionary through `getServerT()` rather than the client hook, because the
 * header of this file already ruled on the question: the disclosures on this
 * page must render from HTML. This is the heaviest client route on the site,
 * and a caveat that needs hydration is a caveat that can fail to appear while
 * the claims around it do not.
 *
 * The cost is that `cookies()` makes this route dynamic. That is one route, and
 * one that renders a wallet-connected app nobody can usefully cache. See
 * i18n/server.ts for the full trade, including where the server and the client
 * can disagree (local development, where no country cookie exists).
 *
 * `metadata` below stays English: it is generated at build time, and localising
 * it means `generateMetadata` with the same cookie read. Worth doing, not done
 * here — a share card in the wrong language is a smaller defect than a caveat
 * that does not render, and this pass is spending its risk on the second one.
 */
export default async function PayPage() {
  const t = await getServerT();
  return (
    <StyxShell>
      {/* ── Page header ─────────────────────────────────────────────────── */}
      {/* THIS ROUTE IS A TOOL. THE PAGE IS NOW SHAPED LIKE ONE.
          Measured 2026-09-09: /app was 1 152 words over 5 490 px and the app
          itself started 1 492 px down, under a full-height hero, a four-card
          facts strip and two paragraphs about key derivation. A visitor who
          came to move a test token read an essay first.

          What is left above the app is the three things that decide whether to
          touch it at all: where you are, what it does, and that it is devnet.
          Everything else — the stealth-address sentence, the two buttons, the
          primitives, the four limits — is below the panel, in the same words,
          in the section built for it. Nothing is deleted anywhere on this page;
          the order is the change.

          THE HEADLINE IS THE VERBS. It was "On a stealth send, the payee is a
          one-time address, not a wallet": true, important, and a strange first
          thing to meet before knowing what the screen does. It opens the "How
          it works" section now. */}
      <section className="styx-container styx-app-hero">
        <p className="styx-overline">{t("pay.page.overline")}</p>
        <h1 className="styx-h1" style={SERIF_H1}>
          {t("pay.page.h1")}
        </h1>

        {/* The amber, on one line. It was a bordered card three lines deep
            beside the lede; the sentence is unchanged and it no longer costs a
            block. */}
        <p className="styx-app-hero-warn">
          <span className="styx-app-hero-warn-tag">{t("pay.page.devnetTag")}</span>
          {t("pay.page.devnetBody")}
        </p>
      </section>

      {/* ── The app, first ─────────────────────────────────────────────── */}
      {/* Was the second half of "01 · The app", 1 492 px down the page. The
          prose that introduced it still exists and now follows it: a reader who
          wants the mechanism scrolls to it, and a reader who wants to move a
          token does not have to. The panel, its chips and its note are moved
          verbatim — every sentence __tests__/pages/PayAppCopy.test.tsx pins is
          in this block, unchanged. */}
      <section id="app" className="styx-section styx-section-alt">
        {/* Full container width: the panels inside PayApp need the room. See
            the note at the top of this file — inside a 448px box every
            two-column grid in them collapses and the content truncates.

            THE TWO TOP MARGINS AND THE GLEAM RULE ARE GONE. Both offsets and
            the rule existed to separate this panel from the two paragraphs of
            prose that used to sit above it inside the same section. Nothing
            sits above it now except the page header, so together with the
            section's own padding they left roughly 400px of empty band between
            the disclosure and the first control — measured at 1440x900, the
            panel started at 936px on a page whose whole point is to be used. */}
        <div className="styx-container">
          <div className="styx-panel">
            <div className="styx-panel-head">
              <p className="styx-overline">{t("pay.page.panelOverline")}</p>
              <div
                className="styx-btn-row"
                style={{ marginTop: "0.9rem", alignItems: "center" }}
              >
                <span className="styx-chip">
                  <span className="styx-dot" aria-hidden="true" />
                  {t("pay.page.chipDevnet")}
                </span>
                <span className="styx-chip">{t("pay.page.chipNotAudited")}</span>
                <span className="styx-chip">{t("pay.page.chipNoMainnet")}</span>
              </div>
              {/* 🚨 THIS SAID "your wallet is the fee payer on every
                  transaction this panel sends" AND THAT STOPPED BEING TRUE.
                  Where a funder is configured it pays the rent and fees for a
                  subscription or a withdrawal, and an issued note means the
                  wallet does not deposit either — so the sentence overstated
                  the exposure on exactly the paths built to remove it. The
                  reverse of the usual failure, and just as much a claim the
                  code contradicts: a banner nobody can trust in one direction
                  is not trusted in the other either.

                  🚨 AND THE REPLACEMENT ROTTED IN ONE DAY. It read "Depositing
                  moves real value in, so it always comes from your address by
                  name" — chosen on 2026-08-21 as the one thing that could not
                  change. It changed on 2026-08-22. `PoolPanel` passes
                  `depositPublicly: treasuryMode`, so an ordinary deposit is the
                  RELAYED shape or it is refused: the wallet pays this
                  deployment, this deployment funds the one-time key, and the
                  buyer's address is not in the pool transaction. Confirmed on
                  chain — leaf 72, re-read by RPC, the buyer absent from the
                  deposit's account keys.

                  🧠 THE LESSON IS ABOUT THE SHAPE OF THE MISTAKE, NOT THE
                  SENTENCE. The 2026-08-21 audit fixed six RESULT screens and
                  left the ENTRY screens alone, so every surviving falsehood was
                  one a reader meets BEFORE acting. This banner and
                  SOCIAL_DESCRIPTION both said the deposit names you while step
                  01 below and the page's own meta DESCRIPTION said it does not
                  — four texts, one file, two answers.

                  What is unconditionally true is that the wallet SIGNS once and
                  in public, and that each screen states who paid for that
                  screen's operation, because only the screen knows. Where the
                  money then goes is a per-screen fact and must not be asserted
                  here. */}
              {/* ⚠️ FOLDED, NOT REMOVED, AND THE SUMMARY IS THE HONEST HALF.
                  This is 45 words about who signs what, printed above the tool
                  on every tab and every visit. The three chips above it already
                  say devnet, unaudited, no mainnet — which is the part that
                  decides whether to touch anything. The sentence stays, whole,
                  one click behind a summary that names what it is about, so a
                  reader looking for the cost of a deposit finds it and a reader
                  who came to move a token is not made to read it first.

                  __tests__/pages/PayAppCopy.test.tsx pins the sentence in the
                  dictionary, not its expansion, so folding it changes nothing
                  that guard is watching. */}
              <details className="styx-panel-note" style={{ marginTop: "0.9rem" }}>
                <summary>{t("pay.page.panelNoteSummary")}</summary>
                <p className="styx-note" style={{ marginTop: "0.6rem" }}>
                  {t("pay.page.panelNote")}
                </p>
              </details>
            </div>
            <div className="styx-panel-body">
              {/* Width is load-bearing; PayApp carries the matching classes. */}
              {/* `styx-pay` is the scope of the skin that drags components/pay/*
                  into the vault language — see the block at the end of
                  app/_styx/styx.css for what it does and why it is a skin
                  rather than a rewrite of those files. */}
              <div className="styx-pay mx-auto w-full max-w-md lg:max-w-5xl">
                <WalletProvider network="devnet">
                  <PayApp />
                </WalletProvider>
              </div>
            </div>
          </div>
        </div>
      </section>


      {/* ── Facts strip ────────────────────────────────────────────────── */}
      <section className="styx-container styx-strip" aria-label="What this app runs on">
        <div className="styx-grid styx-grid-4">
          <div className="styx-card styx-sweep">
            <p className="styx-card-label">{t("pay.page.factProofLabel")}</p>
            <p className="styx-card-value">{t("pay.page.factProofValue")}</p>
            <p className="styx-card-note">{t("pay.page.factProofNote")}</p>
          </div>
          <div className="styx-card styx-sweep">
            <p className="styx-card-label">{t("pay.page.factStealthLabel")}</p>
            <p className="styx-card-value">X25519 + ML-KEM-768</p>
            <p className="styx-card-note">{t("pay.page.factStealthNote")}</p>
          </div>
          <div className="styx-card styx-sweep">
            <p className="styx-card-label">{t("pay.page.factSigLabel")}</p>
            <p className="styx-card-value">Ed25519</p>
            <p className="styx-card-note">{t("pay.page.factSigNote")}</p>
          </div>
          <div className="styx-card styx-sweep">
            <p className="styx-card-label">{t("pay.page.factStatusLabel")}</p>
            <p className="styx-card-value">{t("pay.page.factStatusValue")}</p>
            <p className="styx-card-note">{t("pay.page.factStatusNote")}</p>
          </div>
        </div>
      </section>


      {/* ── 01 · How it works ──────────────────────────────────────────── */}
      {/* The prose half of what used to be one section with the app panel. It
          keeps id="how" — id="app" belongs to the panel above, which is what
          the hero button and every inbound #app link mean now. */}
      <section id="how" className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">{t("pay.page.howIndex")}</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              {t("pay.page.howTitle")}
            </h2>
          </div>
          <div className="styx-prose">
            {/* The old hero lede and its two buttons, re-homed. They are the
                page's explanation of itself, which is what this section is; at
                the top they were three blocks a reader had to get past to reach
                the control. Word for word the same sentences. */}
            <p>
              {t("pay.page.howStealthLead")}
              <em className="styx-em">{t("pay.page.howStealthEm")}</em>
              {t("pay.page.howStealthTail")}
              <strong>{t("pay.page.howKeys")}</strong>
            </p>
            <p>{t("pay.page.howBody")}</p>
            <p>
              <strong>{t("pay.page.howPromptLead")}</strong>
              {t("pay.page.howPromptBody")}
            </p>
            <div className="styx-btn-row" style={{ marginTop: "1.75rem" }}>
              <a className="styx-btn-ghost" href="#limits">
                {t("pay.page.ctaLimits")}
              </a>
              <a className="styx-btn-ghost" href="/docs">
                {t("pay.page.ctaDocs")}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── 02 · Before you sign ───────────────────────────────────────── */}
      <section id="limits" className="styx-section">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              02
            </span>
            <p className="styx-index">{t("pay.page.limitsIndex")}</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              {t("pay.page.limitsTitle")}
            </h2>
          </div>
          <div>
            <div className="styx-prose">
              <p>
                {t("pay.page.limitsLede")}
              </p>
            </div>

            <ul className="styx-steps">
              <li className="styx-step">
                <span className="styx-step-index">01</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    {t("pay.page.limit1Title")}
                  </h3>
                  <p className="styx-step-body">
                    {t("pay.page.limit1Body")}
                  </p>
                  <div style={{ marginTop: "0.9rem" }}>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit1Row1Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit1Row1Value")}
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit1Row2Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit1Row2Value")}
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit1Row3Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit1Row3Value")}
                      </span>
                    </div>
                  </div>
                </div>
              </li>

              <li className="styx-step">
                <span className="styx-step-index">02</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    {t("pay.page.limit2Title")}
                  </h3>
                  <p className="styx-step-body">
                    {t("pay.page.limit2Body")}
                  </p>
                  <div style={{ marginTop: "0.9rem" }}>
                    <div className="styx-row">
                      <span className="styx-row-key">cluster</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">devnet</span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">leaf</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">16</span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">commitment</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        8901821612542787864
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit2Row3Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit2Row3Value")}
                      </span>
                    </div>
                  </div>
                </div>
              </li>

              <li className="styx-step">
                <span className="styx-step-index">03</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    {t("pay.page.limit3Title")}
                  </h3>
                  <p className="styx-step-body">
                    {t("pay.page.limit3Body")}
                  </p>
                  <div style={{ marginTop: "0.9rem" }}>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit3Row1Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit3Row1Value")}
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit3Row2Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit3Row2Value")}
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit3Row3Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit3Row3Value")}
                      </span>
                    </div>
                  </div>
                </div>
              </li>

              <li className="styx-step">
                <span className="styx-step-index">04</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    {t("pay.page.limit4Title")}
                  </h3>
                  <p className="styx-step-body">
                    {t("pay.page.limit4Body")}
                  </p>
                  <div style={{ marginTop: "0.9rem" }}>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit4Row1Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit4Row1Value")}
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit4Row2Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit4Row2Value")}
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">{t("pay.page.limit4Row3Key")}</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        {t("pay.page.limit4Row3Value")}
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── Close ──────────────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container">
          <p className="styx-overline">{t("pay.page.closeOverline")}</p>
          <h2 className="styx-h2" style={SERIF_H2}>
            {t("pay.page.closeTitle")}
          </h2>
          <p className="styx-lede" style={{ marginTop: "1.5rem" }}>
            {t("pay.page.closeBody")}
          </p>
          <div className="styx-btn-row" style={{ marginTop: "2rem" }}>
            <a className="styx-btn-ghost" href="/docs">
              {t("pay.page.closeDocs")}
            </a>
            <a className="styx-btn-ghost" href="/explorer">
              {t("pay.page.closeExplorer")}
            </a>
            <a className="styx-btn-ghost" href="#app">
              {t("pay.page.closeBack")}
            </a>
          </div>
          <p className="styx-note" style={{ marginTop: "2rem" }}>
            <span className="styx-check" aria-hidden="true">
              &#10003;
            </span>
            {t("pay.page.closeNote")}
          </p>
        </div>
      </section>
    </StyxShell>
  );
}
