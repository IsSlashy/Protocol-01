import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Typewriter, Badge } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

/**
 * Scene 2 — 0:08 → 0:30 (1320 frames @ 60fps)
 *
 * Voiceover: "I'm a cybersecurity engineer. Security work pulls you toward
 * cryptography — and the frontier of cryptography today is web3. That's why
 * I went full-time on hackathons. Nine months, no fallback, shipping real
 * products on-chain."
 */
export const WhoIAm: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Three-node progression: Security → Cryptography → Web3 / Hackathons
  const nodes = [
    { label: 'Security', sub: 'my training', color: colors.cyan },
    { label: 'Cryptography', sub: 'the natural next step', color: colors.brightCyan },
    { label: 'Web3', sub: 'where crypto ships today', color: colors.pink },
  ];

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
          gap: 48,
        }}
      >
        <Badge text="Who I am" delay={0} />

        <TextReveal
          text="Cybersecurity engineer."
          delay={12}
          fontSize={110}
          maxWidth="2800px"
        />

        <CyanLine delay={28} width="600px" />

        {/* Progression nodes: Security → Cryptography → Web3 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 36,
            marginTop: 20,
          }}
        >
          {nodes.map((n, i) => {
            const nodeDelay = 45 + i * 20;
            const opacity = spring({ frame: frame - nodeDelay, fps, config: { damping: 30 } });
            const scale = spring({ frame: frame - nodeDelay, fps, config: { damping: 14 } });

            return (
              <React.Fragment key={i}>
                <div
                  style={{
                    backgroundColor: 'rgba(21, 21, 24, 0.75)',
                    border: `2px solid ${n.color}80`,
                    borderRadius: 24,
                    padding: '36px 56px',
                    minWidth: 480,
                    textAlign: 'center',
                    opacity,
                    transform: `scale(${scale})`,
                    boxShadow: `0 0 48px ${n.color}18`,
                  }}
                >
                  <div
                    style={{
                      fontFamily: fonts.display,
                      fontSize: 64,
                      fontWeight: 800,
                      color: n.color,
                    }}
                  >
                    {n.label}
                  </div>
                  <div
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 24,
                      color: colors.textMuted,
                      marginTop: 10,
                      letterSpacing: 2,
                    }}
                  >
                    {n.sub}
                  </div>
                </div>

                {/* Arrow between nodes */}
                {i < nodes.length - 1 && (
                  <div
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 72,
                      color: colors.cyan,
                      opacity: interpolate(
                        spring({ frame: frame - (nodeDelay + 10), fps, config: { damping: 30 } }),
                        [0, 1],
                        [0, 0.6]
                      ),
                    }}
                  >
                    →
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        <Narrative
          lines={[
            'Nine months of hackathons. Full-time. No fallback.',
          ]}
          delay={170}
          fontSize={48}
          lineDelay={0}
          highlight={[0]}
        />

        <Typewriter
          text="// that's how i ended up here"
          delay={240}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
