import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * A layout exists here for one reason: `/demo/pitch/page.tsx` is a client
 * component (it is a keyboard-driven deck), and a client page cannot export
 * metadata. Without this the browser tab would inherit the root layout's old
 * title. Nothing else about the route changes.
 */
export const metadata: Metadata = {
  title: "Styx Protocol · Pitch",
  description:
    "The Styx Protocol deck. Private payments on Solana: a shielded pool, hash-based STARK proofs, hybrid post-quantum stealth addresses. Devnet, and not audited.",
};

export default function PitchLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
