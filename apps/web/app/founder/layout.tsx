import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Founder · Protocol 01",
  description:
    "Meet the solo developer behind Protocol 01: 12 Solana programs, post-quantum STARKs, and 10 SDKs built from scratch since January 2026.",
  openGraph: {
    title: "Founder · Protocol 01",
    description:
      "The solo developer's journey building privacy infrastructure for Solana.",
    type: "profile",
  },
};

export default function FounderLayout({ children }: { children: React.ReactNode }) {
  return children;
}
