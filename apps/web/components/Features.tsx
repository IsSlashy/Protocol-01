"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import {
  Eye,
  Radio,
  MessageCircle,
  Smartphone,
  Shield,
  UserX,
  Zap,
  CreditCard,
  ArrowRight,
  Check,
} from "lucide-react";

const features = [
  {
    id: "stealth",
    icon: Eye,
    name: "Stealth Addresses",
    tagline: "Unlinkable transactions",
    color: "cyan",
    description:
      "Every transaction uses a unique one-time address. No one can link your payments together or trace your activity on-chain.",
    highlights: [
      "One-time addresses per transaction",
      "Completely unlinkable payments",
      "No transaction history exposure",
      "Mathematically proven privacy",
    ],
  },
  {
    id: "streams",
    icon: Radio,
    name: "Stream Payments",
    tagline: "Recurring with limits",
    color: "pink",
    description:
      "Set up subscriptions and recurring payments with on-chain spending limits. Perfect for salaries, memberships, and services.",
    highlights: [
      "Automated recurring payments",
      "On-chain spending limits",
      "Subscription management",
      "Cancel anytime",
    ],
  },
  {
    id: "messaging",
    icon: MessageCircle,
    name: "Encrypted Messaging",
    tagline: "Wallet-to-wallet chat",
    color: "cyan",
    description:
      "Send end-to-end encrypted messages directly between wallets. Your conversations stay private, always.",
    highlights: [
      "End-to-end encryption",
      "Wallet-to-wallet communication",
      "No metadata leakage",
      "Decentralized messaging",
    ],
  },
  {
    id: "multiplatform",
    icon: Smartphone,
    name: "Multi-Platform",
    tagline: "Use anywhere",
    color: "pink",
    description:
      "Access Protocol 01 from any device. Native mobile apps for Android and iOS, Chrome extension, and a powerful Web SDK.",
    highlights: [
      "Android & iOS apps",
      "Chrome browser extension",
      "Web SDK for developers",
      "Sync across all devices",
    ],
  },
  {
    id: "privacy-zone",
    icon: Shield,
    name: "Privacy Zone",
    tagline: "Hide everything",
    color: "cyan",
    description:
      "Keep your balances and activity hidden from prying eyes. Your financial data is nobody's business but yours.",
    highlights: [
      "Hidden balance display",
      "Activity obfuscation",
      "Private portfolio view",
      "No public exposure",
    ],
  },
  {
    id: "no-kyc",
    icon: UserX,
    name: "No KYC Required",
    tagline: "Fully anonymous",
    color: "pink",
    description:
      "No identity verification, no personal data collection. Use Protocol 01 with complete anonymity from day one.",
    highlights: [
      "Zero identity verification",
      "No personal data collected",
      "Instant account creation",
      "True financial freedom",
    ],
  },
  {
    id: "solana",
    icon: Zap,
    name: "Solana Powered",
    tagline: "Fast & cheap",
    color: "cyan",
    description:
      "Built on Solana for lightning-fast transactions and minimal fees. Privacy shouldn't cost a fortune.",
    highlights: [
      "Sub-second finality",
      "Fraction of a cent fees",
      "High throughput",
      "Battle-tested blockchain",
    ],
  },
  {
    id: "buy-crypto",
    icon: CreditCard,
    name: "Buy Crypto",
    tagline: "Fiat on-ramp",
    color: "pink",
    description:
      "Purchase crypto directly with fiat through MoonPay, Transak, and Ramp. Easy onboarding for everyone.",
    highlights: [
      "MoonPay integration",
      "Transak support",
      "Ramp Network",
      "Multiple payment methods",
    ],
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.2,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 40 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: "easeOut",
    },
  },
};

export default function Features() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  // P-01 color scheme - cyan #39c5bb, pink #ff77a8
  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; border: string; glow: string }> = {
      cyan: {
        bg: "bg-[#39c5bb]/10",
        text: "text-[#39c5bb]",
        border: "border-[#39c5bb]/40",
        glow: "group-hover:shadow-[0_0_30px_rgba(57,197,187,0.15)]",
      },
      pink: {
        bg: "bg-[#ff77a8]/10",
        text: "text-[#ff77a8]",
        border: "border-[#ff77a8]/40",
        glow: "group-hover:shadow-[0_0_30px_rgba(255,119,168,0.15)]",
      },
    };
    return colors[color] || colors.cyan;
  };

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-20"
        >
          <span className="badge-cyan mb-4">Features</span>
          <h2 className="section-title">
            Everything you need.{" "}
            <span className="text-[#39c5bb]">Nothing you don't.</span>
          </h2>
          <p className="section-subtitle">
            Protocol 01 delivers privacy-first crypto tools with no compromise.
            Fast, anonymous, and available everywhere.
          </p>
        </motion.div>

        {/* Features Grid - 2x4 layout */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {features.map((feature) => {
            const colors = getColorClasses(feature.color);

            return (
              <motion.div
                key={feature.id}
                variants={itemVariants}
                className={`card p-6 group hover:border-[${feature.color === 'cyan' ? '#39c5bb' : '#ff77a8'}]/60 ${colors.glow} transition-all duration-500`}
              >
                {/* Icon */}
                <div
                  className={`w-12 h-12 ${colors.bg} ${colors.text} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform border ${colors.border}`}
                >
                  <feature.icon size={24} />
                </div>

                {/* Title & Tagline */}
                <h3 className="text-lg font-bold font-display text-white mb-1">
                  {feature.name}
                </h3>
                <p className={`text-xs font-mono ${colors.text} mb-3 uppercase tracking-wider`}>
                  {feature.tagline}
                </p>

                {/* Description */}
                <p className="text-p01-text-muted text-sm mb-4 leading-relaxed">
                  {feature.description}
                </p>

                {/* Highlights */}
                <ul className="space-y-2">
                  {feature.highlights.map((highlight, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <div
                        className={`w-4 h-4 ${colors.bg} ${colors.text} flex items-center justify-center flex-shrink-0 mt-0.5`}
                      >
                        <Check size={10} />
                      </div>
                      <span className="text-[#888892] font-mono text-xs">{highlight}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Bottom CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.8 }}
          className="text-center mt-16"
        >
          <div className="inline-flex items-center gap-4 p-4 border border-p01-border bg-p01-void/50">
            <span className="text-p01-text-muted font-mono text-sm">
              Ready to go private?
            </span>
            <button className="inline-flex items-center gap-2 text-[#39c5bb] hover:gap-3 transition-all font-medium font-display uppercase tracking-wider text-sm">
              Get Started
              <ArrowRight size={16} />
            </button>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
