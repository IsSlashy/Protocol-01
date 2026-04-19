import React from 'react';
import { interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { colors } from '../theme';

export const CyanLine: React.FC<{
  delay?: number;
  width?: string;
  align?: 'left' | 'center';
}> = ({ delay = 0, width = '200px', align = 'center' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scaleX = spring({ frame: frame - delay, fps, config: { damping: 20 } });

  return (
    <div
      style={{
        width,
        height: 3,
        background: `linear-gradient(to right, ${colors.cyan}, ${colors.brightCyan})`,
        transform: `scaleX(${scaleX})`,
        transformOrigin: align === 'left' ? 'left' : 'center',
        margin: align === 'center' ? '0 auto' : undefined,
        boxShadow: `0 0 20px ${colors.cyanGlow}`,
      }}
    />
  );
};

export const PulseRing: React.FC<{
  size?: number;
  delay?: number;
  x?: number;
  y?: number;
}> = ({ size = 400, delay = 0, x = 0, y = 0 }) => {
  const frame = useCurrentFrame();
  const adjustedFrame = Math.max(0, frame - delay);
  const scale = interpolate(adjustedFrame % 90, [0, 90], [0.5, 1.5]);
  const opacity = interpolate(adjustedFrame % 90, [0, 90], [0.6, 0]);

  return (
    <div
      style={{
        position: 'absolute',
        left: `calc(50% + ${x}px)`,
        top: `calc(50% + ${y}px)`,
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid ${colors.cyan}`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        opacity,
      }}
    />
  );
};

export const FloatingParticles: React.FC<{ count?: number }> = ({ count = 20 }) => {
  const frame = useCurrentFrame();

  const particles = React.useMemo(() => {
    return Array.from({ length: count }, (_, i) => ({
      x: (i * 197 + 50) % 3840,
      y: (i * 131 + 100) % 2160,
      speed: 0.3 + (i % 5) * 0.15,
      size: 2 + (i % 3),
      phase: i * 0.5,
    }));
  }, [count]);

  return (
    <>
      {particles.map((p, i) => {
        const y = (p.y + frame * p.speed) % 2160;
        const opacity = interpolate(
          Math.sin(frame * 0.03 + p.phase),
          [-1, 1],
          [0.1, 0.5]
        );
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: p.x,
              top: y,
              width: p.size,
              height: p.size,
              borderRadius: '50%',
              backgroundColor: colors.cyan,
              opacity,
            }}
          />
        );
      })}
    </>
  );
};

export const CodeBlock: React.FC<{
  lines: string[];
  delay?: number;
  x?: number;
  y?: number;
  width?: number;
}> = ({ lines, delay = 0, x = 0, y = 0, width = 1200 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = spring({ frame: frame - delay, fps, config: { damping: 30 } });

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        backgroundColor: 'rgba(15, 15, 18, 0.9)',
        border: `1px solid ${colors.border}`,
        borderRadius: 16,
        padding: 40,
        opacity,
      }}
    >
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: colors.red }} />
        <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: colors.yellow }} />
        <div style={{ width: 16, height: 16, borderRadius: '50%', backgroundColor: '#4ade80' }} />
      </div>
      {lines.map((line, i) => {
        const lineDelay = delay + i * 4;
        const lineOpacity = spring({ frame: frame - lineDelay, fps, config: { damping: 30 } });
        return (
          <div
            key={i}
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 26,
              color: line.startsWith('//') ? colors.textDim : line.startsWith('pub') || line.startsWith('fn') ? colors.cyan : colors.textMuted,
              opacity: lineOpacity,
              marginBottom: 6,
              whiteSpace: 'pre',
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

export const StatCard: React.FC<{
  value: string;
  label: string;
  delay?: number;
  color?: string;
}> = ({ value, label, delay = 0, color = colors.cyan }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame: frame - delay, fps, config: { damping: 15, stiffness: 80 } });
  const opacity = spring({ frame: frame - delay, fps, config: { damping: 30 } });

  return (
    <div
      style={{
        backgroundColor: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: 20,
        padding: '40px 50px',
        textAlign: 'center',
        transform: `scale(${scale})`,
        opacity,
        minWidth: 280,
      }}
    >
      <div
        style={{
          fontFamily: 'Orbitron, system-ui',
          fontSize: 72,
          fontWeight: 900,
          color,
          marginBottom: 8,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 22,
          color: colors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 4,
        }}
      >
        {label}
      </div>
    </div>
  );
};
