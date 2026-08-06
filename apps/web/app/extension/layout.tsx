import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Protocol 01 · Chrome Extension (Beta)",
  description:
    "Install the Protocol 01 privacy wallet extension on Chrome, Opera, Edge or Brave. Beta · Solana Devnet.",
};

export default function ExtensionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
