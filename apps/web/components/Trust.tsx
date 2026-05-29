"use client";

import { memo } from "react";

/**
 * Trust — monochrome (white-on-black) logo marquee, scrolling left → right.
 *
 * Honest signals only. Protocol 01 has raised $0, so no investors/backers are
 * shown. The header frames the strip as "built on / recognized", not "backed by".
 * Marks are clean white wordmarks (Solana keeps its real 3-bar glyph). Drop
 * official white SVGs into /public/logos and swap <Logo> for <img> for a
 * pixel-perfect set.
 */
type Brand = { name: string; glyph?: "solana" };

const brands: Brand[] = [
  { name: "Solana", glyph: "solana" },
  { name: "Arcium" },
  { name: "Superteam" },
  { name: "Dev3pack" },
  { name: "Colosseum" },
  { name: "npm" },
];

const SolanaGlyph = () => (
  <svg width="22" height="17" viewBox="0 0 24 18" fill="none" aria-hidden className="shrink-0">
    <path d="M4 13.5h15.5L16 17H0.5L4 13.5Z" fill="currentColor" />
    <path d="M4 7.25h15.5L16 10.75H0.5L4 7.25Z" fill="currentColor" />
    <path d="M4 1h15.5L16 4.5H0.5L4 1Z" fill="currentColor" />
  </svg>
);

const Logo = ({ b }: { b: Brand }) => (
  <div className="mx-9 flex shrink-0 items-center gap-2.5 text-white/65 transition-colors duration-300 hover:text-white">
    {b.glyph === "solana" && <SolanaGlyph />}
    <span
      className="text-xl font-bold tracking-tight"
      style={{ fontFamily: "var(--font-display)" }}
    >
      {b.name}
    </span>
  </div>
);

function Trust() {
  // Duplicate the set so the marquee loops seamlessly.
  const track = [...brands, ...brands];
  return (
    <section className="relative border-y border-[#1a1a1e] bg-black py-10">
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes trust-ltr { from { transform: translateX(-50%); } to { transform: translateX(0); } }
        .trust-track { animation: trust-ltr 30s linear infinite; will-change: transform; }
        .trust-marquee:hover .trust-track { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) { .trust-track { animation: none; } }
      `}} />
      <p className="mb-8 text-center font-mono text-xs uppercase tracking-[0.3em] text-[#555560]">
        Built on, and recognized across the Solana ecosystem
      </p>
      <div
        className="trust-marquee relative overflow-hidden"
        style={{
          maskImage: "linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent)",
          WebkitMaskImage: "linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent)",
        }}
      >
        <div className="trust-track flex w-max items-center">
          {track.map((b, i) => (
            <Logo key={`${b.name}-${i}`} b={b} />
          ))}
        </div>
      </div>
    </section>
  );
}

export default memo(Trust);
