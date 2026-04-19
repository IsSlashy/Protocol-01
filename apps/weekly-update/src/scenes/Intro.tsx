import React from 'react';
import { AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../components/Background';
import { GlitchText, TextReveal, Badge, Typewriter } from '../components/Typography';
import { CyanLine } from '../components/Shapes';
import { colors, fonts } from '../theme';

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({ frame, fps, config: { damping: 12, stiffness: 60 } });
  const logoGlow = interpolate(Math.sin(frame * 0.05), [-1, 1], [0.3, 0.8]);

  return (
    <AbsoluteFill>
      <GlowBackground />
      <ScanLine />

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 40,
        }}
      >
        <div
          style={{
            transform: `scale(${logoScale})`,
            filter: `drop-shadow(0 0 ${40 * logoGlow}px ${colors.cyanGlow})`,
          }}
        >
          <Img src={staticFile('icon.png')} style={{ width: 200, height: 200, borderRadius: 32 }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              opacity: spring({ frame: frame - 15, fps, config: { damping: 30 } }),
              filter: `drop-shadow(0 0 ${30 * logoGlow}px rgba(255, 77, 168, 0.6))`,
            }}
          >
            <Img src={staticFile('01-logo.png')} style={{ height: 200, marginTop: 28 }} />
          </div>
          <GlitchText text="PROTOCOL" fontSize={160} delay={15} />
        </div>

        <CyanLine delay={30} width="400px" />

        <Badge text="Weekly Update" delay={40} />

        <TextReveal
          text="WEEK 1"
          delay={55}
          fontSize={100}
          color={colors.cyan}
          font={fonts.display}
          letterSpacing={20}
        />

        <Typewriter
          text="// april 6 - 12, 2026"
          delay={70}
          fontSize={32}
          color={colors.textDim}
        />

        {/* Caution notice */}
        <div
          style={{
            position: 'absolute',
            bottom: 100,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: spring({ frame: frame - 85, fps, config: { damping: 30 } }),
          }}
        >
          <div
            style={{
              display: 'inline-block',
              backgroundColor: 'rgba(21, 21, 24, 0.7)',
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: '16px 40px',
            }}
          >
            <span style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.textMuted }}>
              This project is already in progress — for details visit{' '}
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.cyan }}>
              protocol-01.dev/docs
            </span>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
