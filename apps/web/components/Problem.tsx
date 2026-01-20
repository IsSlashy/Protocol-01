"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import { Eye, Database, Network, AlertTriangle } from "lucide-react";

const stats = [
  {
    icon: Eye,
    value: "100%",
    label: "of blockchain transactions are public",
    description: "Every transfer you make is permanently recorded and visible to anyone",
  },
  {
    icon: Database,
    value: "73%",
    label: "of users have been deanonymized",
    description: "Blockchain analytics can link your wallet to your real identity",
  },
  {
    icon: Network,
    value: "24/7",
    label: "surveillance by governments & corporations",
    description: "Your financial activity is constantly monitored and analyzed",
  },
  {
    icon: AlertTriangle,
    value: "$4.3B",
    label: "stolen through wallet tracking",
    description: "Bad actors use public data to target high-value wallets",
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: "easeOut",
    },
  },
};

export default function Problem() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-p01-void via-p01-surface/30 to-p01-void" />

      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <span className="badge-yellow mb-4">The Problem</span>
          <h2 className="section-title">
            Your blockchain activity is{" "}
            <span className="text-[#ffcc00]">completely exposed</span>
          </h2>
          <p className="section-subtitle">
            Traditional blockchains offer pseudonymity, not privacy. Every transaction
            you make creates a permanent trail that can be traced back to you.
          </p>
        </motion.div>

        {/* Stats Grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate={isInView ? "visible" : "hidden"}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {stats.map((stat, index) => (
            <motion.div
              key={index}
              variants={itemVariants}
              className="card-hover p-6 group"
            >
              {/* Industrial square icon */}
              <div className="flex items-center justify-center w-12 h-12 bg-[#ffcc00]/10 text-[#ffcc00] border border-[#ffcc00]/30 mb-4 group-hover:scale-105 transition-transform">
                <stat.icon size={24} />
              </div>
              <div className="text-4xl font-bold font-display text-white mb-2">
                {stat.value}
              </div>
              <div className="text-p01-text-muted text-sm font-medium mb-2">
                {stat.label}
              </div>
              <div className="text-p01-text-dim text-xs">
                {stat.description}
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Visual Representation */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={isInView ? { opacity: 1, scale: 1 } : {}}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-16 relative"
        >
          <div className="card p-8 overflow-hidden">
            <div className="flex flex-col lg:flex-row items-center gap-8">
              {/* Before - Exposed */}
              <div className="flex-1 text-center">
                <div className="text-p01-yellow font-mono text-sm mb-4 uppercase tracking-wider">
                  WITHOUT PROTOCOL 01
                </div>
                <div className="bg-[#0a0a0c] p-6 border border-[#ffcc00]/30">
                  <div className="space-y-3 font-mono text-sm">
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Eye className="text-p01-yellow" size={16} />
                      <span>7xK9f...8c2e sent 100 SOL</span>
                    </div>
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Eye className="text-p01-yellow" size={16} />
                      <span>7xK9f...8c2e received 50k USDC</span>
                    </div>
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Eye className="text-p01-yellow" size={16} />
                      <span>7xK9f...8c2e = John Smith</span>
                    </div>
                  </div>
                  <div className="mt-4 p-3 bg-[#ffcc00]/10 border border-[#ffcc00]/30">
                    <span className="text-[#ffcc00] text-xs font-medium font-mono uppercase">
                      Identity Exposed - All history visible
                    </span>
                  </div>
                </div>
              </div>

              {/* Arrow */}
              <div className="text-p01-text-dim text-4xl">
                <motion.span
                  animate={{ x: [0, 10, 0] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                >
                  &rarr;
                </motion.span>
              </div>

              {/* After - Protected */}
              <div className="flex-1 text-center">
                <div className="text-p01-cyan font-mono text-sm mb-4 uppercase tracking-wider">
                  WITH PROTOCOL 01
                </div>
                <div className="bg-[#0a0a0c] p-6 border border-[#39c5bb]/30">
                  <div className="space-y-3 font-mono text-sm">
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Shield className="text-p01-cyan" size={16} />
                      <span className="blur-sm">????...???? sent ??? SOL</span>
                    </div>
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Shield className="text-p01-cyan" size={16} />
                      <span className="blur-sm">????...???? received ??? USDC</span>
                    </div>
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Shield className="text-p01-cyan" size={16} />
                      <span className="blur-sm">Identity = Unknown</span>
                    </div>
                  </div>
                  <div className="mt-4 p-3 bg-[#39c5bb]/10 border border-[#39c5bb]/30">
                    <span className="text-[#39c5bb] text-xs font-medium font-mono uppercase">
                      Fully Anonymous - Zero knowledge
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function Shield(props: { className?: string; size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={props.size || 24}
      height={props.size || 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
