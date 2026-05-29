"use client";

import { memo } from "react";

/**
 * Trust — monochrome (white) logo marquee, scrolling left → right, on a
 * transparent background with a soft glow that bleeds into the rest of the
 * page (no hard section cut).
 *
 * Honest signals only ($0 raised — no investors/backers). Marks are clean white
 * wordmarks (Solana keeps its real 3-bar glyph). Drop official white SVGs into
 * /public/logos and swap the wordmark for <img src="/logos/{slug}.svg"> for a
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
  <svg width="30" height="23" viewBox="0 0 24 18" fill="none" aria-hidden className="shrink-0">
    <path d="M4 13.5h15.5L16 17H0.5L4 13.5Z" fill="currentColor" />
    <path d="M4 7.25h15.5L16 10.75H0.5L4 7.25Z" fill="currentColor" />
    <path d="M4 1h15.5L16 4.5H0.5L4 1Z" fill="currentColor" />
  </svg>
);

const Logo = ({ b }: { b: Brand }) => (
  <div className="mx-10 flex shrink-0 items-center gap-3 text-white/70 transition-colors duration-300 hover:text-white">
    {b.glyph === "solana" && <SolanaGlyph />}
    <span className="text-2xl font-bold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
      {b.name}
    </span>
  </div>
);

function Trust() {
  // Duplicate the set so the marquee loops seamlessly.
  const track = [...brands, ...brands];
  return (
    <section className="relative bg-transparent py-12">
      {/* Soft glow that bleeds into the page — no hard edges */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 55% 130% at 50% 50%, rgba(57,197,187,0.06), transparent 70%)",
        }}
      />
      <p className="relative mb-9 text-center font-mono text-xs uppercase tracking-[0.3em] text-[#555560]">
        Built on, and recognized across the Solana ecosystem
      </p>
      <div
        className="trust-marquee-wrap relative overflow-hidden"
        style={{
          maskImage: "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)",
          WebkitMaskImage: "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)",
        }}
      >
        <div className="trust-track-anim flex w-max items-center">
          {track.map((b, i) => (
            <Logo key={`${b.name}-${i}`} b={b} />
          ))}
        </div>
      </div>
    </section>
  );
}

export default memo(Trust);
