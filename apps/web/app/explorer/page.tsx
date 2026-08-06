"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";
import ObserverTest from "@/components/explorer/ObserverTest";
import { useT } from "@/i18n";
import type { NetworkMetrics } from "@/lib/metrics/types";
import { STARK_CIRCUIT_LIST } from "@/lib/metrics/types";

const EXPLORER_BASE = "https://explorer.solana.com";
const cluster = "?cluster=devnet";

function fmt(n: number, max = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

function StatCard({
  value,
  label,
  hint,
  color = "#39c5bb",
  delay = 0,
}: {
  value: string;
  label: string;
  hint?: string;
  color?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md p-6 hover:bg-white/[0.04] hover:border-white/[0.12] transition-colors"
    >
      <div className="text-3xl sm:text-4xl font-bold font-display mb-2" style={{ color }}>
        {value}
      </div>
      <div className="text-p01-text-muted text-sm font-medium">{label}</div>
      {hint && <div className="text-p01-text-dim text-xs mt-1">{hint}</div>}
    </motion.div>
  );
}

/** Anonymity-set visualizer: a crowd of indistinguishable dots per pool. */
function AnonymitySet({ count, max = 64 }: { count: number; max?: number }) {
  const shown = Math.min(count, max);
  return (
    <div className="flex flex-wrap gap-1.5">
      {Array.from({ length: shown }).map((_, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0, scale: 0 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.3, delay: Math.min(i * 0.012, 0.6) }}
          className="w-2 h-2 rounded-full bg-[#39c5bb]/70"
        />
      ))}
      {count > max && (
        <span className="text-[10px] font-mono text-p01-text-dim self-center ml-1">
          +{fmt(count - max, 0)}
        </span>
      )}
    </div>
  );
}

export default function ExplorerPage() {
  const t = useT();
  const [m, setM] = useState<NetworkMetrics | null>(null);
  const [relayer, setRelayer] = useState<"green" | "orange" | "red" | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/metrics", { cache: "no-store" });
        const data = (await res.json()) as NetworkMetrics;
        if (alive) setM(data);
      } catch {
        /* keep last snapshot */
      }
    };
    const loadRelayer = async () => {
      try {
        const res = await fetch("/api/relayer-health", { cache: "no-store" });
        const data = await res.json();
        if (alive) setRelayer(data?.status ?? null);
      } catch {
        /* ignore */
      }
    };
    load();
    loadRelayer();
    const id = setInterval(() => {
      load();
      loadRelayer();
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const tvlSol = m?.tvlByToken.SOL ?? 0;
  const notes = m?.totalNotes ?? 0;
  const pools = m?.activePools ?? 0;
  const live = m?.live ?? false;
  const relayerColor =
    relayer === "green" ? "#39c5bb" : relayer === "orange" ? "#ffcc00" : relayer === "red" ? "#ff3366" : "#555560";

  return (
    <div className="min-h-screen bg-p01-void text-white">
      <SiteHeader />

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 pb-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="flex items-center gap-3 mb-4">
            <span className="badge-cyan">{t("explorer.badge")}</span>
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-p01-text-dim">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: live ? "#39c5bb" : "#555560" }}
              />
              {live ? t("explorer.statusLive") : t("explorer.statusOffline")}
              <span className="text-p01-text-dim/60">· {m?.network ?? "devnet"}</span>
            </span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-bold font-display tracking-tight mb-3">
            {t("explorer.title")} <span className="text-cyan">{t("explorer.titleAccent")}</span>
          </h1>
          <p className="text-base sm:text-lg text-p01-text-muted max-w-2xl whitespace-pre-line">
            {t("explorer.subtitle")}
          </p>
        </motion.div>
      </section>

      {/* Stat grid */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-10">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatCard
            value={`${fmt(tvlSol)} SOL`}
            label={t("explorer.stat.tvl")}
            hint={t("explorer.stat.tvlHint")}
            delay={0}
          />
          <StatCard
            value={fmt(notes, 0)}
            label={t("explorer.stat.anonSet")}
            hint={t("explorer.stat.anonSetHint")}
            delay={0.05}
          />
          <StatCard
            value={fmt(pools, 0)}
            label={t("explorer.stat.pools")}
            hint={t("explorer.stat.poolsHint")}
            delay={0.1}
          />
          <StatCard
            value="7"
            label={t("explorer.stat.circuits")}
            hint={t("explorer.stat.circuitsHint")}
            color="#00ffe5"
            delay={0.15}
          />
        </div>
      </section>

      {/* Observer Test */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <ObserverTest />
      </section>

      {/* Anonymity sets per pool */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <div className="mb-5">
          <span className="badge-cyan mb-2 inline-block">{t("explorer.anon.badge")}</span>
          <h2 className="text-2xl font-bold font-display">{t("explorer.anon.title")}</h2>
          <p className="text-sm text-p01-text-muted mt-1 max-w-2xl">{t("explorer.anon.subtitle")}</p>
        </div>
        {m && m.pools.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
            {m.pools.map((p) => (
              <a
                key={p.address}
                href={`${EXPLORER_BASE}/address/${p.address}${cluster}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md p-5 hover:bg-white/[0.04] hover:border-[#39c5bb]/30 transition-colors block"
              >
                <div className="flex items-baseline justify-between mb-3">
                  <span className="font-display font-bold">
                    {p.denomination} {p.token}
                  </span>
                  <span className="text-xs font-mono text-p01-text-muted">
                    1 {t("explorer.anon.of")} {fmt(p.noteCount, 0)}
                  </span>
                </div>
                <AnonymitySet count={p.noteCount} />
              </a>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center text-sm text-p01-text-dim font-mono">
            {live ? t("explorer.anon.empty") : t("explorer.anon.loading")}
          </div>
        )}
      </section>

      {/* Circuit grid */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
        <div className="mb-5">
          <span className="badge-cyan mb-2 inline-block">{t("explorer.circuits.badge")}</span>
          <h2 className="text-2xl font-bold font-display">{t("explorer.circuits.title")}</h2>
          <p className="text-sm text-p01-text-muted mt-1 max-w-2xl">{t("explorer.circuits.subtitle")}</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {STARK_CIRCUIT_LIST.map((c) => (
            <div
              key={c.id}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover:border-[#39c5bb]/30 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-p01-text-dim">C{c.id}</span>
                <span className="text-[9px] font-mono uppercase tracking-wider text-[#00ffe5] border border-[#00ffe5]/30 bg-[#00ffe5]/10 px-1.5 py-0.5 rounded">
                  PQ
                </span>
              </div>
              <div className="font-display text-sm font-semibold">{c.name}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Network footer line */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-mono">
          <span className="inline-flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ background: relayerColor }} />
            {t("explorer.net.relayer")}:{" "}
            <span style={{ color: relayerColor }}>{relayer ?? "n/a"}</span>
          </span>
          <span className="text-p01-text-dim">
            {t("explorer.net.snapshot")}:{" "}
            {m?.snapshotAt ? new Date(m.snapshotAt).toLocaleTimeString() : "n/a"}
          </span>
          <a
            href={`${EXPLORER_BASE}/address/2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms${cluster}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#39c5bb] hover:underline ml-auto"
          >
            {t("explorer.net.program")} ↗
          </a>
        </div>
      </section>

      <Footer />
    </div>
  );
}
