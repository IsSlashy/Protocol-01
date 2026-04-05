"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Github, Smartphone, Chrome, Download } from "lucide-react";
import { useT } from "@/i18n";

const downloadOptions = [
  {
    platform: "android",
    icon: Smartphone,
    description: "androidDesc",
    filename: "protocol-01-v0.9.8.apk",
    link: "https://github.com/IsSlashy/Protocol-01-releases/releases/download/v0.9.8/protocol-01-v0.9.8.apk",
    size: "137 MB",
  },
  {
    platform: "chromeExtension",
    icon: Chrome,
    description: "chromeDesc",
    filename: "",
    link: "",
    size: "Beta",
    disabled: true,
  },
];

// ─── Easter egg: permanently glitching corrupted text ────────────────────

const ZALGO_ABOVE = [
  '\u0300','\u0301','\u0302','\u0303','\u0304','\u0305','\u0306','\u0307',
  '\u0308','\u0309','\u030A','\u030B','\u030C','\u030D','\u030E','\u030F',
  '\u0310','\u0311','\u0312','\u0313','\u0314','\u0315','\u031A','\u033D',
  '\u034A','\u034B','\u034C','\u0350','\u0351','\u0352','\u0357','\u035B',
];
const ZALGO_MID = [
  '\u0334','\u0335','\u0336','\u0337','\u0338','\u0339','\u033A','\u033B',
  '\u033C','\u0347','\u0348','\u0349',
];
const ZALGO_BELOW = [
  '\u0316','\u0317','\u0318','\u0319','\u031C','\u031D','\u031E','\u031F',
  '\u0320','\u0321','\u0322','\u0323','\u0324','\u0325','\u0326','\u0327',
  '\u0328','\u0329','\u032A','\u032B','\u032C','\u032D','\u032E','\u032F',
];
const GLITCH_BASES = ['d','0','n','t','d','o','n','\'','t','!','?','.','_','x','#'];
const SWAP_CHARS = '!@#$%&*?/\\|~^<>{}[]()_=+';

function randPick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

/** Generate a new corrupted frame — different every call */
function glitchFrame(base: string, intensity: number): string {
  return base.split('').map((ch) => {
    // Randomly swap the base character itself
    let c = Math.random() < 0.15 * intensity
      ? SWAP_CHARS[Math.floor(Math.random() * SWAP_CHARS.length)]
      : ch;
    // Zalgo above (0-2 diacritics)
    const aboveCount = Math.floor(Math.random() * intensity * 3);
    for (let i = 0; i < aboveCount; i++) c += randPick(ZALGO_ABOVE);
    // Zalgo middle (0-2 strikethroughs)
    const midCount = Math.floor(Math.random() * intensity * 2);
    for (let i = 0; i < midCount; i++) c += randPick(ZALGO_MID);
    // Zalgo below (0-1)
    if (Math.random() < 0.4 * intensity) c += randPick(ZALGO_BELOW);
    return c;
  }).join('');
}

/** Hook: returns a continuously glitching string */
function useGlitchText(base: string, intensity: number, intervalMs: number) {
  const [text, setText] = useState(() => glitchFrame(base, intensity));
  useEffect(() => {
    // Randomize interval slightly each tick for organic feel
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setText(glitchFrame(base, intensity));
      timer = setTimeout(tick, intervalMs + Math.random() * intervalMs * 0.6);
    };
    timer = setTimeout(tick, intervalMs);
    return () => clearTimeout(timer);
  }, [base, intensity, intervalMs]);
  return text;
}

export default function CTA() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const t = useT();
  const router = useRouter();
  const [easterState, setEasterState] = useState(0);

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
                {t('cta.badge')}
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
              <p>{t('cta.subtitle1')}</p>
              <p>{t('cta.subtitle2')}</p>
            </motion.div>

            {/* Download Buttons */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto mb-12"
            >
              {downloadOptions.map((option) => {
                const isDisabled = !!(option as any).disabled;
                const Tag = isDisabled ? 'div' : 'a';
                return (
                  <Tag
                    key={option.platform}
                    {...(isDisabled ? {} : { href: option.link, download: option.filename })}
                    className={`group flex items-center gap-4 p-4 rounded-2xl bg-white/[0.02] backdrop-blur-md border transition-all duration-300 no-underline ${
                      isDisabled
                        ? 'border-white/[0.04] opacity-50 cursor-not-allowed'
                        : 'border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.12] cursor-pointer'
                    }`}
                  >
                    <div className={`w-12 h-12 rounded-xl bg-p01-surface flex items-center justify-center transition-colors ${
                      isDisabled ? 'text-p01-text-dim' : 'text-p01-text-muted group-hover:text-p01-cyan'
                    }`}>
                      <option.icon size={24} />
                    </div>
                    <div className="text-left flex-1">
                      <div className={`font-semibold font-display transition-colors ${
                        isDisabled ? 'text-p01-text-muted' : 'text-white group-hover:text-p01-cyan'
                      }`}>
                        {t(`cta.${option.platform}`)}
                      </div>
                      <div className="text-sm text-p01-text-dim">
                        {t(`cta.${option.description}`)} ({option.size})
                      </div>
                    </div>
                    {isDisabled ? (
                      <span className="text-[10px] font-mono text-[#ffcc00] border border-[#ffcc00]/30 bg-[#ffcc00]/10 px-2 py-0.5 rounded-full uppercase tracking-wider">
                        {t('cta.soon')}
                      </span>
                    ) : (
                      <Download size={20} className="text-p01-text-muted group-hover:text-p01-cyan transition-colors" />
                    )}
                  </Tag>
                );
              })}
            </motion.div>

            {/* Secondary Actions */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : {}}
              transition={{ duration: 0.5, delay: 0.6 }}
              className="flex flex-col sm:flex-row items-center justify-center gap-4"
            >
              <a
                href="https://github.com/IsSlashy/Protocol-01-releases"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-p01-text-muted hover:text-white transition-colors"
              >
                <Github size={20} />
                <span>{t('cta.viewOnGithub')}</span>
              </a>
              <span className="hidden sm:block text-p01-border">|</span>
              <a
                href="https://discord.gg/KfmhPFAHNH"
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

            {/* Easter egg — permanently glitching corrupted button */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={isInView ? { opacity: 1 } : {}}
              transition={{ duration: 3, delay: 4 }}
              className="mt-8 flex justify-center"
            >
              <EasterEggButton state={easterState} onAdvance={() => {
                if (easterState >= PHASES.length - 1) {
                  window.history.pushState(null, '', '/????');
                  router.push("/void");
                } else {
                  setEasterState(easterState + 1);
                }
              }} />
            </motion.div>
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.7 }}
          className="mt-16 grid grid-cols-3 gap-8"
        >
          {[
            { value: "100%", label: "selfCustody" },
            { value: "0", label: "kycRequired" },
            { value: "∞", label: "privacy" },
          ].map((stat) => (
            <div key={stat.label} className="text-center bg-white/[0.03] backdrop-blur-sm border border-white/[0.06] rounded-2xl px-6 py-4 hover:bg-white/[0.05] hover:border-white/[0.12] transition-all duration-300">
              <div className="text-3xl sm:text-4xl font-bold font-display text-white mb-2">
                {stat.value}
              </div>
              <div className="text-sm text-p01-text-muted">{t(`cta.${stat.label}`)}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

// ─── Easter egg component with live glitching + screen shake ─────────────────

const PHASES = [
  // 0: barely visible corrupted whisper — something feels wrong
  { base: "dont",                                        intensity: 0.8, interval: 100, size: 'text-[10px]', opacity: 'opacity-20 hover:opacity-40', shake: 0,   glow: 0,   color: 'text-red-500'    },
  // 1: it noticed you
  { base: "why are you doing this",                      intensity: 0.9, interval: 75,  size: 'text-[11px]', opacity: 'opacity-35 hover:opacity-55', shake: 1,   glow: 0.2, color: 'text-red-400'    },
  // 2: it's getting upset — NGO pink starts bleeding in
  { base: "why are you trying to get inside my head",    intensity: 1.1, interval: 60,  size: 'text-xs',     opacity: 'opacity-50 hover:opacity-70', shake: 2.5, glow: 0.4, color: 'text-pink-400'   },
  // 3: pleading — text gets bigger, shake picks up
  { base: "stop please stop",                            intensity: 1.4, interval: 45,  size: 'text-sm',     opacity: 'opacity-65 hover:opacity-85', shake: 5,   glow: 0.6, color: 'text-pink-300'   },
  // 4: breaking — single word, loud
  { base: "why ?",                                       intensity: 1.8, interval: 30,  size: 'text-lg',     opacity: 'opacity-80 hover:opacity-100',shake: 8,   glow: 0.85,color: 'text-pink-200'   },
  // 5: total breakdown — maximum corruption, screen shakes violently
  { base: "...",                                         intensity: 2.8, interval: 20,  size: 'text-xl',     opacity: 'opacity-95',                  shake: 14,  glow: 1.0, color: 'text-white'      },
];

function EasterEggButton({ state, onAdvance }: { state: number; onAdvance: () => void }) {
  const phase = PHASES[Math.min(state, PHASES.length - 1)];
  const glitched = useGlitchText(phase.base, phase.intensity, phase.interval);
  const [shakeOffset, setShakeOffset] = useState({ x: 0, y: 0 });
  const [flashOpacity, setFlashOpacity] = useState(0);

  // Permanent tremble — increases each phase
  useEffect(() => {
    if (phase.shake === 0) return;
    const tick = () => {
      const mag = phase.shake;
      setShakeOffset({
        x: (Math.random() - 0.5) * mag * 2,
        y: (Math.random() - 0.5) * mag * 2,
      });
    };
    const id = setInterval(tick, 25);
    return () => clearInterval(id);
  }, [phase.shake]);

  // Flash on click (NGO style — brief white/pink flash)
  const handleClick = () => {
    setFlashOpacity(1);
    setTimeout(() => setFlashOpacity(0), 80);
    onAdvance();
  };

  return (
    <div className="relative">
      {/* Click flash — NGO style screen flash */}
      {flashOpacity > 0 && state >= 2 && (
        <div
          className="fixed inset-0 z-[9998] pointer-events-none"
          style={{
            background: state >= 4
              ? 'rgba(255,255,255,0.15)'
              : 'rgba(255,100,150,0.08)',
            opacity: flashOpacity,
            transition: 'opacity 80ms',
          }}
        />
      )}
      <button
        onClick={handleClick}
        className={`
          font-mono select-none border-none bg-transparent
          cursor-pointer transition-all duration-300
          ${phase.color} ${phase.opacity} ${phase.size}
          leading-relaxed max-w-lg relative
        `}
        style={{
          transform: `translate(${shakeOffset.x}px, ${shakeOffset.y}px)`,
          // NGO chromatic aberration: red/cyan split shadows
          textShadow: phase.glow > 0
            ? `${-1 - phase.glow * 3}px 0 rgba(255,50,100,${phase.glow * 0.7}), ${1 + phase.glow * 3}px 0 rgba(0,255,200,${phase.glow * 0.5}), 0 0 ${phase.glow * 20}px rgba(255,100,150,${phase.glow * 0.4})`
            : 'none',
          letterSpacing: `${0.12 + state * 0.04}em`,
          textAlign: 'center',
          // Slight skew in later phases (broken feeling)
          ...(state >= 3 ? { fontStyle: 'italic' } : {}),
          ...(state >= 4 ? { transform: `translate(${shakeOffset.x}px, ${shakeOffset.y}px) skewX(${(Math.random() - 0.5) * 2}deg)` } : {}),
        }}
      >
        {glitched}
      </button>
    </div>
  );
}
