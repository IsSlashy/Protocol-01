import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

const tracks = [
  {
    label: 'B2B SDK',
    title: 'Privacy primitives for businesses',
    desc: 'Merchants, payroll, treasuries — give them ZK without making them learn ZK.',
    color: colors.cyan,
  },
  {
    label: 'P2B FLOW',
    title: 'User-to-business private payments',
    desc: 'Stealth invoices, on-chain receipts, no leaked customer wallet.',
    color: colors.mugenBlue,
  },
];

export const WhatsNext: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const castleScale = spring({ frame: frame - 130, fps, config: { damping: 14 } });
  const castleOpacity = spring({ frame: frame - 130, fps, config: { damping: 30 } });

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
        <Badge text="What's Next" delay={0} color={colors.mugenViolet} />

        <TextReveal text="Back to Paris — focus shifts to enterprise" delay={10} fontSize={76} maxWidth="3200px" />

        <CyanLine delay={25} width="500px" />

        <Narrative
          lines={[
            "With the ZK layer stable, the next chapter is distribution.",
            "Two SDK tracks open up — and a chance to come back to Ireland this summer.",
          ]}
          delay={30}
          fontSize={34}
          lineDelay={10}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 50, marginTop: 20, maxWidth: 3400 }}>
          {tracks.map((t, i) => {
            const d = 60 + i * 18;
            const slideY = interpolate(
              spring({ frame: frame - d, fps, config: { damping: 18, stiffness: 60 } }),
              [0, 1],
              [50, 0]
            );
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });

            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(21, 21, 24, 0.6)',
                  border: `2px solid ${t.color}30`,
                  borderRadius: 24,
                  padding: '40px 45px',
                  transform: `translateY(${slideY}px)`,
                  opacity,
                }}
              >
                <div
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 22,
                    color: colors.void,
                    backgroundColor: t.color,
                    padding: '6px 16px',
                    borderRadius: 8,
                    fontWeight: 700,
                    letterSpacing: 3,
                    display: 'inline-block',
                    marginBottom: 16,
                  }}
                >
                  {t.label}
                </div>
                <div style={{ fontFamily: fonts.display, fontSize: 38, fontWeight: 700, color: colors.text, marginBottom: 12 }}>
                  {t.title}
                </div>
                <div style={{ fontFamily: fonts.body, fontSize: 28, color: colors.textMuted, lineHeight: 1.5 }}>
                  {t.desc}
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            transform: `scale(${castleScale})`,
            opacity: castleOpacity,
            backgroundColor: 'rgba(21, 21, 24, 0.7)',
            border: `2px solid ${colors.pink}40`,
            borderRadius: 20,
            padding: '24px 40px',
            display: 'flex',
            alignItems: 'center',
            gap: 28,
            marginTop: 20,
            boxShadow: `0 0 40px rgba(255, 119, 168, 0.25)`,
          }}
        >
          <div
            style={{
              fontFamily: fonts.display,
              fontSize: 24,
              color: colors.void,
              backgroundColor: colors.pink,
              padding: '8px 18px',
              borderRadius: 8,
              fontWeight: 700,
              letterSpacing: 3,
            }}
          >
            APPLIED
          </div>
          <div>
            <div style={{ fontFamily: fonts.display, fontSize: 36, fontWeight: 700, color: colors.text }}>
              CastleDAO — Ireland, August 2026
            </div>
            <div style={{ fontFamily: fonts.body, fontSize: 24, color: colors.textMuted, marginTop: 4 }}>
              If accepted: 2 weeks alongside the best Solana builders
            </div>
          </div>
        </div>

        <Typewriter
          text="// stable foundation → enterprise distribution"
          delay={170}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
