import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../components/Background';
import { TextReveal, Typewriter, Badge } from '../components/Typography';
import { CyanLine } from '../components/Shapes';
import { Narrative } from '../components/TextBlock';
import { colors, fonts } from '../theme';

const kycSteps = [
  { icon: '1.', label: 'Upload Passport', color: colors.red },
  { icon: '2.', label: 'Take Selfie', color: colors.red },
  { icon: '3.', label: 'Proof of Address', color: colors.red },
  { icon: '4.', label: 'Wait 24-48h', color: colors.red },
  { icon: '5.', label: 'Identity Stored Forever', color: colors.pink },
];

export const TheProblem: React.FC = () => {
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
        <Badge text="The Problem" delay={0} color={colors.red} />

        <TextReveal
          text="Every fiat onramp breaks your privacy"
          delay={10}
          fontSize={90}
          maxWidth="2800px"
        />

        <CyanLine delay={20} width="600px" />

        <Narrative
          lines={[
            "Protocol 01 gives you full privacy on Solana.",
            "But to get crypto in the first place, you need a fiat onramp.",
            "MoonPay, Ramp, Transak — they all require this:",
          ]}
          delay={25}
          fontSize={38}
          lineDelay={12}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 30, flexWrap: 'wrap', justifyContent: 'center' }}>
          {kycSteps.map((step, i) => {
            const stepDelay = 65 + i * 10;
            const scale = spring({ frame: frame - stepDelay, fps, config: { damping: 15 } });
            const opacity = spring({ frame: frame - stepDelay, fps, config: { damping: 30 } });

            return (
              <div
                key={i}
                style={{
                  backgroundColor: 'rgba(255, 51, 102, 0.08)',
                  border: `2px solid ${step.color}40`,
                  borderRadius: 20,
                  padding: '30px 40px',
                  transform: `scale(${scale})`,
                  opacity,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 20,
                }}
              >
                <span style={{ fontFamily: fonts.mono, fontSize: 30, color: step.color, fontWeight: 700 }}>
                  {step.icon}
                </span>
                <span style={{ fontFamily: fonts.body, fontSize: 30, color: colors.text }}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>

        <Typewriter
          text="// you expose your identity just to enter a privacy protocol"
          delay={120}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
