import React from 'react';
import { AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { GlitchText, TextReveal } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

export const ExtOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoGlow = interpolate(Math.sin(frame * 0.06), [-1, 1], [0.3, 1]);
  const mascotOpacity = interpolate(frame, [0, 150], [0, 0.12], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ctaOpacity = spring({ frame: frame - 60, fps, config: { damping: 30 } });

  return (
    <AbsoluteFill>
      <GlowBackground />
      <ScanLine />

      <div
        style={{
          position: 'absolute',
          right: -260,
          bottom: -200,
          opacity: mascotOpacity,
          filter: `drop-shadow(0 0 ${30 * logoGlow}px ${colors.cyanGlow})`,
          zIndex: 0,
        }}
      >
        <Img src={staticFile('mascot.png')} style={{ height: 1600, objectFit: 'contain' }} />
      </div>

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 34,
          zIndex: 1,
        }}
      >
        <div
          style={{
            opacity: spring({ frame, fps, config: { damping: 30 } }),
            transform: `scale(${spring({ frame, fps, config: { damping: 12 } })})`,
            filter: `drop-shadow(0 0 ${35 * logoGlow}px ${colors.cyanGlow})`,
          }}
        >
          <Img src={staticFile('icon.png')} style={{ width: 170, height: 170, borderRadius: 30 }} />
        </div>

        <GlitchText text="PROTOCOL 01" fontSize={130} delay={12} />

        <CyanLine delay={26} width="460px" />

        <TextReveal
          text="The private wallet is now in your browser."
          delay={34}
          fontSize={52}
          color={colors.text}
          font={fonts.body}
        />

        <div
          style={{
            opacity: ctaOpacity,
            marginTop: 18,
            backgroundColor: 'rgba(57, 197, 187, 0.08)',
            border: `1px solid ${colors.cyan}55`,
            borderRadius: 16,
            padding: '24px 56px',
          }}
        >
          <span style={{ fontFamily: fonts.mono, fontSize: 40, color: colors.textMuted }}>Install the beta → </span>
          <span style={{ fontFamily: fonts.mono, fontSize: 40, color: colors.cyan }}>protocol-01.dev/extension</span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
