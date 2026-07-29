"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import QRCode from "react-qr-code";
import HoloFoil from "@/components/HoloFoil";

const VCARD = `BEGIN:VCARD
VERSION:3.0
N:Chatbi;Ramy;;;
FN:Ramy Chatbi (Slashy)
NICKNAME:Slashy
ORG:Protocol 01
TITLE:Founder / Solo Dev
ROLE:Privacy Infrastructure for Solana
EMAIL;TYPE=INTERNET,PREF:amirramy.chatbi@gmail.com
URL;TYPE=WORK:https://protocol-01.dev
URL;TYPE=GitHub:https://github.com/IsSlashy
URL;TYPE=Twitter:https://x.com/Slashy_fx
NOTE:Privacy & ZK infrastructure for Solana.
END:VCARD`;

const fadeUp = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } };

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
    <main className="min-h-screen bg-p01-void flex items-center justify-center px-4 py-8 relative overflow-hidden">
      {/* Ambient gradient */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-p01-cyan/10 blur-[120px]" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-p01-cyan/5 blur-[100px]" />
      </div>

      <motion.div
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
        className="relative w-full max-w-md"
      >
        {/* Top label */}
        <motion.div variants={fadeUp} className="flex items-center justify-between mb-4 px-1">
          <div className="flex items-center gap-2">
            <img src="/icon.png" alt="Protocol 01" className="w-5 h-5 rounded" />
            <span className="text-[10px] font-mono text-p01-text-muted tracking-[0.3em] uppercase">
              Protocol 01
            </span>
          </div>
          <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">
            vCard
          </span>
        </motion.div>

        {/* Main card */}
        <motion.div
          variants={fadeUp}
          className="bg-p01-surface border border-p01-border rounded-2xl p-6 sm:p-8 shadow-[0_0_60px_rgba(57,197,187,0.08)] backdrop-blur-sm"
        >
          {/* Identity */}
          <div className="flex items-center gap-4 mb-6">
            <div className="relative shrink-0">
              <HoloFoil
                variant="spectrum"
                className="w-20 h-20 rounded-xl overflow-hidden border-2 border-p01-cyan/40 shadow-[0_0_24px_rgba(57,197,187,0.25)]"
              >
                <img
                  src="/images/founder-slashy.png"
                  alt="Slashy"
                  className="w-full h-full object-cover"
                />
              </HoloFoil>
              <div className="absolute -bottom-1.5 -right-1.5 bg-p01-cyan text-p01-void text-[9px] font-mono font-bold px-1.5 py-0.5 rounded">
                SOLO
              </div>
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-white font-display tracking-tight leading-tight">
                Slashy
              </h1>
              <p className="text-p01-cyan font-mono text-[11px] tracking-wider mt-0.5">
                FOUNDER / SOLO DEV
              </p>
              <p className="text-p01-text-dim text-xs mt-1 leading-snug">
                Privacy &amp; ZK infra for Solana
              </p>
            </div>
          </div>

          {/* QR */}
          <div className="relative bg-white rounded-xl p-4 mb-5">
            <QRCode
              value={VCARD}
              size={256}
              level="M"
              className="w-full h-auto"
              bgColor="#ffffff"
              fgColor="#0a0e12"
            />
            {/* Corner accents */}
            <div className="absolute top-2 left-2 w-3 h-3 border-t-2 border-l-2 border-p01-cyan" />
            <div className="absolute top-2 right-2 w-3 h-3 border-t-2 border-r-2 border-p01-cyan" />
            <div className="absolute bottom-2 left-2 w-3 h-3 border-b-2 border-l-2 border-p01-cyan" />
            <div className="absolute bottom-2 right-2 w-3 h-3 border-b-2 border-r-2 border-p01-cyan" />
          </div>

          <p className="text-center text-[11px] font-mono text-p01-text-dim tracking-wider uppercase mb-5">
            Scan to save contact
          </p>

          {/* Links */}
          <div className="space-y-2 mb-5">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-3 py-2.5 bg-white/[0.02] border border-p01-border rounded-lg hover:border-p01-cyan/40 hover:bg-white/[0.04] transition-all group"
              >
                <span className="text-p01-text-muted group-hover:text-p01-cyan transition-colors">
                  {l.icon}
                </span>
                <span className="text-[11px] font-mono text-p01-text-muted uppercase tracking-wider w-16 shrink-0">
                  {l.label}
                </span>
                <span className="text-xs text-white font-mono truncate ml-auto">
                  {l.handle}
                </span>
              </a>
            ))}
          </div>

          {/* Action buttons */}
          <div className="grid grid-cols-2 gap-2">
            <a
              href="/slashy.vcf"
              download="slashy-protocol01.vcf"
              className="btn-primary text-center text-xs py-3 block"
            >
              Save Contact
            </a>
            <a
              href="/slashy-card.pdf"
              download="slashy-protocol01.pdf"
              className="text-center text-xs py-3 block border border-p01-cyan/40 text-p01-cyan rounded-lg hover:bg-p01-cyan/10 transition-colors font-mono uppercase tracking-wider"
            >
              {downloaded ? "PDF \u2713" : "Download PDF"}
            </a>
          </div>
        </motion.div>

        {/* Footer line */}
        <motion.p
          variants={fadeUp}
          className="text-center text-[10px] font-mono text-p01-text-dim tracking-[0.25em] uppercase mt-4"
        >
          protocol-01.dev/card
        </motion.p>
      </motion.div>
    </main>
  );
}
