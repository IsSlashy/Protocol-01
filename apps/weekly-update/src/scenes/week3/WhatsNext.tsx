import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge, GlitchText, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

export const WhatsNext: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const ticketScale = spring({ frame: frame - 90, fps, config: { damping: 14 } });
  const ticketOpacity = spring({ frame: frame - 90, fps, config: { damping: 30 } });
  const glowPulse = interpolate(Math.sin(frame * 0.05), [-1, 1], [0.4, 0.9]);

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
          padding: 100,
          gap: 30,
        }}
      >
        <Badge text="What's Next" delay={0} color={colors.brightCyan} />

        <GlitchText text="DUBLIN BOUND" fontSize={130} delay={10} />

        <CyanLine delay={25} width="500px" />

        <Narrative
          lines={[
            "Code shipped. Deck shipped. Time to meet the people behind the chats.",
            "Five days at Buildstation, Superteam Ireland HQ, and IRL builder rooms.",
          ]}
          delay={30}
          fontSize={36}
          lineDelay={10}
          highlight={[0]}
        />

        <div
          style={{
            transform: `scale(${ticketScale})`,
            opacity: ticketOpacity,
            backgroundColor: 'rgba(21, 21, 24, 0.75)',
            border: `2px solid ${colors.brightCyan}50`,
            borderRadius: 24,
            padding: '36px 60px',
            display: 'flex',
            alignItems: 'center',
            gap: 40,
            marginTop: 30,
            boxShadow: `0 0 ${50 * glowPulse}px ${colors.brightCyan}40`,
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: fonts.mono, fontSize: 20, color: colors.textDim, letterSpacing: 4 }}>
              FROM
            </div>
            <div style={{ fontFamily: fonts.display, fontSize: 56, fontWeight: 700, color: colors.text, marginTop: 6 }}>
              PARIS
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 22, color: colors.cyan, marginTop: 6 }}>
              CDG · APR 26
            </div>
          </div>

          <div style={{ fontFamily: fonts.mono, fontSize: 60, color: colors.brightCyan }}>
            →
          </div>

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: fonts.mono, fontSize: 20, color: colors.textDim, letterSpacing: 4 }}>
              TO
            </div>
            <div style={{ fontFamily: fonts.display, fontSize: 56, fontWeight: 700, color: colors.text, marginTop: 6 }}>
              DUBLIN
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 22, color: colors.cyan, marginTop: 6 }}>
              DUB · APR 30
            </div>
          </div>
        </div>

        <Typewriter
          text="// face-to-face beats a thousand DMs"
          delay={130}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
