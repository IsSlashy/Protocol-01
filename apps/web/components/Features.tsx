"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import Link from "next/link";
import {
  Wallet, Radio, ArrowLeftRight, Bot, Shield, Layers,
  Lock, Calendar, Eye, Fingerprint, Globe, Zap,
} from "lucide-react";

const features = [
  {
    icon: Shield,
    name: "Auto-Shield",
    desc: "Funds auto-shield on receive. Your main wallet is never exposed.",
    color: "#39c5bb",
  },
  {
    icon: Wallet,
    name: "Stealth Transfers",
    desc: "One-time addresses for every transaction. Completely unlinkable.",
    color: "#ff2d7a",
  },
  {
    icon: Layers,
    name: "Privacy Pools",
    desc: "Fixed-denomination pools (0.1-100 SOL) break the deposit-withdrawal link.",
    color: "#39c5bb",
  },
  {
    icon: Radio,
    name: "Private Subscriptions",
    desc: "Recurring payments with zero traces. Pause, resume, cancel anytime.",
    color: "#00ffe5",
  },
  {
    icon: ArrowLeftRight,
    name: "Token Swap",
    desc: "Swap any Solana token via Jupiter. Best rates, low slippage.",
    color: "#39c5bb",
  },
  {
    icon: Bot,
    name: "AI Agent",
    desc: "56 tools. On-device LLM. Manage your privacy wallet with natural language.",
    color: "#ffcc00",
  },
  {
    icon: Lock,
    name: "ZK Proofs",
    desc: "Groth16 + STARK proofs. Quantum-resistant. All generated client-side.",
    color: "#ff2d7a",
  },
  {
    icon: Globe,
    name: "Tor Relay",
    desc: "All RPC calls routed through Tor. Your IP is never visible to anyone.",
    color: "#00ffe5",
  },
  {
    icon: Eye,
    name: "Confidential Balances",
    desc: "zkSPL — account-model tokens with hidden balances via Poseidon commitments.",
    color: "#39c5bb",
  },
  {
    icon: Fingerprint,
    name: "Stealth Meta-Addresses",
    desc: "Share one address forever. Senders derive fresh one-time addresses from it.",
    color: "#ff2d7a",
  },
  {
    icon: Calendar,
    name: "Subscription Vaults",
    desc: "On-chain escrow with auto-pause, ZK subscriber verification, retailer claims.",
    color: "#ffcc00",
  },
  {
    icon: Zap,
    name: "Multi-Hop Routing",
    desc: "Up to 20 splits, 14 hops, timing jitter. Paranoid-level privacy.",
    color: "#00ffe5",
  },
];

export default function Features() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <section className="section relative overflow-hidden py-24" ref={ref}>
      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <span className="badge-cyan mb-4">Features</span>
          <h2 className="section-title">
            Everything you need.{" "}
            <span className="text-[#39c5bb]">Nothing they can trace.</span>
          </h2>
          <p className="section-subtitle">
            12 privacy modules working together. No KYC. No traces. Self-custody.
          </p>
        </motion.div>

        {/* Compact Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((feature, i) => (
            <motion.div
              key={feature.name}
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              className="group card p-6 hover:border-[var(--accent)]/30 transition-all duration-300"
              style={{ "--accent": feature.color } as React.CSSProperties}
            >
              <div className="flex items-start gap-4">
                <div
                  className="w-10 h-10 flex items-center justify-center shrink-0 border"
                  style={{
                    backgroundColor: `${feature.color}10`,
                    borderColor: `${feature.color}30`,
                    color: feature.color,
                  }}
                >
                  <feature.icon size={20} />
                </div>
                <div>
                  <h3 className="text-white font-bold font-display text-base mb-1">
                    {feature.name}
                  </h3>
                  <p className="text-[#888892] text-sm leading-relaxed">
                    {feature.desc}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Bottom CTA */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ duration: 0.5, delay: 0.6 }}
          className="mt-12 text-center space-y-4"
        >
          <div className="inline-flex items-center gap-4 px-6 py-3 bg-[#151518] border border-[#2a2a30]">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-[#39c5bb] animate-pulse" />
              <span className="text-[#39c5bb] text-sm font-mono">DEVNET</span>
            </div>
            <span className="text-[#555560]">|</span>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-[#ff2d7a]" />
              <span className="text-[#888892] text-sm font-mono">MAINNET</span>
            </div>
          </div>
          <div>
            <Link
              href="/docs"
              className="text-[#39c5bb] text-sm font-mono hover:underline"
            >
              Read the full technical documentation →
            </Link>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
