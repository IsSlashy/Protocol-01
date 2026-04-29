"use client";

import { motion, AnimatePresence, useInView } from "framer-motion";
import { useState, useEffect, useRef } from "react";
import { Wallet, Shield, Bot, Radio, Check, Layers, Lock } from "lucide-react";

const screens = [
  {
    id: "wallet",
    icon: Wallet,
    title: "Private Wallet",
    subtitle: "Full-featured self-custody",
    color: "#39c5bb",
    description:
      "Send, receive, and swap tokens with complete privacy. Self-custody means your keys never leave your device. Stealth addresses make every transfer unlinkable.",
    highlights: [
      "Stealth address generation (ECDH)",
      "Multi-token support (SOL, USDC, BONK...)",
      "Jupiter-powered instant swaps",
      "Encrypted local storage",
    ],
    visual: {
      topLabel: "WALLET BALANCE",
      centerValue: "$2,847",
      centerSuffix: ".63",
      items: [
        { label: "SOL", value: "12.5", accent: true },
        { label: "USDC", value: "250.00", accent: false },
        { label: "BONK", value: "5.2M", accent: false },
      ],
    },
  },
  {
    id: "shield",
    icon: Shield,
    title: "ZK Shielded Pool",
    subtitle: "Shield & unshield in ~3 seconds",
    color: "#ff77a8",
    description:
      "Deposit tokens into a Merkle tree pool using quantum-resistant STARK proofs. Funds become untraceable on-chain. The on-device WASM prover makes operations instant.",
    highlights: [
      "Instant shield & unshield (~3s total)",
      "On-device STARK prover (no remote prover, ~9-15KB proofs)",
      "1M+ commitment capacity (depth 20)",
      "Dual verification safety net",
    ],
    visual: {
      topLabel: "ZK SHIELDED POOL",
      centerValue: "SHIELDED",
      centerSuffix: "",
      items: [
        { label: "Proof", value: "Valid", accent: true },
        { label: "Nullifier", value: "Set", accent: true },
        { label: "Root", value: "Synced", accent: true },
      ],
    },
  },
  {
    id: "agent",
    icon: Bot,
    title: "AI Agent",
    subtitle: "Privacy assistant on-device",
    color: "#00ffe5",
    description:
      "Manage your private finances through natural conversation. The on-device LLM understands privacy operations natively — no data leaves your phone.",
    highlights: [
      'Natural language: "Shield 100 USDC"',
      "On-device LLM (zero cloud dependency)",
      "Transaction explanations & history",
      "Privacy-aware recommendations",
    ],
    visual: {
      topLabel: "AI AGENT",
      centerValue: "Ready",
      centerSuffix: "",
      items: [
        { label: "Shield", value: "Active", accent: true },
        { label: "Transfer", value: "Active", accent: true },
        { label: "Explain", value: "Active", accent: true },
      ],
    },
  },
  {
    id: "streams",
    icon: Radio,
    title: "Stealth Streams",
    subtitle: "Recurring private payments",
    color: "#ffcc00",
    description:
      "Set up subscriptions and payment streams with privacy noise. Amounts and timing are randomized to resist chain analysis.",
    highlights: [
      "Automated recurring payments",
      "Amount noise: \u00b120% random variation",
      "Timing noise: \u00b124h random delay",
      "Stealth address for recipients",
    ],
    visual: {
      topLabel: "PAYMENT STREAM",
      centerValue: "ACTIVE",
      centerSuffix: "",
      items: [
        { label: "Monthly", value: "9.99", accent: false },
        { label: "Noise", value: "\u00b118%", accent: true },
        { label: "Next", value: "3d 7h", accent: false },
      ],
    },
  },
  {
    id: "denominated",
    icon: Layers,
    title: "Denominated Pools",
    subtitle: "Fixed-denomination privacy",
    color: "#ff77a8",
    description:
      "Deposit exact denominations into privacy pools. All notes share the same value, making deposits and withdrawals completely unlinkable. Share notes peer-to-peer via BLE or NFC.",
    highlights: [
      "Fixed denominations (0.1/1/10/100 SOL)",
      "USDC pools (1/10/100/1000)",
      "P2P note sharing (BLE + NFC)",
      "Epoch-based maturity protection",
    ],
    visual: {
      topLabel: "DENOMINATED POOL",
      centerValue: "1 SOL",
      centerSuffix: "",
      items: [
        { label: "Notes", value: "32K", accent: true },
        { label: "Epoch", value: "Mature", accent: true },
        { label: "Pool", value: "Active", accent: false },
      ],
    },
  },
  {
    id: "confidential",
    icon: Lock,
    title: "Confidential Balances",
    subtitle: "Quantum-resistant zkSPL",
    color: "#00ffe5",
    description:
      "Account-model confidential tokens using Poseidon hash commitments. Balances are hidden on-chain while remaining fully functional. Quantum-resistant by design.",
    highlights: [
      "Poseidon hash commitments",
      "Quantum-resistant cryptography",
      "Balance proof: prove balance >= threshold",
      "Account-model (no UTXO management)",
    ],
    visual: {
      topLabel: "CONFIDENTIAL BALANCE",
      centerValue: "HIDDEN",
      centerSuffix: "",
      items: [
        { label: "Balance", value: "***", accent: true },
        { label: "Proof", value: "Valid", accent: true },
        { label: "Quantum", value: "Safe", accent: true },
      ],
    },
  },
];

const INTERVAL = 5000;

export default function Showcase() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (!isInView || isPaused) return;
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % screens.length);
    }, INTERVAL);
    return () => clearInterval(timer);
  }, [isInView, isPaused]);

  const screen = screens[activeIndex];

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-p01-surface/20 to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <span className="badge-pink mb-4">See it in action</span>
          <h2 className="section-title">
            One app.{" "}
            <span className="text-p01-pink text-glow-pink">
              Total invisibility.
            </span>
          </h2>
          <div className="section-subtitle">
            <p>
              Every feature designed for privacy — from stealth transfers to
              AI-powered operations.
            </p>
          </div>
        </motion.div>

        {/* Showcase Card */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="card p-0 overflow-hidden"
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
        >
          <div className="flex flex-col lg:flex-row items-stretch min-h-[460px]">
            {/* Left — Visual mockup */}
            <div className="flex-1 relative bg-[#0a0a0c] p-8 lg:p-12 flex items-center justify-center overflow-hidden">
              {/* Background glow — transitions with active screen */}
              <div
                className="absolute inset-0 transition-all duration-700"
                style={{
                  background: `radial-gradient(ellipse 70% 70% at 50% 50%, ${screen.color}08 0%, transparent 70%)`,
                }}
              />

              {/* Grid pattern */}
              <div
                className="absolute inset-0 opacity-10"
                style={{
                  backgroundImage: `
                    linear-gradient(${screen.color}08 1px, transparent 1px),
                    linear-gradient(90deg, ${screen.color}08 1px, transparent 1px)
                  `,
                  backgroundSize: "30px 30px",
                }}
              />

              <AnimatePresence mode="wait">
                <motion.div
                  key={screen.id}
                  initial={{ opacity: 0, scale: 0.92, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -10 }}
                  transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                  className="relative z-10 w-full max-w-[300px]"
                >
                  {/* Mockup card */}
                  <div
                    className="border relative overflow-hidden"
                    style={{
                      borderColor: `${screen.color}25`,
                      backgroundColor: `${screen.color}04`,
                    }}
                  >
                    {/* Top bar */}
                    <div
                      className="flex items-center justify-between px-5 py-3 border-b"
                      style={{ borderColor: `${screen.color}15` }}
                    >
                      <span
                        className="text-[9px] font-mono tracking-[0.3em] uppercase"
                        style={{ color: `${screen.color}70` }}
                      >
                        {screen.visual.topLabel}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-1.5 h-1.5 animate-pulse"
                          style={{ backgroundColor: screen.color }}
                        />
                        <span
                          className="text-[9px] font-mono"
                          style={{ color: `${screen.color}50` }}
                        >
                          LIVE
                        </span>
                      </div>
                    </div>

                    {/* Center */}
                    <div className="px-5 py-8 text-center">
                      {/* Icon */}
                      <div className="flex justify-center mb-5">
                        <div
                          className="w-16 h-16 flex items-center justify-center border relative"
                          style={{
                            borderColor: `${screen.color}30`,
                            boxShadow: `0 0 50px ${screen.color}15`,
                          }}
                        >
                          {/* Corner dots */}
                          <div
                            className="absolute -top-0.5 -left-0.5 w-1 h-1"
                            style={{ backgroundColor: screen.color }}
                          />
                          <div
                            className="absolute -top-0.5 -right-0.5 w-1 h-1"
                            style={{ backgroundColor: screen.color }}
                          />
                          <div
                            className="absolute -bottom-0.5 -left-0.5 w-1 h-1"
                            style={{ backgroundColor: screen.color }}
                          />
                          <div
                            className="absolute -bottom-0.5 -right-0.5 w-1 h-1"
                            style={{ backgroundColor: screen.color }}
                          />
                          <screen.icon
                            size={28}
                            style={{ color: screen.color }}
                          />
                        </div>
                      </div>

                      {/* Value */}
                      <div className="mb-2">
                        <span
                          className="text-3xl font-bold font-display tracking-wider"
                          style={{ color: screen.color }}
                        >
                          {screen.visual.centerValue}
                        </span>
                        {screen.visual.centerSuffix && (
                          <span
                            className="text-xl font-display"
                            style={{ color: `${screen.color}60` }}
                          >
                            {screen.visual.centerSuffix}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Bottom items */}
                    <div
                      className="px-5 py-4 border-t"
                      style={{ borderColor: `${screen.color}12` }}
                    >
                      <div className="flex justify-between">
                        {screen.visual.items.map((item) => (
                          <div key={item.label} className="text-center">
                            <div
                              className="text-xs font-mono font-medium"
                              style={{
                                color: item.accent
                                  ? screen.color
                                  : "#888892",
                              }}
                            >
                              {item.value}
                            </div>
                            <div className="text-[9px] font-mono text-[#555560] mt-0.5">
                              {item.label}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Status bar below card */}
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <div
                      className="w-1.5 h-1.5 animate-pulse"
                      style={{ backgroundColor: screen.color }}
                    />
                    <span className="text-[10px] font-mono text-[#555560] uppercase tracking-wider">
                      Protocol Active
                    </span>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Right — Info */}
            <div className="flex-1 p-8 lg:p-12 border-t lg:border-t-0 lg:border-l border-[#2a2a30] flex flex-col justify-center">
              <AnimatePresence mode="wait">
                <motion.div
                  key={screen.id}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                >
                  {/* Badge */}
                  <div
                    className="inline-flex items-center gap-2 px-3 py-1.5 mb-6 border text-xs font-mono uppercase tracking-wider"
                    style={{
                      color: screen.color,
                      borderColor: `${screen.color}35`,
                      backgroundColor: `${screen.color}08`,
                    }}
                  >
                    <screen.icon size={14} />
                    {screen.subtitle}
                  </div>

                  {/* Title */}
                  <h3 className="text-3xl lg:text-4xl font-bold font-display text-white mb-4 tracking-wide">
                    {screen.title}
                  </h3>

                  {/* Description */}
                  <p className="text-[#888892] text-base lg:text-lg mb-8 leading-relaxed">
                    {screen.description}
                  </p>

                  {/* Highlights */}
                  <ul className="space-y-3">
                    {screen.highlights.map((h) => (
                      <li key={h} className="flex items-center gap-3">
                        <div
                          className="w-5 h-5 flex items-center justify-center flex-shrink-0"
                          style={{
                            backgroundColor: `${screen.color}12`,
                            color: screen.color,
                          }}
                        >
                          <Check size={12} />
                        </div>
                        <span className="text-sm text-[#888892] font-mono">
                          {h}
                        </span>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* Navigation tabs */}
          <div className="flex items-center justify-center gap-1 sm:gap-2 py-4 border-t border-[#2a2a30] bg-[#0a0a0c]/60">
            {screens.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setActiveIndex(i)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 transition-all duration-300 relative"
                style={{
                  backgroundColor:
                    i === activeIndex ? `${s.color}10` : "transparent",
                }}
              >
                {/* Active indicator bar */}
                {i === activeIndex && (
                  <motion.div
                    layoutId="showcase-indicator"
                    className="absolute bottom-0 left-2 right-2 h-0.5"
                    style={{ backgroundColor: s.color }}
                    transition={{ duration: 0.3 }}
                  />
                )}
                <s.icon
                  size={16}
                  style={{
                    color: i === activeIndex ? s.color : "#555560",
                  }}
                />
                <span
                  className="text-xs font-mono hidden sm:inline transition-colors duration-300"
                  style={{
                    color: i === activeIndex ? s.color : "#555560",
                  }}
                >
                  {s.title}
                </span>
              </button>
            ))}

            {/* Auto-advance progress */}
            {!isPaused && (
              <div className="ml-4 hidden sm:flex items-center gap-2">
                <div className="w-20 h-0.5 bg-[#2a2a30] overflow-hidden">
                  <motion.div
                    key={activeIndex}
                    className="h-full"
                    style={{ backgroundColor: screen.color }}
                    initial={{ width: "0%" }}
                    animate={{ width: "100%" }}
                    transition={{ duration: INTERVAL / 1000, ease: "linear" }}
                  />
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
