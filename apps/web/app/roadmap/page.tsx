"use client";

import React from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { useT } from "@/i18n";
import {
  ArrowLeft,
  CheckCircle,
  Clock,
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
  Network,
  FileText,
  TestTube,
  Server,
  Download,
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
  shipped: "roadmap.shipped",
  next: "roadmap.inProgress",
  future: "roadmap.planned",
};

const roadmap: RoadmapPhase[] = [
  {
    id: "current",
    status: "shipped",
    title: "roadmap.current",
    subtitle: "roadmap.currentSub",
    items: [
      {
        title: "Stealth Addresses (ECDH)",
        description:
          "One-time addresses for every transaction using Elliptic Curve Diffie-Hellman key exchange. Recipients receive funds without revealing their public address.",
        icon: <Eye className="w-5 h-5" />,
      },
      {
        title: "ZK Shielded Pool (Groth16 + STARK)",
        description:
          "Dual proof system: 7 Groth16 circuits (BN254, up to 12,222 constraints) + 6 STARK AIRs (Winterfell/Goldilocks, quantum-resistant). All circuits compiled with trusted setup.",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "On-Chain Relayer + Quantum Vault",
        description:
          "Fully on-chain trustless relayer (no backend server). Quantum vault with WOTS+ signatures, hash-timelock, and commit-then-reveal for quantum-safe withdrawals.",
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
        title: "Mobile App + Browser Extension",
        description:
          "Full-featured Solana wallet available as a React Native mobile app and Chrome browser extension with dApp connectivity.",
        icon: <Wallet className="w-5 h-5" />,
      },
      {
        title: "AI Agent",
        description:
          "On-device AI agent that manages private finances through natural language. Shield, transfer, and manage subscriptions by chatting — no data leaves your phone.",
        icon: <Bot className="w-5 h-5" />,
      },
      {
        title: "Instant ZK Operations",
        description:
          "Shield and unshield in ~3 seconds total via filledSubtrees optimization. Local-only proving via snarkjs (WebView on mobile) — spending key never leaves device.",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "On-Chain Smart Contracts",
        description:
          "13 Anchor programs deployed to devnet (118+ instructions). Trustless, permissionless privacy — no server required for core operations.",
        icon: <Code className="w-5 h-5" />,
      },
      {
        title: "Advanced Privacy (Decoy Transactions + Noise)",
        description:
          "Amount noise (\u00b120% variation) and timing noise (\u00b124h delay) to defeat chain analysis heuristics. Multiple privacy levels from standard to maximum.",
        icon: <Lock className="w-5 h-5" />,
      },
      {
        title: "Denominated Pools",
        description:
          "Tornado Cash-style fixed-denomination privacy pools for SOL and USDC. Epoch-based maturity, PDA-per-nullifier, 32K notes per pool. P2P note sharing via BLE and NFC.",
        icon: <Layers className="w-5 h-5" />,
      },
      {
        title: "Confidential Balances (zkSPL)",
        description:
          "Account-model confidential tokens using Poseidon hash commitments. Quantum-resistant privacy with balance proofs. Full SDK, on-chain program, and mobile/extension integration.",
        icon: <Lock className="w-5 h-5" />,
      },
      {
        title: "Subscription Vaults",
        description:
          "On-chain recurring payment vaults with configurable intervals. Normal and ZK-private subscriber modes. Auto-pause on insufficient funds, retailer claim periods.",
        icon: <Radio className="w-5 h-5" />,
      },
      {
        title: "P2P Note Sharing (BLE + NFC)",
        description:
          "Share denominated pool notes between devices using BLE (ECDH encrypted) or NFC (HCE with PIN-derived encryption). Anti-MITM fingerprint verification.",
        icon: <Wallet className="w-5 h-5" />,
      },
      {
        title: "STARK Migration (On-Chain Verifier)",
        description:
          "Custom FRI verifier on-chain (no Winterfell dependency). 6 STARK AIRs with compact proofs (9-15KB). Mobile WASM prover (82KB). ~889K CU verification. Quantum-resistant by default.",
        icon: <Cpu className="w-5 h-5" />,
      },
      {
        title: "Arcium MPC Integration (9 Circuits)",
        description:
          "Multi-party computation via Arcium Cerberus protocol. 6 use cases: confidential relay, anonymous registry, hidden nullifier, balance audit, stealth scan, private vote. 1-of-N honest node.",
        icon: <Network className="w-5 h-5" />,
      },
      {
        title: "On-Chain Registry (EIP-5564)",
        description:
          "Stealth meta-address directory on Solana. Register/update spending + viewing public keys, optional ML-KEM-768 pubkey for quantum-resistant stealth v2.",
        icon: <FileText className="w-5 h-5" />,
      },
      {
        title: "Security Hardening",
        description:
          "Spending key never leaves device. PIN with SHA-256 + progressive lockout. SecureStore for all secrets. Clipboard auto-clear (60s). App switcher blur. android:allowBackup=false.",
        icon: <Lock className="w-5 h-5" />,
      },
      {
        title: "RPC Fallback Infrastructure",
        description:
          "@p01/rpc-config package with priority-based connection manager. QuickNode \u2192 Helius \u2192 public fallback chain. Auto-switch on 429/502/503 errors. URL sanitization.",
        icon: <Server className="w-5 h-5" />,
      },
      {
        title: "370+ Automated Tests",
        description:
          "Comprehensive test suite: 106 program stress tests, 124 crypto SDK tests, 140 mobile service tests, E2E flows, 69 Rust STARK tests. All passing.",
        icon: <TestTube className="w-5 h-5" />,
      },
      {
        title: "Privacy Relay (Tor Routing)",
        description:
          "3-tier privacy relay deployed on Railway. Client-side header stripping + jitter, server-side Tor SOCKS5 routing with circuit rotation every 10min. 13K+ requests tested, 100% Tor-routed.",
        icon: <Globe className="w-5 h-5" />,
      },
      {
        title: "Auto-Shield Receive",
        description:
          "One-time stealth addresses on Receive screen. Incoming funds auto-detected and shielded into the pool. Main wallet never exposed to senders.",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "Stealth Meta-Addresses (P01-to-P01)",
        description:
          "Persistent st:01/st:02 meta-addresses for full P01-to-P01 privacy. Sender auto-derives one-time stealth destination. Both sides hidden on-chain.",
        icon: <Eye className="w-5 h-5" />,
      },
      {
        title: "Multi-Hop Privacy Router",
        description:
          "5 privacy levels (1-14+ hops). Autonomous runner with Android foreground service. Note locking, consent popup, route progress tracking, timing jitter.",
        icon: <Zap className="w-5 h-5" />,
      },
      {
        title: "Cross-Pool Note Splitting",
        description:
          "Split high-denomination notes into multiple lower-denomination notes across pools. ZK proof (10K constraints), on-chain instruction deployed, mobile SDK ready.",
        icon: <Layers className="w-5 h-5" />,
      },
      {
        title: "AI Agent — 56 Tools",
        description:
          "Expanded from 10 to 56 tools: wallet ops, privacy actions, Solana queries, DeFi analytics, staking, NFTs, alerts, conversions, device features. On-device LLM.",
        icon: <Bot className="w-5 h-5" />,
      },
      {
        title: "0 TypeScript Errors",
        description:
          "Full codebase audit: 56 screens, 80+ components, all using P01 design system. Zero TypeScript errors. Settings components fixed to use theme constants.",
        icon: <Code className="w-5 h-5" />,
      },
      {
        title: "Full Stealth Unshield (v0.9.5)",
        description:
          "User wallet never appears on-chain during unshield. Ephemeral stealth signer pays fees, ECDH one-time recipient receives from pool. Delayed auto-sweep with timing jitter. MPC nullifier fix (4\u00d7u64 chunks).",
        icon: <Eye className="w-5 h-5" />,
      },
      {
        title: "i18n (EN/FR/JA)",
        description:
          "Full internationalization across all mobile screens and web pages. English, French, and Japanese. Language auto-detected from device settings.",
        icon: <Globe className="w-5 h-5" />,
      },
    ],
  },
  {
    id: "next",
    status: "next",
    title: "roadmap.next",
    subtitle: "roadmap.nextSub",
    items: [
      {
        title: "P-01 Internal Network Mapping",
        description:
          "Map internal transaction flows to optimize privacy routing and reduce on-chain fingerprinting across the P-01 network.",
        icon: <Globe className="w-5 h-5" />,
      },
      {
        title: "Fiat On-Ramp (Buy Crypto)",
        description:
          "Buy SOL, USDC, and USDT with credit card or bank transfer. Direct fiat-to-crypto without leaving the app.",
        icon: <CreditCard className="w-5 h-5" />,
      },
      {
        title: "External Security Audit",
        description:
          "Comprehensive audit of all 14 programs, 7 Groth16 circuits, 6 STARK AIRs, and 8 SDKs by OtterSec, Neodyme, or Trail of Bits before mainnet deployment.",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "Trusted Setup Ceremony",
        description:
          "Multi-party Groth16 trusted setup with 3+ contributors (currently 1). Powers of Tau + beacon finalization for all 7 circuits.",
        icon: <Lock className="w-5 h-5" />,
      },
      {
        title: "iOS Build & Testing",
        description:
          "iOS build and testing — currently only Android is verified. Requires CocoaPods setup, code signing, and TestFlight deployment.",
        icon: <Wallet className="w-5 h-5" />,
      },
      {
        title: "DeFi Composability",
        description:
          "Enable confidential balances and shielded pools to interact with Solana DeFi protocols. Composable privacy for lending, swapping, and staking.",
        icon: <Layers className="w-5 h-5" />,
      },
    ],
  },
  {
    id: "future",
    status: "future",
    title: "roadmap.future",
    subtitle: "roadmap.futureSub",
    items: [
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
  const t = useT();
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
              <span className="hidden sm:inline font-mono">{t('nav.back')}</span>
            </Link>
            <div className="h-6 w-px" style={{ backgroundColor: THEME.borderColor }} />
            <div className="flex items-center gap-3">
              <img src="/icon.png" alt="Protocol 01" className="w-8 h-8 rounded-lg" />
              <h1 className="text-lg font-bold font-display tracking-wider">{t('roadmap.title')}</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="text-xs font-mono uppercase tracking-wider hover:text-white transition-colors"
              style={{ color: THEME.mutedColor }}
            >
              {t('nav.docs')}
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
            {t('roadmap.heroSubtitle')}
          </p>
          <h2 className="text-3xl sm:text-4xl font-bold font-display tracking-wide mb-4">
            {t('roadmap.heroTitle')}
          </h2>
          <p className="text-base max-w-2xl mx-auto" style={{ color: THEME.mutedColor }}>
            {t('roadmap.heroDesc')}
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
                    {t(PHASE_LABELS[phase.status])}
                  </span>
                  <div>
                    <h3 className="text-xl font-bold font-display tracking-wide">
                      {t(phase.title)}
                    </h3>
                    <p className="text-sm" style={{ color: THEME.dimColor }}>
                      {t(phase.subtitle)}
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
                      className={`rounded-2xl border p-5 transition-colors bg-white/[0.02] backdrop-blur-sm border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.12]`}
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
            {t('roadmap.buildWithUs')}
          </p>
          <h3 className="text-2xl font-bold font-display tracking-wide mb-4">
            {t('roadmap.shapeFuture')}
          </h3>
          <p className="text-sm mb-8 max-w-md mx-auto" style={{ color: THEME.mutedColor }}>
            {t('roadmap.joinCommunity')}
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <a
              href="https://github.com/IsSlashy/Protocol-01-releases"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-2.5 text-sm font-bold font-display tracking-wider rounded-2xl transition-colors"
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
              className="px-6 py-2.5 text-sm font-bold font-display tracking-wider rounded-2xl border transition-colors text-[#888892] hover:text-white bg-white/[0.02] backdrop-blur-sm border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.12]"
            >
              Discord
            </a>
          </div>
        </div>
      </section>

      {/* Design Document */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex justify-center">
        <a
          href="/protocol-01-design-document.pdf"
          download
          className="group flex items-center gap-3 px-5 py-2.5 border rounded-2xl transition-all duration-300 bg-white/[0.02] backdrop-blur-sm border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.12]"
        >
          <FileText className="w-4 h-4 transition-colors" style={{ color: THEME.dimColor }} />
          <span className="text-sm" style={{ color: THEME.mutedColor }}>
            Design & Architecture Document
          </span>
          <span className="text-xs font-mono" style={{ color: THEME.dimColor }}>PDF</span>
          <Download className="w-3.5 h-3.5 transition-colors" style={{ color: THEME.dimColor }} />
        </a>
      </div>
      <p className="text-center text-[10px] font-mono tracking-wider pb-4" style={{ color: THEME.dimColor }}>
        PROGRESSIVELY UPDATED · LAST REVISION MARCH 2026
      </p>

      {/* Footer */}
      <footer className="border-t py-8 px-4" style={{ borderColor: THEME.borderColor }}>
        <div className="max-w-5xl mx-auto text-center space-y-3">
          <div className="flex items-center justify-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.2em] px-2 py-0.5 border rounded"
              style={{ borderColor: THEME.primaryColor + "50", color: THEME.primaryColor }}>
              Beta
            </span>
            <span style={{ color: THEME.borderColor }}>·</span>
            <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: THEME.dimColor }}>
              Devnet Only
            </span>
          </div>
          <p className="text-sm font-mono" style={{ color: THEME.dimColor }}>
            &copy; {new Date().getFullYear()} PROTOCOL 01 | Built from scratch for privacy
          </p>
          <p className="text-[10px] font-mono" style={{ color: THEME.dimColor + "80" }}>
            This software is in active development. Not audited. Use at your own risk.
          </p>
        </div>
      </footer>

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
