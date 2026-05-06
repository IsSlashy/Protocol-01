import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

const services = [
  { name: 'NETFLIX', tier: '$15.99/mo', color: '#e50914' },
  { name: 'SPOTIFY', tier: '$10.99/mo', color: '#1db954' },
  { name: 'YOUTUBE', tier: '$13.99/mo', color: '#ff0000' },
  { name: 'DISNEY+', tier: '$10.99/mo', color: '#0063e5' },
];

export const ServiceRegistry: React.FC = () => {
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
        <Badge text="Service Registry" delay={0} color={colors.brightCyan} />

        <TextReveal
          text="Four services attested on devnet"
          delay={10}
          fontSize={84}
          maxWidth="3200px"
        />

        <CyanLine delay={25} width="500px" />

        <Narrative
          lines={[
            "On-chain registry of subscription services with verified pricing.",
            "Mobile hook live, release APK shipped to Galaxy device for IRL demo.",
          ]}
          delay={30}
          fontSize={36}
          lineDelay={10}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 36, marginTop: 30, flexWrap: 'wrap', justifyContent: 'center' }}>
          {services.map((s, i) => {
            const d = 65 + i * 10;
            const scale = spring({ frame: frame - d, fps, config: { damping: 14, stiffness: 70 } });
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
            const slideY = interpolate(
              spring({ frame: frame - d, fps, config: { damping: 18 } }),
              [0, 1],
              [50, 0]
            );
            const glowPulse = interpolate(Math.sin(frame * 0.04 + i * 0.7), [-1, 1], [0.3, 0.7]);

            return (
              <div
                key={i}
                style={{
                  backgroundColor: 'rgba(21, 21, 24, 0.7)',
                  border: `2px solid ${s.color}50`,
                  borderRadius: 22,
                  padding: '40px 48px',
                  textAlign: 'center',
                  transform: `scale(${scale}) translateY(${slideY}px)`,
                  opacity,
                  minWidth: 380,
                  boxShadow: `0 0 ${40 * glowPulse}px ${s.color}40`,
                }}
              >
                <div
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 44,
                    fontWeight: 900,
                    color: s.color,
                    letterSpacing: 4,
                    marginBottom: 14,
                  }}
                >
                  {s.name}
                </div>
                <div
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 26,
                    color: colors.text,
                    marginBottom: 16,
                  }}
                >
                  {s.tier}
                </div>
                <div
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 16,
                    color: colors.brightCyan,
                    letterSpacing: 3,
                    backgroundColor: 'rgba(0, 255, 229, 0.1)',
                    padding: '6px 14px',
                    borderRadius: 8,
                    display: 'inline-block',
                  }}
                >
                  ✓ ATTESTED
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 50,
            marginTop: 24,
            opacity: spring({ frame: frame - 130, fps, config: { damping: 30 } }),
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.textDim, letterSpacing: 3 }}>
              PROGRAM
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 22, color: colors.cyan, marginTop: 4 }}>
              p01_registry
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.textDim, letterSpacing: 3 }}>
              HOOK
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 22, color: colors.cyan, marginTop: 4 }}>
              useServiceRegistry()
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.textDim, letterSpacing: 3 }}>
              DEVICE
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 22, color: colors.cyan, marginTop: 4 }}>
              Galaxy · release APK
            </div>
          </div>
        </div>

        <Typewriter
          text="// subscriptions, on-chain, verifiable"
          delay={240}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
