"use client";

import { memo } from "react";

/**
 * Trust — monochrome (white) logo marquee, scrolling left → right, on a
 * transparent background with a soft glow that bleeds into the page.
 *
 * Honest signals only ($0 raised — no investors/backers). Founder-provided
 * brand logos, trimmed and forced to pure white. Per-logo heights balance the
 * very different aspect ratios (wide wordmarks vs square marks).
 */
type Brand = { name: string; logo: string; h: string };

const brands: Brand[] = [
  { name: "Solana", logo: "/logos/solana.png", h: "h-12" },
  { name: "Arcium", logo: "/logos/arcium.png", h: "h-8" },
  { name: "Superteam Ireland", logo: "/logos/superteam.png", h: "h-14" },
  { name: "Dev3pack", logo: "/logos/dev3pack.png", h: "h-14" },
  { name: "Colosseum Frontier", logo: "/logos/colosseum.png", h: "h-12" },
  { name: "npm", logo: "/logos/npm.png", h: "h-9" },
];

const Logo = ({ b }: { b: Brand }) => (
  <div className="mx-14 flex shrink-0 items-center opacity-70 transition-opacity duration-300 hover:opacity-100">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img
      src={b.logo}
      alt={b.name}
      className={`${b.h} w-auto object-contain`}
      style={{ filter: "brightness(0) invert(1)" }}
    />
  </div>
);

function Trust() {
  // Duplicate the set so the marquee loops seamlessly.
  const track = [...brands, ...brands];
  return (
    <section className="relative bg-transparent py-14">
      {/* Soft glow that bleeds into the page — no hard edges */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 55% 130% at 50% 50%, rgba(57,197,187,0.06), transparent 70%)",
        }}
      />
      <p className="relative mb-10 text-center font-mono text-xs uppercase tracking-[0.3em] text-[#555560]">
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
