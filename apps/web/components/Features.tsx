"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import { Wallet, Radio, MessageCircle, Bot, ArrowRight, Check } from "lucide-react";

const modules = [
  {
    id: "wallet",
    icon: Wallet,
    name: "Stealth Wallet",
    tagline: "Invisible transactions",
    color: "cyan",
    description:
      "Send and receive crypto without leaving a trace. Stealth addresses ensure each transaction is completely unlinkable.",
    features: [
      "One-time stealth addresses",
      "ZK-proof transactions",
      "Solana native support",
      "Private balance hiding",
    ],
    codePreview: `// Send anonymously
const tx = await p01.wallet.send({
  to: "p01:7xK9...",
  amount: "100",
  token: "USDC",
  privacy: "maximum"
});`,
  },
  {
    id: "streams",
    icon: Radio,
    name: "Private Streams",
    tagline: "Invisible payment flows",
    color: "pink",
    description:
      "Stream payments in real-time without revealing amounts or recipients. Perfect for salaries, subscriptions, and DAOs.",
    features: [
      "Real-time private streaming",
      "Encrypted metadata",
      "Programmable conditions",
      "Batch streaming support",
    ],
    codePreview: `// Create private stream
const stream = await p01.streams.create({
  recipient: "p01:7xK9...",
  rate: "0.1 SOL/hour",
  duration: "30 days",
  hidden: true
});`,
  },
  {
    id: "social",
    icon: MessageCircle,
    name: "Anonymous Social",
    tagline: "Invisible communication",
    color: "bright-cyan",
    description:
      "Communicate with on-chain proof of identity without revealing who you are. End-to-end encrypted messaging.",
    features: [
      "Anonymous credentials",
      "Encrypted messaging",
      "Private group chats",
      "Proof of membership",
    ],
    codePreview: `// Send anonymous message
await p01.social.send({
  channel: "private-dao",
  message: encrypted,
  proof: membershipProof,
  anonymous: true
});`,
  },
  {
    id: "agent",
    icon: Bot,
    name: "AI Agent",
    tagline: "Invisible automation",
    color: "yellow",
    description:
      "Deploy AI agents that act on your behalf with full privacy. Automated trading, DeFi, and more without exposure.",
    features: [
      "Private AI execution",
      "TEE-secured compute",
      "Autonomous transactions",
      "Strategy privacy",
    ],
    codePreview: `// Deploy private agent
const agent = await p01.agent.deploy({
  strategy: "dca-btc",
  budget: "10000 USDC",
  frequency: "daily",
  stealth: true
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

  // Industrial color classes - no soft glows
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
          <span className="badge-cyan mb-4">The Solution</span>
          <h2 className="section-title">
            Four modules.{" "}
            <span className="text-[#39c5bb]">Complete privacy.</span>
          </h2>
          <p className="section-subtitle">
            Protocol 01 provides a comprehensive suite of privacy tools, all working
            together seamlessly to keep your digital life invisible.
          </p>
        </motion.div>

        {/* Modules Grid */}
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
                      {/* Industrial square icon container - no rounded */}
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

                    <p className="text-p01-text-muted text-lg mb-8">
                      {module.description}
                    </p>

                    <ul className="space-y-3 mb-8">
                      {module.features.map((feature, i) => (
                        <li key={i} className="flex items-center gap-3">
                          {/* Industrial square checkmark */}
                          <div
                            className={`w-5 h-5 ${colors.bg} ${colors.text} flex items-center justify-center`}
                          >
                            <Check size={12} />
                          </div>
                          <span className="text-[#888892] font-mono text-sm">{feature}</span>
                        </li>
                      ))}
                    </ul>

                    <button
                      className={`inline-flex items-center gap-2 ${colors.text} hover:gap-4 transition-all font-medium font-display uppercase tracking-wider text-sm`}
                    >
                      Learn more about {module.name}
                      <ArrowRight size={18} />
                    </button>
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
      </div>
    </section>
  );
}
