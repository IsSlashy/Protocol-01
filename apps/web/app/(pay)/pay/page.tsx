import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";
import DepthBackground from "@/components/DepthBackground";
import { WalletProvider } from "@/components/WalletProvider";
import PayApp from "@/components/pay/PayApp";

/**
 * The hero is the first privacy claim a visitor reads, so it is held to the
 * same standard as the in-app disclosures rather than to marketing licence.
 *
 * What the code supports, and therefore what this page may say:
 *   · A stealth send names a one-time address as the payee, not a wallet —
 *     `SystemProgram.transfer({ toPubkey: stealth.address })`,
 *     packages/pay-core/src/worker/workerCore.ts:352.
 *   · The sender is NOT hidden on any leg. The same transfer has
 *     `fromPubkey: sender` and every tx in the batch carries
 *     `tx.feePayer = sender` (workerCore.ts:352, 363), and the browser submits
 *     them itself (PayApp.tsx:120-133) — there is no relayer on /pay.
 *   · A pool withdrawal no longer pays the connected wallet: the payee is a
 *     per-note derived payout address (PoolPanel.tsx:286-295) and
 *     `executeUnshield` refuses `recipient.equals(ownerPubkey)` outright
 *     (lib/privacy/pool/unshieldEphemeral.ts:228). But the wallet still
 *     pre-funds the ephemeral signer in a public transfer one hop earlier
 *     (unshieldEphemeral.ts:209-215), and the withdrawal republishes the
 *     commitment its deposit published — devnet leaf 16, commitment
 *     8901821612542787864, present in both transactions.
 *
 * The previous subline ("unshielding to a public wallet is a visible hop") is
 * now stale in the SAFE direction — the withdrawal stopped naming the wallet in
 * f7e74a96 — but understating is not free either: it described the product as
 * worse than it is while leaving the actually-unfixed hop (the pre-fund, and
 * the republished commitment) unmentioned. Both are corrected here together.
 */
export const metadata: Metadata = {
  title: "Private Pay — Protocol 01",
  description:
    "Post-quantum stealth payments. The payee is a one-time ML-KEM-768 hybrid stealth address, never a wallet. Your own wallet and the amount stay public.",
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
            The payee is a one-time address, not a wallet.
          </h1>

          <p className="mx-auto mt-4 max-w-md font-mono text-sm leading-relaxed text-p01-text-muted">
            Post-quantum stealth payments. Nothing here hides you: your wallet signs and pays for
            every transaction, and a pool withdrawal republishes its deposit&apos;s commitment.
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

        {/* App card with a soft glow bloom behind it.
            Widens past `md` on large screens so the panels can lay their action
            and their context side by side. While this box was 448px wide, every
            two-column grid inside it was decorative: the columns existed and had
            no room to open, so the whole app stayed a tall single strip on a
            wide display. */}
        <div className="relative mx-auto mt-12 w-full max-w-md lg:max-w-5xl">
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
