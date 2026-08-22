/**
 * The Styx mark.
 *
 * 🚨 I DREW THE WRONG ONE FIRST. The first version of this file invented a
 * circle-and-crossbar glyph, and the founder's answer was immediate: "le logo
 * n'est pas le notre". It was not. Inventing a mark for a brand that already
 * has one is not a design decision, it is a failure to look.
 *
 * The real mark is `apps/web/public/styx-mark.png`: a high-contrast serif S cut
 * by a cyan diagonal. It is COMPOSED here rather than loaded, because the
 * extension already ships Newsreader for its display type, so the letterform is
 * a font the popup has and the slash is one line. That means it scales to any
 * size, takes the surrounding text colour, needs no second asset for a light
 * ground, and renders before any image request resolves.
 *
 * ⚠️ The raster is still shipped at `public/styx-mark.png` for the boot frame
 * in popup.html, which paints before React and therefore before any font or
 * component exists.
 */

import { cn } from '@/shared/utils';

interface WordmarkProps {
  /** Height of the mark in px. The name scales with it. */
  size?: number;
  showText?: boolean;
  /** Kept for signature parity with the mark this replaced. */
  animated?: boolean;
  className?: string;
}

export default function Wordmark({
  size = 32,
  showText = false,
  animated = false,
  className,
}: WordmarkProps) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span
        role="img"
        aria-label="Styx"
        className={cn('relative inline-block shrink-0 select-none', animated && 'animate-fadeIn')}
        style={{ width: size, height: size }}
      >
        {/* The letterform. Newsreader at a light weight is the same face the
            headings use, which is why the mark and the product read as one
            thing rather than a logo pasted onto an interface. */}
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center font-display font-light leading-none text-p01-text"
          style={{ fontSize: size * 1.02, lineHeight: 1 }}
        >
          S
        </span>

        {/* The cut. Drawn edge to edge and tapered, so it reads as a slash
            through the letter rather than a border on a box. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 32 32"
          className="absolute inset-0 h-full w-full text-p01-cyan"
          fill="none"
        >
          <path
            d="M27.5 4.5 L4.5 27.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>

      {showText && (
        <span
          className="font-display font-light leading-none tracking-tight text-p01-text"
          style={{ fontSize: Math.max(15, size * 0.6) }}
        >
          Styx
        </span>
      )}
    </div>
  );
}
