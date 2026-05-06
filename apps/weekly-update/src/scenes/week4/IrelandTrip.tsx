import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

const tripPoints = [
  { day: 'APR 26', label: 'Paris → Dublin', color: colors.cyan },
  { day: 'APR 27', label: 'Superteam Ireland HQ', color: colors.brightCyan },
  { day: 'APR 28', label: 'Buildstation Conference', color: colors.mugenBlue },
  { day: 'APR 29', label: 'Builder meetings', color: colors.mugenViolet },
  { day: 'APR 30', label: 'Dublin → Paris', color: colors.pink },
];

export const IrelandTrip: React.FC = () => {
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
          padding: 120,
          gap: 40,
        }}
      >
        <Badge text="On The Ground" delay={0} color={colors.brightCyan} />

        <TextReveal
          text="Five days in Dublin"
          delay={10}
          fontSize={96}
          maxWidth="2800px"
        />

        <CyanLine delay={20} width="500px" />

        <Narrative
          lines={[
            "We flew to Ireland to meet the Superteam community face-to-face.",
            "Five days of builders, conferences, and conversations that don't happen on Discord.",
          ]}
          delay={25}
          fontSize={38}
          lineDelay={12}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center', marginTop: 30 }}>
          {tripPoints.map((step, i) => {
            const stepDelay = 60 + i * 12;
            const slideY = interpolate(
              spring({ frame: frame - stepDelay, fps, config: { damping: 18 } }),
              [0, 1],
              [40, 0]
            );
            const opacity = spring({ frame: frame - stepDelay, fps, config: { damping: 30 } });

            return (
              <div
                key={i}
                style={{
                  backgroundColor: 'rgba(21, 21, 24, 0.6)',
                  border: `2px solid ${step.color}30`,
                  borderRadius: 20,
                  padding: '28px 36px',
                  transform: `translateY(${slideY}px)`,
                  opacity,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                  minWidth: 320,
                }}
              >
                <span style={{ fontFamily: fonts.mono, fontSize: 22, color: step.color, letterSpacing: 4, fontWeight: 700 }}>
                  {step.day}
                </span>
                <span style={{ fontFamily: fonts.body, fontSize: 28, color: colors.text, textAlign: 'center' }}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>

        <Typewriter
          text="// face-to-face beats a thousand DMs"
          delay={150}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
