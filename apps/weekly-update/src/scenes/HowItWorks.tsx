import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../components/Background';
import { TextReveal, Badge, Typewriter } from '../components/Typography';
import { CyanLine } from '../components/Shapes';
import { Narrative } from '../components/TextBlock';
import { colors, fonts } from '../theme';

const steps = [
  {
    num: '01',
    title: 'P2P MATCHING',
    desc: 'Buyers and sellers connect directly.\nNo centralized order book, no middleman.',
    detail: 'Automated matching engine',
    color: colors.cyan,
  },
  {
    num: '02',
    title: 'ON-CHAIN ESCROW',
    desc: 'Funds are locked in a Solana PDA vault.\nNeither party can rug \u2014 the contract enforces it.',
    detail: 'Trustless smart contract',
    color: colors.mugenBlue,
  },
  {
    num: '03',
    title: 'FIAT TRANSFER',
    desc: 'The buyer sends fiat via standard bank transfer.\nNo crypto intermediary needed.',
    detail: 'Standard banking rails',
    color: colors.mugenViolet,
  },
  {
    num: '04',
    title: 'STEALTH DELIVERY',
    desc: 'Crypto arrives at a one-time stealth address.\nNo link between your bank and your wallet.',
    detail: 'Quantum-resistant address',
    color: colors.brightCyan,
  },
];

export const HowItWorks: React.FC = () => {
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
          gap: 35,
        }}
      >
        <Badge text="How It Works" delay={0} />

        <TextReveal text="From fiat to private crypto" delay={10} fontSize={76} />

        <Narrative
          lines={[
            "The full flow is trustless and privacy-preserving end to end.",
            "Here's exactly what happens when you use Mugen:",
          ]}
          delay={20}
          fontSize={36}
          lineDelay={10}
          highlight={[0]}
        />

        <CyanLine delay={35} width="400px" />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 30,
            maxWidth: 3200,
            marginTop: 20,
          }}
        >
          {steps.map((step, i) => {
            const d = 40 + i * 18;
            const slideY = interpolate(
              spring({ frame: frame - d, fps, config: { damping: 18, stiffness: 60 } }),
              [0, 1],
              [60, 0]
            );
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });

            return (
              <div
                key={i}
                style={{
                  backgroundColor: 'rgba(21, 21, 24, 0.6)',
                  border: `2px solid ${step.color}25`,
                  borderRadius: 24,
                  padding: '40px 45px',
                  transform: `translateY(${slideY}px)`,
                  opacity,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 16 }}>
                  <div
                    style={{
                      fontFamily: fonts.display,
                      fontSize: 22,
                      color: colors.void,
                      backgroundColor: step.color,
                      padding: '6px 16px',
                      borderRadius: 8,
                      fontWeight: 700,
                      letterSpacing: 3,
                    }}
                  >
                    STEP {step.num}
                  </div>
                  <div style={{ fontFamily: fonts.display, fontSize: 32, fontWeight: 700, color: colors.text }}>
                    {step.title}
                  </div>
                </div>

                <div
                  style={{
                    fontFamily: fonts.body,
                    fontSize: 28,
                    color: colors.textMuted,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-line',
                    marginBottom: 12,
                  }}
                >
                  {step.desc}
                </div>

                <div
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 18,
                    color: step.color,
                    letterSpacing: 2,
                    textTransform: 'uppercase',
                  }}
                >
                  {step.detail}
                </div>
              </div>
            );
          })}
        </div>

        <Typewriter
          text="// fully on-chain escrow, no third party"
          delay={120}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
