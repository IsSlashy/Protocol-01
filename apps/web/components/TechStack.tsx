"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import React, { useRef } from "react";
import { Lock, Cpu, Server, Code, Zap, Shield } from "lucide-react";

const technologies = [
  {
    category: "Zero-Knowledge",
    icon: Lock,
    items: [
      { name: "Noir", description: "ZK circuit language" },
      { name: "Barretenberg", description: "Ultra-fast prover" },
      { name: "Groth16", description: "Succinct proofs" },
    ],
    color: "cyan",
  },
  {
    category: "Privacy Infrastructure",
    icon: Shield,
    items: [
      { name: "Stealth Addresses", description: "Unlinkable recipients" },
      { name: "Private Relay", description: "Backend ZK verification → on-chain program" },
      { name: "Encrypted Storage", description: "Hidden metadata" },
    ],
    color: "pink",
  },
  {
    category: "Secure Compute",
    icon: Cpu,
    items: [
      { name: "TEE Enclaves", description: "Hardware isolation" },
      { name: "SGX/TDX", description: "Intel trusted execution" },
      { name: "Remote Attestation", description: "Verified compute" },
    ],
    color: "bright-cyan",
  },
  {
    category: "Blockchain",
    icon: Server,
    items: [
      { name: "Solana", description: "High-speed settlement" },
      { name: "Anchor", description: "Smart contract framework" },
      { name: "SPL Tokens", description: "Token standard" },
    ],
    color: "yellow",
  },
];

const architectureLayers = [
  {
    name: "Client Layer",
    color: "cyan" as const,
    hex: "#39c5bb",
    nodes: [
      { label: "MOBILE APP", sub: "React Native" },
      { label: "EXTENSION", sub: "Chrome / Brave" },
      { label: "SDK", sub: "TypeScript" },
    ],
  },
  {
    name: "ZK-SDK",
    color: "pink" as const,
    hex: "#ff77a8",
    nodes: [
      { label: "WASM Prover", sub: "Groth16" },
      { label: "Poseidon", sub: "Hash Function" },
      { label: "Note Mgmt", sub: "Encrypt / Decrypt" },
    ],
  },
  {
    name: "Protocol Layer",
    color: "bright-cyan" as const,
    hex: "#00ffe5",
    nodes: [
      { label: "STEALTH", sub: "ECDH Addresses" },
      { label: "SHIELDED", sub: "Groth16 Pool" },
      { label: "STREAMS", sub: "SPL Payments" },
    ],
  },
  {
    name: "Relay Layer",
    color: "pink" as const,
    hex: "#ff77a8",
    nodes: [
      { label: "RELAYER", sub: "ZK Verify + Transfer" },
      { label: "ON-CHAIN", sub: "Solana Program" },
    ],
  },
  {
    name: "Solana Blockchain",
    color: "yellow" as const,
    hex: "#ffcc00",
    nodes: [
      { label: "alt_bn128", sub: "Curve Ops" },
      { label: "SPL Tokens", sub: "Token Standard" },
      { label: "Anchor", sub: "Framework" },
    ],
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
} as const;

export default function TechStack() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; border: string }> = {
      cyan: {
        bg: "bg-p01-cyan/10",
        text: "text-p01-cyan",
        border: "border-p01-cyan/30",
      },
      pink: {
        bg: "bg-p01-pink/10",
        text: "text-p01-pink",
        border: "border-p01-pink/30",
      },
      "bright-cyan": {
        bg: "bg-p01-bright-cyan/10",
        text: "text-p01-bright-cyan",
        border: "border-p01-bright-cyan/30",
      },
      yellow: {
        bg: "bg-p01-yellow/10",
        text: "text-p01-yellow",
        border: "border-p01-yellow/30",
      },
    };
    return colors[color] || colors.cyan;
  };

  const getLayerHex = (color: string) => {
    const map: Record<string, string> = {
      cyan: "#39c5bb",
      pink: "#ff77a8",
      "bright-cyan": "#00ffe5",
      yellow: "#ffcc00",
    };
    return map[color] || map.cyan;
  };

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-p01-void via-p01-surface/20 to-p01-void" />
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <span className="badge-pink mb-4">Technology</span>
          <h2 className="section-title">
            Built on{" "}
            <span className="text-p01-pink text-glow-pink">
              cutting-edge cryptography
            </span>
          </h2>
          <div className="section-subtitle space-y-1">
            <p>We combine the latest advances in zero-knowledge proofs, trusted execution environments, and privacy-preserving protocols.</p>
          </div>
        </motion.div>

        {/* Architecture Diagram */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={isInView ? { opacity: 1, scale: 1 } : {}}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mb-20"
        >
          <div className="relative border border-[#2a2a30] bg-[#0a0a0c] p-6 sm:p-10 overflow-hidden">
            {/* Injected CSS for diagram animations */}
            <style dangerouslySetInnerHTML={{ __html: `
              @keyframes arch-dataflow {
                0% { transform: translateY(-100%); opacity: 0; }
                10% { opacity: 1; }
                90% { opacity: 1; }
                100% { transform: translateY(800%); opacity: 0; }
              }
              @keyframes arch-scan {
                0% { transform: translateY(-100%); }
                100% { transform: translateY(100%); }
              }
              @keyframes arch-glow-pulse {
                0%, 100% { opacity: 0.03; }
                50% { opacity: 0.07; }
              }
              @keyframes arch-particle-drift {
                0%, 100% { transform: translateY(0) translateX(0); opacity: 0.08; }
                25% { transform: translateY(-15px) translateX(5px); opacity: 0.15; }
                50% { transform: translateY(-8px) translateX(-3px); opacity: 0.1; }
                75% { transform: translateY(-20px) translateX(8px); opacity: 0.18; }
              }
              @media (prefers-reduced-motion: reduce) {
                .arch-animated { animation: none !important; }
              }
            `}} />

            {/* BG Layer 1 — Perspective grid for depth */}
            <div className="absolute inset-0 overflow-hidden">
              <div className="absolute w-[200%] h-[120%] left-[-50%] top-[20%]" style={{
                backgroundImage: `
                  linear-gradient(rgba(57, 197, 187, 0.04) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(57, 197, 187, 0.025) 1px, transparent 1px)
                `,
                backgroundSize: '60px 60px',
                transform: 'perspective(600px) rotateX(55deg)',
                transformOrigin: 'center top',
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 20%, black 50%, transparent 90%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 20%, black 50%, transparent 90%)',
              }} />
            </div>

            {/* BG Layer 2 — Radial glow pulse */}
            <div className="absolute inset-0 arch-animated" style={{
              background: `
                radial-gradient(ellipse 60% 40% at 30% 20%, rgba(57, 197, 187, 0.06) 0%, transparent 60%),
                radial-gradient(ellipse 50% 35% at 70% 80%, rgba(255, 119, 168, 0.04) 0%, transparent 60%)
              `,
              animation: 'arch-glow-pulse 6s ease-in-out infinite',
            }} />

            {/* BG Layer 3 — Vertical data flow lines */}
            <div className="absolute inset-0 overflow-hidden">
              {[15, 35, 55, 75, 90].map((x, i) => (
                <div key={i} className="absolute arch-animated" style={{
                  left: `${x}%`,
                  top: 0,
                  width: '1px',
                  height: '12%',
                  background: `linear-gradient(to bottom, transparent, ${i % 2 === 0 ? 'rgba(57,197,187,0.15)' : 'rgba(255,119,168,0.12)'}, transparent)`,
                  animation: `arch-dataflow ${5 + i * 0.7}s linear infinite`,
                  animationDelay: `${i * 1.2}s`,
                }} />
              ))}
            </div>

            {/* BG Layer 4 — Floating particles */}
            <div className="absolute inset-0">
              {[
                { x: '10%', y: '15%', s: '+', c: '#39c5bb' },
                { x: '85%', y: '25%', s: '◇', c: '#ff77a8' },
                { x: '20%', y: '70%', s: '○', c: '#00ffe5' },
                { x: '75%', y: '80%', s: '×', c: '#ffcc00' },
                { x: '50%', y: '45%', s: '△', c: '#39c5bb' },
                { x: '92%', y: '55%', s: '+', c: '#ff77a8' },
              ].map((p, i) => (
                <span key={i} className="absolute font-light select-none pointer-events-none arch-animated" style={{
                  left: p.x, top: p.y,
                  fontSize: 10 + (i % 3) * 2,
                  color: p.c,
                  animation: `arch-particle-drift ${7 + i}s ease-in-out infinite`,
                  animationDelay: `${i * 1.1}s`,
                }}>{p.s}</span>
              ))}
            </div>

            {/* BG Layer 5 — Scanline */}
            <div className="absolute left-0 right-0 h-[1px] arch-animated" style={{
              background: 'linear-gradient(90deg, transparent 10%, rgba(57,197,187,0.08) 50%, transparent 90%)',
              animation: 'arch-scan 8s linear infinite',
            }} />

            {/* BG Layer 6 — Vignette for depth */}
            <div className="absolute inset-0 pointer-events-none" style={{
              background: 'radial-gradient(ellipse 80% 70% at 50% 50%, transparent 20%, rgba(10,10,12,0.5) 80%, rgba(10,10,12,0.8) 100%)',
            }} />

            {/* BG Layer 7 — Noise texture */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.015] mix-blend-overlay" style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            }} />

            <div className="relative z-10">
              <h3 className="text-xs font-mono text-[#555560] uppercase tracking-[0.3em] text-center mb-2">
                System Architecture
              </h3>
              <h4 className="text-xl sm:text-2xl font-bold font-display text-white text-center mb-10 uppercase tracking-wider">
                Protocol Stack
              </h4>

              <div className="flex flex-col items-center gap-0">
                {architectureLayers.map((layer, layerIndex) => {
                  const hex = getLayerHex(layer.color);
                  return (
                    <React.Fragment key={layer.name}>
                      {/* Layer */}
                      <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={isInView ? { opacity: 1, y: 0 } : {}}
                        transition={{ duration: 0.5, delay: 0.3 + layerIndex * 0.12 }}
                        className="w-full max-w-2xl"
                      >
                        {/* Layer label */}
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-1.5 h-1.5" style={{ backgroundColor: hex }} />
                          <span className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em]" style={{ color: hex }}>
                            {layer.name}
                          </span>
                          <div className="flex-1 h-px" style={{ backgroundColor: `${hex}15` }} />
                        </div>

                        {/* Nodes grid */}
                        <div className={`grid gap-2 sm:gap-3 ${layer.nodes.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                          {layer.nodes.map((node) => (
                            <div
                              key={node.label}
                              className="group relative bg-[#111114] border p-3 sm:p-4 text-center transition-all duration-300 hover:bg-[#151518]"
                              style={{
                                borderColor: `${hex}25`,
                              }}
                              onMouseEnter={(e) => {
                                (e.currentTarget as HTMLElement).style.borderColor = `${hex}60`;
                                (e.currentTarget as HTMLElement).style.boxShadow = `0 0 20px ${hex}10, inset 0 1px 0 ${hex}15`;
                              }}
                              onMouseLeave={(e) => {
                                (e.currentTarget as HTMLElement).style.borderColor = `${hex}25`;
                                (e.currentTarget as HTMLElement).style.boxShadow = 'none';
                              }}
                            >
                              <div className="text-xs sm:text-sm font-bold font-mono tracking-wide" style={{ color: hex }}>
                                {node.label}
                              </div>
                              <div className="text-[10px] sm:text-xs text-[#555560] mt-1 font-mono">
                                {node.sub}
                              </div>
                            </div>
                          ))}
                        </div>
                      </motion.div>

                      {/* Connector arrow between layers */}
                      {layerIndex < architectureLayers.length - 1 && (
                        <motion.div
                          initial={{ opacity: 0, scaleY: 0 }}
                          animate={isInView ? { opacity: 1, scaleY: 1 } : {}}
                          transition={{ duration: 0.3, delay: 0.4 + layerIndex * 0.12 }}
                          className="flex flex-col items-center py-2"
                        >
                          <div className="w-px h-4" style={{ backgroundColor: `${hex}40` }} />
                          <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent" style={{ borderTopColor: `${hex}60` }} />
                        </motion.div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Bottom status bar */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={isInView ? { opacity: 1 } : {}}
                transition={{ duration: 0.5, delay: 1 }}
                className="flex items-center justify-center gap-3 mt-8 pt-6 border-t border-[#2a2a30]"
              >
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-[#39c5bb] animate-pulse" />
                  <span className="text-[10px] sm:text-xs font-mono text-[#555560] uppercase tracking-wider">
                    End-to-end encrypted
                  </span>
                </div>
                <span className="text-[#2a2a30]">|</span>
                <div className="flex items-center gap-2">
                  <Zap size={12} className="text-[#39c5bb]" />
                  <span className="text-[10px] sm:text-xs font-mono text-[#555560] uppercase tracking-wider">
                    From client to settlement
                  </span>
                </div>
              </motion.div>
            </div>
          </div>
        </motion.div>

        {/* Tech Grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {technologies.map((tech) => {
            const colors = getColorClasses(tech.color);
            return (
              <motion.div
                key={tech.category}
                variants={itemVariants}
                className="card-hover p-6"
              >
                <div
                  className={`w-12 h-12 rounded-xl ${colors.bg} ${colors.text} flex items-center justify-center mb-4`}
                >
                  <tech.icon size={24} />
                </div>
                <h3 className="text-lg font-bold font-display text-white mb-4">
                  {tech.category}
                </h3>
                <ul className="space-y-3">
                  {tech.items.map((item) => (
                    <li key={item.name} className="flex flex-col">
                      <span className={`font-medium ${colors.text}`}>{item.name}</span>
                      <span className="text-p01-text-dim text-sm">
                        {item.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Security Badges */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.6 }}
          className="mt-16 flex flex-wrap items-center justify-center gap-6"
        >
          <div className="flex items-center gap-2 px-4 py-2 bg-p01-surface rounded-lg border border-p01-border">
            <Lock size={18} className="text-p01-cyan" />
            <span className="text-sm text-p01-text-muted font-mono">Self-Custody</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 bg-p01-surface rounded-lg border border-p01-border">
            <Shield size={18} className="text-p01-pink" />
            <span className="text-sm text-p01-text-muted font-mono">ZK-Powered</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 bg-p01-surface rounded-lg border border-p01-border">
            <Zap size={18} className="text-p01-bright-cyan" />
            <span className="text-sm text-p01-text-muted font-mono">Solana Native</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
