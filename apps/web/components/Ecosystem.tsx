"use client";

import { memo } from "react";
import { motion, useInView } from "framer-motion";
import { useRef } from "react";

const techsRow1 = [
  { name: "Solana", category: "L1 Blockchain" },
  { name: "Anchor", category: "Smart Contracts" },
  { name: "Circom", category: "ZK Circuits" },
  { name: "ark-circom", category: "Rust Prover" },
  { name: "Groth16", category: "ZK Proof System" },
  { name: "Poseidon", category: "ZK Hash" },
  { name: "Jupiter", category: "DEX Aggregator" },
  { name: "React Native", category: "Mobile" },
  { name: "Expo", category: "App Platform" },
  { name: "Next.js", category: "Web Framework" },
  { name: "TypeScript", category: "Language" },
  { name: "Docker", category: "Deployment" },
];

const techsRow2 = [
  { name: "BN254", category: "Elliptic Curve" },
  { name: "Curve25519", category: "ECDH" },
  { name: "Merkle Trees", category: "Data Structure" },
  { name: "Nullifiers", category: "Anti Double-Spend" },
  { name: "snarkjs", category: "JS Verifier" },
  { name: "axum", category: "Rust HTTP" },
  { name: "Zustand", category: "State Mgmt" },
  { name: "Reanimated", category: "Animations" },
  { name: "Tailwind", category: "Styling" },
  { name: "Vite", category: "Build Tool" },
  { name: "llama.rn", category: "On-Device AI" },
  { name: "SPL Tokens", category: "Token Standard" },
];

function Ecosystem() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-50px" });

  // Duplicate arrays for seamless loop
  const row1 = [...techsRow1, ...techsRow1];
  const row2 = [...techsRow2, ...techsRow2];

  return (
    <section className="py-20 relative overflow-hidden" ref={ref}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
        @keyframes marquee-left {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes marquee-right {
          0% { transform: translateX(-50%); }
          100% { transform: translateX(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .marquee-track { animation-play-state: paused !important; }
        }
      `,
        }}
      />

      <div className="absolute inset-0 bg-gradient-to-b from-p01-void via-p01-surface/10 to-p01-void" />

      <div className="relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-12 px-6"
        >
          <span className="text-[10px] font-mono text-[#555560] uppercase tracking-[0.4em]">
            Ecosystem & Technologies
          </span>
          <h3 className="text-xl sm:text-2xl font-bold font-display text-white mt-3 tracking-wider">
            BUILT WITH THE{" "}
            <span className="text-p01-cyan">BEST IN CLASS</span>
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

          {/* Row 1 — scrolls left */}
          <div className="mb-3 overflow-hidden">
            <div
              className="flex gap-3 marquee-track"
              style={{
                animation: "marquee-left 40s linear infinite",
                width: "max-content",
              }}
            >
              {row1.map((tech, i) => (
                <div
                  key={`r1-${i}`}
                  className="flex items-center gap-3 px-4 py-2.5 border border-[#2a2a30] bg-[#111114] whitespace-nowrap hover:border-[#39c5bb]/30 transition-colors duration-300 group"
                >
                  <div className="w-1.5 h-1.5 bg-[#39c5bb] group-hover:shadow-[0_0_8px_#39c5bb80] transition-shadow" />
                  <span className="text-sm font-mono text-white font-medium">
                    {tech.name}
                  </span>
                  <span className="text-[10px] font-mono text-[#555560]">
                    {tech.category}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Row 2 — scrolls right */}
          <div className="overflow-hidden">
            <div
              className="flex gap-3 marquee-track"
              style={{
                animation: "marquee-right 45s linear infinite",
                width: "max-content",
              }}
            >
              {row2.map((tech, i) => (
                <div
                  key={`r2-${i}`}
                  className="flex items-center gap-3 px-4 py-2.5 border border-[#2a2a30] bg-[#111114] whitespace-nowrap hover:border-[#ff77a8]/30 transition-colors duration-300 group"
                >
                  <div className="w-1.5 h-1.5 bg-[#ff77a8] group-hover:shadow-[0_0_8px_#ff77a880] transition-shadow" />
                  <span className="text-sm font-mono text-white font-medium">
                    {tech.name}
                  </span>
                  <span className="text-[10px] font-mono text-[#555560]">
                    {tech.category}
                  </span>
                </div>
              ))}
            </div>
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
            { value: "24+", label: "Technologies" },
            { value: "6", label: "On-chain Programs" },
            { value: "3", label: "Client SDKs" },
            { value: "100%", label: "Open Source" },
          ].map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-lg sm:text-xl font-bold font-display text-white">
                {s.value}
              </div>
              <div className="text-[10px] font-mono text-[#555560] uppercase tracking-wider">
                {s.label}
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

export default memo(Ecosystem);
