import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * /docs is a "use client" page, so it cannot export metadata itself. This layout
 * exists only to carry the tab title, because the root layout still says
 * "PROTOCOL-01" and this route now wears the Styx name.
 *
 * The description states the two things a reader should know before reading any
 * page below it: devnet, and unaudited.
 */
export const metadata: Metadata = {
  title: "Documentation · Styx Protocol",
  description:
    "Technical documentation for Styx Protocol: shielded pool, hash-based STARK proofs over Poseidon and Merkle trees, hybrid X25519 + ML-KEM-768 stealth addresses. Deployed on Solana devnet. Not audited.",
  // Stated here because the root layout's openGraph still carries the old brand,
  // and this route would otherwise inherit it.
  openGraph: {
    title: "Documentation · Styx Protocol",
    description:
      "How the shielded pool, the on-chain STARK verifier and the stealth addresses actually work, including what they do not hide. Devnet, not audited.",
    type: "website",
  },
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return children;
}
