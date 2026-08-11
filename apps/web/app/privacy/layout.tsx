import type { Metadata } from "next";

/**
 * A "use client" page cannot export metadata, which is why this layout exists.
 * Its only job is the title and description; the default export must keep
 * returning `children` untouched.
 */
export const metadata: Metadata = {
  title: "Privacy Policy | Styx Protocol",
  description:
    "What Styx Protocol collects, what it does not, and which third parties are involved. Devnet software, not audited.",
};

export default function PrivacyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
