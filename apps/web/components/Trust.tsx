"use client";

import { memo } from "react";

/**
 * Trust — animated credibility marquee.
 *
 * Honest signals only (Protocol 01 has raised $0 — no investors/backers shown).
 * What IS shown is verifiable: the tech it is built on (Solana, Arcium MPC),
 * real recognition (Dev3pack #2 worldwide, Superteam Ireland), an accelerator
 * application (Colosseum Frontier, applicant), and open-source SDKs.
 *
 * Marks are brand-colored monogram tiles (Solana uses its real 3-bar mark).
 * Drop official SVGs into /public/logos and swap the <Mark> for <img> later.
 */
type Item = { label: string; name: string; sub?: string; color: string; mono: string };

const items: Item[] = [
  { label: "Built on", name: "Solana", color: "#14f195", mono: "solana" },
  { label: "Powered by", name: "Arcium MPC", color: "#39c5bb", mono: "Ar" },
  { label: "#2 worldwide", name: "Dev3pack 2026", sub: "Solana track", color: "#ffcc00", mono: "#2" },
  { label: "Recognized by", name: "Superteam IE", color: "#ff2d7a", mono: "ST" },
  { label: "Applicant", name: "Colosseum Frontier", color: "#00ffe5", mono: "C" },
  { label: "Open source", name: "npm SDKs", color: "#ff3366", mono: "npm" },
];

const SolanaMark = ({ color }: { color: string }) => (
  <svg width="20" height="16" viewBox="0 0 24 18" fill="none" aria-hidden>
    <path d="M4 13.5h15.5L16 17H0.5L4 13.5Z" fill={color} />
    <path d="M4 7.25h15.5L16 10.75H0.5L4 7.25Z" fill={color} opacity="0.75" />
    <path d="M4 1h15.5L16 4.5H0.5L4 1Z" fill={color} opacity="0.5" />
  </svg>
);

const Card = ({ it }: { it: Item }) => (
  <div className="mx-2 flex min-w-[210px] items-center gap-3 border border-[#2a2a30] bg-[#151518] px-4 py-3 transition-colors hover:border-white/25">
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-bold"
      style={{ backgroundColor: `${it.color}1a`, border: `1px solid ${it.color}40`, color: it.color }}
    >
      {it.mono === "solana" ? <SolanaMark color={it.color} /> : (
        <span className="font-mono text-[11px] leading-none">{it.mono}</span>
      )}
    </div>
    <div className="flex flex-col">
      <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: it.color }}>
        {it.label}
      </span>
      <span className="text-sm font-bold text-white" style={{ fontFamily: "var(--font-display)" }}>
        {it.name}
      </span>
      {it.sub && <span className="font-mono text-[9px] text-[#555560]">{it.sub}</span>}
    </div>
  </div>
);

function Trust() {
  // Duplicate the track so the marquee loops seamlessly.
  const track = [...items, ...items];
  return (
    <section className="relative border-y border-[#2a2a30] bg-[#0a0a0c] py-9">
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes trust-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .trust-track { animation: trust-scroll 34s linear infinite; }
        .trust-marquee:hover .trust-track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) { .trust-track { animation: none; } }
      `}} />
      <p className="mb-7 text-center font-mono text-xs uppercase tracking-[0.3em] text-[#555560]">
        Built on, and recognized across the Solana ecosystem
      </p>
      <div
        className="trust-marquee relative overflow-hidden"
        style={{
          maskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)",
          WebkitMaskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)",
        }}
      >
        <div className="trust-track flex w-max">
          {track.map((it, i) => (
            <Card key={`${it.name}-${i}`} it={it} />
          ))}
        </div>
      </div>
    </section>
  );
}

export default memo(Trust);
