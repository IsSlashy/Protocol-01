import React from 'react';
import { AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { GlitchText, TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors } from '../../theme';

export const RelIntro: React.FC = () => {
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
          <div style={{ transform: `scale(${logoScale})`, filter: `drop-shadow(0 0 ${40 * logoGlow}px ${colors.cyanGlow})` }}>
            <Img src={staticFile('icon.png')} style={{ width: 180, height: 180, borderRadius: 30 }} />
          </div>
          <GlitchText text="PROTOCOL 01" fontSize={150} delay={12} />
        </div>

        <CyanLine delay={28} width="420px" />

        <Badge text="The Update" delay={36} />

        <TextReveal text="WHAT CHANGED" delay={50} fontSize={108} color={colors.cyan} letterSpacing={18} />

        <Typewriter
          text="// privacy, stabilized — and now in your browser"
          delay={70}
          fontSize={34}
          color={colors.textMuted}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
