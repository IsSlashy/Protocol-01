"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
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
    name: "Application Layer",
    description: "Wallet, Streams, Agent",
    color: "p01-cyan",
  },
  {
    name: "Privacy Layer",
    description: "ZK Proofs, Stealth Addresses, Encryption",
    color: "p01-pink",
  },
  {
    name: "Execution Layer",
    description: "TEE Compute, Private Relayers",
    color: "p01-bright-cyan",
  },
  {
    name: "Settlement Layer",
    description: "Solana, SPL Tokens, Jupiter",
    color: "p01-yellow",
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

  const getLayerStyles = (color: string) => {
    const styles: Record<string, { bg: string; border: string; dot: string }> = {
      "p01-cyan": {
        bg: "bg-p01-cyan/5",
        border: "border-p01-cyan/30",
        dot: "bg-p01-cyan",
      },
      "p01-pink": {
        bg: "bg-p01-pink/5",
        border: "border-p01-pink/30",
        dot: "bg-p01-pink",
      },
      "p01-bright-cyan": {
        bg: "bg-p01-bright-cyan/5",
        border: "border-p01-bright-cyan/30",
        dot: "bg-p01-bright-cyan",
      },
      "p01-yellow": {
        bg: "bg-p01-yellow/5",
        border: "border-p01-yellow/30",
        dot: "bg-p01-yellow",
      },
    };
    return styles[color] || styles["p01-cyan"];
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
          <div className="card p-8">
            <h3 className="text-xl font-bold font-display text-white text-center mb-8 uppercase tracking-wider">
              Protocol Architecture
            </h3>
            <div className="space-y-4">
              {architectureLayers.map((layer, index) => {
                const styles = getLayerStyles(layer.color);
                return (
                  <motion.div
                    key={layer.name}
                    initial={{ opacity: 0, x: -20 }}
                    animate={isInView ? { opacity: 1, x: 0 } : {}}
                    transition={{ duration: 0.5, delay: 0.3 + index * 0.1 }}
                    className={`flex items-center gap-6 p-4 rounded-xl border ${styles.border} ${styles.bg}`}
                  >
                    <div className={`w-3 h-3 rounded-full ${styles.dot}`} />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white font-display">{layer.name}</span>
                        <span className="text-p01-text-muted text-sm font-mono">
                          {layer.description}
                        </span>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
            <div className="flex items-center justify-center mt-6 text-p01-text-dim text-sm font-mono">
              <Zap size={16} className="mr-2 text-p01-cyan" />
              End-to-end privacy from application to settlement
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
            <Code size={18} className="text-p01-cyan" />
            <span className="text-sm text-p01-text-muted font-mono">Open Source</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 bg-p01-surface rounded-lg border border-p01-border">
            <Shield size={18} className="text-p01-pink" />
            <span className="text-sm text-p01-text-muted font-mono">Audited by Trail of Bits</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 bg-p01-surface rounded-lg border border-p01-border">
            <Lock size={18} className="text-p01-bright-cyan" />
            <span className="text-sm text-p01-text-muted font-mono">Formally Verified</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
