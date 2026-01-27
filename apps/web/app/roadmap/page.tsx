"use client";

import React from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle,
  Clock,
  Sparkles,
  Shield,
  Zap,
  Code,
  Layers,
  Cpu,
  Eye,
  Wallet,
  Globe,
  Terminal,
  Bot,
  Lock,
  Radio,
  CreditCard,
} from "lucide-react";

// ============ P-01 Theme Constants ============
const THEME = {
  primaryColor: "#39c5bb",
  primaryBright: "#00ffe5",
  secondaryColor: "#ff77a8",
  pinkHot: "#ff2d7a",
  backgroundColor: "#0a0a0c",
  surfaceColor: "#151518",
  elevatedColor: "#1f1f24",
  textColor: "#ffffff",
  mutedColor: "#888892",
  dimColor: "#555560",
  borderColor: "#2a2a30",
};

type PhaseStatus = "shipped" | "next" | "future";

interface RoadmapItem {
  title: string;
  description: string;
  icon: React.ReactNode;
}

interface RoadmapPhase {
  id: string;
  status: PhaseStatus;
  title: string;
  subtitle: string;
  items: RoadmapItem[];
}

const PHASE_STYLES: Record<PhaseStatus, { badge: string; badgeBg: string; borderColor: string; glowColor: string }> = {
  shipped: {
    badge: "text-[#39c5bb]",
    badgeBg: "bg-[#39c5bb]/15 border-[#39c5bb]/30",
    borderColor: "border-[#39c5bb]/20",
    glowColor: "#39c5bb",
  },
  next: {
    badge: "text-[#ff77a8]",
    badgeBg: "bg-[#ff77a8]/15 border-[#ff77a8]/30",
    borderColor: "border-[#ff77a8]/20",
    glowColor: "#ff77a8",
  },
  future: {
    badge: "text-[#555560]",
    badgeBg: "bg-[#555560]/15 border-[#555560]/30",
    borderColor: "border-[#2a2a30]",
    glowColor: "#555560",
  },
};

const PHASE_LABELS: Record<PhaseStatus, string> = {
  shipped: "SHIPPED",
  next: "IN PROGRESS",
  future: "PLANNED",
};

const roadmap: RoadmapPhase[] = [
  {
    id: "current",
    status: "shipped",
    title: "Current",
    subtitle: "Live in production",
    items: [
      {
        title: "Stealth Addresses (ECDH)",
        description:
          "One-time addresses for every transaction using Elliptic Curve Diffie-Hellman key exchange. Recipients receive funds without revealing their public address.",
        icon: <Eye className="w-5 h-5" />,
      },
      {
        title: "ZK Shielded Pool",
        description:
          "Groth16 zero-knowledge proofs for private transfers. Amounts and participants are hidden on-chain using Solana's native alt_bn128 syscalls.",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "Backend Relayer",
        description:
          "Relayer service that submits transactions on behalf of users, breaking the link between sender identity and on-chain activity.",
        icon: <Radio className="w-5 h-5" />,
      },
      {
        title: "Payment Streams",
        description:
          "Real-time token streaming for subscriptions and recurring payments. Create, pause, and cancel streams with per-second settlement.",
        icon: <Zap className="w-5 h-5" />,
      },
      {
        title: "Jupiter Swap Integration",
        description:
          "In-app token swaps powered by Jupiter aggregator with best-price routing across Solana DEXes.",
        icon: <Layers className="w-5 h-5" />,
      },
      {
        title: "Fiat On-Ramp (Buy Crypto)",
        description:
          "Buy SOL, USDC, and USDT with credit card or bank transfer via MoonPay and Ramp Network integration.",
        icon: <CreditCard className="w-5 h-5" />,
      },
      {
        title: "Mobile App + Browser Extension",
        description:
          "Full-featured Solana wallet available as a React Native mobile app and Chrome browser extension with dApp connectivity.",
        icon: <Wallet className="w-5 h-5" />,
      },
    ],
  },
  {
    id: "next",
    status: "next",
    title: "Next",
    subtitle: "Actively building",
    items: [
      {
        title: "On-Chain Smart Contracts",
        description:
          "Replace the backend relayer with fully on-chain Solana programs. Trustless, permissionless privacy — no server required.",
        icon: <Code className="w-5 h-5" />,
      },
      {
        title: "P-01 Internal Network Mapping",
        description:
          "Map internal transaction flows to optimize privacy routing and reduce on-chain fingerprinting across the P-01 network.",
        icon: <Globe className="w-5 h-5" />,
      },
      {
        title: "Advanced Privacy (Decoy Transactions + Noise)",
        description:
          "Configurable decoy transactions and timing noise to defeat chain analysis heuristics. Multiple privacy levels from standard to maximum.",
        icon: <Lock className="w-5 h-5" />,
      },
    ],
  },
  {
    id: "future",
    status: "future",
    title: "Future",
    subtitle: "On the horizon",
    items: [
      {
        title: "AI Agent Integration",
        description:
          "Autonomous AI agent that can execute transactions, manage streams, and optimize privacy settings on your behalf with confirmation controls.",
        icon: <Bot className="w-5 h-5" />,
      },
      {
        title: "Desktop App",
        description:
          "Native desktop application for macOS, Windows, and Linux with full wallet functionality and hardware wallet support.",
        icon: <Cpu className="w-5 h-5" />,
      },
      {
        title: "CLI Tool",
        description:
          "Command-line interface for developers and power users. Script transactions, automate streams, and integrate P-01 into existing workflows.",
        icon: <Terminal className="w-5 h-5" />,
      },
    ],
  },
];

export default function RoadmapPage() {
  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: THEME.backgroundColor, color: THEME.textColor }}
    >
      {/* Sticky Header */}
      <header
        className="sticky top-0 z-50 backdrop-blur-lg border-b"
        style={{
          backgroundColor: THEME.backgroundColor + "cc",
          borderColor: THEME.borderColor,
        }}
      >
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm hover:text-white transition-colors"
              style={{ color: THEME.mutedColor }}
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline font-mono">Back</span>
            </Link>
            <div className="h-6 w-px" style={{ backgroundColor: THEME.borderColor }} />
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 flex items-center justify-center border"
                style={{
                  backgroundColor: THEME.primaryColor + "15",
                  borderColor: THEME.primaryColor + "40",
                }}
              >
                <span
                  className="font-mono font-bold text-xs"
                  style={{ color: THEME.primaryColor }}
                >
                  P01
                </span>
              </div>
              <h1 className="text-lg font-bold font-display tracking-wider">ROADMAP</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="text-xs font-mono uppercase tracking-wider hover:text-white transition-colors"
              style={{ color: THEME.mutedColor }}
            >
              Docs
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <p
            className="text-xs font-mono tracking-[0.2em] mb-4"
            style={{ color: THEME.primaryColor }}
          >
            {"> PROTOCOL 01 // DEVELOPMENT ROADMAP"}
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold font-display tracking-wide mb-4">
            Building Private Finance
          </h2>
          <p className="text-base max-w-2xl mx-auto" style={{ color: THEME.mutedColor }}>
            Our path from stealth addresses and ZK proofs to fully on-chain
            privacy with no backend required.
          </p>
        </motion.div>
      </section>

      {/* Timeline */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pb-24">
        <div className="space-y-16">
          {roadmap.map((phase, phaseIndex) => {
            const styles = PHASE_STYLES[phase.status];
            return (
              <motion.div
                key={phase.id}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: phaseIndex * 0.15 }}
              >
                {/* Phase Header */}
                <div className="flex items-center gap-4 mb-8">
                  <span
                    className={`px-3 py-1 text-[11px] font-mono font-bold tracking-wider border rounded ${styles.badge} ${styles.badgeBg}`}
                  >
                    {PHASE_LABELS[phase.status]}
                  </span>
                  <div>
                    <h3 className="text-xl font-bold font-display tracking-wide">
                      {phase.title}
                    </h3>
                    <p className="text-sm" style={{ color: THEME.dimColor }}>
                      {phase.subtitle}
                    </p>
                  </div>
                </div>

                {/* Items Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {phase.items.map((item, itemIndex) => (
                    <motion.div
                      key={item.title}
                      initial={{ opacity: 0, y: 15 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.4,
                        delay: phaseIndex * 0.15 + itemIndex * 0.06,
                      }}
                      className={`rounded-xl border p-5 transition-colors hover:border-opacity-50 ${styles.borderColor}`}
                      style={{ backgroundColor: THEME.surfaceColor }}
                    >
                      <div className="flex items-start gap-4">
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{
                            backgroundColor: styles.glowColor + "15",
                            color: styles.glowColor,
                          }}
                        >
                          {item.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h4 className="font-semibold text-sm">{item.title}</h4>
                            {phase.status === "shipped" && (
                              <CheckCircle
                                className="w-4 h-4 flex-shrink-0"
                                style={{ color: THEME.primaryColor }}
                              />
                            )}
                            {phase.status === "next" && (
                              <Clock
                                className="w-4 h-4 flex-shrink-0"
                                style={{ color: THEME.secondaryColor }}
                              />
                            )}
                          </div>
                          <p
                            className="text-xs leading-relaxed"
                            style={{ color: THEME.mutedColor }}
                          >
                            {item.description}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* CTA */}
      <section
        className="border-t"
        style={{ borderColor: THEME.borderColor }}
      >
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <p
            className="text-xs font-mono tracking-[0.2em] mb-4"
            style={{ color: THEME.primaryColor }}
          >
            {"> BUILD WITH US"}
          </p>
          <h3 className="text-2xl font-bold font-display tracking-wide mb-4">
            Shape the Future of Privacy
          </h3>
          <p className="text-sm mb-8 max-w-md mx-auto" style={{ color: THEME.mutedColor }}>
            P-01 is open source. Contribute, suggest features, or follow our progress.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <a
              href="https://github.com/SectorCT/Protocol01"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-2.5 text-sm font-bold font-display tracking-wider rounded-lg transition-colors"
              style={{
                backgroundColor: THEME.primaryColor,
                color: THEME.backgroundColor,
              }}
            >
              GitHub
            </a>
            <a
              href="https://discord.gg/KfmhPFAHNH"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-2.5 text-sm font-bold font-display tracking-wider rounded-lg border transition-colors hover:text-white"
              style={{
                borderColor: THEME.borderColor,
                color: THEME.mutedColor,
              }}
            >
              Discord
            </a>
          </div>
        </div>
      </section>

      {/* Bottom glow line */}
      <div
        className="h-px"
        style={{
          background: `linear-gradient(to right, transparent, ${THEME.primaryColor}80, transparent)`,
        }}
      />
    </div>
  );
}
