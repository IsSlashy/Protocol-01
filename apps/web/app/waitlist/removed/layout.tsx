import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Metadata only.
 *
 * page.tsx must stay "use client" (useT is a context hook), and a client
 * component cannot export metadata. This layout exists purely so the tab title
 * carries the Styx brand instead of inheriting the root "PROTOCOL-01". It adds
 * no wrapper markup and no behaviour: children pass through untouched, so the
 * root layout's <main>, I18nProvider and overlays are unaffected.
 *
 * Middot in the title, not an em dash: the repo just finished sweeping em dashes
 * out of the copy, and the sibling waitlist pages separate the same way.
 */
export const metadata: Metadata = {
  title: "Off the waitlist · Styx Protocol",
  description:
    "Unsubscribe confirmation for the Styx Protocol waitlist.",
};

export default function WaitlistRemovedLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
