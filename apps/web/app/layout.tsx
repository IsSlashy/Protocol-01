import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono, Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import DepthBackground from "@/components/DepthBackground";
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

export const metadata: Metadata = {
  title: "PROTOCOL-01",
  description:
    "The ultimate privacy-first protocol for secure transactions and anonymous interactions. Powered by zero-knowledge proofs.",
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
  icons: {
    icon: "/01-miku.png",
    apple: "/01-miku.png",
  },
  openGraph: {
    title: "PROTOCOL-01",
    description:
      "The ultimate privacy-first protocol for secure transactions and anonymous interactions.",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "/01-miku.png",
        width: 512,
        height: 512,
        alt: "Protocol-01",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "PROTOCOL-01",
    description:
      "The ultimate privacy-first protocol for secure transactions and anonymous interactions.",
    images: ["/01-miku.png"],
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
          <I18nProvider>
            <main className="relative z-10">{children}</main>
          </I18nProvider>
        </div>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
