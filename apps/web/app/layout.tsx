import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";
import "./globals.css";
import DepthBackground from "@/components/DepthBackground";

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

export const metadata: Metadata = {
  title: "PROTOCOL 01 | One app. Total invisibility.",
  description:
    "The ultimate privacy-first protocol for secure transactions, private communications, and anonymous interactions. Powered by zero-knowledge proofs.",
  keywords: [
    "privacy",
    "blockchain",
    "zero-knowledge",
    "anonymous",
    "secure",
    "wallet",
    "stealth",
    "protocol 01",
    "p01",
  ],
  authors: [{ name: "Protocol 01" }],
  openGraph: {
    title: "PROTOCOL 01 | One app. Total invisibility.",
    description:
      "The ultimate privacy-first protocol for secure transactions, private communications, and anonymous interactions.",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "PROTOCOL 01 | One app. Total invisibility.",
    description:
      "The ultimate privacy-first protocol for secure transactions, private communications, and anonymous interactions.",
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
        className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} ${inter.variable} font-sans antialiased bg-p01-void text-white`}
      >
        <div className="relative min-h-screen overflow-hidden">
          {/* Deep background with layers */}
          <DepthBackground />

          {/* Main content */}
          <main className="relative z-10">{children}</main>
        </div>
      </body>
    </html>
  );
}
