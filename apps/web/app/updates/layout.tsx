import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Weekly Updates · Protocol 01",
  description:
    "Protocol 01 development, week by week. Features, integrations, and milestones shipped on Solana devnet, documented in public.",
  openGraph: {
    title: "Weekly Updates · Protocol 01",
    description:
      "Follow Protocol 01 development week by week, built in public on Solana.",
    type: "website",
  },
};

export default function UpdatesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
