import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * The only way to give /explorer its own tab title.
 *
 * app/explorer/page.tsx is a client component (it needs useT() and a polling
 * effect), so it cannot export `metadata` itself. Without this file the title
 * falls back to the root layout's "PROTOCOL-01", the retired brand, and
 * app/layout.tsx is off limits. The root metadata sets no title template, so
 * this value replaces it outright.
 *
 * The description says only what a stranger can check: the numbers are
 * aggregates read from public devnet state, nothing is audited, and there is no
 * mainnet deployment.
 */
export const metadata: Metadata = {
  title: "Network explorer · Styx Protocol",
  description:
    "The aggregate, public state of the Styx shielded pool on Solana devnet: value shielded, notes per denomination pool, relayer status and the seven STARK circuits. Not audited. No mainnet deployment.",
  openGraph: {
    title: "Network explorer · Styx Protocol",
    description:
      "Aggregate, public state of the Styx shielded pool on Solana devnet. Not audited. No mainnet deployment.",
    type: "website",
  },
};

export default function ExplorerLayout({ children }: { children: ReactNode }) {
  return children;
}
