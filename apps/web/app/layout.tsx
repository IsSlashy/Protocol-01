import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Inter, Noto_Sans_JP, Orbitron, Fira_Code } from "next/font/google";
import AnalyticsExceptPrivateApp from "@/components/AnalyticsExceptPrivateApp";
import "./globals.css";
import DepthBackground from "@/components/DepthBackground";
import CorruptionOverlay from "@/components/CorruptionOverlay";
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

/**
 * \U0001f6a8 SELF-HOSTED, AND THEY WERE NOT.
 *
 * Orbitron and Fira Code arrived through two `@import url(fonts.googleapis.com)`
 * lines at the top of `globals.css`, which is imported by the root layout -- so
 * EVERY route, including the private app, told Google the visitor's IP and the
 * timestamp on any cold cache. The four families below were already served from
 * our own origin by `next/font/google`, which downloads them at BUILD time; the
 * two that were not simply predated that block.
 *
 * \u26a0 A privacy claim about a page is worth nothing while the page asks a
 * third party for its typeface.
 */
const orbitron = Orbitron({
  subsets: ["latin"],
  variable: "--font-orbitron",
  display: "swap",
});

const firaCode = Fira_Code({
  subsets: ["latin"],
  variable: "--font-fira-code",
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
   * come back while probe `P3b` of `verify/p01-verify.mjs` stands. That probe
   * carries the recovery measurement — four C1 witnesses, the spend secret
   * among them, out of published proof bytes in 5 ms — and it is pinned FAIL by
   * construction. Seven of the eight circuits apply no trace blinding at all.
   * The eighth, `spend`, does apply a coset LDE and 128 CSPRNG-drawn mask rows
   * — and that still is not secrecy: it buys UNDERDETERMINATION, 90 published
   * evaluations against ~138 unknowns, and the recovery above was itself
   * performed on an underdetermined system because the AIR constraints supply
   * the equations the openings do not. So the proofs are succinct and verified
   * on chain but they are NOT zero-knowledge. The word
   * was sitting in the head of every page, which is the one place a claim
   * reaches someone who never opened the app. "STARK" below is the accurate
   * term and stays. When a blinded prover ships AND a positive control shows
   * the recovery failing, put the word back; not before.
   *
   * ⚠️ The pointer here used to be `stark/tests/zk_feasibility.rs`, and the
   * trigger used to be "that test starts failing". That file was deleted in
   * `dc9dd515` (calibrated to a superseded two-row wire) and NOTHING executable
   * replaced it, so there is no test anyone can run today to flip this. The
   * gate is unchanged and the word stays out; only the evidence pointer moved.
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
        className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} ${inter.variable} ${notoSansJP.variable} ${orbitron.variable} ${firaCode.variable} font-sans antialiased bg-p01-void text-white`}
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
        </SmoothScroll>
        <AnalyticsExceptPrivateApp />
      </body>
    </html>
  );
}
