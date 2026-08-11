import type { Metadata } from "next";

/**
 * Local metadata for /extension. Server component on purpose: it exports
 * `metadata`, which a client component cannot do, and it returns children
 * untouched so the page keeps its own "use client" boundary.
 *
 * The brand moved to Styx Protocol. The Beta and Solana Devnet framing stays,
 * and "not audited" is now stated here too rather than only in the footer.
 */
export const metadata: Metadata = {
  title: "Styx Protocol · Chrome Extension (Beta)",
  description:
    "How to install the Styx Protocol wallet extension on Chrome, Opera, Edge or Brave. Beta · Solana Devnet. Not audited.",
};

export default function ExtensionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
