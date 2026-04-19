import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { colors } from '../theme';

export const GlowBackground: React.FC = () => {
  const frame = useCurrentFrame();

  // Slow-moving glow orbs
  const orbs = [
    {
      color: 'rgba(57, 197, 187, 0.12)',
      size: 1200,
      x: interpolate(Math.sin(frame * 0.006), [-1, 1], [15, 35]),
      y: interpolate(Math.cos(frame * 0.005), [-1, 1], [20, 50]),
    },
    {
      color: 'rgba(255, 77, 168, 0.07)',
      size: 1000,
      x: interpolate(Math.sin(frame * 0.004 + 2), [-1, 1], [55, 80]),
      y: interpolate(Math.cos(frame * 0.007 + 1), [-1, 1], [30, 65]),
    },
    {
      color: 'rgba(139, 92, 246, 0.06)',
      size: 900,
      x: interpolate(Math.sin(frame * 0.005 + 4), [-1, 1], [30, 60]),
      y: interpolate(Math.cos(frame * 0.003 + 3), [-1, 1], [50, 80]),
    },
    {
      color: 'rgba(0, 255, 229, 0.05)',
      size: 800,
      x: interpolate(Math.sin(frame * 0.007 + 1), [-1, 1], [60, 90]),
      y: interpolate(Math.cos(frame * 0.006 + 2), [-1, 1], [10, 40]),
    },
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: colors.void }}>
      {orbs.map((orb, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: `${orb.x}%`,
            top: `${orb.y}%`,
            width: orb.size,
            height: orb.size,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${orb.color} 0%, transparent 70%)`,
            transform: 'translate(-50%, -50%)',
            filter: 'blur(80px)',
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

export const ScanLine: React.FC = () => {
  const frame = useCurrentFrame();
  const y = interpolate(frame % 300, [0, 300], [0, 2160]);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: y,
        height: 1,
        background: `linear-gradient(to right, transparent, rgba(57,197,187,0.08), transparent)`,
        zIndex: 50,
      }}
    />
  );
};
