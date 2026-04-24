import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Typewriter, Badge } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

/**
 * Scene 7 — 1:50 → 2:00 (600 frames @ 60fps)
 *
 * Voiceover: "Privacy on Solana isn't a feature. It's a prerequisite for the
 * next billion users who don't want their financial life indexed. Protocol 01
 * is live on devnet. The repo is open. Thanks."
 */
export const PitchOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoScale = spring({ frame, fps, config: { damping: 14, stiffness: 60 } });
  const logoGlow = interpolate(Math.sin(frame * 0.05), [-1, 1], [0.3, 0.8]);
  const mascotOpacity = interpolate(
    spring({ frame: frame - 60, fps, config: { damping: 30 } }),
    [0, 1],
    [0, 0.12]
  );

  return (
    <AbsoluteFill>
      <GlowBackground />
      <ScanLine />

      {/* Faded mirrored mascot, lower-left */}
      <div
        style={{
          position: 'absolute',
          left: -300,
          bottom: -200,
          opacity: mascotOpacity,
          transform: 'scaleX(-1)',
          pointerEvents: 'none',
        }}
      >
        <Img src={staticFile('mascot.png')} style={{ width: 1400, height: 1400 }} />
      </div>

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 40,
        }}
      >
        <Badge text="Live on devnet" delay={0} />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 28,
            transform: `scale(${logoScale})`,
            filter: `drop-shadow(0 0 ${60 * logoGlow}px ${colors.cyanGlow})`,
          }}
        >
          <Img src={staticFile('icon.png')} style={{ width: 180, height: 180, borderRadius: 28 }} />
          <Img src={staticFile('01-logo.png')} style={{ height: 180, marginTop: 20 }} />
        </div>

        <TextReveal
          text="PROTOCOL 01"
          delay={20}
          fontSize={120}
          letterSpacing={16}
        />

        <CyanLine delay={35} width="600px" />

        <TextReveal
          text="Privacy on Solana isn't a feature. It's a prerequisite."
          delay={50}
          fontSize={44}
          color={colors.textMuted}
          font={fonts.body}
          maxWidth="2800px"
        />

        <div
          style={{
            marginTop: 40,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
            opacity: spring({ frame: frame - 120, fps, config: { damping: 30 } }),
          }}
        >
          <div style={{ fontFamily: fonts.mono, fontSize: 32, color: colors.cyan }}>
            github.com/IsSlashy/Protocol-01
          </div>
          <div style={{ fontFamily: fonts.mono, fontSize: 28, color: colors.textMuted }}>
            protocol-01.dev · @Protocol01_
          </div>
        </div>

        <Typewriter
          text="// thanks for watching"
          delay={240}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>

      {/* Developer credit bottom-right */}
      <div
        style={{
          position: 'absolute',
          bottom: 80,
          right: 100,
          fontFamily: fonts.mono,
          fontSize: 22,
          color: colors.textDim,
          opacity: spring({ frame: frame - 200, fps, config: { damping: 30 } }),
        }}
      >
        Slashy · Developer
      </div>
    </AbsoluteFill>
  );
};
