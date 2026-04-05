"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Github, MessageCircle } from "lucide-react";
import { useT } from "@/i18n";

// ─── Easter egg glitch engine ───────────────────────────────────────────────
const ZA = '\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u030D\u030E\u030F\u0310\u0311\u0312\u0313\u0314\u0315\u031A\u033D\u034A\u034B\u034C';
const ZM = '\u0334\u0335\u0336\u0337\u0338\u0339\u033A\u033B\u033C\u0347\u0348\u0349';
const ZB = '\u0316\u0317\u0318\u0319\u031C\u031D\u031E\u031F\u0320\u0321\u0322\u0323\u0324\u0325\u0326\u0327\u0328\u0329';
const rc = (s: string) => s[Math.floor(Math.random() * s.length)];
const SWAP = '!@#$%&?/|~^<>_=+';

function glitchFrame(base: string, intensity: number): string {
  return base.split('').map(c => {
    let o = Math.random() < 0.12 * intensity ? SWAP[Math.floor(Math.random() * SWAP.length)] : c;
    for (let i = 0; i < Math.floor(Math.random() * 3 * intensity); i++) o += rc(ZA);
    for (let i = 0; i < Math.floor(Math.random() * 2 * intensity); i++) o += rc(ZM);
    if (Math.random() < 0.3 * intensity) o += rc(ZB);
    return o;
  }).join('');
}

const W = (...c: number[]) => String.fromCharCode(...c);
const PHASES = [
  { base: W(0x898B, 0x3066),                                     intensity: 0.8, interval: 90,  color: 'text-red-500/20 hover:text-red-500/40' },    // 見て (look at me)
  { base: W(0x304B, 0x307E, 0x3063, 0x3066),                     intensity: 1.2, interval: 50,  color: 'text-pink-400/50 hover:text-pink-400/70' },  // かまって (pay attention to me)
  { base: W(0x5ACC, 0x308F, 0x306A, 0x3044, 0x3067),             intensity: 1.8, interval: 30,  color: 'text-pink-200/80 hover:text-pink-200' },    // 嫌わないで (don't hate me)
  { base: W(0x52A9, 0x3051, 0x3066),                             intensity: 2.8, interval: 18,  color: 'text-white/90' },                            // 助けて (help me)
];

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
    title: "product",
    links: [
      { name: "mobileApp", href: "#download" },
      { name: "chromeExtension", href: "#download" },
      { name: "features", href: "#features" },
      { name: "sdkDemo", href: "/sdk-demo" },
      { name: "roadmap", href: "/roadmap" },
    ],
  },
  developers: {
    title: "developers",
    links: [
      { name: "sdkDemo", href: "/sdk-demo" },
      { name: "documentation", href: "/docs" },
      { name: "GitHub", href: "https://github.com/IsSlashy/Protocol-01-releases", external: true },
    ],
  },
  community: {
    title: "community",
    links: [
      { name: "Discord", href: "https://discord.gg/KfmhPFAHNH", external: true },
      { name: "Twitter / X", href: "https://x.com/Protocol01_", external: true },
      { name: "GitHub", href: "https://github.com/IsSlashy/Protocol-01-releases", external: true },
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
  { icon: GithubIcon, href: "https://github.com/IsSlashy/Protocol-01-releases", label: "GitHub" },
  { icon: DiscordIcon, href: "https://discord.gg/KfmhPFAHNH", label: "Discord" },
];

export default function Footer() {
  const t = useT();
  const router = useRouter();
  const [eggState, setEggState] = useState(0);
  const [glitchText, setGlitchText] = useState('');
  const [shake, setShake] = useState({ x: 0, y: 0 });

  // Live glitch loop
  useEffect(() => {
    const phase = PHASES[Math.min(eggState, PHASES.length - 1)];
    const id = setInterval(() => {
      setGlitchText(glitchFrame(phase.base, phase.intensity));
    }, phase.interval + Math.random() * phase.interval * 0.5);
    return () => clearInterval(id);
  }, [eggState]);

  // Shake — starts at phase 1, gets violent fast
  useEffect(() => {
    if (eggState < 1) { setShake({ x: 0, y: 0 }); return; }
    const mag = [0, 3, 8, 15][Math.min(eggState, 3)];
    const id = setInterval(() => {
      setShake({ x: (Math.random() - 0.5) * mag, y: (Math.random() - 0.5) * mag });
    }, 25);
    return () => clearInterval(id);
  }, [eggState]);
  return (
    <footer className="relative border-t border-p01-border bg-p01-void">
      {/* Main Footer */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 lg:gap-12">
          {/* Brand Column */}
          <div className="col-span-2">
            <div className="flex items-center gap-3 mb-6">
              {/* Industrial square logo */}
              <img src="/icon.png" alt="Protocol 01" className="w-10 h-10 rounded-lg" />
              <span className="text-xl font-bold font-display text-white tracking-wider">
                PROTOCOL 01
              </span>
            </div>
            <div className="text-p01-text-muted text-sm mb-6 max-w-xs space-y-1">
              <p>{t('footer.brandDesc1')}</p>
              <p>{t('footer.brandDesc2')}</p>
            </div>
            <p className="text-p01-cyan text-xs font-mono mb-6">
              &gt; {t('footer.tagline')}
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
                {t(`footer.${section.title}`)}
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
                      {['GitHub', 'Discord', 'Twitter / X'].includes(link.name) ? link.name : t(`footer.${link.name}`)}
                    </a>
                  </li>
                ))}
                {/* Easter egg — only in community column, under GitHub */}
                {section.title === 'community' && (
                  <li className="mt-2">
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        if (eggState >= PHASES.length - 1) {
                          window.history.pushState(null, '', '/????');
                          router.push('/void');
                        } else {
                          setEggState(s => s + 1);
                        }
                      }}
                      className={`
                        text-[10px] font-mono select-none bg-transparent border-none
                        cursor-pointer transition-all duration-500 text-left
                        ${PHASES[Math.min(eggState, PHASES.length - 1)].color}
                      `}
                      style={{
                        transform: `translate(${shake.x}px, ${shake.y}px)`,
                        textShadow: eggState >= 2
                          ? `${-1 - eggState}px 0 rgba(0,255,200,${0.2 + eggState * 0.1}), ${1 + eggState}px 0 rgba(255,45,120,${0.2 + eggState * 0.1})`
                          : 'none',
                        ...(eggState >= 3 ? { fontStyle: 'italic' } : {}),
                      }}
                    >
                      {glitchText}
                    </button>
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="border-t border-p01-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-sm text-p01-text-dim font-mono">
              <span className="text-[10px] font-mono uppercase tracking-[0.2em] px-2 py-0.5 border border-p01-cyan/30 text-p01-cyan rounded">Beta</span>
              <span>&copy; {new Date().getFullYear()} {t('footer.copyright')}</span>
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
                href="https://github.com/IsSlashy/Protocol-01-releases"
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
