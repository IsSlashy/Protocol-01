"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useT } from "@/i18n";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";
import {
  CheckCircle,
  ChevronDown,
  Clock,
  Shield,
  Zap,
  Code,
  Layers,
  Cpu,
  Eye,
  EyeOff,
  Wallet,
  Globe,
  Terminal,
  Bot,
  Lock,
  Key,
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

// ── Shipped-item categorization ────────────────────────────────
// Keyed by the item's i18n key stem (roadmap.items.<stem>.title) so the
// data array below stays untouched.
type CategoryKey =
  | "privacyCore"
  | "poolsNotes"
  | "payments"
  | "infrastructure"
  | "appsSdk"
  | "ecosystem";

const CATEGORY_ORDER: CategoryKey[] = [
  "privacyCore",
  "poolsNotes",
  "payments",
  "infrastructure",
  "appsSdk",
  "ecosystem",
];

const SHIPPED_CATEGORY: Record<string, CategoryKey> = {
  stealthAddresses: "privacyCore",
  zkShieldedPool: "privacyCore",
  instantZk: "privacyCore",
  advancedPrivacy: "privacyCore",
  starkMigration: "privacyCore",
  autoShieldReceive: "privacyCore",
  stealthMetaAddresses: "privacyCore",
  multiHopRouter: "privacyCore",
  fullStealthUnshield: "privacyCore",
  stealthAirdrops: "privacyCore",
  complianceZk: "privacyCore",
  deterministicStealth: "privacyCore",
  v3StarkE2E: "privacyCore",
  uniformStarkProofs: "privacyCore",
  denominatedPools: "poolsNotes",
  confidentialBalances: "poolsNotes",
  p2pNoteSharing: "poolsNotes",
  crossPoolSplitting: "poolsNotes",
  perWalletNotes: "poolsNotes",
  poolV2Migration: "poolsNotes",
  poolV4Migration: "poolsNotes",
  paymentStreams: "payments",
  subscriptionVaults: "payments",
  subscribePrivateV3: "payments",
  onChainRelayer: "infrastructure",
  onChainContracts: "infrastructure",
  onChainRegistry: "infrastructure",
  rpcFallback: "infrastructure",
  instantUnshield: "infrastructure",
  multiLayoutDecoder: "infrastructure",
  txOpacityRelayer: "infrastructure",
  txOpacityEvents: "infrastructure",
  multiRelayerRotation: "infrastructure",
  automatedTests: "infrastructure",
  securityHardening: "infrastructure",
  mobileApp: "appsSdk",
  aiAgent: "appsSdk",
  aiAgent56Tools: "appsSdk",
  i18n: "appsSdk",
  privacySdkNpm: "appsSdk",
  jupiterSwap: "appsSdk",
  zeroTsErrors: "appsSdk",
  mugenExchange: "ecosystem",
  colosseumFrontier: "ecosystem",
};

// Extract the stem from a "roadmap.items.<stem>.title" key.
const itemStem = (titleKey: string): string => titleKey.split(".")[2] ?? "";

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
      // ── May 2026 sprint shipping wave ─────────────────────────
      {
        title: "roadmap.items.v3StarkE2E.title",
        description: "roadmap.items.v3StarkE2E.desc",
        icon: <Cpu className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.txOpacityRelayer.title",
        description: "roadmap.items.txOpacityRelayer.desc",
        icon: <Radio className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.txOpacityEvents.title",
        description: "roadmap.items.txOpacityEvents.desc",
        icon: <EyeOff className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.uniformStarkProofs.title",
        description: "roadmap.items.uniformStarkProofs.desc",
        icon: <Lock className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.multiRelayerRotation.title",
        description: "roadmap.items.multiRelayerRotation.desc",
        icon: <Network className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.poolV4Migration.title",
        description: "roadmap.items.poolV4Migration.desc",
        icon: <Layers className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.subscribePrivateV3.title",
        description: "roadmap.items.subscribePrivateV3.desc",
        icon: <Zap className="w-5 h-5" />,
      },
      // ── June 2026 — Privy removal & extension parity ──────────
      {
        title: "roadmap.items.privyRemoval.title",
        description: "roadmap.items.privyRemoval.desc",
        icon: <Wallet className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.extensionParity.title",
        description: "roadmap.items.extensionParity.desc",
        icon: <Code className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.licenseKeys.title",
        description: "roadmap.items.licenseKeys.desc",
        icon: <Key className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.relayerHealth.title",
        description: "roadmap.items.relayerHealth.desc",
        icon: <Server className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.v102Release.title",
        description: "roadmap.items.v102Release.desc",
        icon: <Download className="w-5 h-5" />,
      },
      // ── Reconciled from "Next" — verified shipped in code ─────
      {
        title: "roadmap.items.leafInsertedCanonical.title",
        description: "roadmap.items.leafInsertedCanonical.desc",
        icon: <Code className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.fiatOnRamp.title",
        description: "roadmap.items.fiatOnRamp.desc",
        icon: <CreditCard className="w-5 h-5" />,
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
        title: "roadmap.items.securityAudit.title",
        description: "roadmap.items.securityAudit.desc",
        icon: <Shield className="w-5 h-5" />,
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
        title: "roadmap.items.cancelPrivateV3.title",
        description: "roadmap.items.cancelPrivateV3.desc",
        icon: <Code className="w-5 h-5" />,
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
        title: "roadmap.items.quantumWallet.title",
        description: "roadmap.items.quantumWallet.desc",
        icon: <Key className="w-5 h-5" />,
      },
      {
        title: "roadmap.items.coverTraffic.title",
        description: "roadmap.items.coverTraffic.desc",
        icon: <EyeOff className="w-5 h-5" />,
      },
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

// ── Retired — shipped as code ─────────────────────────────────
// Honest archive: real, committed (some deployed to devnet) but NOT wired
// into the live product. Surfaced for transparency rather than hidden or
// falsely listed as a live feature.
const retiredItems: RoadmapItem[] = [
  {
    title: "roadmap.items.arciumMpc.title",
    description: "roadmap.items.arciumMpc.desc",
    icon: <Network className="w-5 h-5" />,
  },
  {
    title: "roadmap.items.sealedBidAuctions.title",
    description: "roadmap.items.sealedBidAuctions.desc",
    icon: <Lock className="w-5 h-5" />,
  },
  {
    title: "roadmap.items.arciumConfidentialRelay.title",
    description: "roadmap.items.arciumConfidentialRelay.desc",
    icon: <Cpu className="w-5 h-5" />,
  },
];

function ItemCard({
  item,
  status,
  t,
}: {
  item: RoadmapItem;
  status: PhaseStatus;
  t: (k: string) => string;
}) {
  const styles = PHASE_STYLES[status];
  return (
    <div className="rounded-2xl border p-5 transition-colors bg-white/[0.02] backdrop-blur-sm border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.12]">
      <div className="flex items-start gap-4">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: styles.glowColor + "15", color: styles.glowColor }}
        >
          {item.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-semibold text-sm">{t(item.title)}</h4>
            {status === "shipped" && (
              <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: THEME.primaryColor }} />
            )}
            {status === "next" && (
              <Clock className="w-4 h-4 flex-shrink-0" style={{ color: THEME.secondaryColor }} />
            )}
          </div>
          <p className="text-xs leading-relaxed" style={{ color: THEME.mutedColor }}>
            {t(item.description)}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function RoadmapPage() {
  const t = useT();
  const [activeTab, setActiveTab] = useState<PhaseStatus>("next");
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({ privacyCore: true });

  const shippedPhase = roadmap.find((p) => p.status === "shipped")!;
  const nextPhase = roadmap.find((p) => p.status === "next")!;
  const futurePhase = roadmap.find((p) => p.status === "future")!;
  const counts: Record<PhaseStatus, number> = {
    shipped: shippedPhase.items.length,
    next: nextPhase.items.length,
    future: futurePhase.items.length,
  };
  const total = counts.shipped + counts.next + counts.future;
  const pct = Math.round((counts.shipped / total) * 100);
  const activePhase = roadmap.find((p) => p.status === activeTab)!;
  const focusItem = nextPhase.items[0];

  // Group shipped items by category (ordered).
  const shippedByCat = CATEGORY_ORDER.reduce(
    (acc, c) => ({ ...acc, [c]: [] as RoadmapItem[] }),
    {} as Record<CategoryKey, RoadmapItem[]>,
  );
  shippedPhase.items.forEach((it) => {
    const cat = SHIPPED_CATEGORY[itemStem(it.title)] ?? "ecosystem";
    shippedByCat[cat].push(it);
  });

  const TABS: PhaseStatus[] = ["shipped", "next", "future"];
  const RING_R = 34;
  const RING_C = 2 * Math.PI * RING_R;

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: THEME.backgroundColor, color: THEME.textColor }}
    >
      <SiteHeader />

      {/* Compact hero */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-2">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <p className="text-xs font-mono tracking-[0.2em] mb-3" style={{ color: THEME.primaryColor }}>
            {t('roadmap.heroSubtitle')}
          </p>
          <h2 className="text-2xl sm:text-3xl font-bold font-display tracking-wide mb-2">
            {t('roadmap.heroTitle')}
          </h2>
          <p className="text-sm max-w-2xl" style={{ color: THEME.mutedColor }}>
            {t('roadmap.heroDesc')}
          </p>
        </motion.div>
      </section>

      {/* Dashboard — counts double as phase tabs */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="rounded-2xl border p-6 bg-white/[0.02] backdrop-blur-sm border-white/[0.06]"
        >
          <div className="flex flex-col sm:flex-row items-center gap-6">
            {/* Progress ring */}
            <div className="relative flex-shrink-0" style={{ width: 96, height: 96 }}>
              <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
                <circle cx="48" cy="48" r={RING_R} fill="none" stroke={THEME.borderColor} strokeWidth="7" />
                <circle
                  cx="48"
                  cy="48"
                  r={RING_R}
                  fill="none"
                  stroke={THEME.primaryColor}
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - pct / 100)}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-xl font-bold font-display" style={{ color: THEME.textColor }}>
                  {pct}%
                </span>
                <span className="text-[9px] font-mono uppercase tracking-wider" style={{ color: THEME.dimColor }}>
                  {t('roadmap.shippedLabel')}
                </span>
              </div>
            </div>

            {/* Stat tiles = phase tabs */}
            <div className="grid grid-cols-3 gap-3 w-full">
              {TABS.map((status) => {
                const s = PHASE_STYLES[status];
                const active = activeTab === status;
                return (
                  <button
                    key={status}
                    onClick={() => setActiveTab(status)}
                    className="rounded-xl border p-4 text-left transition-all"
                    style={{
                      borderColor: active ? s.glowColor + "60" : THEME.borderColor,
                      backgroundColor: active ? s.glowColor + "12" : "rgba(255,255,255,0.02)",
                    }}
                  >
                    <div className="text-2xl font-bold font-display" style={{ color: s.glowColor }}>
                      {counts[status]}
                    </div>
                    <div
                      className="text-[10px] font-mono uppercase tracking-wider mt-1"
                      style={{ color: active ? s.glowColor : THEME.dimColor }}
                    >
                      {t(PHASE_LABELS[status])}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Current focus */}
          {focusItem && (
            <div
              className="mt-5 pt-4 border-t flex items-center gap-2 flex-wrap"
              style={{ borderColor: THEME.borderColor }}
            >
              <span
                className="text-[10px] font-mono uppercase tracking-wider"
                style={{ color: THEME.secondaryColor }}
              >
                {t('roadmap.currentFocus')}
              </span>
              <span className="text-sm" style={{ color: THEME.mutedColor }}>
                {t(focusItem.title)}
              </span>
            </div>
          )}
        </motion.div>
      </section>

      {/* Active phase content */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-10 pb-24">
        <div className="mb-6">
          <h3 className="text-lg font-bold font-display tracking-wide">{t(activePhase.title)}</h3>
          <p className="text-sm" style={{ color: THEME.dimColor }}>{t(activePhase.subtitle)}</p>
        </div>

        {activeTab === "shipped" ? (
          <div className="space-y-3">
            {CATEGORY_ORDER.map((cat) => {
              const items = shippedByCat[cat];
              if (!items.length) return null;
              const open = openCats[cat];
              return (
                <div
                  key={cat}
                  className="rounded-2xl border overflow-hidden bg-white/[0.02] backdrop-blur-sm border-white/[0.06]"
                >
                  <button
                    onClick={() => setOpenCats((p) => ({ ...p, [cat]: !p[cat] }))}
                    className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-sm">{t(`roadmap.categories.${cat}`)}</span>
                      <span
                        className="text-[11px] font-mono px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: THEME.primaryColor + "15", color: THEME.primaryColor }}
                      >
                        {items.length}
                      </span>
                    </div>
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
                      style={{ color: THEME.dimColor }}
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                        className="overflow-hidden"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-5 pb-5">
                          {items.map((it) => (
                            <ItemCard key={it.title} item={it} status="shipped" t={t} />
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activePhase.items.map((it) => (
              <ItemCard key={it.title} item={it} status={activeTab} t={t} />
            ))}
          </div>
        )}
      </section>

      {/* Retired — shipped as code (honest archive of built-but-parked work) */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-2">
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <span className="text-[11px] font-mono px-2.5 py-1 rounded-full border text-[#b08d57] bg-[#b08d57]/[0.12] border-[#b08d57]/25">
            {t('roadmap.retiredBadge')}
          </span>
          <h3 className="text-lg font-bold font-display tracking-wide">{t('roadmap.retiredTitle')}</h3>
        </div>
        <p className="text-sm mb-5 max-w-2xl" style={{ color: THEME.mutedColor }}>{t('roadmap.retiredSub')}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {retiredItems.map((it) => (
            <ItemCard key={it.title} item={it} status="future" t={t} />
          ))}
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

      <Footer />
    </div>
  );
}
