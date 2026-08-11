import type { Metadata } from "next";

/**
 * The page itself is a client component, so it cannot export metadata. Without
 * this file /roadmap inherits the root layout's title, which still carries the
 * retired identity. Same pattern as app/careers/layout.tsx.
 */
export const metadata: Metadata = {
  title: "Roadmap · Styx Protocol",
  description:
    "What Styx Protocol has built, what is in progress, and what is planned. It runs on Solana devnet. It has not been audited and there is no mainnet deployment.",
  openGraph: {
    title: "Roadmap · Styx Protocol",
    description:
      "Shipped, in progress and planned work on Styx Protocol. Solana devnet only, not audited.",
    type: "website",
  },
};

export default function RoadmapLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
