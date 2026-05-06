import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

const deliverables = [
  {
    label: 'PITCH DECK',
    title: 'Public investor deck',
    desc: 'Full deck + economic charter PDFs published on the marketing site.',
    color: colors.pink,
  },
  {
    label: 'SDK B2B',
    title: 'Plug-and-play hardening',
    desc: 'Merchant surface battle-tested for the pitch-day demo.',
    color: colors.cyan,
  },
  {
    label: 'WEB v0.9.9',
    title: 'Marketing site refresh',
    desc: 'Design & architecture doc · 9 missing JP strings · APK download.',
    color: colors.mugenViolet,
  },
];

export const PitchSDK: React.FC = () => {
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
          gap: 32,
        }}
      >
        <Badge text="Pitch Day" delay={0} color={colors.pink} />

        <TextReveal text="From code to story" delay={10} fontSize={88} />

        <CyanLine delay={25} width="500px" />

        <Narrative
          lines={[
            "Hardened the merchant SDK and turned the architecture into a deck.",
            "Same codebase, three audiences: builders, investors, end users.",
          ]}
          delay={30}
          fontSize={36}
          lineDelay={10}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 36, marginTop: 24, maxWidth: 3400 }}>
          {deliverables.map((d, i) => {
            const dl = 60 + i * 14;
            const slideY = interpolate(
              spring({ frame: frame - dl, fps, config: { damping: 18, stiffness: 60 } }),
              [0, 1],
              [50, 0]
            );
            const opacity = spring({ frame: frame - dl, fps, config: { damping: 30 } });

            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(21, 21, 24, 0.6)',
                  border: `2px solid ${d.color}30`,
                  borderRadius: 24,
                  padding: '36px 40px',
                  transform: `translateY(${slideY}px)`,
                  opacity,
                }}
              >
                <div
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 22,
                    color: colors.void,
                    backgroundColor: d.color,
                    padding: '6px 16px',
                    borderRadius: 8,
                    fontWeight: 700,
                    letterSpacing: 3,
                    display: 'inline-block',
                    marginBottom: 18,
                  }}
                >
                  {d.label}
                </div>
                <div style={{ fontFamily: fonts.display, fontSize: 36, fontWeight: 700, color: colors.text, marginBottom: 12 }}>
                  {d.title}
                </div>
                <div style={{ fontFamily: fonts.body, fontSize: 26, color: colors.textMuted, lineHeight: 1.5 }}>
                  {d.desc}
                </div>
              </div>
            );
          })}
        </div>

        <Typewriter
          text="// builders, investors, users — one stack"
          delay={130}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
