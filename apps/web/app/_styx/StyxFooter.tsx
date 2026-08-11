"use client";

import { ScanEye } from "lucide-react";
import { useT } from "@/i18n";

/**
 * StyxFooter — the shared footer, in the Styx voice.
 *
 * A restyle of components/Footer.tsx with the same destinations. What matters
 * to keep, and is kept:
 *
 *  - the legal row: /privacy, /terms, /licenses
 *  - **the discreet ScanEye link to /admin/waitlist**. That is the founder's
 *    own way into the waitlist dashboard. It looks like decoration and is not:
 *    drop it and the only entrance to the admin page is typing the URL.
 *  - the same i18n keys, so the three locales keep their footer copy
 *  - Discord and X, the two live socials
 *
 * Deliberately dropped: the glitching Japanese easter egg and the cyan radial
 * glow rising from the base. Both are pure Protocol 01 signature — the easter
 * egg runs two intervals and a per-frame character scrambler on every page, and
 * the glow is exactly the kind of thing direction A rules out. The old footer
 * is preserved intact in the identity archive.
 *
 * GitHub stays commented out, matching the old footer's WAITLIST MODE note, so
 * restoring it at launch is one line in both files rather than a hunt.
 */
const SECTIONS: {
  title: string;
  links: { label: string; href: string; external?: boolean }[];
}[] = [
  {
    title: "Protocol",
    links: [
      { label: "Devnet app", href: "/app" },
      { label: "Explorer", href: "/explorer" },
      { label: "Roadmap", href: "/roadmap" },
      { label: "Updates", href: "/updates" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "SDK demo", href: "/sdk-demo" },
      { label: "Extension", href: "/extension" },
      // WAITLIST MODE: GitHub de-emphasized while access runs through the
      // waitlist, restore at launch:
      // { label: "GitHub", href: "https://github.com/IsSlashy/Protocol-01-releases", external: true },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Founder", href: "/founder" },
      { label: "Careers", href: "/careers" },
      { label: "Waitlist", href: "/waitlist" },
      { label: "Discord", href: "https://discord.gg/EfqnVmb2dV", external: true },
      { label: "X", href: "https://x.com/Protocol01_", external: true },
    ],
  },
];

export default function StyxFooter() {
  const t = useT();

  return (
    <footer className="styx-footer">
      <div className="styx-container">
        <div className="styx-footer-grid">
          <div className="styx-footer-brand">
            <span className="styx-wordmark">
              <span className="styx-wordmark-name">Styx</span>
              <span className="styx-wordmark-suffix">Protocol</span>
            </span>
            <p className="styx-footer-brand-line">
              Private payments on Solana. Shielded pool, hash-based STARK
              proofs, hybrid post-quantum stealth addresses. Formerly
              Protocol 01.
            </p>
          </div>

          {SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="styx-footer-col-title">{section.title}</p>
              <ul className="styx-footer-links">
                {section.links.map((link) => (
                  <li key={link.href + link.label}>
                    <a
                      className="styx-footer-link"
                      href={link.href}
                      {...(link.external
                        ? { target: "_blank", rel: "noopener noreferrer" }
                        : {})}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="styx-footer-legal">
          <span>
            Devnet software. Not audited. Use funds you can afford to lose.
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "1.25rem",
            }}
          >
            <a className="styx-footer-link" href="/privacy">
              {t("footer.privacy")}
            </a>
            <a className="styx-footer-link" href="/terms">
              {t("footer.terms")}
            </a>
            <a className="styx-footer-link" href="/licenses">
              {t("footer.licenses")}
            </a>
            {/* Founder's entrance to the waitlist dashboard. Quiet on purpose,
                present on purpose. */}
            <a
              href="/admin/waitlist"
              aria-label="Waitlist admin"
              title="Waitlist admin"
              className="styx-footer-link"
              style={{ opacity: 0.45 }}
            >
              <ScanEye size={13} aria-hidden />
            </a>
            <span>&copy; {new Date().getFullYear()} Styx Protocol</span>
          </span>
        </div>
      </div>
    </footer>
  );
}
