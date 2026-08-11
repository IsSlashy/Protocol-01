import type { Metadata } from "next";
import StyxShell from "./_styx/StyxShell";
import HomeSections from "./_home/HomeSections";

/**
 * / , the landing page, ported to Styx Protocol.
 *
 * This file is a SERVER component on purpose. The old page was "use client"
 * because it needed useT(), and a client component cannot export `metadata`,
 * which left the tab title as the root layout's "PROTOCOL-01", and
 * app/layout.tsx is off limits. So the copy moved to ./_home/HomeSections.tsx
 * ("use client", where useT() belongs) and the page keeps only the metadata and
 * the StyxShell frame.
 *
 * Overriding `title` and `description` here also replaces the site-wide
 * description, which called the protocol "the ultimate privacy-first protocol
 * for secure transactions and anonymous interactions". Nothing about Styx is
 * anonymous today, so that sentence cannot survive on the page a stranger lands
 * on first.
 *
 * openGraph and twitter are restated because Next replaces each nested object
 * outright at the closest segment that defines it, and the root layout's copy
 * carries the retired brand. They deliberately carry NO `images`: the inherited
 * asset is /01-miku.png, the anime art of the retired identity, and this file
 * was still pointing both cards at it. Leaving `images` out is what takes it off
 * this route, which is the same fix app/(pay)/app/page.tsx and
 * app/waitlist/page.tsx already apply. The twitter card is therefore `summary`,
 * which needs no image, instead of `summary_large_image`, which does. Choosing a
 * Styx share image is an asset decision and stays upstream: there is no
 * Styx-branded file in public/ to point at yet.
 *
 * chrome defaults to true: StyxHeader and StyxFooter replace components/
 * SiteHeader.tsx and components/Footer.tsx, and the footer keeps the discreet
 * /admin/waitlist entrance.
 */

const DESCRIPTION =
  "Private payments on Solana. A shielded pool, hash-based STARK proofs over Poseidon and Merkle trees, and hybrid X25519 + ML-KEM-768 stealth addresses. Running on devnet. Not audited, and no mainnet deployment.";

export const metadata: Metadata = {
  title: "Styx Protocol: private payments on Solana",
  description: DESCRIPTION,
  openGraph: {
    title: "Styx Protocol: private payments on Solana",
    description: DESCRIPTION,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: "Styx Protocol: private payments on Solana",
    description: DESCRIPTION,
  },
};

export default function Home() {
  return (
    <StyxShell>
      <HomeSections />
    </StyxShell>
  );
}
