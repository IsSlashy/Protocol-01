import type { Metadata } from "next";

/**
 * The card is unlisted: nothing on the site links to /card, and this tells
 * crawlers to keep it out of search results if the URL ever leaks through a
 * share, a referrer header, or someone pasting it publicly.
 *
 * This is obscurity, not access control: anyone holding the URL can open it.
 * That is the intent, the URL is what gets handed out in person.
 *
 * `openGraph`, `twitter`, `authors` and `keywords` are all restated here on
 * purpose. Next merges metadata shallowly per segment, so a field this file does
 * not define is inherited from app/layout.tsx, which still carries the Protocol
 * 01 identity and a description that promises a degree of untraceability the
 * protocol does not deliver: the sender is not hidden on any leg, and the
 * deposit-to-withdrawal link is not closed today. That preview was the one piece
 * of copy a reader saw before opening anything. Defining `openGraph` here
 * replaces the parent object whole, images included, which is what drops the old
 * /01-miku.png preview art.
 */
const TITLE = "Slashy · Styx Protocol";
const DESCRIPTION = "Contact card. Private payments on Solana. Devnet, not audited.";

export const metadata: Metadata = {
  title: TITLE,
  description: "Contact card.",
  authors: [{ name: "Slashy" }],
  keywords: ["styx protocol", "contact card", "vcard", "solana", "devnet"],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

export default function CardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
