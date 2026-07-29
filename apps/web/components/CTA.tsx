"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
// WAITLIST MODE: Github icon unused while the GitHub CTA is hidden, restore at launch
// import { Github } from "lucide-react";
import { useT } from "@/i18n";
import WaitlistForm from "./WaitlistForm";
// WAITLIST MODE: the download cards below are disabled. To restore at public
// launch, re-add `Chrome, Download` to the lucide-react import and
// `import Link from "next/link";`, then un-comment the download block.

// WAITLIST MODE: download CTA disabled, restore at public launch.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const APK_URL =
  "https://github.com/IsSlashy/Protocol-01/releases/download/v1.0.3/protocol-01-v1.0.3.apk";


export default function CTA() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const t = useT();

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      {/* Background Effects - Industrial grid, no soft blurs */}
      <div className="absolute inset-0">
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage: `
              linear-gradient(to right, rgba(57, 197, 187, 0.05) 1px, transparent 1px),
              linear-gradient(to bottom, rgba(57, 197, 187, 0.05) 1px, transparent 1px)
            `,
            backgroundSize: '40px 40px',
          }}
        />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto">
        {/* Main CTA Card */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="card p-12 text-center relative overflow-hidden scanlines"
        >
          {/* Gradient border effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-p01-cyan/20 via-p01-pink/20 to-p01-bright-cyan/20 opacity-50" />
          <div className="absolute inset-[1px] bg-p01-surface rounded-2xl" />

          <div className="relative z-10">
            {/* Badge - Industrial style, no rounded */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={isInView ? { opacity: 1, scale: 1 } : {}}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#151518] border border-[#39c5bb]/40 mb-8"
            >
              <span className="w-2 h-2 bg-[#39c5bb]" />
              <span className="text-[#39c5bb] text-sm font-medium font-mono uppercase tracking-wider">
                {t('waitlist.badge')}
              </span>
            </motion.div>

            {/* Heading - No soft glow */}
            <motion.h2
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="text-4xl sm:text-5xl lg:text-6xl font-bold font-display mb-6 tracking-tight"
            >
              {t('cta.title')}{" "}
              <span className="text-[#39c5bb]">{t('cta.titleHighlight')}</span>?
            </motion.h2>

            {/* Subtitle */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="text-lg text-p01-text-muted max-w-2xl mx-auto mb-12 space-y-1"
            >
              <p>{t('waitlist.subtitle1')}</p>
              <p>{t('waitlist.subtitle2')}</p>
            </motion.div>

            {/* Waitlist — public downloads are paused, visitors leave their email */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="mb-10"
            >
              <WaitlistForm source="cta" />
            </motion.div>

            {/* WAITLIST MODE: download CTA disabled, restore at public launch.
                The Android APK card + Chrome extension card below are paused
                while we run double opt-in signups. Restore this block (and the
                Chrome/Download/Link imports) to bring back direct downloads.
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="max-w-md mx-auto mb-10"
            >
              <a
                href={APK_URL}
                download="protocol-01-v1.0.3.apk"
                className="group flex items-center gap-4 p-5 rounded-2xl border border-p01-cyan/40 bg-p01-cyan/[0.06] hover:bg-p01-cyan/[0.12] hover:border-p01-cyan/70 transition-all duration-300 no-underline"
              >
                <div className="w-12 h-12 rounded-xl bg-p01-cyan/15 flex items-center justify-center text-p01-cyan shrink-0">
                  <svg viewBox="0 0 24 24" className="w-6 h-6" fill="currentColor" aria-hidden>
                    <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85a.637.637 0 0 0-.83.22l-1.88 3.24a11.46 11.46 0 0 0-8.94 0L5.65 5.67a.643.643 0 0 0-.87-.2c-.28.18-.37.54-.22.83L6.4 9.48A10.78 10.78 0 0 0 1 18h22a10.78 10.78 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z" />
                  </svg>
                </div>
                <div className="text-left flex-1 min-w-0">
                  <div className="font-semibold font-display text-white group-hover:text-p01-cyan transition-colors">
                    {t('cta.android')}
                  </div>
                  <div className="text-sm text-p01-text-dim">{t('cta.androidDesc')} (120 MB)</div>
                </div>
                <Download size={20} className="text-p01-cyan shrink-0" />
              </a>

              <Link
                href="/extension"
                className="group mt-3 flex items-center gap-4 p-5 rounded-2xl border border-p01-pink/40 bg-p01-pink/[0.06] hover:bg-p01-pink/[0.12] hover:border-p01-pink/70 transition-all duration-300 no-underline"
              >
                <div className="w-12 h-12 rounded-xl bg-p01-pink/15 flex items-center justify-center text-p01-pink shrink-0">
                  <Chrome size={24} />
                </div>
                <div className="text-left flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold font-display text-white group-hover:text-p01-pink transition-colors">
                      {t('cta.chromeExtension')}
                    </span>
                    <span className="text-[10px] font-mono text-[#ffcc00] border border-[#ffcc00]/30 bg-[#ffcc00]/10 px-2 py-0.5 rounded-full uppercase tracking-wider">
                      Beta
                    </span>
                  </div>
                  <div className="text-sm text-p01-text-dim">Chrome · Opera · Edge · Brave · Devnet</div>
                </div>
                <Download size={20} className="text-p01-pink shrink-0" />
              </Link>
            </motion.div>
            WAITLIST MODE end */}

            {/* Secondary Actions */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : {}}
              transition={{ duration: 0.5, delay: 0.6 }}
              className="flex flex-col sm:flex-row items-center justify-center gap-4"
            >
              {/* WAITLIST MODE: GitHub de-emphasized while access runs through the
                  waitlist (repo stays public; licenses/terms keep their links).
                  Restore at public launch:
              <a
                href="https://github.com/IsSlashy/Protocol-01"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-p01-text-muted hover:text-white transition-colors"
              >
                <Github size={20} />
                <span>{t('cta.viewOnGithub')}</span>
              </a>
              <span className="hidden sm:block text-p01-border">|</span>
              WAITLIST MODE end */}
              <a
                href="https://discord.gg/fShgQ5j6pE"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-p01-text-muted hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                </svg>
                <span>{t('cta.joinDiscord')}</span>
              </a>
            </motion.div>

            {/* Trust stats — integrated divided strip */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.7 }}
              className="mt-10 pt-8 border-t border-p01-border/50 grid grid-cols-3 divide-x divide-p01-border/50"
            >
              {[
                { value: "100%", label: "selfCustody" },
                { value: "0", label: "kycRequired" },
                { value: "∞", label: "privacy" },
              ].map((stat) => (
                <div key={stat.label} className="px-2 text-center">
                  <div className="text-2xl sm:text-3xl font-bold font-display text-white">
                    {stat.value}
                  </div>
                  <div className="text-xs sm:text-sm text-p01-text-muted mt-1">{t(`cta.${stat.label}`)}</div>
                </div>
              ))}
            </motion.div>

          </div>
        </motion.div>
      </div>
    </section>
  );
}

