"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  Lock,
  Radio,
  Shield,
  Smartphone,
  Sparkles,
  Trophy,
  Zap,
} from "lucide-react";

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
    <div className="relative h-screen w-screen overflow-hidden bg-p01-void text-p01-text">
      {/* CRT scan-line overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-30 opacity-[0.04]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(57,197,187,0.6) 2px, rgba(57,197,187,0.6) 3px)",
        }}
      />
      {/* radial vignette */}
      <div
        className="pointer-events-none fixed inset-0 z-20"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)",
        }}
      />

      {/* Progress bar */}
      <div className="fixed top-0 left-0 right-0 z-40 h-[2px] bg-p01-border">
        <motion.div
          className="h-full bg-gradient-to-r from-p01-cyan to-p01-bright-cyan"
          initial={false}
          animate={{ width: `${((idx + 1) / total) * 100}%` }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          style={{ boxShadow: "0 0 12px rgba(0,255,229,0.6)" }}
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
          className="relative z-10 flex h-full w-full items-center justify-center px-12 py-16"
        >
          <Slide />
        </motion.div>
      </AnimatePresence>

      {/* Controls */}
      <div className="fixed bottom-4 left-4 right-4 z-40 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-p01-text-muted">
        <div className="flex items-center gap-3">
          <span>PROTOCOL 01 // PITCH</span>
          <span className="text-p01-text-dim">F = FULLSCREEN · ←/→ NAV</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={prev}
            disabled={idx === 0}
            className="rounded border border-p01-border p-1.5 transition hover:border-p01-cyan hover:text-p01-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-p01-cyan/60 disabled:opacity-30"
            aria-label="Previous slide"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-p01-cyan">
            {String(idx + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </span>
          <button
            onClick={next}
            disabled={idx === total - 1}
            className="rounded border border-p01-border p-1.5 transition hover:border-p01-cyan hover:text-p01-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-p01-cyan/60 disabled:opacity-30"
            aria-label="Next slide"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Reusable atoms
// ----------------------------------------------------------------------------

function Eyebrow({ children, color = "cyan" }: { children: React.ReactNode; color?: "cyan" | "pink" | "yellow" }) {
  const cls =
    color === "pink"
      ? "text-p01-pink"
      : color === "yellow"
      ? "text-p01-yellow"
      : "text-p01-cyan";
  return (
    <div className={`font-mono text-[11px] uppercase tracking-[0.4em] ${cls}`}>
      {children}
    </div>
  );
}

function MonoPill({
  children,
  tone = "cyan",
}: {
  children: React.ReactNode;
  tone?: "cyan" | "pink" | "yellow";
}) {
  const map = {
    cyan: "border-p01-cyan/40 bg-p01-cyan/10 text-p01-cyan",
    pink: "border-p01-pink/40 bg-p01-pink/10 text-p01-pink",
    yellow: "border-p01-yellow/40 bg-p01-yellow/10 text-p01-yellow",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider ${map[tone]}`}
    >
      {children}
    </span>
  );
}

function GlowCard({
  children,
  tone = "cyan",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "cyan" | "pink";
  className?: string;
}) {
  const shadow =
    tone === "pink"
      ? "shadow-[0_0_24px_rgba(255,119,168,0.2)] border-p01-pink/30"
      : "shadow-[0_0_24px_rgba(57,197,187,0.18)] border-p01-cyan/30";
  return (
    <div className={`rounded-2xl border bg-p01-surface/80 backdrop-blur ${shadow} ${className}`}>
      {children}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Slides
// ----------------------------------------------------------------------------

function Slide1Title() {
  return (
    <div className="flex w-full max-w-5xl flex-col items-center gap-10 text-center">
      <Eyebrow>PRIVACY STACK FOR SOLANA</Eyebrow>
      <div className="relative">
        <h1
          className="font-display text-[clamp(64px,11vw,160px)] font-black leading-[0.9] tracking-tight text-p01-cyan"
          style={{
            textShadow:
              "0 0 32px rgba(0,255,229,0.45), 2px 0 0 rgba(255,119,168,0.5), -2px 0 0 rgba(0,255,229,0.5)",
          }}
        >
          PROTOCOL 01
        </h1>
      </div>
      <p className="max-w-2xl text-balance text-lg text-p01-text-muted">
        Solo build since January 2026. Now live on devnet, with quantum-resistant
        proofs, stealth subscriptions, and 12 deployed Solana programs.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Trophy className="h-4 w-4 text-p01-pink" />
        <span className="font-mono text-[11px] uppercase tracking-[0.35em] text-p01-pink">
          Ranked #2 Worldwide · Dev3pack Solana Track
        </span>
      </div>
    </div>
  );
}

function Slide2Problem() {
  const lines = [
    { label: "Sender address", note: "every wallet you've paid is public forever" },
    { label: "Amount", note: "fingerprintable, correlatable across chains" },
    { label: "Subscription cadence", note: "your business model leaks in real time" },
    { label: "Recipient", note: "linkable to KYC and sanctions databases" },
  ];
  return (
    <div className="flex w-full max-w-5xl flex-col gap-10">
      <div>
        <Eyebrow color="pink">THE PROBLEM</Eyebrow>
        <h2 className="mt-3 font-display text-5xl font-black leading-tight text-white">
          Every Solana tx is{" "}
          <span className="text-p01-pink" style={{ textShadow: "0 0 24px rgba(255,119,168,0.4)" }}>
            public
          </span>{" "}
          by default.
        </h2>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {lines.map((l) => (
          <GlowCard key={l.label} tone="pink" className="p-5">
            <div className="font-mono text-[11px] uppercase tracking-wider text-p01-pink">
              {l.label}
            </div>
            <div className="mt-2 text-sm text-p01-text-muted">{l.note}</div>
          </GlowCard>
        ))}
      </div>
      <p className="text-sm text-p01-text-dim">
        Existing options: trusted-setup mixers (sanctionable), opaque L2s (custodial),
        or pre-quantum crypto that breaks the day a useful quantum machine ships.
      </p>
    </div>
  );
}

function Slide3Stack() {
  const layers = [
    {
      title: "APPLICATION",
      items: ["mobile (Expo)", "extension (Chrome MV3)", "web (Next.js 16)"],
      icon: <Smartphone size={18} />,
    },
    {
      title: "PRIVACY SDK",
      items: ["zk-sdk", "specter-sdk", "p01-js", "stark-prover"],
      icon: <Layers size={18} />,
    },
    {
      title: "CRYPTOGRAPHY",
      items: ["Winterfell STARK", "Poseidon Goldilocks", "ML-KEM stealth", "ECDH"],
      icon: <Lock size={18} />,
    },
    {
      title: "SOLANA PROGRAMS",
      items: ["12 deployed", "13 V4 pools", "p01_relayer keeper", "p01_stark_verifier"],
      icon: <Shield size={18} />,
    },
  ];
  return (
    <div className="flex w-full max-w-5xl flex-col gap-8">
      <div>
        <Eyebrow>THE STACK</Eyebrow>
        <h2 className="mt-3 font-display text-5xl font-black text-white">
          Four layers, one privacy contract.
        </h2>
      </div>
      <div className="flex flex-col gap-3">
        {layers.map((l) => (
          <GlowCard key={l.title} className="flex items-center gap-6 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-p01-cyan/40 bg-p01-cyan/10 text-p01-cyan">
              {l.icon}
            </div>
            <div className="w-44 font-mono text-[11px] uppercase tracking-[0.3em] text-p01-cyan">
              {l.title}
            </div>
            <div className="flex flex-wrap gap-2">
              {l.items.map((it) => (
                <MonoPill key={it}>{it}</MonoPill>
              ))}
            </div>
          </GlowCard>
        ))}
      </div>
    </div>
  );
}

function Slide4Notes() {
  return (
    <div className="grid w-full max-w-6xl grid-cols-2 gap-12">
      <div className="flex flex-col justify-center gap-6">
        <Eyebrow>SHIELDED DENOMINATED NOTES</Eyebrow>
        <h2 className="font-display text-5xl font-black leading-tight text-white">
          Fixed buckets.{" "}
          <span className="text-p01-cyan" style={{ textShadow: "0 0 24px rgba(0,255,229,0.45)" }}>
            No leak by amount.
          </span>
        </h2>
        <p className="text-base text-p01-text-muted">
          Every shielded note has a canonical denomination, so the amount you move carries
          no signal. Hiding <em>which</em> deposit a withdrawal spends is the next circuit,
          today the note commitment is still published.
        </p>
        <div className="flex flex-wrap gap-2">
          <MonoPill>0.1 SOL</MonoPill>
          <MonoPill>1 SOL</MonoPill>
          <MonoPill>10 SOL</MonoPill>
          <MonoPill>100 SOL</MonoPill>
          <MonoPill tone="pink">+ SPL tokens</MonoPill>
        </div>
      </div>
      <div className="flex items-center justify-center">
        <GlowCard className="w-full p-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-p01-text-muted">
            denominated_pool_v4
          </div>
          <div
            className="mt-2 font-display text-7xl font-black text-p01-cyan"
            style={{ textShadow: "0 0 32px rgba(0,255,229,0.4)" }}
          >
            13
          </div>
          <div className="text-sm text-p01-text-muted">live pools on devnet</div>
          <div className="mt-6 grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="font-mono uppercase tracking-wider text-p01-text-dim">Hash</div>
              <div className="text-white">Poseidon (Goldilocks)</div>
            </div>
            <div>
              <div className="font-mono uppercase tracking-wider text-p01-text-dim">Tree</div>
              <div className="text-white">depth 15 · 32K notes</div>
            </div>
            <div>
              <div className="font-mono uppercase tracking-wider text-p01-text-dim">Proof</div>
              <div className="text-white">STARK · circuit 5</div>
            </div>
            <div>
              <div className="font-mono uppercase tracking-wider text-p01-text-dim">Verifier</div>
              <div className="text-white">on-chain · 1.32M CU</div>
            </div>
          </div>
        </GlowCard>
      </div>
    </div>
  );
}

function Slide5Subscriptions() {
  return (
    <div className="flex w-full max-w-5xl flex-col gap-10">
      <div>
        <Eyebrow color="pink">STEALTH SUBSCRIPTIONS</Eyebrow>
        <h2 className="mt-3 font-display text-5xl font-black leading-tight text-white">
          Recurring payments, zero subscriber linkability.
        </h2>
      </div>
      <div className="flex items-stretch gap-6">
        <GlowCard className="flex-1 p-6">
          <div className="font-mono text-[11px] uppercase tracking-wider text-p01-cyan">
            SUBSCRIBER
          </div>
          <div className="mt-2 text-lg text-white">Holds spending key + viewing key locally</div>
          <div className="mt-4 text-xs text-p01-text-muted">
            Generates STARK proof of vault ownership on-device. Privy or local
            keypair. Never transmits the secret.
          </div>
        </GlowCard>
        <div className="flex w-32 flex-col items-center justify-center gap-2">
          <div
            className="h-px w-full bg-gradient-to-r from-p01-cyan via-p01-pink to-p01-cyan"
            style={{ boxShadow: "0 0 12px rgba(255,119,168,0.4)" }}
          />
          <MonoPill tone="pink">ZK PROOF</MonoPill>
          <div
            className="h-px w-full bg-gradient-to-r from-p01-cyan via-p01-pink to-p01-cyan"
            style={{ boxShadow: "0 0 12px rgba(255,119,168,0.4)" }}
          />
        </div>
        <GlowCard tone="pink" className="flex-1 p-6">
          <div className="font-mono text-[11px] uppercase tracking-wider text-p01-pink">
            RETAILER
          </div>
          <div className="mt-2 text-lg text-white">Sees only the period claim, never the payer</div>
          <div className="mt-4 text-xs text-p01-text-muted">
            A subscription is one-way: there is no cancellation and no refund.
            claim_period closes the vault once its funding is spent and pays the
            remainder and the rent to the retailer.
          </div>
        </GlowCard>
      </div>
      <div className="flex justify-center gap-3">
        <MonoPill>STARK circuit 0 · subscriber_ownership</MonoPill>
        <MonoPill tone="pink">claim_period · one-way, no refund leg</MonoPill>
      </div>
    </div>
  );
}

function Slide6Quantum() {
  const items = [
    {
      title: "STARK proofs",
      detail: "no trusted setup, hash-based, post-quantum secure (Grover-resistant 124-bit)",
      tone: "cyan" as const,
    },
    {
      title: "ML-KEM stealth derivation",
      detail: "NIST FIPS 203 KEM standard, replaces ECDH for value-bearing key exchange",
      tone: "cyan" as const,
    },
    {
      title: "SPHINCS+ on the roadmap",
      detail: "stateless hash signatures for the Quantum Wallet smart-contract account",
      tone: "pink" as const,
    },
  ];
  return (
    <div className="flex w-full max-w-5xl flex-col gap-8">
      <div>
        <Eyebrow color="yellow">QUANTUM-RESISTANT BY DEFAULT</Eyebrow>
        <h2 className="mt-3 font-display text-5xl font-black leading-tight text-white">
          Post-quantum,{" "}
          <span className="text-p01-bright-cyan" style={{ textShadow: "0 0 24px rgba(0,255,229,0.45)" }}>
            not post-fix.
          </span>
        </h2>
      </div>
      <div className="flex flex-col gap-3">
        {items.map((it) => (
          <GlowCard key={it.title} tone={it.tone} className="flex items-center gap-5 p-5">
            <Sparkles
              size={20}
              className={it.tone === "pink" ? "text-p01-pink" : "text-p01-cyan"}
            />
            <div>
              <div className="font-display text-xl text-white">{it.title}</div>
              <div className="text-sm text-p01-text-muted">{it.detail}</div>
            </div>
          </GlowCard>
        ))}
      </div>
      <div className="rounded-lg border border-p01-yellow/40 bg-p01-yellow/5 p-4 text-xs text-p01-yellow">
        <Zap className="mr-2 inline h-3 w-3" />
        Shor's algorithm breaks ECC. We don't use it for any value-bearing
        signature path.
      </div>
    </div>
  );
}

function Slide7Hardening() {
  const phases = [
    { id: "A", label: "Relayer wired", note: "unshield via on-chain p01_relayer", done: true },
    { id: "B", label: "Event scrub", note: "removed 3 leaky events (Shield/Unshield/Transfer V3)", done: true },
    { id: "C", label: "Padded proofs", note: "uniform 145KB proof buffers, defeats size fingerprinting", done: true },
    { id: "D", label: "Confidential relay", note: "scaffolded ix, deploy pending", done: false },
    { id: "E", label: "Multi-relayer rotation", note: "auto-failover + liveness filter", done: true },
    { id: "F", label: "Quantum vault", note: "SPHINCS+ smart-contract wallet", done: false },
  ];
  return (
    <div className="flex w-full max-w-5xl flex-col gap-8">
      <div className="flex items-end justify-between">
        <div>
          <Eyebrow>TX-OPACITY HARDENING</Eyebrow>
          <h2 className="mt-3 font-display text-5xl font-black leading-tight text-white">
            6 layers shipped. 2 in design.
          </h2>
        </div>
        <MonoPill>20 LEAKS AUDITED · 6 CLOSED</MonoPill>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {phases.map((p) => (
          <GlowCard key={p.id} tone={p.done ? "cyan" : "pink"} className="flex items-center gap-4 p-4">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md font-display text-lg font-black ${
                p.done
                  ? "bg-p01-cyan/15 text-p01-cyan"
                  : "bg-p01-pink/15 text-p01-pink"
              }`}
            >
              {p.id}
            </div>
            <div>
              <div className="text-sm text-white">{p.label}</div>
              <div className="text-xs text-p01-text-muted">{p.note}</div>
            </div>
          </GlowCard>
        ))}
      </div>
    </div>
  );
}

function Slide8Mobile() {
  return (
    <div className="grid w-full max-w-6xl grid-cols-2 gap-16 items-center">
      <div className="flex flex-col gap-6">
        <Eyebrow>MOBILE · ON-DEVICE STARK</Eyebrow>
        <h2 className="font-display text-5xl font-black leading-tight text-white">
          Proof generation,{" "}
          <span className="text-p01-cyan" style={{ textShadow: "0 0 24px rgba(0,255,229,0.45)" }}>
            in your pocket.
          </span>
        </h2>
        <p className="text-base text-p01-text-muted">
          The full Winterfell prover runs in a WebView on the device. ~2-4 seconds
          per proof on a Galaxy S22. The spending key never leaves SecureStore.
        </p>
        <div className="flex flex-wrap gap-2">
          <MonoPill>WebView prover</MonoPill>
          <MonoPill>Privy + local keypair fallback</MonoPill>
          <MonoPill tone="pink">Stealth scanner local</MonoPill>
          <MonoPill>Expo 54 / RN 0.81</MonoPill>
        </div>
      </div>
      <div className="flex justify-center">
        <GlowCard className="w-72 p-6">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.3em] text-p01-text-muted">
            <span>SHIELDED</span>
            <Smartphone size={12} />
          </div>
          <div
            className="mt-2 font-display text-5xl font-black text-p01-cyan"
            style={{ textShadow: "0 0 24px rgba(0,255,229,0.4)" }}
          >
            0.0934
          </div>
          <div className="font-mono text-xs text-p01-text-dim">SOL</div>
          <div className="mt-6 space-y-2">
            {[
              { d: "0.1 SOL", s: "matured" },
              { d: "0.01 SOL", s: "matured" },
              { d: "0.01 SOL", s: "pending · 2/5" },
            ].map((n, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-p01-border bg-p01-dark px-3 py-2">
                <span className="font-mono text-xs text-white">{n.d}</span>
                <span
                  className={`font-mono text-[10px] uppercase tracking-wider ${
                    n.s.startsWith("pending") ? "text-p01-yellow" : "text-p01-cyan"
                  }`}
                >
                  {n.s}
                </span>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mt-6 w-full rounded-md border border-p01-cyan/40 bg-p01-cyan/10 py-2.5 font-mono text-xs uppercase tracking-[0.3em] text-p01-cyan"
            style={{ boxShadow: "0 0 16px rgba(0,255,229,0.2)" }}
          >
            UNSHIELD
          </button>
        </GlowCard>
      </div>
    </div>
  );
}

function Slide9LiveDemo() {
  const steps = [
    { n: "01", title: "SHIELD 0.1 SOL", note: "deposit into a v4 denominated pool · receives a Merkle commitment" },
    { n: "02", title: "WAIT FOR MATURITY", note: "epoch_delay enforces minimum age · ~5 min on devnet" },
    { n: "03", title: "UNSHIELD TO FRESH WALLET", note: "STARK circuit 5 · zero on-chain link to source" },
  ];
  return (
    <div className="flex w-full max-w-5xl flex-col gap-10">
      <div className="flex items-end justify-between">
        <div>
          <Eyebrow color="pink">DEMO · LIVE ON DEVNET</Eyebrow>
          <h2 className="mt-3 font-display text-5xl font-black leading-tight text-white">
            Three steps. Real proofs. No mocks.
          </h2>
        </div>
        <Radio className="h-7 w-7 animate-pulse text-p01-pink" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        {steps.map((s, i) => (
          <GlowCard key={s.n} tone={i === 1 ? "pink" : "cyan"} className="flex flex-col gap-3 p-5">
            <div
              className={`font-display text-3xl font-black ${
                i === 1 ? "text-p01-pink" : "text-p01-cyan"
              }`}
              style={{
                textShadow: i === 1 ? "0 0 18px rgba(255,119,168,0.5)" : "0 0 18px rgba(0,255,229,0.5)",
              }}
            >
              {s.n}
            </div>
            <div className="text-sm text-white">{s.title}</div>
            <div className="text-xs text-p01-text-muted">{s.note}</div>
          </GlowCard>
        ))}
      </div>
      <div className="flex justify-center gap-3">
        <MonoPill>devnet · GbVM5y…NKnij</MonoPill>
        <MonoPill tone="pink">STARK · Winterfell · Goldilocks</MonoPill>
        <MonoPill>on-chain verify · ~1.32M CU</MonoPill>
      </div>
    </div>
  );
}

function Slide10Closing() {
  return (
    <div className="flex w-full max-w-4xl flex-col items-center gap-12 text-center">
      <Eyebrow color="pink">CLOSING</Eyebrow>
      <h2 className="font-display text-[clamp(48px,7vw,96px)] font-black leading-[0.95] text-white">
        Shipping{" "}
        <span className="text-p01-cyan" style={{ textShadow: "0 0 24px rgba(0,255,229,0.45)" }}>
          post-quantum
        </span>{" "}
        <span className="text-p01-pink" style={{ textShadow: "0 0 24px rgba(255,119,168,0.45)" }}>
          privacy
        </span>
        .
      </h2>
      <p className="font-display text-2xl text-p01-text-muted">Thank you for listening.</p>
      <div className="flex flex-col items-center gap-2 font-mono text-sm">
        <div className="text-p01-text-muted">github.com/Slashy/Protocol-01</div>
        <div className="text-p01-text-muted">x.com/SlashyFx</div>
        <div className="text-p01-text-muted">dev3pack · rank #2 worldwide</div>
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-md border border-p01-cyan/40 bg-p01-cyan/10 px-5 py-3 font-mono text-[11px] uppercase tracking-[0.35em] text-p01-cyan"
        style={{ boxShadow: "0 0 28px rgba(0,255,229,0.25)" }}
      >
        TRY THE BUILD · AUDIT THE CONTRACTS · DM ME ON X
      </div>
    </div>
  );
}
