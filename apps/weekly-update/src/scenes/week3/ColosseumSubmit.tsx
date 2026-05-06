import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { GlitchText, TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

const stats = [
  { value: '~$250K', label: 'TARGET RAISE', color: colors.cyan },
  { value: '~7%', label: 'EQUITY', color: colors.brightCyan },
  { value: 'IRELAND', label: 'TEAM REGION', color: colors.pink },
];

export const ColosseumSubmit: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

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
          gap: 36,
        }}
      >
        <Badge text="Colosseum Frontier" delay={0} color={colors.pink} />

        <GlitchText text="SUBMITTED" fontSize={150} delay={10} />

        <CyanLine delay={25} width="500px" />

        <Narrative
          lines={[
            "Solo founder, accelerator track, deadline beaten by hours.",
            "Pitch deck, demo video, economic charter — all shipped on April 23.",
          ]}
          delay={30}
          fontSize={38}
          lineDelay={12}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 40, marginTop: 30 }}>
          {stats.map((s, i) => {
            const d = 70 + i * 12;
            const scale = spring({ frame: frame - d, fps, config: { damping: 14, stiffness: 80 } });
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
            const slideY = interpolate(
              spring({ frame: frame - d, fps, config: { damping: 18 } }),
              [0, 1],
              [40, 0]
            );

            return (
              <div
                key={i}
                style={{
                  backgroundColor: 'rgba(21, 21, 24, 0.6)',
                  border: `2px solid ${s.color}40`,
                  borderRadius: 24,
                  padding: '36px 50px',
                  textAlign: 'center',
                  transform: `scale(${scale}) translateY(${slideY}px)`,
                  opacity,
                  minWidth: 360,
                  boxShadow: `0 0 30px ${s.color}20`,
                }}
              >
                <div
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 76,
                    fontWeight: 900,
                    color: s.color,
                    marginBottom: 10,
                  }}
                >
                  {s.value}
                </div>
                <div
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 22,
                    color: colors.textMuted,
                    letterSpacing: 4,
                  }}
                >
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            backgroundColor: 'rgba(21, 21, 24, 0.7)',
            border: `1px solid ${colors.cyan}30`,
            borderRadius: 16,
            padding: '20px 36px',
            marginTop: 20,
            opacity: spring({ frame: frame - 110, fps, config: { damping: 30 } }),
          }}
        >
          <span style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.textMuted }}>
            Public deck → {' '}
          </span>
          <span style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.cyan }}>
            protocol-01.dev/docs/pitch-deck.pdf
          </span>
        </div>

        <Typewriter
          text="// the bet is on the table"
          delay={150}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
