import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { space, styx, styxFonts, tracking, type } from './theme';

/**
 * The shared vocabulary for the Styx video. Every scene composes from here and
 * writes no colours, no font stacks and no easing of its own, for the same
 * reason the site has one stylesheet: twenty scenes with their own margins read
 * as twenty videos.
 *
 * One easing for the whole film. Motion is a courtesy in this design, so it is
 * always the same courtesy: things arrive, they do not bounce.
 */
export const EASE = [0.22, 1, 0.36, 1] as const;

/** Opacity and a short rise, the only entrance this design uses. */
export const useEnter = (delay = 0, duration = 26, rise = 34) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [delay, delay + duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: (v) => cubicBezier(EASE[0], EASE[1], EASE[2], EASE[3], v),
  });
  return { opacity: t, transform: `translateY(${(1 - t) * rise}px)` };
};

/** Minimal cubic-bezier solver, so the kit needs no easing dependency. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const x = ((ax * u + bx) * u + cx) * u - t;
    const d = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(d) < 1e-6) break;
    u -= x / d;
  }
  return ((ay * u + by) * u + cy) * u;
}

/** The ground every scene sits on. Never paint a different background. */
export const Frame: React.FC<{ children: React.ReactNode; band?: boolean }> = ({
  children,
  band,
}) => (
  <AbsoluteFill
    style={{
      background: band ? styx.panel : styx.ink,
      color: styx.paper,
      fontFamily: styxFonts.sans,
      padding: `${space.frameY}px ${space.frameX}px`,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
    }}
  >
    {children}
  </AbsoluteFill>
);

/** Mono, uppercase, cyan tick. The only place a scene names itself. */
export const Eyebrow: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => {
  const enter = useEnter(delay);
  return (
    <div
      style={{
        ...enter,
        display: 'flex',
        alignItems: 'center',
        gap: 28,
        fontFamily: styxFonts.mono,
        fontSize: type.label,
        letterSpacing: tracking.label,
        textTransform: 'uppercase',
        color: styx.faint,
      }}
    >
      <div style={{ width: 64, height: 2, background: styx.seal }} />
      {children}
    </div>
  );
};

/** The act number, oversized and set in the rule colour. Editorial, not decor. */
export const Numeral: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => {
  const enter = useEnter(delay);
  return (
    <div
      style={{
        ...enter,
        fontFamily: styxFonts.serif,
        fontWeight: 300,
        fontSize: 200,
        lineHeight: 0.82,
        letterSpacing: '-0.03em',
        color: styx.rule,
      }}
    >
      {children}
    </div>
  );
};

/** A statement. Weight 300 at display size, 400 for a second-level line. */
export const Statement: React.FC<{
  children: React.ReactNode;
  delay?: number;
  size?: number;
  weight?: 300 | 400 | 500;
  maxWidth?: number;
}> = ({ children, delay = 0, size = type.h1, weight = 300, maxWidth = 2600 }) => {
  const enter = useEnter(delay, 32, 44);
  return (
    <div
      style={{
        ...enter,
        fontFamily: styxFonts.serif,
        fontWeight: weight,
        fontSize: size,
        lineHeight: 1.04,
        letterSpacing: '-0.022em',
        maxWidth,
      }}
    >
      {children}
    </div>
  );
};

/** Body copy under a statement. */
export const Lede: React.FC<{
  children: React.ReactNode;
  delay?: number;
  maxWidth?: number;
}> = ({ children, delay = 0, maxWidth = 1900 }) => {
  const enter = useEnter(delay);
  return (
    <div
      style={{
        ...enter,
        fontSize: type.lede,
        lineHeight: 1.55,
        color: styx.muted,
        maxWidth,
      }}
    >
      {children}
    </div>
  );
};

/** Evidence: an address, a compute count, a program name. */
export const Mono: React.FC<{
  children: React.ReactNode;
  delay?: number;
  size?: number;
  color?: string;
}> = ({ children, delay = 0, size = type.body, color = styx.muted }) => {
  const enter = useEnter(delay);
  return (
    <div
      style={{
        ...enter,
        fontFamily: styxFonts.mono,
        fontSize: size,
        letterSpacing: '0.02em',
        color,
      }}
    >
      {children}
    </div>
  );
};

/**
 * A hairline that draws itself from the left, with the cyan seal on its head.
 * This is the one gesture carried over from the site's hero rule.
 */
export const Rule: React.FC<{ delay?: number; width?: number | string }> = ({
  delay = 0,
  width = '100%',
}) => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [delay, delay + 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: (v) => cubicBezier(EASE[0], EASE[1], EASE[2], EASE[3], v),
  });
  return (
    <div style={{ position: 'relative', width, height: 2 }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: styx.rule,
          transform: `scaleX(${scale})`,
          transformOrigin: 'left',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: -2,
          width: 96,
          height: 6,
          background: styx.seal,
          opacity: scale,
        }}
      />
    </div>
  );
};

/** A hairline grid of cards, borders shared rather than doubled. */
export const CardRow: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => {
  const enter = useEnter(delay);
  return (
    <div
      style={{
        ...enter,
        display: 'grid',
        gridAutoFlow: 'column',
        gridAutoColumns: '1fr',
        gap: 2,
        background: styx.rule,
        border: `2px solid ${styx.rule}`,
      }}
    >
      {children}
    </div>
  );
};

export const Card: React.FC<{
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  band?: boolean;
}> = ({ label, value, note, band }) => (
  <div style={{ background: band ? styx.ink : styx.panel, padding: 56 }}>
    <div
      style={{
        fontFamily: styxFonts.mono,
        fontSize: type.micro,
        letterSpacing: tracking.micro,
        textTransform: 'uppercase',
        color: styx.faint,
        marginBottom: 28,
      }}
    >
      {label}
    </div>
    <div
      style={{
        fontFamily: styxFonts.serif,
        fontWeight: 500,
        fontSize: type.h3,
        lineHeight: 1.12,
        marginBottom: note ? 20 : 0,
      }}
    >
      {value}
    </div>
    {note ? (
      <div style={{ fontSize: type.body, lineHeight: 1.45, color: styx.muted }}>{note}</div>
    ) : null}
  </div>
);

/** The one place amber is allowed. Use it for what the viewer must not miss. */
export const Admission: React.FC<{
  title: string;
  children: React.ReactNode;
  delay?: number;
}> = ({ title, children, delay = 0 }) => {
  const enter = useEnter(delay);
  return (
    <div
      style={{
        ...enter,
        border: `2px solid rgba(217, 162, 74, 0.45)`,
        background: 'rgba(217, 162, 74, 0.05)',
        padding: '44px 52px',
        maxWidth: 2400,
      }}
    >
      <div
        style={{
          fontFamily: styxFonts.mono,
          fontSize: type.micro,
          letterSpacing: tracking.micro,
          textTransform: 'uppercase',
          color: styx.warn,
          marginBottom: 20,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: type.body, lineHeight: 1.5, color: styx.muted }}>{children}</div>
    </div>
  );
};

/** A status chip. Border and text only, never a filled pill. */
export const Chip: React.FC<{ children: React.ReactNode; dot?: boolean }> = ({
  children,
  dot,
}) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 18,
      padding: '16px 34px',
      border: `2px solid ${styx.rule}`,
      borderRadius: 999,
      fontFamily: styxFonts.mono,
      fontSize: type.micro,
      letterSpacing: tracking.label,
      textTransform: 'uppercase',
      color: styx.muted,
    }}
  >
    {dot ? (
      <div style={{ width: 12, height: 12, borderRadius: 999, background: styx.seal }} />
    ) : null}
    {children}
  </div>
);

export const ChipRow: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => {
  const enter = useEnter(delay);
  return <div style={{ ...enter, display: 'flex', gap: 24 }}>{children}</div>;
};

/** Vertical rhythm, so no scene sets its own margins. */
export const Stack: React.FC<{
  children: React.ReactNode;
  gap?: number;
}> = ({ children, gap = space.gap }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap }}>{children}</div>
);
