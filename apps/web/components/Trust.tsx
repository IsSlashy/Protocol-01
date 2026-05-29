"use client";

import { memo } from "react";

/**
 * Trust — monochrome (white) logo marquee, scrolling left → right, on a
 * transparent background with a soft glow that bleeds into the page.
 *
 * Honest signals only ($0 raised — no investors/backers). Brand logos provided
 * by the founder, forced to pure white via `brightness(0) invert(1)` for a
 * uniform strip. Solana keeps its real 3-bar glyph.
 */
type Brand = { name: string; logo?: string; glyph?: "solana" };

const brands: Brand[] = [
  { name: "Solana", glyph: "solana" },
  { name: "Arcium", logo: "/logos/arcium.png" },
  { name: "Superteam Ireland", logo: "/logos/superteam.webp" },
  { name: "Dev3pack", logo: "/logos/dev3pack.png" },
  { name: "Colosseum Frontier", logo: "/logos/colosseum.png" },
  { name: "npm", logo: "/logos/npm.png" },
];

const SolanaGlyph = () => (
  <div className="flex items-center gap-2.5 text-white">
    <svg width="30" height="23" viewBox="0 0 24 18" fill="none" aria-hidden className="shrink-0">
      <path d="M4 13.5h15.5L16 17H0.5L4 13.5Z" fill="currentColor" />
      <path d="M4 7.25h15.5L16 10.75H0.5L4 7.25Z" fill="currentColor" />
      <path d="M4 1h15.5L16 4.5H0.5L4 1Z" fill="currentColor" />
    </svg>
    <span className="text-2xl font-bold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
      Solana
    </span>
  </div>
);

const Logo = ({ b }: { b: Brand }) => (
  <div className="mx-10 flex shrink-0 items-center opacity-70 transition-opacity duration-300 hover:opacity-100">
    {b.glyph === "solana" ? (
      <SolanaGlyph />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={b.logo}
        alt={b.name}
        className="h-8 w-auto object-contain"
        style={{ filter: "brightness(0) invert(1)" }}
      />
    )}
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
