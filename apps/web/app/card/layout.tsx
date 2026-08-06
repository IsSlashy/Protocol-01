import type { Metadata } from "next";

/**
 * The card is unlisted: nothing on the site links to /card, and this tells
 * crawlers to keep it out of search results if the URL ever leaks through a
 * share, a referrer header, or someone pasting it publicly.
 *
 * This is obscurity, not access control — anyone holding the URL can open it.
 * That is the intent: the URL is what gets handed out in person.
 */
export const metadata: Metadata = {
  title: "Slashy · Protocol 01",
  description: "Contact card.",
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
