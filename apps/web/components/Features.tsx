"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import Link from "next/link";
import { Wallet, Radio, ArrowLeftRight, ShoppingCart, Shield, ArrowRight, Check } from "lucide-react";

const modules = [
  {
    id: "streams",
    icon: Radio,
    name: "Private Subscriptions",
    tagline: "Recurring payments without traces",
    color: "cyan",
    description: [
      "Set up recurring private payments for subscriptions, memberships, and services.",
      "Automatic monthly/weekly transfers with full privacy.",
      "Perfect for creators, SaaS, and any subscription-based business.",
    ],
    features: [
      "Automated recurring payments",
      "Customizable intervals",
      "Cancel anytime",
      "100% private & untraceable",
    ],
    docsLink: "/docs#subscriptions",
    codePreview: `// Create a private subscription
const subscription = await p01.subscribe({
  to: "p01:creator...",
  amount: "9.99 USDC",
  interval: "monthly",
  privacy: "stealth" // Untraceable payments
});

// Manage subscription
await subscription.pause();
await subscription.cancel();`,
  },
  {
    id: "wallet",
    icon: Wallet,
    name: "Stealth Transfers",
    tagline: "Send & receive without traces",
    color: "pink",
    description: [
      "Send and receive SOL and SPL tokens without leaving a trace.",
      "Stealth addresses ensure each transaction is completely unlinkable.",
      "Works on both Devnet and Mainnet.",
    ],
    features: [
      "One-time stealth addresses",
      "Devnet & Mainnet support",
      "SOL & SPL tokens (USDC, USDT...)",
      "Instant private transfers",
    ],
    docsLink: "/docs#stealth-addresses",
    codePreview: `// Send privately
const tx = await p01.send({
  to: "p01:7xK9...",
  amount: "100",
  token: "USDC",
  privacy: "stealth" // One-time address
});`,
  },
  {
    id: "swap",
    icon: ArrowLeftRight,
    name: "Token Swap",
    tagline: "Swap any Solana token",
    color: "bright-cyan",
    description: [
      "Swap between any Solana tokens including SOL, USDC, USDT, BONK, JUP, RAY, ORCA, and more.",
      "Powered by Jupiter aggregator for best rates.",
    ],
    features: [
      "15+ tokens supported",
      "Best rate aggregation",
      "Low slippage",
      "Instant swaps",
    ],
    docsLink: "/docs#client-sdk",
    codePreview: `// Swap tokens
const swap = await p01.swap({
  from: "SOL",
  to: "USDC",
  amount: "10",
  slippage: 0.5 // 0.5%
});`,
  },
  {
    id: "buy",
    icon: ShoppingCart,
    name: "Buy Crypto",
    tagline: "Fiat to crypto on-ramp",
    color: "yellow",
    description: [
      "Buy SOL, USDC, and USDT directly with fiat currency.",
      "Multiple payment providers including MoonPay and Ramp Network.",
    ],
    features: [
      "Credit/Debit card support",
      "Bank transfer",
      "Multiple providers",
      "Competitive rates",
    ],
    docsLink: "/docs",
    codePreview: `// Buy crypto with fiat
const purchase = await p01.buy({
  asset: "SOL",
  amount: "100",
  currency: "USD",
  provider: "moonpay"
});`,
  },
  {
    id: "security",
    icon: Shield,
    name: "Zero-Knowledge Proofs",
    tagline: "Maximum privacy with ZK",
    color: "pink",
    description: [
      "Advanced cryptography ensures your transactions and identity remain private.",
      "ZK proofs verify without revealing sensitive data.",
    ],
    features: [
      "ZK-proof transactions",
      "No KYC required",
      "Self-custody",
      "Open source",
    ],
    docsLink: "/docs#zk-proofs",
    codePreview: `// Generate ZK proof
const proof = await p01.zk.prove({
  statement: "balance > 100",
  witness: privateData,
  public: false
});`,
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
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 40 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
} as const;

export default function Features() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  const getColorClasses = (color: string) => {
    const colors: Record<string, { bg: string; text: string; border: string }> = {
      cyan: {
        bg: "bg-[#39c5bb]/10",
        text: "text-[#39c5bb]",
        border: "border-[#39c5bb]/40",
      },
      pink: {
        bg: "bg-[#ff2d7a]/10",
        text: "text-[#ff2d7a]",
        border: "border-[#ff2d7a]/40",
      },
      "bright-cyan": {
        bg: "bg-[#00ffe5]/10",
        text: "text-[#00ffe5]",
        border: "border-[#00ffe5]/40",
      },
      yellow: {
        bg: "bg-[#ffcc00]/10",
        text: "text-[#ffcc00]",
        border: "border-[#ffcc00]/40",
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
            Private payments.{" "}
            <span className="text-[#39c5bb]">Recurring or one-time.</span>
          </h2>
          <div className="section-subtitle space-y-1">
            <p>Subscribe to services, pay creators, and transfer funds—all without leaving traces.</p>
            <p>Works on Devnet for testing and Mainnet for real transactions.</p>
          </div>
        </motion.div>

        {/* Modules - Apple style alternating layout */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          className="space-y-8"
        >
          {modules.map((module, index) => {
            const colors = getColorClasses(module.color);
            const isReversed = index % 2 === 1;

            return (
              <motion.div
                key={module.id}
                variants={itemVariants}
                className={`card p-0 overflow-hidden group hover:${colors.border} transition-all duration-500`}
              >
                <div
                  className={`flex flex-col ${
                    isReversed ? "lg:flex-row-reverse" : "lg:flex-row"
                  } items-stretch`}
                >
                  {/* Content Side */}
                  <div className="flex-1 p-8 lg:p-12">
                    <div className="flex items-center gap-4 mb-6">
                      {/* Industrial square icon container */}
                      <div
                        className={`w-14 h-14 ${colors.bg} ${colors.text} flex items-center justify-center group-hover:scale-105 transition-transform border ${colors.border}`}
                      >
                        <module.icon size={28} />
                      </div>
                      <div>
                        <h3 className="text-2xl font-bold font-display text-white">
                          {module.name}
                        </h3>
                        <p className={`text-sm ${colors.text}`}>{module.tagline}</p>
                      </div>
                    </div>

                    <div className="text-p01-text-muted text-lg mb-8 space-y-1">
                      {module.description.map((line, i) => (
                        <p key={i}>{line}</p>
                      ))}
                    </div>

                    <ul className="space-y-3 mb-8">
                      {module.features.map((feature, i) => (
                        <li key={i} className="flex items-center gap-3">
                          <div
                            className={`w-5 h-5 ${colors.bg} ${colors.text} flex items-center justify-center`}
                          >
                            <Check size={12} />
                          </div>
                          <span className="text-[#888892] font-mono text-sm">{feature}</span>
                        </li>
                      ))}
                    </ul>

                    <Link
                      href={module.docsLink}
                      className={`inline-flex items-center gap-2 ${colors.text} hover:gap-4 transition-all font-medium font-display uppercase tracking-wider text-sm`}
                    >
                      Learn more about {module.name}
                      <ArrowRight size={18} />
                    </Link>
                  </div>

                  {/* Code Preview Side */}
                  <div className="flex-1 bg-p01-void p-8 lg:p-12 border-t lg:border-t-0 lg:border-l border-p01-border">
                    <div className="h-full flex flex-col">
                      <div className="flex items-center gap-2 mb-4">
                        <div className="w-3 h-3 rounded-full bg-p01-red/60" />
                        <div className="w-3 h-3 rounded-full bg-p01-yellow/60" />
                        <div className="w-3 h-3 rounded-full bg-p01-cyan/60" />
                        <span className="ml-4 text-p01-text-dim text-xs font-mono">
                          example.ts
                        </span>
                      </div>
                      <pre className="flex-1 overflow-auto">
                        <code className="text-sm font-mono text-p01-text-muted whitespace-pre-wrap">
                          {module.codePreview.split("\n").map((line, i) => (
                            <div key={i} className="leading-relaxed">
                              {line.includes("//") ? (
                                <span className="text-p01-text-dim">{line}</span>
                              ) : line.includes("await") || line.includes("const") ? (
                                <>
                                  <span className="text-p01-pink">
                                    {line.split(" ")[0]}
                                  </span>
                                  <span>{line.substring(line.indexOf(" "))}</span>
                                </>
                              ) : (
                                line
                              )}
                            </div>
                          ))}
                        </code>
                      </pre>
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Network Info */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-16 text-center"
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
            <span className="text-[#555560] text-xs font-mono ml-2">Switch anytime in settings</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
