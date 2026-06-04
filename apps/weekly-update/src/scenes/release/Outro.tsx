import React from 'react';
import { AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { GlitchText, TextReveal } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

const Pill: React.FC<{ label: string; sub: string; color: string; delay: number }> = ({ label, sub, color, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 16, stiffness: 80 } });
  return (
    <div
      style={{
        transform: `scale(${s})`,
        backgroundColor: `${color}12`,
        border: `1px solid ${color}55`,
        borderRadius: 16,
        padding: '20px 40px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontFamily: fonts.display, fontSize: 38, color, letterSpacing: 2 }}>{label}</div>
      <div style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.textMuted, marginTop: 4 }}>{sub}</div>
    </div>
  );
};

export const RelOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const logoGlow = interpolate(Math.sin(frame * 0.06), [-1, 1], [0.3, 1]);
  const mascotOpacity = interpolate(frame, [0, 150], [0, 0.12], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ctaOpacity = spring({ frame: frame - 90, fps, config: { damping: 30 } });

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
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 32, zIndex: 1 }}
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

        <TextReveal text="Private by default. Mobile and browser." delay={34} fontSize={50} color={colors.text} font={fonts.body} />

        <div style={{ display: 'flex', gap: 30, marginTop: 16 }}>
          <Pill label="ANDROID" sub="v1.0.2" color={colors.cyan} delay={60} />
          <Pill label="CHROME" sub="extension · beta" color={colors.pink} delay={70} />
        </div>

        <div
          style={{
            opacity: ctaOpacity,
            marginTop: 12,
            fontFamily: fonts.mono,
            fontSize: 38,
            color: colors.cyan,
          }}
        >
          protocol-01.dev
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
