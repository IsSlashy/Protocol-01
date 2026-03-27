"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef } from "react";
import Link from "next/link";
import {
  Wallet, Radio, ArrowLeftRight, Bot, Shield, Layers,
  Lock, Calendar, Eye, Fingerprint, Globe, Zap,
} from "lucide-react";
import { useT } from "@/i18n";

const features = [
  { icon: Shield, name: "autoShield", color: "#39c5bb" },
  { icon: Wallet, name: "stealthTransfers", color: "#ff2d7a" },
  { icon: Layers, name: "privacyPools", color: "#39c5bb" },
  { icon: Radio, name: "privateSubscriptions", color: "#00ffe5" },
  { icon: ArrowLeftRight, name: "tokenSwap", color: "#39c5bb" },
  { icon: Bot, name: "aiAgent", color: "#ffcc00" },
  { icon: Lock, name: "zkProofs", color: "#ff2d7a" },
  { icon: Globe, name: "torRelay", color: "#00ffe5" },
  { icon: Eye, name: "confidentialBalances", color: "#39c5bb" },
  { icon: Fingerprint, name: "stealthMetaAddresses", color: "#ff2d7a" },
  { icon: Calendar, name: "subscriptionVaults", color: "#ffcc00" },
  { icon: Zap, name: "multiHopRouting", color: "#00ffe5" },
];

export default function Features() {
  const t = useT();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <section className="relative overflow-hidden py-28 px-4 sm:px-6 lg:px-8" ref={ref}>
      <div className="relative z-10 max-w-6xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#39c5bb]/8 border border-[#39c5bb]/15 rounded-full mb-6">
            <div className="w-1 h-1 bg-[#39c5bb] rounded-full" />
            <span className="text-[10px] font-mono text-[#39c5bb] uppercase tracking-[0.25em]">
              {t('features.badge')}
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight mb-4">
            {t('features.title1')}
            <br />
            <span className="bg-gradient-to-r from-[#39c5bb] to-[#00ffe5] bg-clip-text text-transparent">
              {t('features.title2')}
            </span>
          </h2>
        </motion.div>

        {/* Liquid Glass Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {features.map((feature, i) => (
            <motion.div
              key={feature.name}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={isInView ? { opacity: 1, scale: 1 } : {}}
              transition={{ duration: 0.4, delay: i * 0.04 }}
              className="group relative"
            >
              {/* Glow on hover */}
              <div
                className="absolute -inset-px rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-sm"
                style={{ background: `linear-gradient(135deg, ${feature.color}20, transparent 60%)` }}
              />

              {/* Card */}
              <div className="relative flex flex-col items-center text-center p-5 sm:p-6 rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm hover:bg-white/[0.05] hover:border-white/[0.12] transition-all duration-300 cursor-default h-full">
                {/* Icon */}
                <div
                  className="w-11 h-11 rounded-xl flex items-center justify-center mb-3 transition-transform duration-300 group-hover:scale-110"
                  style={{
                    backgroundColor: `${feature.color}12`,
                    border: `1px solid ${feature.color}25`,
                    color: feature.color,
                  }}
                >
                  <feature.icon size={20} strokeWidth={1.5} />
                </div>

                {/* Name */}
                <h3 className="text-sm font-semibold text-white/90 font-display tracking-wide">
                  {t(`features.${feature.name}`)}
                </h3>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Bottom */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-14 flex flex-col items-center gap-5"
        >
          {/* Network status */}
          <div className="inline-flex items-center gap-4 px-5 py-2.5 rounded-full border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-[#39c5bb] rounded-full animate-pulse" />
              <span className="text-[#39c5bb] text-xs font-mono tracking-wider">DEVNET</span>
            </div>
            <div className="w-px h-3 bg-white/10" />
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-[#ff2d7a] rounded-full" />
              <span className="text-[#555560] text-xs font-mono tracking-wider">MAINNET</span>
            </div>
          </div>

          <Link
            href="/docs"
            className="text-[#888892] text-xs font-mono tracking-wider hover:text-[#39c5bb] transition-colors"
          >
            {t('features.exploreDocs')}
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
