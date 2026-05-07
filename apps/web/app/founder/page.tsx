"use client";

import { motion } from "framer-motion";
import { useT } from "@/i18n";
import Footer from "@/components/Footer";
import { LanguageSwitcher } from "@/i18n";

const fadeUp = { hidden: { opacity: 0, y: 30 }, visible: { opacity: 1, y: 0 } };

const timeline = [
  { year: "2007", key: "origin", icon: "terminal" },
  { year: "2019", key: "coding", icon: "code" },
  { year: "2022", key: "ecommerce", icon: "shopping-cart" },
  { year: "2023", key: "bachelor", icon: "graduation-cap" },
  { year: "2023-24", key: "captnboat", icon: "briefcase" },
  { year: "2025", key: "master", icon: "shield" },
  { year: "2025", key: "freelance", icon: "rocket" },
  { year: "2026", key: "protocol01", icon: "lock" },
];

// Project start: January 18, 2026
const PROJECT_START = new Date('2026-01-18');
const daysSinceStart = () => Math.floor((Date.now() - PROJECT_START.getTime()) / 86_400_000);

const stats = [
  { value: "7+", labelKey: "yearsCode" },
  { value: "14", labelKey: "programs" },
  { value: "6", labelKey: "circuits" },
  { value: String(daysSinceStart()), labelKey: "days" },
  { value: "1", labelKey: "dev" },
  { value: "3", labelKey: "apps" },
];

export default function FounderPage() {
  const t = useT();

  return (
    <>
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-p01-void/80 backdrop-blur-lg border-b border-p01-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <a href="/" className="flex items-center gap-2.5">
              <img src="/icon.png" alt="Protocol 01" className="w-7 h-7 rounded-md" />
              <span className="text-sm font-bold text-white tracking-wider hidden sm:inline">PROTOCOL 01</span>
            </a>
            <div className="hidden md:flex items-center gap-5">
              <a href="/docs" className="text-xs text-p01-text-muted hover:text-white transition-colors font-mono uppercase tracking-wider">Docs</a>
              <a href="/roadmap" className="text-xs text-p01-text-muted hover:text-white transition-colors font-mono uppercase tracking-wider">Roadmap</a>
              <a href="/updates" className="text-xs text-p01-text-muted hover:text-white transition-colors font-mono uppercase tracking-wider">Updates</a>
              <a href="/founder" className="text-xs text-p01-cyan hover:text-white transition-colors font-mono uppercase tracking-wider">Founder</a>
            </div>
            <div className="flex items-center gap-2">
              <LanguageSwitcher className="hidden sm:flex" />
              <a href="/#download" className="btn-primary text-xs px-4 py-1.5">{t('nav.download')}</a>
            </div>
          </div>
        </div>
      </nav>

      <main className="min-h-screen pt-20 pb-16 px-4">
        <div className="max-w-4xl mx-auto">

          {/* Hero — Photo + Identity */}
          <motion.section
            className="text-center mb-20"
            initial="hidden" animate="visible"
            variants={{ visible: { transition: { staggerChildren: 0.15 } } }}
          >
            <motion.div variants={fadeUp} className="relative inline-block mb-6">
              <div className="w-32 h-32 rounded-2xl overflow-hidden border-2 border-p01-cyan/40 shadow-[0_0_40px_rgba(57,197,187,0.2)] mx-auto">
                <img
                  src="/images/founder-slashy.png"
                  alt="Slashy"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="absolute -bottom-2 -right-2 bg-p01-cyan text-p01-void text-[10px] font-mono font-bold px-2 py-0.5 rounded-md">
                SOLO DEV
              </div>
            </motion.div>

            <motion.h1 variants={fadeUp} className="text-4xl sm:text-5xl font-bold text-white mb-2 font-display tracking-tight">
              Slashy
            </motion.h1>

            <motion.p variants={fadeUp} className="text-p01-cyan font-mono text-sm mb-4 tracking-wider">
              {t('founder.role')}
            </motion.p>

            <motion.p variants={fadeUp} className="text-p01-text-secondary text-base max-w-2xl mx-auto leading-relaxed whitespace-pre-line">
              {t('founder.bio')}
            </motion.p>

            {/* Quick links */}
            <motion.div variants={fadeUp} className="flex items-center justify-center gap-3 mt-6">
              <a href="https://github.com/IsSlashy" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-p01-text-muted hover:text-white hover:border-p01-cyan/40 transition-all">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                GitHub
              </a>
              <a href="https://x.com/Slashy_fx" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-p01-text-muted hover:text-white hover:border-p01-cyan/40 transition-all">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                @Slashy_fx
              </a>
              <a href="https://protocol-01.dev" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-xs text-p01-text-muted hover:text-white hover:border-p01-cyan/40 transition-all">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                Website
              </a>
            </motion.div>
          </motion.section>

          {/* Stats Grid */}
          <motion.section
            className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-20"
            initial="hidden" whileInView="visible" viewport={{ once: true, margin: "-50px" }}
            variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
          >
            {stats.map((s) => (
              <motion.div
                key={s.labelKey}
                variants={fadeUp}
                className="bg-p01-surface border border-p01-border rounded-xl p-4 text-center"
              >
                <div className="text-2xl font-bold text-p01-cyan font-mono">{s.value}</div>
                <div className="text-[10px] text-p01-text-dim font-mono uppercase tracking-wider mt-1">
                  {t(`founder.stats.${s.labelKey}`)}
                </div>
              </motion.div>
            ))}
          </motion.section>

          {/* Mission */}
          <motion.section
            className="mb-20"
            initial="hidden" whileInView="visible" viewport={{ once: true, margin: "-50px" }}
            variants={{ visible: { transition: { staggerChildren: 0.12 } } }}
          >
            <motion.div variants={fadeUp} className="text-center mb-8">
              <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">{t('founder.missionBadge')}</span>
              <h2 className="text-2xl sm:text-3xl font-bold text-white mt-2 font-display">{t('founder.missionTitle')}</h2>
            </motion.div>
            <motion.div variants={fadeUp}
              className="bg-p01-surface border border-p01-border rounded-2xl p-6 sm:p-8 space-y-4 text-p01-text-secondary leading-relaxed"
            >
              <p className="whitespace-pre-line">{t('founder.mission1')}</p>
              <p className="whitespace-pre-line">{t('founder.mission2')}</p>
              <p className="whitespace-pre-line text-white font-medium">{t('founder.mission3')}</p>
            </motion.div>
          </motion.section>

          {/* Timeline */}
          <motion.section
            className="mb-20"
            initial="hidden" whileInView="visible" viewport={{ once: true, margin: "-50px" }}
            variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
          >
            <motion.div variants={fadeUp} className="text-center mb-10">
              <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">{t('founder.journeyBadge')}</span>
              <h2 className="text-2xl sm:text-3xl font-bold text-white mt-2 font-display">{t('founder.journeyTitle')}</h2>
            </motion.div>

            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-[22px] sm:left-1/2 sm:-translate-x-px top-0 bottom-0 w-px bg-gradient-to-b from-p01-cyan/40 via-p01-cyan/20 to-transparent" />

              {timeline.map((item, i) => (
                <motion.div
                  key={item.key}
                  variants={fadeUp}
                  className={`relative flex items-start gap-4 sm:gap-8 mb-8 ${
                    i % 2 === 0 ? "sm:flex-row" : "sm:flex-row-reverse"
                  }`}
                >
                  {/* Dot */}
                  <div className="absolute left-[18px] sm:left-1/2 sm:-translate-x-1/2 w-[9px] h-[9px] rounded-full bg-p01-cyan border-2 border-p01-void shadow-[0_0_12px_rgba(57,197,187,0.5)] z-10 mt-5" />

                  {/* Content */}
                  <div className={`ml-12 sm:ml-0 sm:w-[calc(50%-2rem)] ${i % 2 === 0 ? "sm:text-right sm:pr-8" : "sm:pl-8"}`}>
                    <span className="text-p01-cyan font-mono text-xs font-bold">{item.year}</span>
                    <h3 className="text-white font-semibold text-sm mt-1">{t(`founder.timeline.${item.key}.title`)}</h3>
                    <p className="text-p01-text-dim text-xs mt-1 leading-relaxed">{t(`founder.timeline.${item.key}.desc`)}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.section>

          {/* What I Built — Protocol 01 Scope */}
          <motion.section
            className="mb-20"
            initial="hidden" whileInView="visible" viewport={{ once: true, margin: "-50px" }}
            variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
          >
            <motion.div variants={fadeUp} className="text-center mb-8">
              <span className="text-[10px] font-mono text-p01-cyan tracking-[0.3em] uppercase">{t('founder.builtBadge')}</span>
              <h2 className="text-2xl sm:text-3xl font-bold text-white mt-2 font-display">{t('founder.builtTitle')}</h2>
            </motion.div>

            <div className="grid sm:grid-cols-2 gap-3">
              {[
                { icon: "cube", titleKey: "onchain", items: ["12 Solana programs (Anchor/Rust)", "6 STARK AIRs (Winterfell, hot path)", "Custom on-chain FRI verifier (Goldilocks)", "On-chain relayer + fee splitter"] },
                { icon: "phone", titleKey: "clients", items: ["Mobile app (Expo/React Native)", "Chrome extension (MV3)", "Next.js 16 web app", "SDK demo + documentation"] },
                { icon: "shield", titleKey: "privacy", items: ["Stealth addresses (ECDH + ML-KEM-768)", "Denominated privacy pools", "Multi-hop mixing router", "On-chain p01_relayer (encrypted submission)"] },
                { icon: "cpu", titleKey: "quantum", items: ["STARK migration (post-quantum)", "Winternitz OTS vault (WOTS+)", "Hash-timelock vault", "Commit-then-reveal auth"] },
              ].map((card) => (
                <motion.div
                  key={card.titleKey}
                  variants={fadeUp}
                  className="bg-p01-surface border border-p01-border rounded-xl p-5 hover:border-p01-cyan/30 transition-colors"
                >
                  <h3 className="text-white font-semibold text-sm mb-3">{t(`founder.built.${card.titleKey}`)}</h3>
                  <ul className="space-y-1.5">
                    {card.items.map((item, j) => (
                      <li key={j} className="text-p01-text-dim text-xs flex items-start gap-2">
                        <span className="text-p01-cyan mt-0.5">&#x2022;</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ))}
            </div>
          </motion.section>

          {/* CTA */}
          <motion.section
            className="text-center"
            initial="hidden" whileInView="visible" viewport={{ once: true }}
            variants={{ visible: { transition: { staggerChildren: 0.12 } } }}
          >
            <motion.p variants={fadeUp} className="text-p01-text-dim text-sm mb-4">{t('founder.cta')}</motion.p>
            <motion.div variants={fadeUp} className="flex items-center justify-center gap-3">
              <a href="https://x.com/Slashy_fx" target="_blank" rel="noopener noreferrer"
                className="btn-primary text-xs px-6 py-2.5">
                {t('founder.ctaTwitter')}
              </a>
              <a href="/#download" className="px-6 py-2.5 border border-p01-border rounded-lg text-xs text-p01-text-muted hover:text-white hover:border-p01-cyan/40 transition-all">
                {t('founder.ctaDownload')}
              </a>
            </motion.div>
          </motion.section>

        </div>
      </main>

      <Footer />
    </>
  );
}
