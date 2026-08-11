import type { Metadata } from "next";

/**
 * Metadata for /founder. It lives here because the page is a client component
 * (it needs useT for the French dictionary) and cannot export metadata itself.
 *
 * openGraph.type stays "profile": this page is a person, not an article.
 */
export const metadata: Metadata = {
  title: "Founder · Styx Protocol",
  description:
    "The solo developer behind Styx Protocol, formerly Protocol 01. Solana programs, hash-based STARK proofs and hybrid post-quantum stealth addresses, built alone since January 2026. Running on devnet, not audited.",
  openGraph: {
    title: "Founder · Styx Protocol",
    description:
      "One developer building privacy infrastructure for Solana. Devnet, and not audited.",
    type: "profile",
  },
};

export default function FounderLayout({ children }: { children: React.ReactNode }) {
  return children;
}
