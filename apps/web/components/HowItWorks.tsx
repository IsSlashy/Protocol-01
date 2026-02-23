"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { Wallet, Shield, Send, ArrowDownToLine } from "lucide-react";

const steps = [
  {
    num: "01",
    icon: Wallet,
    title: "CONNECT",
    desc: "Create or import your Solana wallet",
    color: "#39c5bb",
  },
  {
    num: "02",
    icon: Shield,
    title: "SHIELD",
    desc: "Deposit tokens into the ZK shielded pool",
    color: "#ff77a8",
  },
  {
    num: "03",
    icon: Send,
    title: "TRANSFER",
    desc: "Send privately via Groth16 ZK proofs",
    color: "#00ffe5",
  },
  {
    num: "04",
    icon: ArrowDownToLine,
    title: "RECEIVE",
    desc: "Withdraw to any wallet — zero trace",
    color: "#ffcc00",
  },
];

export default function HowItWorks() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-p01-void via-p01-surface/10 to-p01-void" />

      {/* Subtle grid */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(to right, rgba(57, 197, 187, 0.03) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(57, 197, 187, 0.03) 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-20"
        >
          <span className="badge-cyan mb-4">How it works</span>
          <h2 className="section-title">
            Four steps to{" "}
            <span className="text-p01-cyan text-glow-cyan">
              financial privacy
            </span>
          </h2>
          <div className="section-subtitle">
            <p>From wallet creation to untraceable transfers in under a minute.</p>
          </div>
        </motion.div>

        {/* Steps */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 md:gap-0 relative">
          {/* Connecting line (desktop only) */}
          <div className="hidden md:block absolute top-[72px] left-[12.5%] right-[12.5%] h-px">
            <motion.div
              initial={{ scaleX: 0 }}
              animate={isInView ? { scaleX: 1 } : {}}
              transition={{ duration: 1.2, delay: 0.5, ease: "easeInOut" }}
              className="h-full origin-left"
              style={{
                background:
                  "linear-gradient(90deg, #39c5bb60, #ff77a860, #00ffe560, #ffcc0060)",
              }}
            />
          </div>

          {/* Animated dot traveling along the line */}
          <motion.div
            className="hidden md:block absolute top-[69px] w-2 h-2"
            style={{
              background: "linear-gradient(135deg, #39c5bb, #00ffe5)",
              boxShadow: "0 0 12px #39c5bb80",
              left: "12.5%",
            }}
            initial={{ left: "12.5%", opacity: 0 }}
            animate={
              isInView
                ? {
                    left: ["12.5%", "87.5%"],
                    opacity: [0, 1, 1, 0],
                  }
                : {}
            }
            transition={{
              duration: 2.5,
              delay: 0.8,
              ease: "easeInOut",
              repeat: Infinity,
              repeatDelay: 2,
            }}
          />

          {steps.map((step, i) => (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, y: 30 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: 0.3 + i * 0.15 }}
              className="flex flex-col items-center text-center relative px-4"
            >
              {/* Step label */}
              <div
                className="text-[10px] font-mono tracking-[0.3em] mb-3 uppercase"
                style={{ color: `${step.color}90` }}
              >
                Step {step.num}
              </div>

              {/* Icon container */}
              <div
                className="w-20 h-20 flex items-center justify-center border mb-5 relative transition-all duration-500 group"
                style={{
                  borderColor: `${step.color}35`,
                  backgroundColor: `${step.color}06`,
                }}
              >
                {/* Pulse glow on hover */}
                <div
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                  style={{
                    boxShadow: `0 0 40px ${step.color}20, inset 0 0 30px ${step.color}08`,
                  }}
                />
                {/* Corner accents */}
                <div
                  className="absolute -top-px -left-px w-3 h-3 border-t border-l"
                  style={{ borderColor: step.color }}
                />
                <div
                  className="absolute -top-px -right-px w-3 h-3 border-t border-r"
                  style={{ borderColor: step.color }}
                />
                <div
                  className="absolute -bottom-px -left-px w-3 h-3 border-b border-l"
                  style={{ borderColor: step.color }}
                />
                <div
                  className="absolute -bottom-px -right-px w-3 h-3 border-b border-r"
                  style={{ borderColor: step.color }}
                />
                <step.icon size={30} style={{ color: step.color }} />
              </div>

              {/* Title */}
              <h3
                className="text-base font-bold font-display tracking-[0.15em] mb-2"
                style={{ color: step.color }}
              >
                {step.title}
              </h3>

              {/* Description */}
              <p className="text-sm text-[#888892] max-w-[200px] font-mono leading-relaxed">
                {step.desc}
              </p>

              {/* Mobile arrow */}
              {i < steps.length - 1 && (
                <motion.div
                  className="md:hidden my-6 flex flex-col items-center gap-1"
                  initial={{ opacity: 0 }}
                  animate={isInView ? { opacity: 1 } : {}}
                  transition={{ delay: 0.5 + i * 0.15 }}
                >
                  <div
                    className="w-px h-6"
                    style={{ backgroundColor: `${step.color}40` }}
                  />
                  <div
                    className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent"
                    style={{ borderTopColor: `${step.color}60` }}
                  />
                </motion.div>
              )}
            </motion.div>
          ))}
        </div>

        {/* Bottom status */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ delay: 1.2 }}
          className="flex items-center justify-center gap-4 mt-16 pt-8 border-t border-[#2a2a30]"
        >
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-[#39c5bb] animate-pulse" />
            <span className="text-[10px] font-mono text-[#555560] uppercase tracking-wider">
              Instant operations
            </span>
          </div>
          <span className="text-[#2a2a30]">|</span>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-[#ff77a8] animate-pulse" />
            <span className="text-[10px] font-mono text-[#555560] uppercase tracking-wider">
              ~3s shield + unshield
            </span>
          </div>
          <span className="text-[#2a2a30]">|</span>
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-[#00ffe5] animate-pulse" />
            <span className="text-[10px] font-mono text-[#555560] uppercase tracking-wider">
              Zero traces
            </span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
