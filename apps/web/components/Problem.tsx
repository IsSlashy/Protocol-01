"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef, useState, useEffect } from "react";
import { Eye, Database, Network, AlertTriangle } from "lucide-react";
import { useT } from "@/i18n";

// ─── CountUp Animation ───
function CountUp({
  end,
  prefix = "",
  suffix = "",
  decimals = 0,
  duration = 2000,
  trigger,
}: {
  end: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  trigger: boolean;
}) {
  const [value, setValue] = useState(0);
  const hasStarted = useRef(false);

  useEffect(() => {
    if (!trigger || hasStarted.current) return;
    hasStarted.current = true;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setValue(eased * end);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [trigger, end, duration]);

  return (
    <>
      {prefix}
      {decimals > 0 ? value.toFixed(decimals) : Math.floor(value)}
      {suffix}
    </>
  );
}

const stats = [
  {
    icon: Eye,
    value: "100%",
    countUp: { end: 100, suffix: "%" },
    label: "problem.stat1Label" as const,
    description: "problem.stat1Desc" as const,
  },
  {
    icon: Database,
    value: "73%",
    countUp: { end: 73, suffix: "%" },
    label: "problem.stat2Label" as const,
    description: "problem.stat2Desc" as const,
  },
  {
    icon: Network,
    value: "24/7",
    countUp: undefined,
    label: "problem.stat3Label" as const,
    description: "problem.stat3Desc" as const,
  },
  {
    icon: AlertTriangle,
    value: "$4.3B",
    countUp: { end: 4.3, prefix: "$", suffix: "B", decimals: 1 },
    label: "problem.stat4Label" as const,
    description: "problem.stat4Desc" as const,
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
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.16, 1, 0.3, 1] as const,
    },
  },
} as const;

export default function Problem() {
  const t = useT();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });

  return (
    <section className="section relative overflow-hidden" ref={ref}>
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-p01-surface/30 to-transparent" />

      <div className="relative z-10 max-w-7xl mx-auto">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <span className="badge-yellow mb-4">{t("problem.badge")}</span>
          <h2 className="section-title">
            {t("problem.title")}{" "}
            <span className="text-[#ffcc00]">{t("problem.titleHighlight")}</span>
          </h2>
          <div className="section-subtitle space-y-1 [&_strong]:font-semibold [&_strong]:text-white">
            <p dangerouslySetInnerHTML={{ __html: t("problem.subtitle1") }} />
            <p dangerouslySetInnerHTML={{ __html: t("problem.subtitle2") }} />
          </div>
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
              className="bg-white/[0.02] backdrop-blur-md border border-white/[0.06] rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-all duration-300 p-6 group"
            >
              {/* Industrial square icon */}
              <div className="flex items-center justify-center w-12 h-12 bg-[#ffcc00]/10 text-[#ffcc00] border border-[#ffcc00]/30 mb-4 group-hover:scale-105 transition-transform">
                <stat.icon size={24} />
              </div>
              <div className="text-4xl font-bold font-display text-white mb-2">
                {stat.countUp ? (
                  <CountUp {...stat.countUp} trigger={isInView} />
                ) : (
                  stat.value
                )}
              </div>
              <div className="text-p01-text-muted text-sm font-medium mb-2">
                {t(stat.label)}
              </div>
              <div className="text-p01-text-dim text-xs">
                {t(stat.description)}
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
                  {t("problem.without")}
                </div>
                <div className="bg-white/[0.02] backdrop-blur-md p-6 border border-white/[0.06] rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-all duration-300">
                  <div className="space-y-3 font-mono text-sm">
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Eye className="text-p01-yellow" size={16} />
                      <span>{t("problem.sent100")}</span>
                    </div>
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Eye className="text-p01-yellow" size={16} />
                      <span>{t("problem.received50k")}</span>
                    </div>
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Eye className="text-p01-yellow" size={16} />
                      <span>{t("problem.identityExposed")}</span>
                    </div>
                  </div>
                  <div className="mt-4 p-3 bg-[#ffcc00]/10 border border-[#ffcc00]/30">
                    <span className="text-[#ffcc00] text-xs font-medium font-mono uppercase">
                      {t("problem.exposedStatus")}
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
                  {t("problem.with")}
                </div>
                <div className="bg-white/[0.03] backdrop-blur-md p-6 border border-white/[0.08] rounded-2xl hover:bg-white/[0.05] hover:border-white/[0.12] transition-all duration-300">
                  <div className="space-y-3 font-mono text-sm">
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Shield className="text-p01-cyan" size={16} />
                      <span className="blur-sm">
                        {t("problem.hiddenSent")}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Shield className="text-p01-cyan" size={16} />
                      <span className="blur-sm">
                        {t("problem.hiddenReceived")}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-p01-text-muted">
                      <Shield className="text-p01-cyan" size={16} />
                      <span className="blur-sm">{t("problem.hiddenIdentity")}</span>
                    </div>
                  </div>
                  <div className="mt-4 p-3 bg-[#39c5bb]/10 border border-[#39c5bb]/30">
                    <span className="text-[#39c5bb] text-xs font-medium font-mono uppercase">
                      {t("problem.anonymousStatus")}
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
