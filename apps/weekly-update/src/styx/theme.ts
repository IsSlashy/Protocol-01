import { NEWSREADER } from './fonts';

/**
 * The Styx design system, for video.
 *
 * These are the same tokens as apps/web/app/_styx/styx.css, restated here
 * because a Remotion bundle cannot import that stylesheet. If a value changes on
 * the site, change it here too; they are meant to be the same protocol seen in
 * two media.
 *
 * The old src/theme.ts stays where it is: the six week-N compositions still use
 * it, and rewriting videos that were already published would be lying about what
 * they looked like.
 */
export const styx = {
  /* ---- Ground and ink -------------------------------------------------- */
  ink: '#070709',
  panel: '#0d0d10',
  panel2: '#101014',
  paper: '#eae7df',
  muted: 'rgba(234, 231, 223, 0.62)',
  faint: 'rgba(234, 231, 223, 0.4)',
  rule: 'rgba(234, 231, 223, 0.14)',
  ruleSoft: 'rgba(234, 231, 223, 0.07)',

  /** A seal, not a colour. Status dots, section ticks, one travelling light. */
  seal: '#39c5bb',
  /** The one place amber is allowed: an admission the viewer must not miss. */
  warn: '#d9a24a',
} as const;

export const styxFonts = {
  /** Statements. Weight is the axis: 300 display, 400 titles, 500 small. */
  serif: NEWSREADER,
  /** Body copy. */
  sans: 'Inter, system-ui, -apple-system, sans-serif',
  /** Evidence: labels, addresses, compute units, overlines. */
  mono: 'JetBrains Mono, Fira Code, ui-monospace, monospace',
} as const;

/**
 * A 4K type scale. These are absolute pixel sizes for a 3840 by 2160 frame, so
 * they look absurd next to web values and are correct here: 3840 is two times a
 * 1920 layout, so a 76px web headline is a 152px frame headline.
 */
export const type = {
  display: 232,
  h1: 152,
  h2: 104,
  h3: 64,
  lede: 52,
  body: 42,
  label: 30,
  micro: 26,
} as const;

/** Tracking for the uppercase mono labels, which need air at every size. */
export const tracking = {
  label: '0.18em',
  micro: '0.24em',
} as const;

/** One rhythm for the whole video, so no scene invents its own margins. */
export const space = {
  frameX: 260,
  frameY: 190,
  gap: 48,
  gapLg: 96,
} as const;

/**
 * What this design forbids, written down because the previous identity did all
 * of it and a scene author will otherwise reach for the nearest habit:
 * no Orbitron, no glow orbs, no grid background, no pink, no gradient text,
 * no drop-shadow halos, no rounded pills, and no cyan used as a fill.
 */
export const FORBIDDEN = [
  'Orbitron',
  'glow orbs',
  'grid background',
  'pink #ff77a8',
  'gradient text',
  'neon box-shadow',
  'cyan as a fill colour',
] as const;
