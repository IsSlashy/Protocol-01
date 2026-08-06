import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Careers — Protocol 01",
  description:
    "Protocol 01 is hiring a co-founder for business development: land the first merchants on the payment SDK, build the Solana partner pipeline, and run the fundraising track.",
  openGraph: {
    title: "Careers — Protocol 01",
    description:
      "One open role: co-founder, business development. Equity, remote, Solana privacy infrastructure.",
    type: "website",
  },
};

export default function CareersLayout({ children }: { children: React.ReactNode }) {
  return children;
}
