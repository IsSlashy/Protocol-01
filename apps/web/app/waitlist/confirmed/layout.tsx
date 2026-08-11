import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Metadata only, and the same trick /waitlist/removed uses.
 *
 * page.tsx has to stay "use client" (useT is a context hook) and a client
 * component cannot export metadata, so without this file the tab would inherit
 * the root layout's "PROTOCOL-01" title. This layout renders no markup and adds
 * no behaviour: children pass straight through, so the root <main>,
 * I18nProvider, Analytics and the overlays are untouched.
 *
 * Middle dot rather than an em dash: the repo just finished sweeping em dashes
 * out of the copy.
 */
export const metadata: Metadata = {
  title: "Waitlist confirmed · Styx Protocol",
  description:
    "Your address is on the Styx Protocol waitlist. Styx runs on Solana devnet and has not been audited.",
};

export default function WaitlistConfirmedLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
