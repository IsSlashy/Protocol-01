import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WhitepaperPdfFlag } from "@/lib/whitepaper/pdfFlag";
import { loadWhitepaperSource, pdfMatchesSource } from "@/lib/whitepaper/source";

/**
 * /docs is a "use client" page, so it cannot export metadata itself. This layout
 * carries the tab title, because the root layout still says "PROTOCOL-01" and
 * this route now wears the Styx name, and it tells the page whether a matching
 * white paper PDF exists (see whitepaperPdfAvailable below).
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

/**
 * Whether the /docs button to the white paper may say "and PDF": true only when
 * public/styx-whitepaper.pdf was printed from the docs/WHITEPAPER.md this build
 * uses, the same test /whitepaper applies before it shows "Download PDF".
 * Worked out when /docs is prerendered, so it is frozen with the build like the
 * white paper page itself. Any failure (no paper, no PDF, a stale PDF, an
 * unreadable manifest) answers false: /docs then claims a web page only, and
 * this check can never fail the /docs build.
 */
function whitepaperPdfAvailable(): boolean {
  try {
    return pdfMatchesSource(loadWhitepaperSource());
  } catch {
    return false;
  }
}

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <WhitepaperPdfFlag available={whitepaperPdfAvailable()}>{children}</WhitepaperPdfFlag>;
}
