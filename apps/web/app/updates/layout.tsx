import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Weekly updates · Styx Protocol",
  description:
    "The Styx Protocol development log, one entry per week from April 6 to June 7, 2026. What shipped, what broke, and which claims were later corrected. Solana devnet only, and not audited.",
  openGraph: {
    title: "Weekly updates · Styx Protocol",
    description:
      "Nine weeks of Styx Protocol development, logged in public. Devnet only, not audited.",
    type: "website",
  },
};

export default function UpdatesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
