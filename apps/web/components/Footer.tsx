"use client";

import { Github, MessageCircle } from "lucide-react";

interface FooterLink {
  name: string;
  href: string;
  external?: boolean;
}

interface FooterSection {
  title: string;
  links: FooterLink[];
}

const footerLinks: Record<string, FooterSection> = {
  product: {
    title: "Product",
    links: [
      { name: "Mobile App", href: "#download" },
      { name: "Chrome Extension", href: "#download" },
      { name: "Features", href: "#features" },
      { name: "SDK Demo", href: "/sdk-demo" },
      { name: "Roadmap", href: "/roadmap" },
    ],
  },
  developers: {
    title: "Developers",
    links: [
      { name: "SDK Demo", href: "/sdk-demo" },
      { name: "Documentation", href: "/docs" },
      { name: "GitHub", href: "https://github.com/IsSlashy/Protocol-01", external: true },
    ],
  },
  community: {
    title: "Community",
    links: [
      { name: "Discord", href: "https://discord.gg/KfmhPFAHNH", external: true },
      { name: "Twitter / X", href: "https://x.com/Protocol01_", external: true },
      { name: "GitHub", href: "https://github.com/IsSlashy/Protocol-01", external: true },
    ],
  },
};

// Custom X/Twitter icon
const XIcon = () => (
  <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>
);

// Wrapper for Lucide icons to match size
const GithubIcon = () => <Github size={18} />;
const DiscordIcon = () => <MessageCircle size={18} />;

const socialLinks = [
  { icon: XIcon, href: "https://x.com/Protocol01_", label: "Twitter/X" },
  { icon: GithubIcon, href: "https://github.com/IsSlashy/Protocol-01", label: "GitHub" },
  { icon: DiscordIcon, href: "https://discord.gg/KfmhPFAHNH", label: "Discord" },
];

export default function Footer() {
  return (
    <footer className="relative border-t border-p01-border bg-p01-void">
      {/* Main Footer */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 lg:gap-12">
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
            <div className="text-p01-text-muted text-sm mb-6 max-w-xs space-y-1">
              <p>Anonymous Solana wallet with stealth addresses for private transactions.</p>
              <p>Complete financial privacy.</p>
            </div>
            <p className="text-p01-cyan text-xs font-mono mb-6">
              &gt; The system cannot see you.
            </p>
            {/* Social Links - industrial squares */}
            <div className="flex items-center gap-4">
              {socialLinks.map((social) => (
                <a
                  key={social.label}
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={social.label}
                  className="w-10 h-10 bg-[#151518] border border-[#2a2a30] flex items-center justify-center text-[#888892] hover:text-[#39c5bb] hover:border-[#39c5bb]/50 transition-all"
                >
                  <social.icon />
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
                      target={link.external ? "_blank" : undefined}
                      rel={link.external ? "noopener noreferrer" : undefined}
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
                href="https://x.com/Protocol01_"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-p01-text-dim hover:text-p01-text-muted transition-colors"
              >
                Twitter / X
              </a>
              <a
                href="https://github.com/IsSlashy/Protocol-01"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-p01-text-dim hover:text-p01-text-muted transition-colors"
              >
                GitHub
              </a>
              <a
                href="https://discord.gg/KfmhPFAHNH"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-p01-text-dim hover:text-p01-text-muted transition-colors"
              >
                Discord
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
