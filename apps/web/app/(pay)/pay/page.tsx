import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";
import DepthBackground from "@/components/DepthBackground";
import { WalletProvider } from "@/components/WalletProvider";
import PayApp from "@/components/pay/PayApp";

export const metadata: Metadata = {
  title: "Private Pay — Protocol 01",
  description:
    "Post-quantum stealth payments. The recipient is hidden behind a one-time ML-KEM-768 hybrid stealth address.",
};

export default function PayPage() {
  return (
    <div className="relative min-h-screen bg-p01-void">
      <DepthBackground />
      <SiteHeader />

      <main className="relative z-10 px-4 pb-24 pt-28 sm:px-6">
        {/* Hero */}
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 border border-p01-cyan/40 bg-p01-surface px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.3em] text-p01-cyan">
            <span className="h-1.5 w-1.5 bg-p01-cyan" style={{ animation: "blink 1.4s step-end infinite" }} />
            Private Pay · Protocol 01
          </span>

          <h1 className="mt-6 font-display text-3xl font-black tracking-tight text-white sm:text-4xl">
            The recipient is never named on-chain.
          </h1>

          <p className="mx-auto mt-4 max-w-md font-mono text-sm leading-relaxed text-p01-text-muted">
            Post-quantum stealth payments. The recipient hides behind a one-time stealth
            address; unshielding to a public wallet is a visible hop.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-widest text-p01-text-dim">
            <span className="flex items-center gap-1.5">
              <span className="h-1 w-1 bg-p01-cyan" /> Hybrid PQ
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1 w-1 bg-p01-pink" /> Non-custodial
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1 w-1 bg-p01-bright-cyan" /> No indexer
            </span>
          </div>
        </div>

        {/* App card with a soft glow bloom behind it */}
        <div className="relative mx-auto mt-12 w-full max-w-md">
          <p className="mb-3 flex items-center justify-center gap-2 border border-p01-yellow/40 bg-p01-surface px-3 py-1.5 text-center font-mono text-[11px] uppercase tracking-widest text-p01-yellow">
            <span className="h-1 w-1 shrink-0 bg-p01-yellow" />
            Devnet only — test tokens, not real funds.
          </p>
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-16 -inset-y-10 -z-10 blur-glow"
            style={{
              background:
                "radial-gradient(ellipse 60% 55% at 50% 40%, rgba(57,197,187,0.16) 0%, rgba(255,119,168,0.08) 45%, transparent 75%)",
            }}
          />
          <WalletProvider network="devnet">
            <PayApp />
          </WalletProvider>
        </div>
      </main>

      <Footer />
    </div>
  );
}
