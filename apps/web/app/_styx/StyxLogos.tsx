/**
 * StyxLogos — the ecosystem strip.
 *
 * WHY THESE LOGOS AND NOT A CLAIM. components/Trust.tsx already shipped this
 * exact set on the retired identity, with a comment stating the constraint that
 * still holds: "$0 raised — no investors/backers", so the strip is a
 * recognition signal and never a funding one. `trust.tagline` is the sentence
 * both dictionaries already carry for it — "Built on, and recognized across the
 * Solana ecosystem" / "Construit sur, et reconnu dans tout l'écosystème
 * Solana" — and it is reused verbatim rather than reworded, because the wording
 * is the honesty: built on and recognized, not funded by and partnered with.
 *
 * WHY IT MOVED HERE. components/ carries the Protocol 01 identity (Tailwind
 * classes, pink, neon halos, the marquee whose keyframes live in
 * app/globals.css) and is off limits to this page. This is the same eight
 * assets in the vault language: a static grid, no marquee, no bloom, logos
 * knocked back to the paper colour and lifted to full on hover.
 *
 * WHY STATIC AND NOT SCROLLING. A marquee that never stops is motion a reader
 * cannot dismiss, and the set is eight items — small enough to be read at once,
 * which is the whole point of showing it.
 */

type Brand = {
  name: string;
  logo: string;
  /** Cap height in rem, balancing wide wordmarks against square marks. */
  h: number;
};

const BRANDS: Brand[] = [
  { name: "Solana Foundation", logo: "/logos/solana-foundation.png", h: 1.5 },
  { name: "StarkWare", logo: "/logos/starkware.svg", h: 1.5 },
  { name: "Helius", logo: "/logos/helius.png", h: 2 },
  { name: "Jupiter", logo: "/logos/jupiter.png", h: 2.5 },
  { name: "Superteam Ireland", logo: "/logos/superteam.png", h: 2.25 },
  { name: "Dev3pack", logo: "/logos/dev3pack.png", h: 2.25 },
  { name: "Colosseum Frontier", logo: "/logos/colosseum.png", h: 2 },
  { name: "npm", logo: "/logos/npm.png", h: 1.5 },
];

export default function StyxLogos() {
  return (
    <ul className="styx-logos">
      {BRANDS.map((b) => (
        <li key={b.name} className="styx-logo">
          <img
            src={b.logo}
            alt={b.name}
            loading="lazy"
            decoding="async"
            style={{ height: `${b.h}rem` }}
          />
        </li>
      ))}
    </ul>
  );
}
