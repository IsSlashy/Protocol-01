"use client";

import type { CSSProperties, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  Lock,
  Shield,
  Smartphone,
  Trophy,
} from "lucide-react";
import StyxShell from "../../_styx/StyxShell";

/* ---------------------------------------------------------------------------
   The pitch deck, in the Styx voice.

   Presentation only: the deck is still ten slides driven by the keyboard, with
   the same key map, the same clamped index, the same framer-motion transition
   and the same fullscreen toggle. `chrome={false}` is deliberate: the deck is a
   fixed 100vh screen, so the shared header would sit on top of slide one and the
   shared footer would hang below the fold forever. The scope still supplies the
   tokens and opts every heading out of the root stylesheet's Orbitron.

   The copy is where the real work is. This deck used to print an audit that does
   not exist, a security level of 124 bits that measurement contradicts, a CU
   figure that is both unbenchmarked and stale, program counts that disagreed
   with each other, a device timing that was never a benchmark, and a promise of
   "zero on-chain link to source" that the protocol does not keep. All of that is
   gone. What replaces it is the sentence a stranger can check, plus the
   admission the old deck never made once in ten slides.

   THREE CLAIMS CORRECTED ON 2026-08-11, each against the source. Do not put any
   of them back.

     · THE SENDER IS NOT HIDDEN, on any leg. Slide 09 used to end "your own
       wallet appears in neither pool transaction". The wallet signs a public
       pre-fund transfer to the ephemeral one hop before the private leg, and
       both implementation headers say so in writing:
       lib/privacy/pool/shieldEphemeral.ts, "It does not buy sender anonymity
       either", and lib/privacy/pool/unshieldEphemeral.ts, "the `owner -> E`
       pre-fund transfer is untouched and still ties the wallet to this
       withdrawal. Do not read a fresh payout address as unlinkability."
       app/(pay)/app/page.tsx states the same house standard.
     · THE WITHDRAWAL IS CIRCUITS 1 AND 3, not circuit 5. Circuit 5 is
       CIRCUIT_TRANSFER (lib/privacy/pool/stark.ts:40).
       programs/zk_shielded/src/instructions/unshield_denominated_stark_v3.rs
       requires `c1_circuit_id == 1` and `c3_circuit_id == 3`. A deposit carries
       circuit 6, merkle_update (shield_denominated_v3 binds the C6 buffer).
     · MATURITY IS NOT ENFORCED ON CHAIN. The same V3 handler says verbatim
       "Maturity is a UX/SDK concern in V3 (same as v2). We update bookkeeping
       for anonymity metrics but don't enforce", there is no maturity require!,
       and the client pins min_epoch to 0 on every path
       (denominatedPool.ts, UNSHIELD_MIN_EPOCH = 0n).

   THREE MORE CORRECTED LATER THE SAME DAY, also against the source.

     · THERE IS NO 0.01 SOL BUCKET. The chapter 07 wallet illustration used to
       list two 0.01 SOL notes. SOL_POOLS_V3 in lib/privacy/pool/denominatedPool.ts
       holds 0.1, 1, 10, 100, 500 and 1000 SOL and nothing smaller, so the rows
       showed a pool that does not exist and contradicted chapter 03 at the same
       time. Illustrative data still has to be a real denomination.
     · USDC IS THE ONLY SPL TOKEN WITH A POOL. Chapter 03 used to end its bucket
       row with "+ SPL tokens". USDC_POOLS_V3 is the whole SPL side, and that
       file's own type comment says a wider claim would be "the same defect one
       layer down".
     · A FULL UNSHIELD CANNOT COMPLETE ON A PHONE TODAY. The installed mobile
       build carries a prover blob older than the deployed verifier, so the
       proof it builds is rejected on chain. Chapter 07 says the prover runs on
       the device, which is true, and now says this in the same breath, which is
       the part that was missing.
   --------------------------------------------------------------------------- */

const POOL_PROGRAM_ID = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";
const REPO_URL = "https://github.com/IsSlashy/Protocol-01";
const EXPLORER_URL = `https://explorer.solana.com/address/${POOL_PROGRAM_ID}?cluster=devnet`;
const X_FOUNDER = "https://x.com/Slashy_fx";
const X_PROJECT = "https://x.com/Protocol01_";
const DEV3PACK_URL = "https://hack.dev3pack.xyz";

/* `styx-step` ships 2rem of vertical padding and `styx-h3` a 0.7rem heel, which
   is rhythm for a page that scrolls. A slide has one viewport and no scroll, so
   the two step lists in this deck tighten both. Spacing only, composed from the
   shared classes.

   These two numbers are load-bearing, not taste. Measured on 2026-08-11 at
   1280x720, the projector case: the slide box is 619px tall (720 less the
   wrapper's 7vh top and bottom), and at 1.4rem steps the chapter 05 slide stood
   at 747px and chapter 08 at 762px. Both clipped, and the deck has no scroll by
   design, so the clip was silent: chapter 08 lost its "Demo" index off the top
   and put its explorer link 28px below the fold, unreachable. Prose on both
   slides was tightened in the same pass. If you lengthen a step body here,
   re-measure at 720p before you commit it. */
const STEP_TIGHT: CSSProperties = { paddingBlock: "1rem" };
const STEP_HEAD: CSSProperties = { marginBottom: "0.35rem" };

// ----------------------------------------------------------------------------
// Slide content
// ----------------------------------------------------------------------------

const SLIDES: Array<() => ReactElement> = [
  Slide1Title,
  Slide2Problem,
  Slide3Stack,
  Slide4Notes,
  Slide5Subscriptions,
  Slide6Quantum,
  Slide7Hardening,
  Slide8Mobile,
  Slide9LiveDemo,
  Slide10Closing,
];

// ----------------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------------

export default function PitchDeck() {
  const [idx, setIdx] = useState(0);
  const total = SLIDES.length;

  const next = useCallback(() => setIdx((i) => Math.min(i + 1, total - 1)), [total]);
  const prev = useCallback(() => setIdx((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        prev();
      } else if (e.key.toLowerCase() === "f") {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
      } else if (e.key === "Home") {
        setIdx(0);
      } else if (e.key === "End") {
        setIdx(total - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, total]);

  const Slide = SLIDES[idx];

  return (
    <StyxShell chrome={false}>
      <div className="relative h-screen w-full overflow-hidden">
        {/* Progress: a hairline track with an accent fill. No gradient, no glow. */}
        <div
          className="fixed top-0 left-0 right-0 z-40"
          style={{ height: "1px", background: "var(--styx-rule)" }}
        >
          <motion.div
            className="h-full"
            style={{ background: "var(--styx-accent)" }}
            initial={false}
            animate={{ width: `${((idx + 1) / total) * 100}%` }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          />
        </div>

        {/* Slide */}
        <AnimatePresence mode="wait">
          <motion.div
            key={idx}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="relative z-10 flex h-full w-full items-center justify-center"
            /* Asymmetric on purpose. The top of the screen holds a 1px progress
               track and nothing else, while the bottom holds the fixed control
               row: at 720p its ink runs from y 680 to 694. Symmetric 7vh padding
               spent 50px above the fold on nothing and still let the tallest
               slides put a line of type under that row. Measured at 1280x720:
               this gives a 630px slide box from y 32 to y 662, so every slide
               keeps at least 14px of air above the controls. */
            style={{
              paddingTop: "clamp(1.5rem, 4.5vh, 3.5rem)",
              paddingBottom: "clamp(3.5rem, 8vh, 5.5rem)",
            }}
          >
            <Slide />
          </motion.div>
        </AnimatePresence>

        {/* Controls */}
        <div className="fixed bottom-4 left-4 right-4 z-40 flex items-center justify-between gap-4">
          {/* The root layout renders RelayerHealthBadge fixed at the bottom-left
              (x 14, w 75, z 50) on every page and that file is not ours to
              touch, so the deck's own label starts clear of it. */}
          <div className="flex items-center gap-4" style={{ paddingLeft: "6rem" }}>
            <span className="styx-overline">Styx Protocol // Pitch</span>
            <span className="styx-overline" style={{ opacity: 0.7 }}>
              F = FULLSCREEN · ←/→ NAV
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={prev}
              disabled={idx === 0}
              className="styx-btn-ghost"
              style={{ padding: "0.45rem" }}
              aria-label="Previous slide"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="styx-mono">
              <span style={{ color: "var(--styx-accent)" }}>
                {String(idx + 1).padStart(2, "0")}
              </span>{" "}
              / {String(total).padStart(2, "0")}
            </span>
            <button
              onClick={next}
              disabled={idx === total - 1}
              className="styx-btn-ghost"
              style={{ padding: "0.45rem" }}
              aria-label="Next slide"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </StyxShell>
  );
}

// ----------------------------------------------------------------------------
// Reusable atoms: the Styx vocabulary, not a local palette
// ----------------------------------------------------------------------------

/** The editorial chapter mark: oversized numeral, cyan tick, serif title. */
function SlideHead({
  numeral,
  index,
  title,
}: {
  numeral: string;
  index: string;
  title: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "clamp(1rem, 2.5vw, 2rem)",
      }}
    >
      <span
        className="styx-numeral"
        aria-hidden="true"
        style={{ margin: 0, flex: "none" }}
      >
        {numeral}
      </span>
      <div style={{ minWidth: 0 }}>
        <p className="styx-index">{index}</p>
        <h2 className="styx-h2">{title}</h2>
      </div>
    </div>
  );
}

function ChipRow({
  items,
  center = false,
  style,
}: {
  items: string[];
  center?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className="styx-btn-row"
      style={{
        alignItems: "center",
        gap: "0.5rem",
        justifyContent: center ? "center" : undefined,
        ...style,
      }}
    >
      {items.map((it) => (
        <span className="styx-chip" key={it}>
          {it}
        </span>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Slides
// ----------------------------------------------------------------------------

function Slide1Title() {
  return (
    <div className="styx-container styx-center">
      <p className="styx-overline">
        Private payments on Solana &middot; Devnet &middot; Formerly Protocol 01
      </p>
      <h1 className="styx-h1" style={{ marginInline: "auto" }}>
        <span className="styx-gleam-strong">Styx</span> Protocol
      </h1>
      <div className="styx-hero-rule" aria-hidden="true" />
      <p className="styx-lede" style={{ marginInline: "auto" }}>
        A solo build since January 2026. A shielded pool on Solana, proofs made
        of hashes alone, and one-time addresses sealed with hybrid post-quantum
        key encapsulation. <strong>It runs on devnet.</strong>
      </p>
      <ChipRow
        items={["Devnet", "Not audited", "No mainnet"]}
        center
        style={{ marginTop: "1.75rem" }}
      />
      <div
        className="styx-admission"
        style={{
          maxWidth: "46rem",
          marginInline: "auto",
          marginTop: "2rem",
          textAlign: "left",
        }}
      >
        <p className="styx-admission-title">Read this before the other nine</p>
        <p className="styx-admission-body">
          Styx runs on Solana devnet. It has not been audited, there is no
          mainnet deployment, the sender is not hidden on any leg, and the link
          between a deposit and its withdrawal is not hidden yet. Every slide
          after this one is written to that standard: nothing here that a
          stranger cannot check.
        </p>
      </div>
      <p className="styx-mono" style={{ marginTop: "1.75rem" }}>
        <Trophy
          size={14}
          aria-hidden="true"
          style={{
            color: "var(--styx-faint)",
            display: "inline-block",
            verticalAlign: "-2px",
            marginRight: "0.55rem",
          }}
        />
        Second on the Dev3pack Solana track, leaderboard snapshot of 11 May 2026
        {" ("}
        <a
          className="styx-link"
          href={DEV3PACK_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          hack.dev3pack.xyz
        </a>
        {")."}
      </p>
    </div>
  );
}

function Slide2Problem() {
  const lines = [
    {
      label: "Sender address",
      note: "Every wallet you have ever paid stays readable, by anyone, permanently.",
    },
    {
      label: "Amount",
      note: "In plain view in the instruction, and correlatable across chains.",
    },
    {
      label: "Subscription cadence",
      note: "A recurring charge publishes the day it starts and the day it stops.",
    },
    {
      label: "Recipient",
      note: "An address anyone can watch, cluster and label at their leisure.",
    },
  ];
  return (
    <div className="styx-container styx-section-grid">
      <div className="styx-section-label">
        <span className="styx-numeral" aria-hidden="true">
          01
        </span>
        <p className="styx-index">The problem</p>
        <h2 className="styx-h2">A public ledger is a public record.</h2>
      </div>
      <div>
        <div className="styx-grid styx-grid-2">
          {lines.map((l) => (
            <div className="styx-card" key={l.label}>
              <p className="styx-card-label">{l.label}</p>
              <p className="styx-card-note">{l.note}</p>
            </div>
          ))}
        </div>
        <p className="styx-note" style={{ marginTop: "1.5rem" }}>
          None of this requires an attacker. It only requires a reader. And any
          proof system built on elliptic curves inherits whatever Shor&apos;s
          algorithm eventually does to curves.
        </p>
      </div>
    </div>
  );
}

function Slide3Stack() {
  const layers = [
    {
      title: "Application",
      icon: <Smartphone size={15} />,
      items: ["mobile (Expo)", "extension (Chrome MV3)", "web (Next.js 16)"],
    },
    {
      title: "Privacy SDK",
      icon: <Layers size={15} />,
      items: ["zk-sdk", "specter-sdk", "p01-js", "stark-prover"],
    },
    {
      title: "Cryptography",
      icon: <Lock size={15} />,
      items: [
        "Winterfell STARK",
        "Poseidon over Goldilocks",
        "X25519 + ML-KEM-768",
        "Ed25519 signatures, classical",
      ],
    },
    {
      title: "Solana programs",
      icon: <Shield size={15} />,
      items: ["denominated_pool_v4", "p01_relayer keeper", "p01_stark_verifier"],
    },
  ];
  return (
    <div className="styx-container">
      {/* "One contract" used to sit in this title, meaning the editorial
          standard slide one sets. In a Solana deck, next to a row that names
          three programs, it reads as "one smart contract" instead, which is a
          count the deck refuses to assert two paragraphs later. Same promise,
          the word that cannot be misread. */}
      <SlideHead numeral="02" index="The stack" title="Four layers, one standard." />
      <div className="styx-table-wrap" style={{ marginTop: "2rem" }}>
        <table className="styx-table">
          <thead>
            <tr>
              <th>Layer</th>
              <th>Components</th>
            </tr>
          </thead>
          <tbody>
            {layers.map((l) => (
              <tr key={l.title}>
                <td>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.6rem",
                      whiteSpace: "nowrap",
                      color: "var(--styx-paper)",
                      fontFamily: "var(--styx-mono)",
                      fontSize: "0.6875rem",
                      letterSpacing: "0.16em",
                      textTransform: "uppercase",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{ color: "var(--styx-faint)", display: "inline-flex" }}
                    >
                      {l.icon}
                    </span>
                    {l.title}
                  </span>
                </td>
                <td>
                  <ChipRow items={l.items} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="styx-note" style={{ marginTop: "1.25rem" }}>
        The deck does not say how many programs are deployed. The two figures the
        old deck printed did not agree with each other, so read the ids yourself
        on{" "}
        <a className="styx-link" href="/explorer">
          /explorer
        </a>
        , cluster devnet.
      </p>
    </div>
  );
}

function Slide4Notes() {
  return (
    <div className="styx-container grid items-center gap-10 lg:grid-cols-2">
      <div>
        <SlideHead
          numeral="03"
          index="Shielded notes"
          title="Fixed buckets, and one admission."
        />
        <div className="styx-prose" style={{ marginTop: "1.5rem" }}>
          <p>
            Every shielded note carries a canonical denomination, so inside a
            bucket the amount you move adds no signal of its own.
          </p>
          <p>
            <strong>
              What is still published is the note commitment. A withdrawal
              republishes the same commitment the deposit inserted into the tree,
              so a deposit and its withdrawal can currently be paired by anyone.
            </strong>{" "}
            Hiding that link is the next circuit, not a shipped feature, and no
            client-side change can fix it.
          </p>
        </div>
        {/* The six SOL buckets and the SPL side, read off SOL_POOLS_V3 and
            USDC_POOLS_V3 in lib/privacy/pool/denominatedPool.ts. The old chip
            row printed four SOL buckets and "+ SPL tokens": the plural was
            wrong, USDC is the only SPL token with a pool this client can
            reach, and that file's own type comment says so. */}
        <ChipRow
          items={[
            "0.1 SOL",
            "1 SOL",
            "10 SOL",
            "100 SOL",
            "500 SOL",
            "1000 SOL",
            "+ USDC",
          ]}
          style={{ marginTop: "1.5rem" }}
        />
      </div>
      <div className="styx-panel styx-sweep">
        <div className="styx-panel-head">
          <p className="styx-overline">denominated_pool_v4</p>
          <p className="styx-h3" style={{ margin: "0.5rem 0 0" }}>
            What the chain holds.
          </p>
        </div>
        <div className="styx-panel-body">
          <div className="styx-row">
            <span className="styx-row-key">Hash</span>
            <span className="styx-row-leader" />
            <span className="styx-row-value">Poseidon over Goldilocks</span>
          </div>
          <div className="styx-row">
            <span className="styx-row-key">Tree</span>
            <span className="styx-row-leader" />
            <span className="styx-row-value">depth 15, 32,768 leaves</span>
          </div>
          <div className="styx-row">
            <span className="styx-row-key">Proof</span>
            <span className="styx-row-leader" />
            <span className="styx-row-value">STARK, circuits 1 and 3</span>
          </div>
          <div className="styx-row">
            <span className="styx-row-key">Verifier</span>
            <span className="styx-row-leader" />
            <span className="styx-row-value">on-chain, no trusted server</span>
          </div>
          <div className="styx-row">
            <span className="styx-row-key">Pools</span>
            <span className="styx-row-leader" />
            <span className="styx-row-value">
              <a
                className="styx-link"
                href={EXPLORER_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                read the ids
              </a>
            </span>
          </div>
          <p className="styx-note" style={{ marginTop: "1rem" }}>
            Circuits 1 and 3 are pool_commitment and merkle_path, the two proofs
            a withdrawal carries; a deposit carries circuit 6, merkle_update. No
            compute-unit figure appears here. The one the old deck printed was
            never published beside its benchmark, and later measurement
            contradicted it.
          </p>
        </div>
      </div>
    </div>
  );
}

function Slide5Subscriptions() {
  return (
    <div className="styx-container">
      <SlideHead
        numeral="04"
        index="Subscriptions"
        title="Recurring payments on a one-way vault."
      />
      <div
        className="styx-gleam-rule"
        aria-hidden="true"
        style={{ marginTop: "2rem" }}
      />
      <div className="styx-grid styx-grid-2" style={{ marginTop: "2rem" }}>
        <div className="styx-card styx-sweep">
          <p className="styx-card-label">Subscriber</p>
          <p className="styx-card-value">Keeps the keys, funds the vault</p>
          <p className="styx-card-note">
            Pays a period ahead of time and proves ownership of the vault with a
            STARK built on the device. Privy or a local keypair, either way the
            spending key stays local.
          </p>
        </div>
        <div className="styx-card styx-sweep">
          <p className="styx-card-label">Retailer</p>
          <p className="styx-card-value">Registers one payout address</p>
          <p className="styx-card-note">
            claim_period is permissionless to send: anyone may submit the
            transaction, and the funds can only reach the retailer address the
            merchant registered. No keeper of yours takes custody.
          </p>
        </div>
      </div>
      <ChipRow
        items={[
          "STARK circuit 0 · subscriber_ownership",
          "claim_period · no cancel, no refund",
        ]}
        center
        style={{ marginTop: "1.75rem" }}
      />
      <p className="styx-note" style={{ marginTop: "1.25rem", textAlign: "center" }}>
        A subscription is one-way by ruling, not by omission: there is no
        cancellation and no refund leg. What this does not buy is subscriber
        anonymity, for the same published-commitment reason as slide 03.
      </p>
    </div>
  );
}

function Slide6Quantum() {
  return (
    <div className="styx-container">
      <SlideHead
        numeral="05"
        index="The post-quantum line"
        title="Post-quantum where we control it. Classical where the chain decides."
      />
      <ul className="styx-steps">
        <li className="styx-step" style={STEP_TIGHT}>
          <span className="styx-step-index">01</span>
          <div>
            <h3 className="styx-h3" style={STEP_HEAD}>
              Proof system
            </h3>
            <p className="styx-step-body">
              <span className="styx-check" aria-hidden="true">
                &#10003;
              </span>
              The STARK is Poseidon hashes and Merkle trees. No elliptic curves
              and no pairings in it, so no known quantum shortcut applies.
            </p>
          </div>
        </li>
        <li className="styx-step" style={STEP_TIGHT}>
          <span className="styx-step-index">02</span>
          <div>
            <h3 className="styx-h3" style={STEP_HEAD}>
              Stealth addresses
            </h3>
            <p className="styx-step-body">
              <span className="styx-check" aria-hidden="true">
                &#10003;
              </span>
              One-time addresses, sealed with hybrid key encapsulation: X25519{" "}
              <em>plus</em> ML-KEM-768, the lattice KEM of FIPS 203. Break one
              half, the other still holds.
            </p>
          </div>
        </li>
        <li className="styx-step" style={STEP_TIGHT}>
          <span className="styx-step-index">03</span>
          <div>
            <h3 className="styx-h3" style={STEP_HEAD}>
              Transaction signature
            </h3>
            <p className="styx-step-body">
              Ed25519, and it stays Ed25519. Solana verifies nothing else, so
              every transaction Styx sends is signed with a curve and stays
              classical. That holds for every protocol on Solana today.
            </p>
          </div>
        </li>
      </ul>
      <p className="styx-note" style={{ marginTop: "1.25rem" }}>
        No figure in bits appears on this slide. Our own measurement of the
        folded FRI rate contradicts the arithmetic the old deck printed, so the
        number is withdrawn rather than restated.
      </p>
    </div>
  );
}

function Slide7Hardening() {
  const phases = [
    {
      id: "A",
      label: "Relayer wired",
      note: "Unshield goes through the on-chain p01_relayer.",
      state: "Shipped",
      done: true,
    },
    {
      id: "B",
      label: "Event scrub",
      note: "Three leaky events removed: Shield, Unshield, Transfer V3.",
      state: "Shipped",
      done: true,
    },
    {
      id: "C",
      label: "Uniform proof buffers",
      note: "145 KB buffers. Length leaks permanently: trailing-zero boundary, circuit_id at raw offset 40, archived write_proof_chunk data.",
      state: "Shipped, leak open",
      done: false,
    },
    {
      id: "D",
      label: "Confidential relay",
      note: "Instruction scaffolded. Not deployed.",
      state: "In design",
      done: false,
    },
    {
      id: "E",
      label: "Multi-relayer rotation",
      note: "Failover and a liveness filter exist. The relayer is running degraded and the keeper retry bug is open.",
      state: "Shipped, degraded",
      done: false,
    },
    {
      id: "F",
      label: "Hash-based vault signatures",
      note: "A smart-contract account signed without a curve.",
      state: "In design",
      done: false,
    },
  ];
  return (
    <div className="styx-container">
      <SlideHead
        numeral="06"
        index="Transaction opacity"
        title="What is closed, and what is still open."
      />
      <div className="styx-table-wrap" style={{ marginTop: "1rem" }}>
        <table className="styx-table">
          <thead>
            <tr>
              <th>Phase</th>
              <th>What</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {phases.map((p) => (
              <tr key={p.id}>
                <td
                  style={{
                    fontFamily: "var(--styx-mono)",
                    color: "var(--styx-paper)",
                  }}
                >
                  {p.id}
                </td>
                <td>
                  <span style={{ color: "var(--styx-paper)" }}>{p.label}</span>
                  <span style={{ display: "block", marginTop: "0.2rem" }}>
                    {p.note}
                  </span>
                </td>
                <td
                  style={{
                    whiteSpace: "nowrap",
                    fontFamily: "var(--styx-mono)",
                    fontSize: "0.75rem",
                  }}
                >
                  {p.done ? (
                    <span className="styx-check" aria-hidden="true">
                      &#10003;
                    </span>
                  ) : null}
                  {p.state}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="styx-note" style={{ marginTop: "0.75rem" }}>
        Our own read of our own code, not an audit: Styx has not been audited.
        One more measured leak, on no list: the instruction-data length of
        verify_uniform at 28, 36, 52 or 60 bytes.
      </p>
    </div>
  );
}

function Slide8Mobile() {
  /* Illustrative rows, but the denominations have to be real ones: the pool
     table in lib/privacy/pool/denominatedPool.ts has 0.1, 1, 10, 100, 500 and
     1000 SOL and nothing smaller, so the 0.01 SOL notes this array used to show
     were a bucket that does not exist, and they contradicted the chapter 03
     chip row on top of that. The states are honest for the same reason: chapter
     08 says no minimum age is enforced on chain, so a "pending 2/5" gate would
     contradict it. Age is shown as the local label it is. */
  const notes = [
    { d: "0.1 SOL", s: "unspent" },
    { d: "1 SOL", s: "unspent" },
    { d: "0.1 SOL", s: "unspent · 2 epochs old" },
  ];
  return (
    <div className="styx-container grid items-center gap-10 lg:grid-cols-2">
      <div>
        <SlideHead
          numeral="07"
          index="Mobile"
          title="The prover runs on the device."
        />
        <div className="styx-prose" style={{ marginTop: "1.5rem" }}>
          <p>
            The Winterfell prover runs inside a WebView on the phone, so the
            proof is built where the secrets already are and no witness leaves
            the handset. <strong>No timing figure appears here:</strong> the one
            datapoint we hold is a single circuit on a single handset, which is
            an observation and not a benchmark.
          </p>
          <p>
            The spending key is held in the device keystore. Two known defects
            belong on the same slide: a viewing key currently derives the
            spending key, so the two are not separable today, and{" "}
            <strong>
              the installed mobile build carries a prover blob older than the
              deployed verifier, so a full unshield cannot complete on a phone
              today.
            </strong>
          </p>
        </div>
        <ChipRow
          items={[
            "WebView prover",
            "Privy + local keypair fallback",
            "Stealth scanner local",
            "Expo 54 / RN 0.81",
          ]}
          style={{ marginTop: "1.5rem" }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <div style={{ width: "min(20rem, 100%)" }}>
          <div className="styx-panel">
            <div
              className="styx-panel-head"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
              }}
            >
              <p className="styx-overline">Shielded &middot; illustration</p>
              <Smartphone
                size={14}
                aria-hidden="true"
                style={{ color: "var(--styx-faint)", flex: "none" }}
              />
            </div>
            <div className="styx-panel-body">
              {notes.map((n) => (
                <div className="styx-row" key={`${n.d}-${n.s}`}>
                  <span className="styx-row-key">{n.d}</span>
                  <span className="styx-row-leader" />
                  <span className="styx-row-value">{n.s}</span>
                </div>
              ))}
              <div className="styx-row">
                <span className="styx-row-key">total</span>
                <span className="styx-row-leader" />
                <span className="styx-row-value styx-redacted">
                  known only locally
                </span>
              </div>
              <button
                type="button"
                className="styx-btn-ghost"
                disabled
                aria-disabled="true"
                style={{ marginTop: "1.5rem", width: "100%" }}
              >
                Unshield
              </button>
            </div>
          </div>
          <p className="styx-note" style={{ marginTop: "0.75rem" }}>
            An illustration of the data model, not a live wallet. The control
            above is inert. Age is a local label: the chain enforces no minimum.
          </p>
        </div>
      </div>
    </div>
  );
}

function Slide9LiveDemo() {
  return (
    <div className="styx-container">
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "1.5rem",
        }}
      >
        <SlideHead
          numeral="08"
          index="Demo"
          title="Three moves, on devnet, in front of you."
        />
        <span className="styx-chip" style={{ flex: "none" }}>
          <span className="styx-dot" aria-hidden="true" />
          Devnet
        </span>
      </div>
      <ul className="styx-steps">
        <li className="styx-step" style={STEP_TIGHT}>
          <span className="styx-step-index">01</span>
          <div>
            <h3 className="styx-h3" style={STEP_HEAD}>
              Shield 0.1 SOL
            </h3>
            <p className="styx-step-body">
              Deposit into a denominated_pool_v4 pool. One Poseidon commitment
              becomes a leaf of the pool&apos;s Merkle tree.
            </p>
          </div>
        </li>
        <li className="styx-step" style={STEP_TIGHT}>
          <span className="styx-step-index">02</span>
          <div>
            <h3 className="styx-h3" style={STEP_HEAD}>
              Wait before spending
            </h3>
            <p className="styx-step-body">
              Presenter etiquette, not a chain rule: the V3 unshield has no
              maturity check, its own comment calls maturity a UX concern, and
              the client pins min_epoch to 0 on every path.
            </p>
          </div>
        </li>
        <li className="styx-step" style={STEP_TIGHT}>
          <span className="styx-step-index">03</span>
          <div>
            <h3 className="styx-h3" style={STEP_HEAD}>
              Unshield to a fresh address
            </h3>
            <p className="styx-step-body">
              Two STARK proofs authorise it, circuits 1 and 3, verified on chain.{" "}
              <strong>
                What is not hidden: the withdrawal republishes the
                deposit&apos;s commitment, so anyone can pair the two. Since
                2026-08-21 the wallet no longer pre-funds the ephemeral signer —
                it pays this deployment once and the deployment funds the
                signer — so the sender is a hop further away than this slide
                used to claim, not removed.
              </strong>
            </p>
          </div>
        </li>
      </ul>
      <div
        className="styx-btn-row"
        style={{
          alignItems: "center",
          gap: "0.5rem",
          justifyContent: "center",
          marginTop: "1rem",
        }}
      >
        <span className="styx-chip">STARK · Winterfell · Goldilocks</span>
        <a
          className="styx-chip"
          href={EXPLORER_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: "none" }}
        >
          <span className="styx-dot" aria-hidden="true" />
          pool program · GbVM5y…j27c
        </a>
      </div>
    </div>
  );
}

function Slide10Closing() {
  return (
    <div className="styx-container-narrow styx-center">
      <p className="styx-overline">Closing</p>
      <h2 className="styx-h2" style={{ marginTop: "1.25rem" }}>
        Test it with money you can <em className="styx-em">afford</em> to lose.
      </h2>
      <p className="styx-lede" style={{ marginInline: "auto", marginTop: "1.5rem" }}>
        That is the honest offer a devnet can make. Shield, pay, unshield, then
        read the programs that did it.
      </p>
      <div
        className="styx-btn-row"
        style={{ justifyContent: "center", marginTop: "2.25rem" }}
      >
        <a className="styx-btn" href="/app">
          Open the devnet app
        </a>
        <a
          className="styx-btn-ghost"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Read the programs
        </a>
      </div>
      <div
        className="styx-mono"
        style={{ display: "grid", gap: "0.45rem", marginTop: "2.25rem" }}
      >
        <span>
          <a
            className="styx-link"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/IsSlashy/Protocol-01
          </a>
        </span>
        <span>
          <a
            className="styx-link"
            href={X_FOUNDER}
            target="_blank"
            rel="noopener noreferrer"
          >
            x.com/Slashy_fx
          </a>
          {" · "}
          <a
            className="styx-link"
            href={X_PROJECT}
            target="_blank"
            rel="noopener noreferrer"
          >
            x.com/Protocol01_
          </a>
        </span>
      </div>
      <p className="styx-note" style={{ marginTop: "1.75rem" }}>
        Thank you for listening. Devnet software, not audited, no mainnet
        deployment.
      </p>
    </div>
  );
}
