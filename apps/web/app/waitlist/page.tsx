import type { Metadata } from "next";
import StyxShell from "../_styx/StyxShell";
import WaitlistJoin from "./WaitlistJoin";
import WaitlistBands from "./WaitlistBands";

/**
 * /waitlist, the signup page, back as a real page.
 *
 * It never existed before: app/waitlist/ held only the three redirect landings
 * (confirmed, invalid, removed) and the form lived buried in the home page CTA.
 * StyxHeader.tsx:41 and StyxFooter.tsx:57 both link here, so the route had to
 * exist.
 *
 * This file stays a SERVER component so it can export metadata, which means it
 * cannot call t(): t() is a context hook. So it holds no copy at all. Everything
 * a visitor reads is delegated to two client children:
 *   ./WaitlistJoin  the whole hero, overline, heading, lede, form, success panel
 *   ./WaitlistBands the three evidence bands and the two exits at the foot
 * Every sentence in both is a t() call. The bands used to be written inline here
 * and were ~1,400 words of hardcoded English under a translated hero, which
 * deleted the French silently for everything below the fold. That is what moving
 * them into a client child fixes.
 *
 * The band copy needs waitlist.* keys that did not exist before this pass. They
 * are reported as dictionary edits and applied to i18n/en.ts and i18n/fr.ts
 * together, because two agents editing one dictionary would break the parity
 * test. Until they land, t() returns the key path: the wiring and the dictionary
 * edits have to ship in the same commit.
 *
 * Deliberately NOT added: app/waitlist/layout.tsx. It would wrap
 * confirmed/invalid/removed too and give them a second header and footer.
 */

/**
 * The root layout (app/layout.tsx) still carries the retired identity in
 * `keywords`, `authors`, `openGraph` and `twitter`, and Next merges those into
 * every route that does not restate them: og:title "PROTOCOL-01", a description
 * about "anonymous interactions", and /01-miku.png as the share image. Each
 * nested object is replaced outright by the closest segment that defines it, so
 * restating openGraph and twitter here is what takes all of that off this route,
 * including the image. Same fix, same reason, as app/docs/layout.tsx and
 * app/roadmap/layout.tsx.
 *
 * Not fixable from this directory: the favicon. `icons` in the root points at
 * /01-miku.png and there is no Styx-branded asset in public/ to point at
 * instead, so overriding it here would only 404.
 */
export const metadata: Metadata = {
  title: "Waitlist · Styx Protocol",
  description:
    "Join the Styx Protocol waitlist. Double opt-in, one reminder, an unsubscribe link that deletes the record, and a page that lists every field it stores. Solana devnet, not audited.",
  keywords: [
    "styx protocol",
    "waitlist",
    "solana",
    "devnet",
    "stealth addresses",
    "stark proofs",
    "post-quantum",
  ],
  authors: [{ name: "Styx Protocol" }],
  openGraph: {
    title: "Waitlist · Styx Protocol",
    description:
      "Double opt-in, one reminder, and an unsubscribe link that deletes the record. Styx Protocol runs on Solana devnet and has not been audited.",
    type: "website",
  },
  twitter: {
    // summary, not summary_large_image: there is no share image on this route
    // now that the old one is gone, and the large card renders as a blank slab
    // without one.
    card: "summary",
    title: "Waitlist · Styx Protocol",
    description:
      "Double opt-in, one reminder, and an unsubscribe link that deletes the record. Solana devnet, not audited.",
  },
};

export default function WaitlistPage() {
  return (
    <StyxShell>
      <section className="styx-container styx-hero">
        <WaitlistJoin />
      </section>
      <WaitlistBands />
    </StyxShell>
  );
}
