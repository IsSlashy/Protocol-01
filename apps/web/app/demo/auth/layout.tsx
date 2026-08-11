import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * The demo page is a client component, so it cannot export metadata itself.
 * This layout exists only to carry the title, which otherwise inherited the
 * root layout's old-identity "PROTOCOL-01". It adds no markup and no behaviour.
 */
export const metadata: Metadata = {
  title: "QR sign-in demo · Styx Protocol",
  description:
    "A mock of the Styx QR sign-in flow. It builds a deep link and shows the session state machine in the browser. Nothing is signed, nothing reaches a chain.",
};

export default function DemoAuthLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
