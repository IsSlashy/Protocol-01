"use client";

import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { TrendingUp, Store, Code2 } from "lucide-react";

const cols = [
  {
    icon: TrendingUp,
    color: "#39c5bb",
    tag: "Traders & whales",
    title: "Move before the crowd does",
    body:
      "Watchers track big wallets and front-run their every move. Here your size, entries and exits stay invisible until you choose to reveal them.",
  },
  {
    icon: Store,
    color: "#ff2d7a",
    tag: "Merchants",
    title: "Get paid, prove it, store nothing",
    body:
      "Accept private payments and verify subscribers without ever holding their wallet or identity. No database, no breach, no compliance liability.",
  },
  {
    icon: Code2,
    color: "#ffcc00",
    tag: "Builders",
    title: "Ship privacy without building it",
    body:
      "Import a few functions and ship. Proofs, encryption and settlement are handled for you. No cryptographers to hire, no proving servers to run. Live in days, not quarters.",
  },
];

export default function ValueProp() {
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
              Why it pays
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight">
            Privacy that makes
            <br />
            <span className="bg-gradient-to-r from-[#39c5bb] to-[#00ffe5] bg-clip-text text-transparent">
              or saves you money.
            </span>
          </h2>
        </motion.div>

        <div className="grid gap-4 md:grid-cols-3">
          {cols.map((c, i) => (
            <motion.div
              key={c.tag}
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
                {c.tag}
              </span>
              <h3 className="mb-3 text-xl font-bold text-white font-display">{c.title}</h3>
              <p className="text-sm leading-relaxed text-[#888892]">{c.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
