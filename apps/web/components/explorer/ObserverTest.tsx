"use client";

import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useT } from "@/i18n";

/**
 * The Observer Test — the signature module of the explorer.
 *
 * Shows the SAME payment two ways, side by side:
 *   left  = what a transparent chain reveals (sender, recipient, amount, memo)
 *   right = what Protocol 01 reveals (everything redacted, only the proof)
 *
 * It dramatizes the product in two seconds and — crucially — works at zero
 * devnet volume, because it's a conceptual demonstration, not a live feed.
 */
function Redacted({ reveal, plain, label }: { reveal: boolean; plain: string; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase tracking-wider text-p01-text-dim">{label}</span>
      <AnimatePresence mode="wait" initial={false}>
        {reveal ? (
          <motion.span
            key="plain"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-sm font-mono text-[#ff3366]"
          >
            {plain}
          </motion.span>
        ) : (
          <motion.span
            key="hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-sm font-mono text-[#39c5bb] select-none"
            style={{ filter: "blur(0px)" }}
          >
            ████████████
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function ObserverTest() {
  const t = useT();
  // Default to the revealed (transparent-chain) view so the contrast is
  // immediate: plaintext leak on the left vs redacted blocks on the right.
  // Otherwise both columns show blue blocks and look identical.
  const [reveal, setReveal] = useState(true);

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-md p-6 sm:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <span className="badge-cyan mb-2 inline-block">{t("explorer.observer.badge")}</span>
          <h3 className="text-xl font-bold font-display text-white">
            {t("explorer.observer.title")}
          </h3>
          <p className="text-sm text-p01-text-muted mt-1 max-w-xl">
            {t("explorer.observer.subtitle")}
          </p>
        </div>
        <button
          onClick={() => setReveal((r) => !r)}
          className={`shrink-0 text-xs font-mono uppercase tracking-wider px-4 py-2 rounded-lg border transition-colors ${
            reveal
              ? "border-[#ff3366]/40 bg-[#ff3366]/10 text-[#ff3366]"
              : "border-[#39c5bb]/40 bg-[#39c5bb]/10 text-[#39c5bb]"
          }`}
        >
          {reveal ? t("explorer.observer.toggleHide") : t("explorer.observer.toggleShow")}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Standard chain */}
        <div
          className={`rounded-xl border p-5 transition-colors ${
            reveal ? "border-[#ff3366]/30 bg-[#ff3366]/[0.04]" : "border-white/[0.06] bg-white/[0.01]"
          }`}
        >
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-[#ff3366]" />
            <span className="text-xs font-mono uppercase tracking-wider text-p01-text-muted">
              {t("explorer.observer.standardChain")}
            </span>
          </div>
          <div className="flex flex-col gap-3">
            <Redacted reveal={reveal} label={t("explorer.observer.from")} plain="7xKqR2…9fA2" />
            <Redacted reveal={reveal} label={t("explorer.observer.to")} plain="Disney+ (merchant)" />
            <Redacted reveal={reveal} label={t("explorer.observer.amount")} plain="9.99 USDC" />
            <Redacted reveal={reveal} label={t("explorer.observer.memo")} plain="Disney+ subscription" />
          </div>
        </div>

        {/* Protocol 01 */}
        <div className="rounded-xl border border-[#39c5bb]/30 bg-[#39c5bb]/[0.04] p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-[#39c5bb]" />
            <span className="text-xs font-mono uppercase tracking-wider text-[#39c5bb]">
              {t("explorer.observer.protocol01")}
            </span>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-p01-text-dim">
                {t("explorer.observer.from")}
              </span>
              <span className="text-sm font-mono text-[#39c5bb] select-none">████████████</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-p01-text-dim">
                {t("explorer.observer.to")}
              </span>
              <span className="text-sm font-mono text-[#39c5bb] select-none">████████████</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-p01-text-dim">
                {t("explorer.observer.amount")}
              </span>
              <span className="text-sm font-mono text-[#39c5bb] select-none">████████████</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-p01-text-dim">
                {t("explorer.observer.proof")}
              </span>
              <span className="text-sm font-mono text-white">
                C3 Merkle Path <span className="text-[#39c5bb]">✓ verified</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <p className="text-xs text-p01-text-dim mt-5 font-mono">
        {t("explorer.observer.footnote")}
      </p>
    </div>
  );
}

export default memo(ObserverTest);
