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
        title: "roadmap.items.stealthAddresses.title",
        description: "roadmap.items.stealthAddresses.desc",
        icon: <Eye className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.zkShieldedPool.title",
        description: "roadmap.items.zkShieldedPool.desc",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.onChainRelayer.title",
        description: "roadmap.items.onChainRelayer.desc",
        icon: <Radio className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.paymentStreams.title",
        description: "roadmap.items.paymentStreams.desc",
        icon: <Zap className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.jupiterSwap.title",
        description: "roadmap.items.jupiterSwap.desc",
        icon: <Layers className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.mobileApp.title",
        description: "roadmap.items.mobileApp.desc",
        icon: <Wallet className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.aiAgent.title",
        description: "roadmap.items.aiAgent.desc",
        icon: <Bot className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.instantZk.title",
        description: "roadmap.items.instantZk.desc",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.onChainContracts.title",
        description: "roadmap.items.onChainContracts.desc",
        icon: <Code className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.advancedPrivacy.title",
        description: "roadmap.items.advancedPrivacy.desc",
        icon: <Lock className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.denominatedPools.title",
        description: "roadmap.items.denominatedPools.desc",
        icon: <Layers className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.confidentialBalances.title",
        description: "roadmap.items.confidentialBalances.desc",
        icon: <Lock className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.subscriptionVaults.title",
        description: "roadmap.items.subscriptionVaults.desc",
        icon: <Radio className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.p2pNoteSharing.title",
        description: "roadmap.items.p2pNoteSharing.desc",
        icon: <Wallet className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.starkMigration.title",
        description: "roadmap.items.starkMigration.desc",
        icon: <Cpu className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.arciumMpc.title",
        description: "roadmap.items.arciumMpc.desc",
        icon: <Network className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.onChainRegistry.title",
        description: "roadmap.items.onChainRegistry.desc",
        icon: <FileText className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.securityHardening.title",
        description: "roadmap.items.securityHardening.desc",
        icon: <Lock className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.rpcFallback.title",
        description: "roadmap.items.rpcFallback.desc",
        icon: <Server className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.automatedTests.title",
        description: "roadmap.items.automatedTests.desc",
        icon: <TestTube className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.autoShieldReceive.title",
        description: "roadmap.items.autoShieldReceive.desc",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.stealthMetaAddresses.title",
        description: "roadmap.items.stealthMetaAddresses.desc",
        icon: <Eye className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.multiHopRouter.title",
        description: "roadmap.items.multiHopRouter.desc",
        icon: <Zap className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.crossPoolSplitting.title",
        description: "roadmap.items.crossPoolSplitting.desc",
        icon: <Layers className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.aiAgent56Tools.title",
        description: "roadmap.items.aiAgent56Tools.desc",
        icon: <Bot className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.zeroTsErrors.title",
        description: "roadmap.items.zeroTsErrors.desc",
        icon: <Code className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.fullStealthUnshield.title",
        description: "roadmap.items.fullStealthUnshield.desc",
        icon: <Eye className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.i18n.title",
        description: "roadmap.items.i18n.desc",
        icon: <Globe className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.stealthAirdrops.title",
        description: "roadmap.items.stealthAirdrops.desc",
        icon: <Zap className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.complianceZk.title",
        description: "roadmap.items.complianceZk.desc",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.privacySdkNpm.title",
        description: "roadmap.items.privacySdkNpm.desc",
        icon: <Code className="w-5 h-5" />,
      },
      // ── v0.9.9 Frost release (2026-04-23) ─────────────────────
      {
        title: "roadmap.items.instantUnshield.title",
        description: "roadmap.items.instantUnshield.desc",
        icon: <Zap className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.perWalletNotes.title",
        description: "roadmap.items.perWalletNotes.desc",
        icon: <Wallet className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.deterministicStealth.title",
        description: "roadmap.items.deterministicStealth.desc",
        icon: <Eye className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.poolV2Migration.title",
        description: "roadmap.items.poolV2Migration.desc",
        icon: <Layers className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.multiLayoutDecoder.title",
        description: "roadmap.items.multiLayoutDecoder.desc",
        icon: <Code className="w-5 h-5" />,
      },
      // ── Ecosystem / product surface ───────────────────────────
      {
        title: "roadmap.items.mugenExchange.title",
        description: "roadmap.items.mugenExchange.desc",
        icon: <CreditCard className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.colosseumFrontier.title",
        description: "roadmap.items.colosseumFrontier.desc",
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
        title: "roadmap.items.networkMapping.title",
        description: "roadmap.items.networkMapping.desc",
        icon: <Globe className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.fiatOnRamp.title",
        description: "roadmap.items.fiatOnRamp.desc",
        icon: <CreditCard className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.securityAudit.title",
        description: "roadmap.items.securityAudit.desc",
        icon: <Shield className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.leafInsertedCanonical.title",
        description: "roadmap.items.leafInsertedCanonical.desc",
        icon: <Code className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.mainnetLaunch.title",
        description: "roadmap.items.mainnetLaunch.desc",
        icon: <Zap className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.iosBuild.title",
        description: "roadmap.items.iosBuild.desc",
        icon: <Wallet className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.defiComposability.title",
        description: "roadmap.items.defiComposability.desc",
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
        title: "roadmap.items.desktopApp.title",
        description: "roadmap.items.desktopApp.desc",
        icon: <Cpu className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.cliTool.title",
        description: "roadmap.items.cliTool.desc",
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
                            <h4 className="font-semibold text-sm">{t(item.title)}</h4>
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
                            {t(item.description)}
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
            {t('roadmap.designDoc')}
          </span>
          <span className="text-xs font-mono" style={{ color: THEME.dimColor }}>PDF</span>
          <Download className="w-3.5 h-3.5 transition-colors" style={{ color: THEME.dimColor }} />
        </a>
      </div>
      <p className="text-center text-[10px] font-mono tracking-wider pb-4" style={{ color: THEME.dimColor }}>
        {t('roadmap.lastRevision')}
      </p>

      {/* Footer */}
      <footer className="border-t py-8 px-4" style={{ borderColor: THEME.borderColor }}>
        <div className="max-w-5xl mx-auto text-center space-y-3">
          <div className="flex items-center justify-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.2em] px-2 py-0.5 border rounded"
              style={{ borderColor: THEME.primaryColor + "50", color: THEME.primaryColor }}>
              Beta
            </span>
            <span style={{ color: THEME.borderColor }}>&middot;</span>
            <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: THEME.dimColor }}>
              {t('roadmap.devnetOnly')}
            </span>
          </div>
          <p className="text-sm font-mono" style={{ color: THEME.dimColor }}>
            &copy; {new Date().getFullYear()} PROTOCOL 01 | {t('roadmap.builtFromScratch')}
          </p>
          <p className="text-[10px] font-mono" style={{ color: THEME.dimColor + "80" }}>
            {t('roadmap.disclaimer')}
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
