import type { Metadata } from "next";

/**
 * Metadata only. The body stays `return children` on purpose: the page itself is
 * the client component (it needs useT()), and it supplies StyxShell. Wrapping the
 * shell here would push the Styx scope above the client boundary and change
 * nothing for the better.
 *
 * Brand moved to Styx Protocol; the purpose of every field is unchanged, and the
 * openGraph shape is the same three fields it always was.
 */
export const metadata: Metadata = {
  title: "Careers · Styx Protocol",
  description:
    "Styx Protocol is hiring a co-founder for business development: land the first merchants on the payment SDK, build the Solana partner pipeline, and run the fundraising track.",
  openGraph: {
    title: "Careers · Styx Protocol",
    description:
      "One open role: co-founder, business development. Equity, remote, Solana payments infrastructure. Devnet, not audited.",
    type: "website",
  },
};

export default function CareersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
