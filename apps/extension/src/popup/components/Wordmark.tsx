/**
 * The Styx wordmark.
 *
 * ⛔ REPLACES `GlitchLogo`, THE "01" MARK. Founder ruling 2026-08-23: the 01
 * logo is retired. It was a glitch-animated numeral in hot pink, which is two
 * retired things in one asset, and the raster `01-miku.png` it sat beside was
 * hardcoded into four screens plus the HTML shell.
 *
 * What replaces it is the site's own voice rather than a new invention: the
 * name set in Newsreader at weight 300 with tight tracking, which is exactly
 * how every heading on protocol-01.dev is set. A wallet and its website that
 * share a brand should not need a logo file to look related.
 *
 * The glyph is drawn, not loaded. An SVG scales at any size the popup asks for,
 * carries the current text colour so it works on every ground without a second
 * asset, and costs nothing to ship. `01-miku.png` was 64px of raster that went
 * soft the moment anything rendered it larger.
 *
 * ⚠️ The prop signature deliberately mirrors GlitchLogo's (`size`, `showText`,
 * `animated`) so the swap is a one-line import change at each of its call
 * sites, and its test can keep asserting the same things.
 */

import { cn } from '@/shared/utils';

interface WordmarkProps {
  /** Height of the glyph in px. The name scales with it. */
  size?: number;
  showText?: boolean;
  /** Kept for signature parity. The mark does not animate: see below. */
  animated?: boolean;
  className?: string;
}

export default function Wordmark({
  size = 32,
  showText = true,
  animated = false,
  className,
}: WordmarkProps) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {/**
       * The mark: a hairline ring cut by a vertical rule, the same hairline
       * language the site uses to separate everything. It reads as a coin seen
       * edge-on and as a gate, which is what the protocol does to a payment:
       * value goes through, identity does not.
       *
       * `currentColor` throughout, so it inherits whatever text colour the
       * surface already decided on and never needs a dark and a light variant.
       */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        role="img"
        aria-label="Styx"
        className={cn('shrink-0 text-p01-cyan', animated && 'animate-fadeIn')}
      >
        <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.25" opacity="0.55" />
        <path d="M16 3 V29" stroke="currentColor" strokeWidth="1.25" />
        {/* The crossing: the point where the two sides stop being connected. */}
        <path d="M9.5 12.5 H22.5" stroke="currentColor" strokeWidth="1.25" opacity="0.35" />
        <path d="M9.5 19.5 H22.5" stroke="currentColor" strokeWidth="1.25" opacity="0.35" />
      </svg>

      {showText && (
        <span
          className="font-display font-light leading-none tracking-tight text-p01-text"
          style={{ fontSize: Math.max(15, size * 0.62) }}
        >
          Styx
        </span>
      )}
    </div>
  );
}
