"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";

/**
 * /card, the handed-out contact card, in the Styx voice.
 *
 * Shape note: this is a one-screen vertical card, not a chapters page, so it
 * does not use styx-section / styx-section-grid / styx-numeral. It runs under
 * `chrome={false}` because it supplies its own frame (its own top label row and
 * its own bottom URL line), it is noindexed by layout.tsx, and nothing on the
 * site links to it. A 6-link nav and a 4-column footer would be wrong here.
 *
 * Everything load-bearing is preserved verbatim: the session-storage key, the
 * 600 ms auto-download, both download hrefs, the four outbound links, the QR
 * payload and the QR's own colours.
 */

/* The payload the reader's phone saves. Field values are load-bearing: the URL
   lines in particular are the live domain, not brand copy, so they stay. */
const VCARD = `BEGIN:VCARD
VERSION:3.0
N:Chatbi;Ramy;;;
FN:Ramy Chatbi (Slashy)
NICKNAME:Slashy
ORG:Styx Protocol
TITLE:Founder / Solo Dev
ROLE:Private payments on Solana
EMAIL;TYPE=INTERNET,PREF:amirramy.chatbi@gmail.com
URL;TYPE=WORK:https://protocol-01.dev
URL;TYPE=GitHub:https://github.com/IsSlashy
URL;TYPE=Twitter:https://x.com/Slashy_fx
NOTE:Private payments on Solana. Devnet. Not audited.
END:VCARD`;

const links = [
  {
    label: "GitHub",
    href: "https://github.com/IsSlashy",
    handle: "@IsSlashy",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
      </svg>
    ),
  },
  {
    label: "Twitter / X",
    href: "https://x.com/Slashy_fx",
    handle: "@Slashy_fx",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    label: "Email",
    href: "mailto:amirramy.chatbi@gmail.com",
    handle: "amirramy.chatbi@gmail.com",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    ),
  },
  {
    label: "Website",
    href: "https://protocol-01.dev",
    handle: "protocol-01.dev",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
];

export default function CardPage() {
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("p01_card_pdf_downloaded") === "1") {
      setDownloaded(true);
      return;
    }
    const timer = setTimeout(() => {
      const a = document.createElement("a");
      a.href = "/slashy-card.pdf";
      a.download = "slashy-protocol01.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      sessionStorage.setItem("p01_card_pdf_downloaded", "1");
      setDownloaded(true);
    }, 600);
    return () => clearTimeout(timer);
  }, []);

  return (
    <StyxShell chrome={false}>
      {/* The root layout already provides the <main> landmark. */}
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          {/* ── Top label row ──────────────────────────────────────────── */}
          <Reveal className="styx-reveal">
            <div className="flex items-center justify-between mb-4">
              {/* The mark is the design system's own type lockup, the same one
                  StyxHeader renders. It is deliberately not /icon.png: that
                  bitmap is the Protocol 01 app icon, and its glow, gradient and
                  rounded corners are baked into the pixels, so no class here can
                  undo them. Not a link, because this page is handed out on its
                  own and has no site chrome to navigate back into. */}
              <span className="styx-wordmark">
                <span className="styx-wordmark-name">Styx</span>
                <span className="styx-wordmark-suffix">Protocol</span>
              </span>
              <span className="styx-overline">vCard</span>
            </div>
          </Reveal>

          {/* ── The card ───────────────────────────────────────────────── */}
          <Reveal className="styx-panel styx-sweep styx-reveal" delay={80}>
            {/* Identity. The hairline under it comes free with styx-panel-head. */}
            <div className="styx-panel-head">
              <div className="flex items-center gap-4">
                <span
                  className="w-20 h-20 shrink-0 overflow-hidden block"
                  style={{ border: "1px solid var(--styx-rule)" }}
                >
                  <img
                    src="/images/founder-slashy.png"
                    alt="Slashy"
                    className="w-full h-full object-cover"
                  />
                </span>
                <div className="min-w-0">
                  {/* The page's one gleam. With chrome off there is no
                      competing header gleam to fight it. */}
                  <h1 className="styx-h2 styx-gleam-strong" style={{ margin: 0 }}>
                    Slashy
                  </h1>
                  <p
                    className="styx-card-label"
                    style={{ margin: "0.45rem 0 0" }}
                  >
                    Founder &middot; Solo dev
                  </p>
                  <p className="styx-note" style={{ marginTop: "0.35rem" }}>
                    Private payments on Solana.
                  </p>
                </div>
              </div>
              <span className="styx-chip" style={{ marginTop: "1rem" }}>
                <span className="styx-dot" aria-hidden="true" />
                Devnet &middot; not audited
              </span>
            </div>

            {/* ── QR ───────────────────────────────────────────────────── */}
            <div className="styx-panel-body">
              {/* The white plate, its padding and the QRCode's own bgColor /
                  fgColor are FUNCTIONAL, not decoration: a scanner needs the
                  light ground and the quiet zone around the modules. Do not
                  swap #ffffff for a Styx token and do not remove the padding.
                  size and level are tuned to this payload's length. */}
              <div className="p-4" style={{ backgroundColor: "#ffffff" }}>
                <QRCode
                  value={VCARD}
                  size={256}
                  level="M"
                  className="w-full h-auto"
                  bgColor="#ffffff"
                  fgColor="#0a0e12"
                />
              </div>
              <p
                className="styx-card-label styx-center"
                style={{ margin: "1rem 0 0" }}
              >
                Scan to save contact
              </p>
            </div>

            {/* ── Links and actions ────────────────────────────────────── */}
            <div
              className="styx-panel-body"
              style={{ borderTop: "1px solid var(--styx-rule-soft)" }}
            >
              <div>
                {links.map((l) => (
                  <a
                    key={l.label}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="styx-row"
                  >
                    <span className="shrink-0" aria-hidden="true">
                      {l.icon}
                    </span>
                    <span
                      className="styx-row-key"
                      style={{ minWidth: "11ch" }}
                    >
                      {l.label}
                    </span>
                    <span className="styx-row-leader" />
                    <span
                      className="styx-row-value styx-link"
                      style={{ minWidth: 0 }}
                    >
                      {l.handle}
                    </span>
                  </a>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 mt-6">
                <a
                  href="/slashy.vcf"
                  download="slashy-protocol01.vcf"
                  className="styx-btn"
                  style={{ padding: "0.8rem 1rem" }}
                >
                  Save contact
                </a>
                {/* The effect only knows it fired a synthetic click, not that
                    the browser accepted it, so the second state says "again"
                    rather than claiming the file arrived. */}
                <a
                  href="/slashy-card.pdf"
                  download="slashy-protocol01.pdf"
                  className="styx-btn-ghost"
                  style={{ padding: "0.8rem 1rem" }}
                >
                  {downloaded ? "Download again" : "Download PDF"}
                </a>
              </div>
            </div>
          </Reveal>

          {/* ── Footer line ────────────────────────────────────────────── */}
          <Reveal className="styx-reveal" delay={160}>
            {/* protocol-01.dev is the domain that actually resolves. */}
            <p
              className="styx-mono styx-center"
              style={{ margin: "1rem 0 0", letterSpacing: "0.14em" }}
            >
              protocol-01.dev/card
            </p>
          </Reveal>
        </div>
      </div>
    </StyxShell>
  );
}
