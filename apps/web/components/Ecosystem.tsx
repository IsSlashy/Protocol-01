"use client";

import { memo, type ReactElement } from "react";
import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { useT } from "@/i18n";


// Tech logo SVGs — small recognizable icons for each technology
const techLogos: Record<string, ReactElement> = {
  Solana: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M4.52 16.57l3.17-3.24a.56.56 0 01.4-.17h12.35c.25 0 .38.31.2.49l-3.17 3.24a.56.56 0 01-.4.17H4.72a.28.28 0 01-.2-.49z" />
      <path d="M4.52 4.17l3.17 3.24a.56.56 0 00.4.17h12.35c.25 0 .38-.31.2-.49L17.47 3.85a.56.56 0 00-.4-.17H4.72a.28.28 0 00-.2.49z" />
      <path d="M4.52 10.37l3.17 3.24a.56.56 0 00.4.17h12.35c.25 0 .38-.31.2-.49l-3.17-3.24a.56.56 0 00-.4-.17H4.72a.28.28 0 00-.2.49z" />
    </svg>
  ),
  Anchor: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="3" />
      <line x1="12" y1="22" x2="12" y2="8" />
      <path d="M5 12H2a10 10 0 0020 0h-3" />
    </svg>
  ),
  Circom: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
    </svg>
  ),
  "ark-circom": (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Groth16: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  Poseidon: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12c2-4 6-4 8 0s6 4 8 0" />
      <path d="M2 16c2-4 6-4 8 0s6 4 8 0" />
      <path d="M12 2v4M8 3l1 3M16 3l-1 3" />
    </svg>
  ),
  Jupiter: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="9" ry="3" />
      <path d="M12 3c-3 3-3 15 0 18" />
    </svg>
  ),
  "React Native": (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <circle cx="12" cy="12" r="2.5" />
      <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(120 12 12)" />
    </svg>
  ),
  Expo: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15l-5-5 1.41-1.41L11 14.17l7.59-7.59L20 8l-9 9z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  "Next.js": (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1.5 14.5V7.8l7.7 10.2a8.5 8.5 0 01-3.7.9l-4-5.4v3zm6.8.8L10 7.5h1.5V15l4.5 5.8a8.4 8.4 0 002.3-3.5z" />
    </svg>
  ),
  TypeScript: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <rect x="2" y="2" width="20" height="20" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="7" y="17" fontSize="12" fontWeight="bold" fontFamily="monospace" fill="currentColor">TS</text>
    </svg>
  ),
  Docker: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 13.5h3v-3h3v-3h3V5h3v2.5h3v3h1.5a3 3 0 010 6H2v-3z" />
      <rect x="5" y="10.5" width="2" height="2" rx="0.3" fill="currentColor" />
      <rect x="8" y="10.5" width="2" height="2" rx="0.3" fill="currentColor" />
      <rect x="8" y="7.5" width="2" height="2" rx="0.3" fill="currentColor" />
      <rect x="11" y="7.5" width="2" height="2" rx="0.3" fill="currentColor" />
      <rect x="11" y="10.5" width="2" height="2" rx="0.3" fill="currentColor" />
      <rect x="14" y="10.5" width="2" height="2" rx="0.3" fill="currentColor" />
    </svg>
  ),
  BN254: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="12" rx="10" ry="6" />
      <path d="M12 6v12" />
      <path d="M6 8c2 3 10 3 12 0" />
    </svg>
  ),
  Curve25519: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 18c3-12 15-12 18 0" />
      <circle cx="6" cy="14" r="1.5" fill="currentColor" />
      <circle cx="18" cy="14" r="1.5" fill="currentColor" />
    </svg>
  ),
  "Merkle Trees": (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="4" r="2" fill="currentColor" />
      <circle cx="6" cy="12" r="2" fill="currentColor" />
      <circle cx="18" cy="12" r="2" fill="currentColor" />
      <circle cx="3" cy="20" r="1.5" fill="currentColor" />
      <circle cx="9" cy="20" r="1.5" fill="currentColor" />
      <circle cx="15" cy="20" r="1.5" fill="currentColor" />
      <circle cx="21" cy="20" r="1.5" fill="currentColor" />
      <line x1="12" y1="6" x2="6" y2="10" />
      <line x1="12" y1="6" x2="18" y2="10" />
      <line x1="6" y1="14" x2="3" y2="18.5" />
      <line x1="6" y1="14" x2="9" y2="18.5" />
      <line x1="18" y1="14" x2="15" y2="18.5" />
      <line x1="18" y1="14" x2="21" y2="18.5" />
    </svg>
  ),
  Nullifiers: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="5" y1="5" x2="19" y2="19" />
    </svg>
  ),
  snarkjs: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <line x1="14" y1="4" x2="10" y2="20" />
    </svg>
  ),
  axum: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Zustand: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a7 7 0 00-7 7c0 3 2 5.5 4 7l3 4 3-4c2-1.5 4-4 4-7a7 7 0 00-7-7z" />
      <circle cx="12" cy="9" r="2" fill="currentColor" />
    </svg>
  ),
  Reanimated: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h4l3-9 6 18 3-9h4" />
    </svg>
  ),
  Tailwind: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M12 6c-2.67 0-4.33 1.33-5 4 1-1.33 2.17-1.83 3.5-1.5.76.19 1.3.74 1.9 1.35C13.35 10.82 14.48 12 17 12c2.67 0 4.33-1.33 5-4-1 1.33-2.17 1.83-3.5 1.5-.76-.19-1.3-.74-1.9-1.35C15.65 7.18 14.52 6 12 6zM7 12c-2.67 0-4.33 1.33-5 4 1-1.33 2.17-1.83 3.5-1.5.76.19 1.3.74 1.9 1.35C8.35 16.82 9.48 18 12 18c2.67 0 4.33-1.33 5-4-1 1.33-2.17 1.83-3.5 1.5-.76-.19-1.3-.74-1.9-1.35C10.65 13.18 9.52 12 7 12z" />
    </svg>
  ),
  Vite: (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 4L12 22 4 4" stroke="currentColor" />
      <path d="M15 2l-3 8-3-8" fill="currentColor" opacity="0.6" />
    </svg>
  ),
  "llama.rn": (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 00-3 3v1H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V8a2 2 0 00-2-2h-2V5a3 3 0 00-3-3z" />
      <circle cx="9.5" cy="11" r="1" fill="currentColor" />
      <circle cx="14.5" cy="11" r="1" fill="currentColor" />
      <path d="M9 15c.83.67 2.17.67 3 0 .83.67 2.17.67 3 0" />
    </svg>
  ),
  "SPL Tokens": (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  ),
};

const techsRow1 = [
  { name: "Solana", category: "l1Blockchain" },
  { name: "Anchor", category: "smartContracts" },
  { name: "Circom", category: "zkCircuits" },
  { name: "ark-circom", category: "rustProver" },
  { name: "Groth16", category: "zkProofSystem" },
  { name: "STARK", category: "quantumSafeProofs" },
  { name: "Poseidon", category: "zkHash" },
  { name: "Jupiter", category: "dexAggregator" },
  { name: "React Native", category: "mobile" },
  { name: "Expo", category: "appPlatform" },
  { name: "Next.js", category: "webFramework" },
  { name: "TypeScript", category: "language" },
  { name: "Docker", category: "deployment" },
];

const techsRow2 = [
  { name: "Winterfell", category: "starkProver" },
  { name: "BN254", category: "ellipticCurve" },
  { name: "Goldilocks", category: "quantumSafeField" },
  { name: "Curve25519", category: "ecdh" },
  { name: "Merkle Trees", category: "dataStructure" },
  { name: "Nullifiers", category: "antiDoubleSpend" },
  { name: "ML-KEM", category: "postQuantumKEM" },
  { name: "Zustand", category: "stateMgmt" },
  { name: "Reanimated", category: "animations" },
  { name: "Tailwind", category: "styling" },
  { name: "Vite", category: "buildTool" },
  { name: "llama.rn", category: "onDeviceAI" },
  { name: "SPL Tokens", category: "tokenStandard" },
];

function Ecosystem() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-50px" });
  const t = useT();

  // Duplicate arrays for seamless loop
  const row1 = [...techsRow1, ...techsRow1];
  const row2 = [...techsRow2, ...techsRow2];

  return (
    <section className="py-20 relative overflow-hidden" ref={ref}>
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-p01-surface/10 to-transparent" />

      <div className="relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-12 px-6"
        >
          <span className="text-[10px] font-mono text-[#555560] uppercase tracking-[0.4em]">
            {t('ecosystem.badge')}
          </span>
          <h3 className="text-xl sm:text-2xl font-bold font-display text-white mt-3 tracking-wider">
            {t('ecosystem.title')}{" "}
            <span className="text-p01-cyan">{t('ecosystem.titleHighlight')}</span>
          </h3>
        </motion.div>

        {/* Marquee container */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="relative"
        >
          {/* Fade edges */}
          <div className="absolute left-0 top-0 bottom-0 w-24 sm:w-40 z-10 bg-gradient-to-r from-[#0a0a0c] to-transparent pointer-events-none" />
          <div className="absolute right-0 top-0 bottom-0 w-24 sm:w-40 z-10 bg-gradient-to-l from-[#0a0a0c] to-transparent pointer-events-none" />

          {/* Row 1 — scrolls left (framer-motion) */}
          <div className="mb-3 overflow-hidden">
            <motion.div
              className="flex gap-3"
              style={{ width: "max-content" }}
              animate={{ x: ["0%", "-50%"] }}
              transition={{ duration: 40, repeat: Infinity, ease: "linear", repeatType: "loop" }}
            >
              {row1.map((tech, i) => (
                <div
                  key={`r1-${i}`}
                  className="flex items-center gap-3 px-4 py-2.5 border border-[#2a2a30] bg-[#111114] whitespace-nowrap hover:border-[#39c5bb]/30 transition-colors duration-300 group"
                >
                  <div className="text-[#39c5bb] group-hover:drop-shadow-[0_0_6px_#39c5bb80] transition-all flex-shrink-0">
                    {techLogos[tech.name] || <div className="w-4 h-4 bg-[#39c5bb]" />}
                  </div>
                  <span className="text-sm font-mono text-white font-medium">
                    {tech.name}
                  </span>
                  <span className="text-[10px] font-mono text-[#555560]">
                    {t(`ecosystem.${tech.category}`)}
                  </span>
                </div>
              ))}
            </motion.div>
          </div>

          {/* Row 2 — scrolls right (framer-motion) */}
          <div className="overflow-hidden">
            <motion.div
              className="flex gap-3"
              style={{ width: "max-content", x: "-50%" }}
              animate={{ x: ["-50%", "0%"] }}
              transition={{ duration: 45, repeat: Infinity, ease: "linear", repeatType: "loop" }}
            >
              {row2.map((tech, i) => (
                <div
                  key={`r2-${i}`}
                  className="flex items-center gap-3 px-4 py-2.5 border border-[#2a2a30] bg-[#111114] whitespace-nowrap hover:border-[#ff77a8]/30 transition-colors duration-300 group"
                >
                  <div className="text-[#ff77a8] group-hover:drop-shadow-[0_0_6px_#ff77a880] transition-all flex-shrink-0">
                    {techLogos[tech.name] || <div className="w-4 h-4 bg-[#ff77a8]" />}
                  </div>
                  <span className="text-sm font-mono text-white font-medium">
                    {tech.name}
                  </span>
                  <span className="text-[10px] font-mono text-[#555560]">
                    {t(`ecosystem.${tech.category}`)}
                  </span>
                </div>
              ))}
            </motion.div>
          </div>
        </motion.div>

        {/* Bottom count */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ delay: 0.6 }}
          className="flex items-center justify-center gap-6 mt-10 px-6"
        >
          {[
            { value: "26+", label: "technologies" },
            { value: "14", label: "onChainPrograms" },
            { value: "17", label: "clientSDKs" },
            { value: "100%", label: "selfCustody" },
          ].map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-lg sm:text-xl font-bold font-display text-white">
                {s.value}
              </div>
              <div className="text-[10px] font-mono text-[#555560] uppercase tracking-wider">
                {t(`ecosystem.${s.label}`)}
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

export default memo(Ecosystem);
