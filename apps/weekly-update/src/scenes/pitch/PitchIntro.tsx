import React from 'react';
import { AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { GlitchText, TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

/**
 * Scene 1 — 0:00 → 0:08 (480 frames @ 60fps)
 *
 * Voiceover: "Hi, I'm Ramy. I go by Slashy. And this is Protocol 01 —
 * a post-quantum privacy layer for Solana."
 */
export const PitchIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const avatarScale = spring({ frame, fps, config: { damping: 12, stiffness: 60 } });
  const avatarGlow = interpolate(Math.sin(frame * 0.05), [-1, 1], [0.3, 0.8]);

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
        {/* Founder avatar */}
        <div
          style={{
            transform: `scale(${avatarScale})`,
            filter: `drop-shadow(0 0 ${60 * avatarGlow}px ${colors.cyanGlow})`,
          }}
        >
          <Img
            src={staticFile('founder.png')}
            style={{
              width: 300,
              height: 300,
              borderRadius: '50%',
              border: `4px solid ${colors.cyan}`,
            }}
          />
        </div>

        <Badge text="Colosseum Frontier · 2026" delay={15} color={colors.pink} />

        <TextReveal
          text="RAMY CHATBI"
          delay={30}
          fontSize={110}
          letterSpacing={12}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 40,
              color: colors.textMuted,
              opacity: spring({ frame: frame - 50, fps, config: { damping: 30 } }),
            }}
          >
            aka
          </span>
          <GlitchText text="SLASHY" fontSize={80} delay={55} />
        </div>

        <CyanLine delay={75} width="500px" />

        <TextReveal
          text="Protocol 01 — the privacy layer for Solana"
          delay={95}
          fontSize={42}
          color={colors.textMuted}
          font={fonts.body}
        />

        <Typewriter
          text="// pitch · april 23, 2026"
          delay={180}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
