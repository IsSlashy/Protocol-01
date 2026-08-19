"use client";

import React from "react";
import Link from "next/link";
import { Clock, Play } from "lucide-react";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";

/**
 * /updates: the development log, ported to the Styx vocabulary.
 *
 * What is load-bearing here and must not drift:
 *
 *  - `"use client"` and `React.useState<number | null>` are the page's only
 *    state: which week's video is playing. One at a time, keyed by week.
 *  - The paused card holds TWO <video> elements: the muted still preview inside
 *    the button, and nothing else; the playing branch swaps in a `controls
 *    autoPlay` video. `autoPlay` is what makes the click start playback and
 *    `controls` is the only way to pause, so neither may be dropped. The preview
 *    deliberately carries no poster, preload or playsInline: adding them would
 *    change network and iOS behaviour.
 *  - The `update.video ?` layout branch keeps weeks 3 to 9 from rendering an
 *    empty media column.
 *  - The `status` union and both of its branches survive. Nothing in the array
 *    uses "coming-soon" today, but the branch is the data contract, so deleting
 *    it would be a data-shape change rather than a restyle.
 *  - The play button's `aria-label` is its only accessible name (its children
 *    are a video and an icon), and the x.com href and /roadmap <Link> are kept
 *    exactly as they were.
 *
 * Dropped: framer-motion (mount animations, replaced by Reveal, which triggers
 * on intersection instead), the unused ArrowLeft import, SiteHeader/Footer (the
 * shell supplies chrome), and `.btn-primary` from globals.css, which is Orbitron
 * plus a cyan box-shadow.
 *
 * Copy discipline. This page overstated in nine different ways and the entries
 * below are rewritten, not restyled: the 124-bit soundness figure is withdrawn
 * (the FRI rate was later measured at one half, and the verifier had no DEEP
 * binding at the time), the compute-unit and net-SOL numbers are gone because no
 * transaction is linked beside them, the streaming brand names are replaced by
 * neutral wording, "anonymous" and "forever" and "instant" are gone, and the
 * transaction-opacity entry now says in the same breath that a deposit and its
 * withdrawal are still linkable, because the withdrawal republishes the deposit
 * commitment. The nine-week gap between the last entry and today is the single
 * amber admission under the hero.
 *
 * Frozen literals in the copy: p01_liquidity, p01_relayer, denominated_pool_v2,
 * denominated_pool_v4, subscribe_private, specter-sdk. Never rebranded.
 *
 * No t() calls: this route has never been translated, in this version or in any
 * version before it, so there is no key to restore. The localised chrome comes
 * from StyxHeader and StyxFooter, which call useT() themselves and cover both
 * shipped locales, English and French.
 *
 * Known defect that is NOT this page's to fix: every styx-h1 and styx-h2 here
 * renders in the sans face at weight 400 with normal tracking instead of the
 * serif display voice. app/_styx/styx.css line 69 as of 2026-08-11 reads
 * `.styx :is(h1, h2, h3, h4, h5, h6) { font-family: inherit; font-weight:
 * inherit; letter-spacing: normal }`. :is() carries the specificity of its most
 * specific argument, so that rule sits at (0,1,1) and outranks .styx-h1 and
 * .styx-h2 at (0,1,0) on those three properties whatever the source order;
 * only the clamp font-size from the class survives. The fix is one word,
 * `:is(` to `:where(`, and it belongs in the shared file because every styx
 * route is affected identically. Do not patch it locally here, that would fork
 * the design system for one page.
 */
interface WeekUpdate {
  week: number;
  title: string;
  date: string;
  status: "published" | "coming-soon";
  video?: string;
  highlights: string[];
}

const updates: WeekUpdate[] = [
  {
    week: 1,
    title: "Superteam Ireland & Dublin",
    date: "April 6 - 12, 2026",
    status: "published",
    highlights: [
      "Listed as a Superteam Ireland project",
      "Entered the Colosseum Frontier hackathon, an entry and not an outcome. The event has since closed",
      "Booked five days at Dogpatch Labs in Dublin to build in person",
    ],
  },
  {
    week: 2,
    title: "Post-Quantum STARK Migration",
    date: "April 13 - 19, 2026",
    status: "published",
    highlights: [
      "Moved the six circuits off Groth16 onto hash-based STARKs: Poseidon and Merkle trees, with no elliptic curves anywhere in the proof",
      "A FRI verifier running as a Solana program, with no trusted setup",
      "DEEP-ALI composition wired across the circuits. The soundness figure published here at the time was wrong: the FRI rate was later measured at one half rather than one sixteenth, and the verifier had no DEEP binding yet. The number is withdrawn, not restated",
      "Merkle-Update AIR verifying on-chain inside Solana's compute limit. The compute-unit figure once quoted here is stale and is not repeated",
      "p01_liquidity deployed on devnet as the unshield liquidity pool",
      "The WASM prover, the extension and SDK v2 all ported to the new circuits. No test count is quoted here; run the suite in the repository. Proving on a handset was measured much later at over three minutes, so on-device proving is unfinished rather than shipped",
    ],
  },
  {
    week: 3,
    title: "Colosseum Submitted & v0.9.9 Shipped",
    date: "April 20 - 26, 2026",
    status: "published",
    highlights: [
      "Submitted to the Colosseum Frontier hackathon, accelerator track. A submission, not a result, and the event has since closed",
      "Pitch deck and economic charter published as PDFs on the marketing site",
      "Service registry deployed on devnet with four demo service entries. Those entries were placeholders; no streaming provider is or was involved",
      "useServiceRegistry hook wired in, release APK demoed on an Android handset",
      "v0.9.9 tagged internally, denominated_pool_v2 seed bump, 13 fresh pools",
      "Merkle proof rebuild from chain events. Note recovery ran end to end on the cases tested",
      "abandonNote action added, and the destructive walletStore init wipe fixed",
      "Marketing refresh on the web app, plus a Hermes Buffer compatibility fix in specter-sdk",
    ],
  },
  {
    week: 4,
    title: "Five Days in Dublin & ZK End-to-End",
    date: "April 27 - May 3, 2026",
    status: "published",
    highlights: [
      "Five days in Dublin with Superteam Ireland, face to face with builders, founders and investors",
      "Met Diarmuid (Superteam IE) and Alejandro Gutierrez (Lead Superteam IE / Blockchain Ireland)",
      "Pete Townsend's talk on finding product-market fit in Web3 at Buildstation re-shaped the roadmap",
      "Merkle root divergence fixed via replayMerkleProofFromEvents. The notes that had gone unrecoverable came back in the cases tested",
      "Unshield lifecycle: 5 cascading bugs closed, per-pool counter via findSafeShieldCounter",
      "V3 STARK pools deployed on devnet, v1.0.0 tagged internally",
      "Applied to CastleDAO Ireland (August 2026)",
    ],
  },
  {
    week: 5,
    title: "V3 End-to-End, Opacity Sprint & Multi-Relayer",
    date: "May 4 - May 10, 2026",
    status: "published",
    highlights: [
      "V3 STARK transfer ran end to end on devnet: send, encode, import, mature, unshield. The net SOL figure once quoted here had no signature published beside it, so it is gone",
      "The transaction-opacity sprint landed its parts: p01_relayer wired into V3 (Phase A), event scrubbing on chain (Phase B), a uniform proof size (Phase C), fee_escrow PDAs (Phase E). None of that makes a deposit and its withdrawal unlinkable. The withdrawal republishes the deposit commitment, so that link is still open today",
      "Multi-relayer sprint: auto-rotation, a liveness filter, chunked submit_job, and lazy reputation decay against Sybils",
      "V4 pool seed bump (denominated_pool_v4), 13 fresh pools, leaving the un-decodable legacy events behind",
      "subscribe_private V3 fixes: Rust structs moved from V2 to V3, mobile instruction-builder placeholders, stark_proof_buffer made writable, 4 cascading bugs closed",
      "Mobile UI gained two modes (Classique and Privé) with V3 routing in subscribe.tsx and (streams)/[id].tsx, an explicit note picker, and withKeepAwake",
      "subscribe_private vault creation validated on chain. The PDA is shown truncated here (FG3DPX6SN…), so it is not something a reader can resolve from this page",
      "Quantum Wallet UX design document written as the specification for the months after judging",
    ],
  },
  {
    week: 6,
    title: "Dev3pack Placing & Demo Day",
    date: "May 11 - May 17, 2026",
    status: "published",
    highlights: [
      "Ranked second on the Solana track at the Dev3pack Global Hackathon. That is the organizers' record, and nothing on this page proves it for you",
      "Went live on X during the Demo Day window, with a streaming-subscription demo flow as the headline. The service in that demo was ours",
      "Marketing site and pitch materials refreshed off the back of both",
    ],
  },
  {
    week: 7,
    title: "Device Builds & Hardening",
    date: "May 18 - May 24, 2026",
    status: "published",
    highlights: [
      "Android release build pipeline stabilized on Windows: worklets first, then the app. That build produced an internal release APK of roughly 96 MB",
      "Device smoke-test workflow via the bundled release APK over adb",
      "Roadmap re-shaped after Pete Townsend's talk on finding product-market fit in Web3",
    ],
  },
  {
    week: 8,
    title: "Stabilization · ZK Unshield & Relayers",
    date: "May 25 - May 31, 2026",
    status: "published",
    highlights: [
      "C3 merkle_path verifier fixed on devnet. The non-trivial paths that had been failing unshielded in the cases tested",
      "Fixed a Noble shim regression that had broken transaction serialization",
      "Second relayer brought online on Fly (Frankfurt) with the dormant-node self-heal",
      "Privy recovery seed persisted offline, which killed the boot-time signing hang",
    ],
  },
  {
    week: 9,
    title: "Privy Removal & Extension Parity",
    date: "June 1 - June 7, 2026",
    status: "published",
    highlights: [
      "Removed Privy. The local wallet became the default signer, with no remote-signing dependency",
      "Extension caught up with mobile: denominated note transfer, relayer-routed private unshield, license keys that carry no account, Standard and ZK modes, scan-import device pairing, and phone-to-extension connect",
      "Shipped relayer RPC bad-slot self-healing and the live health indicator. The relayer has regressed since, and a keeper retry bug is open",
      "v1.0.2 and Chrome extension v0.5.0 tagged. Both are internal tags; this page does not link a download",
    ],
  },
];

/** Zero-padded week number, for the oversized marginal numeral. */
function weekNumeral(week: number) {
  return String(week).padStart(2, "0");
}

export default function UpdatesPage() {
  const [playingVideo, setPlayingVideo] = React.useState<number | null>(null);

  return (
    <StyxShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        <p className="styx-overline">
          Styx Protocol &middot; Formerly Protocol 01 &middot; Building in public
        </p>
        {/* The page's whole text-gleam budget, spent on one word. */}
        <h1 className="styx-h1">
          Nine weeks, <em className="styx-em styx-gleam-strong">logged</em>.
        </h1>
        <div className="styx-hero-rule" aria-hidden="true" />
        <div className="styx-hero-body">
          <p className="styx-lede">
            A record of what was built, what broke, and which claims did not
            survive being measured. Where an entry once carried a number this
            page could not stand behind, the number is gone and the correction is
            in the entry.{" "}
            <strong>
              Styx runs on Solana devnet. It has not been audited, and there is
              no mainnet deployment.
            </strong>
          </p>
          <div>
            <p className="styx-overline">Range</p>
            <p className="styx-mono" style={{ marginTop: "0.6rem" }}>
              Weeks 01 to 09 &middot; April 6 to June 7, 2026
            </p>
            <div className="styx-btn-row" style={{ marginTop: "1.5rem" }}>
              <a className="styx-btn-ghost" href="#week-9">
                Latest entry
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── The one admission ──────────────────────────────────────────── */}
      <section className="styx-container styx-strip" aria-label="Current state of this log">
        <div className="styx-admission">
          <p className="styx-admission-title">The log stops at week 9</p>
          <p className="styx-admission-body">
            The last entry covers June 1 to 7, 2026, and nothing has been added
            since. Read this as a record of nine weeks in spring 2026, not as the
            current state of the software, and not as a promise of a weekly
            cadence. The standing facts have not changed: devnet only, no audit,
            no mainnet deployment.
          </p>
        </div>
      </section>

      {/* ── The log ────────────────────────────────────────────────────── */}
      {updates.map((update) => {
        const numeral = weekNumeral(update.week);

        return (
          <section
            key={update.week}
            id={`week-${update.week}`}
            className={`styx-section${
              update.week % 2 === 0 ? " styx-section-alt" : ""
            }`}
          >
            <div className="styx-container styx-section-grid">
              <div className="styx-section-label">
                <span className="styx-numeral" aria-hidden="true">
                  {numeral}
                </span>
                {/* The week number is repeated here in text: the numeral above
                    is decorative and hidden from assistive tech. */}
                <p className="styx-index">
                  Week {numeral} &middot; {update.date}
                </p>
                <h2 className="styx-h2">{update.title}</h2>
                <div style={{ marginTop: "1.25rem" }}>
                  {update.status === "published" ? (
                    <span className="styx-chip">
                      <span className="styx-dot" aria-hidden="true" />
                      Shipped
                    </span>
                  ) : (
                    <span className="styx-chip">
                      <Clock size={11} aria-hidden="true" />
                      Not written yet
                    </span>
                  )}
                </div>
              </div>

              <div>
                {update.status === "published" && (
                  <div
                    className={
                      update.video
                        ? "grid gap-8 md:grid-cols-2 md:items-start"
                        : "grid grid-cols-1 gap-8"
                    }
                  >
                    {/* Video. styx.css has no media frame and no play
                        affordance, so this is composed from styx-panel plus
                        Tailwind's aspect-video, which carries no colour. */}
                    {update.video && (
                      <Reveal className="styx-panel styx-sweep styx-reveal">
                        <div className="relative aspect-video">
                          {playingVideo === update.week ? (
                            <video
                              src={update.video}
                              controls
                              autoPlay
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <button
                              onClick={() => setPlayingVideo(update.week)}
                              className="w-full h-full flex items-center justify-center cursor-pointer"
                              aria-label={`Play video, Week ${update.week}: ${update.title}`}
                            >
                              <video
                                src={update.video}
                                muted
                                className="absolute inset-0 w-full h-full object-cover opacity-40"
                              />
                              <span
                                className="styx-btn-ghost relative z-10"
                                style={{ background: "var(--styx-ink)" }}
                              >
                                <Play size={13} aria-hidden="true" />
                                Play
                              </span>
                            </button>
                          )}
                        </div>
                      </Reveal>
                    )}

                    {/* Highlights */}
                    <div>
                      <p className="styx-overline">Highlights</p>
                      <Reveal className="styx-reveal" delay={80}>
                        <ul
                          className="styx-prose"
                          style={{
                            display: "grid",
                            gap: "0.9rem",
                            marginTop: "1.1rem",
                          }}
                        >
                          {update.highlights.map((h, j) => (
                            <li key={j}>
                              <p>
                                <span className="styx-check" aria-hidden="true">
                                  &#10003;
                                </span>
                                {h}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </Reveal>
                    </div>
                  </div>
                )}

                {update.status === "coming-soon" && (
                  <p className="styx-mono">This entry is not written yet.</p>
                )}
              </div>
            </div>
          </section>
        );
      })}

      {/* End of the record. The hairline gleam is free; the text gleam was
          spent on the hero word. */}
      <div className="styx-container">
        <div
          className="styx-gleam-rule"
          aria-hidden="true"
          style={{ marginBlock: "clamp(3rem, 7vw, 5rem)" }}
        />
      </div>

      {/* ── Follow along ───────────────────────────────────────────────── */}
      <section className="styx-section styx-section-alt">
        <div className="styx-container">
          <p className="styx-overline">Follow along</p>
          <h2 className="styx-h2">The next entry gets written the same way.</h2>
          <p className="styx-lede" style={{ marginTop: "1.5rem" }}>
            Where a number could not be checked, it was removed or marked as
            internal, and where the old version guessed, the entry now says so.
            Several entries above still rest on records only the founder or the
            event organizers hold, and they are labelled that way.
          </p>
          <div className="styx-btn-row" style={{ marginTop: "2rem" }}>
            <a
              className="styx-btn"
              href="https://x.com/Slashy_fx"
              target="_blank"
              rel="noopener noreferrer"
            >
              Follow on X
            </a>
            <Link className="styx-btn-ghost" href="/roadmap">
              View roadmap
            </Link>
          </div>
          <p className="styx-note" style={{ marginTop: "1.5rem" }}>
            That X account is the founder&apos;s personal one, which is where
            these updates were posted. The project account is linked in the
            footer.
          </p>
        </div>
      </section>
    </StyxShell>
  );
}
