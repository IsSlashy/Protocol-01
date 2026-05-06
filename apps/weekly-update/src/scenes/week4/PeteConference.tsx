import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, GlitchText, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

const takeaways = [
  {
    label: 'WHO BUYS FIRST',
    text: 'Privacy infra sells to teams that already have a compliance line item — not to retail.',
  },
  {
    label: 'NARRATIVE > FEATURES',
    text: 'Lead with the problem the buyer can name, not the cryptography you are proud of.',
  },
  {
    label: 'DESIGN PARTNERS',
    text: 'Three real B2B integrations beat a thousand wallet downloads at this stage.',
  },
];

export const PeteConference: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const photoScale = spring({ frame: frame - 25, fps, config: { damping: 14, stiffness: 70 } });
  const photoOpacity = spring({ frame: frame - 25, fps, config: { damping: 30 } });
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
          padding: 80,
          gap: 26,
        }}
      >
        <Badge text="Conference" delay={0} color={colors.brightCyan} />

        <GlitchText text="FINDING PMF" fontSize={120} delay={10} />

        <CyanLine delay={25} width="500px" />

        <div style={{ display: 'flex', gap: 70, alignItems: 'center', marginTop: 10 }}>
          <div
            style={{
              transform: `scale(${photoScale})`,
              opacity: photoOpacity,
              width: 460,
              height: 460,
              borderRadius: '50%',
              overflow: 'hidden',
              border: `4px solid ${colors.brightCyan}`,
              boxShadow: `0 0 ${60 * glowPulse}px ${colors.brightCyan}`,
              flexShrink: 0,
            }}
          >
            <Img
              src={staticFile('pete.jpg')}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              maxWidth: 1900,
              opacity: spring({ frame: frame - 40, fps, config: { damping: 30 } }),
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 68, fontWeight: 700, color: colors.text }}>
              Pete Townsend
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.brightCyan, letterSpacing: 4 }}>
              GP · NORIO VENTURES
            </div>
            <div style={{ fontFamily: fonts.body, fontSize: 26, color: colors.textMuted, lineHeight: 1.5 }}>
              Host of <span style={{ color: colors.text, fontWeight: 600 }}>MoneyNeverSleeps</span> · ex-BNP Paribas, Fidelity ·{' '}
              <br />
              20+ years backing fintech & crypto founders out of Dublin
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                marginTop: 14,
                fontFamily: fonts.body,
                fontSize: 26,
                color: colors.textMuted,
                lineHeight: 1.4,
              }}
            >
              <div>
                <span style={{ color: colors.cyan, fontFamily: fonts.mono, marginRight: 16 }}>WHEN</span>
                Tuesday, April 28 — 2:00 PM
              </div>
              <div>
                <span style={{ color: colors.cyan, fontFamily: fonts.mono, marginRight: 16 }}>WHERE</span>
                Buildstation, Dublin
              </div>
              <div>
                <span style={{ color: colors.cyan, fontFamily: fonts.mono, marginRight: 16 }}>TALK</span>
                Finding Product-Market Fit in Web3
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            fontFamily: fonts.mono,
            fontSize: 22,
            color: colors.textDim,
            letterSpacing: 6,
            marginTop: 10,
            opacity: spring({ frame: frame - 110, fps, config: { damping: 30 } }),
          }}
        >
          WHAT WE TOOK AWAY
        </div>

        <div style={{ display: 'flex', gap: 28, maxWidth: 3500 }}>
          {takeaways.map((t, i) => {
            const d = 120 + i * 14;
            const slideY = interpolate(
              spring({ frame: frame - d, fps, config: { damping: 18, stiffness: 60 } }),
              [0, 1],
              [40, 0]
            );
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });

            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(21, 21, 24, 0.65)',
                  border: `1px solid ${colors.brightCyan}30`,
                  borderRadius: 18,
                  padding: '24px 28px',
                  transform: `translateY(${slideY}px)`,
                  opacity,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <div
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 18,
                    color: colors.brightCyan,
                    letterSpacing: 3,
                    fontWeight: 700,
                  }}
                >
                  {t.label}
                </div>
                <div
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 24,
                    color: colors.text,
                    lineHeight: 1.45,
                  }}
                >
                  {t.text}
                </div>
              </div>
            );
          })}
        </div>

        <Typewriter
          text="// the talk that re-shaped our roadmap"
          delay={200}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
