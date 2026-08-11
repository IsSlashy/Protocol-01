import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * page.tsx is a client component, so it cannot export metadata. This layout
 * exists only to carry the title, which otherwise falls through to the root
 * layout and shows the reader the old brand in the browser tab.
 *
 * It does not retitle app/admin/waitlist: Next resolves metadata from the
 * deepest matching segment, and app/admin/waitlist/layout.tsx exports its own
 * title, so that one still wins for /admin/waitlist.
 *
 * No chrome here on purpose: page.tsx supplies its own frame through StyxShell
 * chrome={false}.
 */
export const metadata: Metadata = {
  title: "Whitelist admin · Styx Protocol",
  description: "Internal whitelist dashboard.",
};

export default function WhitelistAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
