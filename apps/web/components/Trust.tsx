"use client";

import { memo } from "react";
import { useT } from "@/i18n";

/**
 * Trust — monochrome (white) logo marquee, scrolling left → right.
 *
 * Sits between the hero and the demo with NO hard section edge: the background
 * is transparent and a soft cyan bloom extends past the section vertically, so
 * it diffuses into the sections above and below instead of reading as a band.
 *
 * Honest signals only ($0 raised — no investors/backers). Founder-provided
 * brand logos, trimmed and forced to pure white. Per-logo heights balance the
 * different aspect ratios (wide wordmarks vs square marks).
 */
type Brand = { name: string; logo: string; h: string };

const brands: Brand[] = [
  { name: "Solana", logo: "/logos/solana.png", h: "h-12" },
  { name: "Helius", logo: "/logos/helius.png", h: "h-12" },
  { name: "Jupiter", logo: "/logos/jupiter.png", h: "h-16" },
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
  const t = useT();
  // Duplicate the set so the marquee loops seamlessly.
  const track = [...brands, ...brands];
  return (
    <section className="relative bg-transparent py-16">
      {/* Diffuse bloom — extends well past the section so it melts into the
          hero above and the demo below, no hard cut. */}
      <div
        className="pointer-events-none absolute left-0 right-0"
        style={{
          top: "-200px",
          bottom: "-200px",
          background:
            "radial-gradient(ellipse 60% 55% at 50% 50%, rgba(57,197,187,0.10), rgba(57,197,187,0.04) 45%, transparent 72%)",
        }}
      />
      <p className="relative mb-10 text-center font-mono text-xs uppercase tracking-[0.3em] text-[#555560]">
        {t("trust.tagline")}
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
