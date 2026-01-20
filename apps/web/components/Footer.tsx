"use client";

import { Github, Twitter, MessageCircle, Book, ExternalLink } from "lucide-react";

const footerLinks = {
  product: {
    title: "Product",
    links: [
      { name: "Stealth Wallet", href: "#" },
      { name: "Private Streams", href: "#" },
      { name: "Anonymous Social", href: "#" },
      { name: "AI Agent", href: "#" },
      { name: "SDK", href: "#" },
    ],
  },
  resources: {
    title: "Resources",
    links: [
      { name: "Documentation", href: "#" },
      { name: "API Reference", href: "#" },
      { name: "Whitepaper", href: "#" },
      { name: "Security Audits", href: "#" },
      { name: "Blog", href: "#" },
    ],
  },
  community: {
    title: "Community",
    links: [
      { name: "Discord", href: "#" },
      { name: "Twitter", href: "#" },
      { name: "GitHub", href: "#" },
      { name: "Forum", href: "#" },
      { name: "Newsletter", href: "#" },
    ],
  },
  legal: {
    title: "Legal",
    links: [
      { name: "Privacy Policy", href: "#" },
      { name: "Terms of Service", href: "#" },
      { name: "Cookie Policy", href: "#" },
    ],
  },
};

const socialLinks = [
  { icon: Twitter, href: "#", label: "Twitter" },
  { icon: Github, href: "#", label: "GitHub" },
  { icon: MessageCircle, href: "#", label: "Discord" },
  { icon: Book, href: "#", label: "Documentation" },
];

// Mini ASCII logo for footer
const miniLogo = `P-01`;

export default function Footer() {
  return (
    <footer className="relative border-t border-p01-border bg-p01-void">
      {/* Main Footer */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-8 lg:gap-12">
          {/* Brand Column */}
          <div className="col-span-2">
            <div className="flex items-center gap-3 mb-6">
              {/* Industrial square logo */}
              <div className="w-10 h-10 bg-[#39c5bb]/10 border border-[#39c5bb]/40 flex items-center justify-center">
                <span className="text-[#39c5bb] font-mono font-bold text-xs">P01</span>
              </div>
              <span className="text-xl font-bold font-display text-white tracking-wider">
                PROTOCOL 01
              </span>
            </div>
            <p className="text-p01-text-muted text-sm mb-6 max-w-xs">
              The privacy-first protocol for secure transactions, private
              communications, and anonymous interactions.
            </p>
            <p className="text-p01-cyan text-xs font-mono mb-6">
              &gt; The system cannot see you.
            </p>
            {/* Social Links - industrial squares */}
            <div className="flex items-center gap-4">
              {socialLinks.map((social) => (
                <a
                  key={social.label}
                  href={social.href}
                  aria-label={social.label}
                  className="w-10 h-10 bg-[#151518] border border-[#2a2a30] flex items-center justify-center text-[#888892] hover:text-[#39c5bb] hover:border-[#39c5bb]/50 transition-all"
                >
                  <social.icon size={18} />
                </a>
              ))}
            </div>
          </div>

          {/* Links Columns */}
          {Object.values(footerLinks).map((section) => (
            <div key={section.title}>
              <h3 className="text-sm font-semibold text-white mb-4 font-display uppercase tracking-wider">
                {section.title}
              </h3>
              <ul className="space-y-3">
                {section.links.map((link) => (
                  <li key={link.name}>
                    <a
                      href={link.href}
                      className="text-sm text-p01-text-muted hover:text-p01-cyan transition-colors inline-flex items-center gap-1"
                    >
                      {link.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="border-t border-p01-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-sm text-p01-text-dim font-mono">
              &copy; {new Date().getFullYear()} PROTOCOL 01. All rights reserved.
            </div>
            <div className="flex items-center gap-6">
              <a
                href="#"
                className="text-sm text-p01-text-dim hover:text-p01-text-muted transition-colors"
              >
                Status
              </a>
              <a
                href="#"
                className="text-sm text-p01-text-dim hover:text-p01-text-muted transition-colors"
              >
                Security
              </a>
              <a
                href="#"
                className="text-sm text-p01-text-dim hover:text-p01-text-muted transition-colors inline-flex items-center gap-1"
              >
                Audit Report <ExternalLink size={12} />
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* Background decoration */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-p01-cyan/50 to-transparent" />
    </footer>
  );
}
