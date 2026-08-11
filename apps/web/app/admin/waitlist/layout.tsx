import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * The page itself is a client component, so it cannot export metadata. This
 * layout exists only to carry the title and to keep the brand current.
 *
 * It deliberately adds no chrome: page.tsx supplies its own frame through
 * StyxShell chrome={false}.
 */
export const metadata: Metadata = {
  title: "Waitlist admin · Styx Protocol",
  description: "Internal waitlist dashboard.",
};

export default function WaitlistAdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
