import type { Metadata } from "next";
import StyxShell from "../../_styx/StyxShell";
import { WalletProvider } from "@/components/WalletProvider";
import PayApp from "@/components/pay/PayApp";

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
 *   · The withdrawal still republishes the commitment its deposit published:
 *     devnet leaf 16, commitment 8901821612542787864, present in both
 *     transactions. That linkage is NOT fixed and this page says so.
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
  "Shield, withdraw and subscribe on Solana devnet. Recipients stand behind one-time hybrid stealth addresses, X25519 with ML-KEM-768. Your wallet signs every transaction it sends, and a deposit is paid through this deployment rather than straight into the pool. Not audited, and there is no mainnet deployment.";

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

export default function PayPage() {
  return (
    <StyxShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        <p className="styx-overline">
          Styx Protocol &middot; Devnet app &middot; Solana
        </p>
        <h1 className="styx-h1" style={SERIF_H1}>
          On a stealth send, the payee is a one-time{" "}
          <em className="styx-em styx-gleam-strong">address</em>, not a wallet.
        </h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        <div className="styx-hero-body">
          <div className="styx-stack">
            <p className="styx-lede">
              Nothing here hides you from the start: a stealth send names
              your wallet as the payer, and a pool withdrawal republishes its
              deposit&apos;s commitment. A deposit is the one leg that detours
              — you pay this deployment, and it funds the key that touches the
              pool.{" "}
              <strong>
                Your keys are derived from one wallet signature and live in this
                tab&apos;s worker. They are never uploaded.
              </strong>
            </p>
            <div className="styx-btn-row">
              <a className="styx-btn" href="#app">
                Open the app
              </a>
              <a className="styx-btn-ghost" href="/docs">
                Read the mechanism
              </a>
            </div>
          </div>

          {/* The one amber on this page. */}
          <div className="styx-admission">
            <p className="styx-admission-title">Devnet only, read first</p>
            <p className="styx-admission-body">
              Test tokens, not real funds. This software has not been audited,
              and there is no mainnet deployment. Anything you move here you
              should be able to afford to lose.
            </p>
          </div>
        </div>
      </section>

      {/* ── Facts strip ────────────────────────────────────────────────── */}
      <section className="styx-container styx-strip" aria-label="What this app runs on">
        <div className="styx-grid styx-grid-4">
          <div className="styx-card styx-sweep">
            <p className="styx-card-label">Proof system</p>
            <p className="styx-card-value">Hash-based STARK</p>
            <p className="styx-card-note">
              Poseidon and Merkle trees only. No elliptic curves anywhere in the
              proof.
            </p>
          </div>
          <div className="styx-card styx-sweep">
            <p className="styx-card-label">Stealth address</p>
            <p className="styx-card-value">X25519 + ML-KEM-768</p>
            <p className="styx-card-note">
              Hybrid key encapsulation. The lattice half follows FIPS 203.
            </p>
          </div>
          <div className="styx-card styx-sweep">
            <p className="styx-card-label">Signatures</p>
            <p className="styx-card-value">Ed25519</p>
            <p className="styx-card-note">
              Solana verifies nothing else, so every transaction you send from
              here stays classically signed.
            </p>
          </div>
          <div className="styx-card styx-sweep">
            <p className="styx-card-label">Status</p>
            <p className="styx-card-value">Devnet, not audited</p>
            <p className="styx-card-note">
              Deployed and running on devnet. There is no mainnet deployment.
            </p>
          </div>
        </div>
      </section>

      {/* ── 01 · The app ───────────────────────────────────────────────── */}
      <section id="app" className="styx-section styx-section-alt">
        <div className="styx-container styx-section-grid">
          <div className="styx-section-label">
            <span className="styx-numeral" aria-hidden="true">
              01
            </span>
            <p className="styx-index">The app</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              Shield, withdraw, subscribe.
            </h2>
          </div>
          <div className="styx-prose">
            <p>
              Connect a wallet, then sign to derive your stealth spending,
              viewing and ML-KEM keys. Your wallet is asked for two signatures,
              and the second one is only there to prove it signs
              deterministically, so your keys can still be re-derived next
              session. Neither signature leaves this tab and no transaction is
              sent to derive anything. From there the tabs cover sending to a
              one-time address, importing a sealed note, moving value in and out
              of the shielded pool, and opening or reviewing a subscription
              vault.
            </p>
            <p>
              <strong>
                The signing prompt is still headed with the old Protocol 01 name.
              </strong>{" "}
              That heading is the seed of every key this app derives for you, so
              renaming it would orphan the notes and vaults of everyone who
              already has some. It stays exactly as it is. The name on the prompt
              is old; the keys it produces are yours.
            </p>
          </div>
        </div>

        {/* Full container width, deliberately outside the 3fr/8fr grid above:
            the panels inside PayApp need the room. See the note at the top. */}
        <div
          className="styx-container"
          style={{ marginTop: "clamp(2.5rem, 5vw, 4rem)" }}
        >
          <div className="styx-gleam-rule" aria-hidden="true" />

          <div
            className="styx-panel"
            style={{ marginTop: "clamp(2rem, 4vw, 3rem)" }}
          >
            <div className="styx-panel-head">
              <p className="styx-overline">
                Solana devnet &middot; your keys stay in this tab
              </p>
              <div
                className="styx-btn-row"
                style={{ marginTop: "0.9rem", alignItems: "center" }}
              >
                <span className="styx-chip">
                  <span className="styx-dot" aria-hidden="true" />
                  Devnet
                </span>
                <span className="styx-chip">Not audited</span>
                <span className="styx-chip">No mainnet deployment</span>
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
              <p className="styx-note" style={{ marginTop: "0.9rem" }}>
                Test tokens only. Depositing costs your wallet one public
                signature paying this deployment, which then funds the one-time
                key that touches the pool — so your address is not on the pool
                transaction itself. Each screen says who paid for that screen.
              </p>
            </div>
            <div className="styx-panel-body">
              {/* Width is load-bearing; PayApp carries the matching classes. */}
              <div className="mx-auto w-full max-w-md lg:max-w-5xl">
                <WalletProvider network="devnet">
                  <PayApp />
                </WalletProvider>
              </div>
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
            <p className="styx-index">Before you sign</p>
            <h2 className="styx-h2" style={SERIF_H2}>
              Four things this page will not pretend.
            </h2>
          </div>
          <div>
            <div className="styx-prose">
              <p>
                Each of these is checkable on a block explorer or in the source,
                which is the only reason it is written here. The recipient side
                is what this app hides. The payer side is not, and neither is
                the link between a deposit and the withdrawal that spends it.
              </p>
            </div>

            <ul className="styx-steps">
              <li className="styx-step">
                <span className="styx-step-index">01</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    Your wallet signs, and it is not always on chain
                  </h3>
                  <p className="styx-step-body">
                    A deposit costs your wallet one signature: a single, fully
                    visible transaction paying this deployment, plus a 1%
                    operator fee in the same transaction. This deployment then
                    funds the single-use key that touches the pool, from a
                    different address of its own — so the transaction that
                    deposits does not name you. A withdrawal or a subscription
                    asks the deployment to cover the whole job; when it does,
                    your wallet is on no transaction at all, and when it cannot,
                    your wallet pays and the screen tells you which of the two
                    happened. A deposit that cannot be relayed is refused rather
                    than quietly falling back.
                  </p>
                  <div style={{ marginTop: "0.9rem" }}>
                    <div className="styx-row">
                      <span className="styx-row-key">you sign</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        one transfer, to this deployment
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">the pool deposit</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        a single-use key we funded
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">relayer</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        this deployment, for the funding leg
                      </span>
                    </div>
                  </div>
                </div>
              </li>

              <li className="styx-step">
                <span className="styx-step-index">02</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    A withdrawal can be paired with its deposit
                  </h3>
                  <p className="styx-step-body">
                    Unshielding republishes the same commitment the deposit
                    published, so the two transactions can be matched today by
                    anyone reading the chain. This is not fixed, no client-side
                    change can hide it, and the pool is small enough that
                    matching is not hard. Read the pair below on devnet before
                    you decide what to move.
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
                      <span className="styx-row-key">appears in</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        both the deposit and the withdrawal
                      </span>
                    </div>
                  </div>
                </div>
              </li>

              <li className="styx-step">
                <span className="styx-step-index">03</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    One public hop, and it points at us, not at the pool
                  </h3>
                  <p className="styx-step-body">
                    Shielding still begins with one ordinary, fully visible
                    transfer signed by your wallet — but it now pays this
                    deployment rather than the single-use signer, and this
                    deployment funds that signer from a separate address. Two
                    transfers, neither naming both ends. What still ties them is
                    the amount and the minutes between them, and nothing here
                    hides either. A pool withdrawal then pays a payout address
                    derived per note, and refuses to pay the connected wallet at
                    all.
                  </p>
                  <div style={{ marginTop: "0.9rem" }}>
                    <div className="styx-row">
                      <span className="styx-row-key">pre-fund</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        public transfer, from you to this deployment
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">signer</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        one use, funded by this deployment
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">payout</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        derived per note, never your wallet
                      </span>
                    </div>
                  </div>
                </div>
              </li>

              <li className="styx-step">
                <span className="styx-step-index">04</span>
                <div>
                  <h3 className="styx-h3" style={SERIF_H3}>
                    The amounts are not hidden, and neither is the clock
                  </h3>
                  <p className="styx-step-body">
                    The pool is denominated, so a shield or a withdrawal reveals
                    which denomination you used, and the timing of every
                    transaction is public because you sent it yourself. What the
                    proof withholds is which note in the tree you spent. That is
                    the whole of the guarantee, and it is worth exactly as much
                    as the number of other notes sitting beside yours.
                  </p>
                  <div style={{ marginTop: "0.9rem" }}>
                    <div className="styx-row">
                      <span className="styx-row-key">hidden</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        which note was spent
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">public</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        denomination, timing, your wallet
                      </span>
                    </div>
                    <div className="styx-row">
                      <span className="styx-row-key">verified by</span>
                      <span className="styx-row-leader" />
                      <span className="styx-row-value">
                        a Solana program, not a server
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
          <p className="styx-overline">The honest offer</p>
          <h2 className="styx-h2" style={SERIF_H2}>
            Test it with money you can afford to lose.
          </h2>
          <p className="styx-lede" style={{ marginTop: "1.5rem" }}>
            That is what a devnet can offer. Shield, pay, withdraw, then read the
            programs that did it and the transactions they left behind.
          </p>
          <div className="styx-btn-row" style={{ marginTop: "2rem" }}>
            <a className="styx-btn-ghost" href="/docs">
              Documentation
            </a>
            <a className="styx-btn-ghost" href="/explorer">
              Live explorer
            </a>
            <a className="styx-btn-ghost" href="#app">
              Back to the app
            </a>
          </div>
          <p className="styx-note" style={{ marginTop: "2rem" }}>
            <span className="styx-check" aria-hidden="true">
              &#10003;
            </span>
            Every claim on this page is either visible on devnet or readable in
            the source. Nothing about users, volume or throughput appears here,
            because none of it is benchmarked.
          </p>
        </div>
      </section>
    </StyxShell>
  );
}
