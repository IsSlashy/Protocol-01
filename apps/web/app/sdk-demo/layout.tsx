import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * page.tsx is a client component (it owns the wallet provider), so it cannot
 * export metadata. This layout exists only to carry the title and to move the
 * brand to Styx: without it the route inherits the root layout's "PROTOCOL-01".
 *
 * It adds no chrome. The header and footer come from StyxShell inside the page.
 */
export const metadata: Metadata = {
  title: "SDK demo · Styx Protocol",
  description:
    "Wallet, privacy and subscription SDK samples, running against Solana devnet. Not audited, no mainnet deployment.",
};

export default function SdkDemoLayout({ children }: { children: ReactNode }) {
  return children;
}
