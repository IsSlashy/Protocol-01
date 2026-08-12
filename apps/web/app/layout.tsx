import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Inter, Noto_Sans_JP } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import DepthBackground from "@/components/DepthBackground";
import CorruptionOverlay from "@/components/CorruptionOverlay";
import RelayerHealthBadge from "@/components/RelayerHealthBadge";
import SmoothScroll from "@/components/SmoothScroll";
import { I18nProvider } from "@/i18n";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["900"],
  variable: "--font-noto-jp",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  metadataBase: new URL("https://protocol-01.dev"),
  /**
   * This block is what a stranger meets before any page renders: the tab title,
   * the favicon, and the card every shared link unfurls. It described a
   * different product until 2026-08-11.
   *
   * What changed and why:
   *  - "PROTOCOL-01" was the default title, so every page that does not override
   *    it announced the old name.
   *  - The description promised "anonymous interactions". The protocol does not
   *    deliver that: the sender is not hidden on any leg and a deposit can be
   *    paired with its withdrawal today. It shipped in the head of every page.
   *  - The favicon, the Apple icon and the OpenGraph image were all
   *    /01-miku.png, so a link pasted anywhere unfurled as fan-art from another
   *    franchise. `icons` and `images` are deliberately absent now: app/icon.tsx
   *    and app/opengraph-image.tsx generate both, in the Styx palette.
   *
   * 🚨 "zero-knowledge" was removed from `keywords` on 2026-08-13, and must not
   * come back while `stark/tests/zk_feasibility.rs` passes. That test recovers a
   * private witness from published proof bytes by interpolation, in under half a
   * second — the prover applies no trace blinding, so the proofs are succinct
   * and verified on chain but they are NOT zero-knowledge. The word was sitting
   * in the head of every page, which is the one place a claim reaches someone
   * who never opened the app. "STARK" below is the accurate term and stays.
   * When a blinded prover ships, that test starts failing; put the word back
   * then, not before.
   */
  title: "Styx Protocol",
  description:
    "Private payments on Solana: a shielded pool with hash-based STARK proofs and hybrid post-quantum stealth addresses. Running on devnet. Not audited.",
  keywords: [
    "privacy",
    "solana",
    "STARK",
    "post-quantum",
    "ML-KEM",
    "stealth addresses",
    "shielded pool",
    "styx protocol",
  ],
  authors: [{ name: "Styx Protocol" }],
  openGraph: {
    title: "Styx Protocol",
    description:
      "Private payments on Solana. Built to be checked, not believed. Running on devnet, not audited.",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Styx Protocol",
    description:
      "Private payments on Solana. Built to be checked, not believed. Running on devnet, not audited.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} ${inter.variable} ${notoSansJP.variable} font-sans antialiased bg-p01-void text-white`}
      >
        <SmoothScroll>
          <div className="relative min-h-screen overflow-hidden">
            {/* Deep background with layers */}
            <DepthBackground />

            {/* Main content */}
            <I18nProvider>
              <main className="relative z-10">{children}</main>
            </I18nProvider>
          </div>
          <CorruptionOverlay />
          <RelayerHealthBadge />
        </SmoothScroll>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
