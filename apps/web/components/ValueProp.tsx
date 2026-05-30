"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { TrendingUp, Store, Code2 } from "lucide-react";
import { useT } from "@/i18n";

const cols = [
  { icon: TrendingUp, color: "#39c5bb", key: "traders" },
  { icon: Store, color: "#ff2d7a", key: "merchants" },
  { icon: Code2, color: "#ffcc00", key: "builders" },
] as const;

export default function ValueProp() {
  const t = useT();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <section className="relative py-28 px-4 sm:px-6 lg:px-8" ref={ref}>
      <div className="relative z-10 max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#39c5bb]/8 border border-[#39c5bb]/15 rounded-full mb-6">
            <div className="w-1 h-1 bg-[#39c5bb] rounded-full" />
            <span className="text-[10px] font-mono text-[#39c5bb] uppercase tracking-[0.25em]">
              {t("valueProp.badge")}
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight">
            {t("valueProp.titleLine1")}
            <br />
            <span className="bg-gradient-to-r from-[#39c5bb] to-[#00ffe5] bg-clip-text text-transparent">
              {t("valueProp.titleLine2")}
            </span>
          </h2>
        </motion.div>

        <div className="grid gap-4 md:grid-cols-3">
          {cols.map((c, i) => (
            <motion.div
              key={c.key}
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="flex flex-col rounded-2xl border border-white/[0.06] bg-white/[0.02] p-7 backdrop-blur-sm"
            >
              <div
                className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl"
                style={{
                  backgroundColor: `${c.color}12`,
                  border: `1px solid ${c.color}25`,
                  color: c.color,
                }}
              >
                <c.icon size={22} strokeWidth={1.5} />
              </div>
              <span
                className="mb-2 font-mono text-[11px] uppercase tracking-wider"
                style={{ color: c.color }}
              >
                {t(`valueProp.${c.key}Tag`)}
              </span>
              <h3 className="mb-3 text-xl font-bold text-white font-display">
                {t(`valueProp.${c.key}Title`)}
              </h3>
              <p className="text-sm leading-relaxed text-[#888892]">
                {t(`valueProp.${c.key}Body`)}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
