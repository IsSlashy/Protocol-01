import React from 'react';
import { AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { GlitchText, TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

export const ExtIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({ frame, fps, config: { damping: 12, stiffness: 60 } });
  const logoGlow = interpolate(Math.sin(frame * 0.05), [-1, 1], [0.3, 0.8]);

  return (
    <AbsoluteFill>
      <GlowBackground />
      <ScanLine />

      <AbsoluteFill
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 40 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              transform: `scale(${logoScale})`,
              filter: `drop-shadow(0 0 ${40 * logoGlow}px ${colors.cyanGlow})`,
            }}
          >
            <Img src={staticFile('icon.png')} style={{ width: 180, height: 180, borderRadius: 30 }} />
          </div>
          <GlitchText text="PROTOCOL 01" fontSize={150} delay={12} />
        </div>

        <CyanLine delay={28} width="420px" />

        <Badge text="Devlog" delay={36} />

        <TextReveal
          text="CHROME EXTENSION"
          delay={50}
          fontSize={104}
          color={colors.cyan}
          font={fonts.display}
          letterSpacing={16}
        />

        <Typewriter
          text="// the private wallet — now in your browser"
          delay={70}
          fontSize={34}
          color={colors.textMuted}
        />

        <div
          style={{
            position: 'absolute',
            bottom: 110,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: spring({ frame: frame - 90, fps, config: { damping: 30 } }),
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
            <span style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.textMuted }}>v0.5.0 · </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.yellow }}>beta · devnet</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.textMuted }}> · live now</span>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
