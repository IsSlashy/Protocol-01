"use client";

import { memo } from "react";

/**
 * Trust — credibility strip.
 *
 * Honest signals only. Protocol 01 has raised $0, so there are no investors or
 * "backers" to show. What it DOES have, and what is shown here, is verifiable:
 * the tech it is built on (Solana, Arcium MPC), real ecosystem recognition
 * (Dev3pack #2 worldwide, Superteam Ireland), an accelerator application
 * (Colosseum Frontier, applicant — not accepted), and open-source SDKs.
 * Brand names are not translated, so this component is intentionally not i18n.
 */
const items: { label: string; name: string; sub?: string }[] = [
  { label: "Built on", name: "Solana" },
  { label: "Powered by", name: "Arcium MPC" },
  { label: "#2 worldwide", name: "Dev3pack 2026", sub: "Solana track" },
  { label: "Recognized by", name: "Superteam Ireland" },
  { label: "Applicant", name: "Colosseum Frontier" },
  { label: "Open source", name: "npm SDKs" },
];

function Trust() {
  return (
    <section className="relative border-y border-[#2a2a30] bg-[#0a0a0c] py-10">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <p className="text-center text-[#555560] text-xs font-mono uppercase tracking-[0.3em] mb-8">
          Built on, and recognized across the Solana ecosystem
        </p>
        <div className="flex flex-wrap items-stretch justify-center gap-3 sm:gap-4">
          {items.map((it) => (
            <div
              key={it.name}
              className="group flex min-w-[150px] flex-col justify-center border border-[#2a2a30] bg-[#151518] px-5 py-3 transition-colors hover:border-[#39c5bb]/50"
            >
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#39c5bb]">
                {it.label}
              </span>
              <span
                className="mt-1 text-sm font-bold text-white"
                style={{ fontFamily: "var(--font-display)" }}
              >
                {it.name}
              </span>
              {it.sub && (
                <span className="mt-0.5 font-mono text-[10px] text-[#555560]">{it.sub}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default memo(Trust);
