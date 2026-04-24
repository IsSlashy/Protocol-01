import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Typewriter, Badge, GlitchText } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

/**
 * Scene 3 — 0:30 → 1:00 (1800 frames @ 60fps)
 *
 * Voiceover (two beats):
 *   "Three months ago I opened the Protocol 01 repo. Here's the problem."
 *   "Every Solana transaction is public by default — balances, senders,
 *    recipients, spending patterns. And no developer has ready-made privacy
 *    tools. Every project that needs confidentiality rebuilds it from scratch."
 */
export const ProblemReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase 1: "Three months ago" (frames 0-360)
  // Phase 2: The problem (frames 360+)
  const phase2Opacity = spring({ frame: frame - 360, fps, config: { damping: 30 } });
  const phase1Opacity = spring({ frame: 360 - frame, fps, config: { damping: 30 } });

  const exposedFields = [
    { label: 'Sender wallet', value: '4e8d...3c1a' },
    { label: 'Recipient wallet', value: 'f21c...9bd3' },
    { label: 'Amount', value: '12.45 SOL' },
    { label: 'Timestamp', value: '2026-04-23 14:21' },
    { label: 'Memo', value: 'rent payment' },
    { label: 'Token balance', value: '214.8 SOL' },
  ];

  return (
    <AbsoluteFill>
      <GlowBackground />
      <ScanLine />

      {/* Phase 1 — Three months ago */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 40,
          opacity: phase1Opacity,
        }}
      >
        <Badge text="Three months ago" delay={0} />
        <GlitchText text="I OPENED THE REPO" fontSize={140} delay={15} />
        <CyanLine delay={50} width="700px" />
        <TextReveal
          text="github.com/IsSlashy/Protocol-01"
          delay={70}
          fontSize={44}
          color={colors.cyan}
          font={fonts.mono}
        />
      </AbsoluteFill>

      {/* Phase 2 — The problem */}
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 120,
          gap: 40,
          opacity: phase2Opacity,
        }}
      >
        <Badge text="The Problem" delay={360} color={colors.red} />

        <TextReveal
          text="Every Solana transaction is public"
          delay={372}
          fontSize={92}
          maxWidth="2800px"
        />

        <CyanLine delay={390} width="600px" />

        <Narrative
          lines={[
            'Balances. Senders. Recipients. Spending patterns.',
            'All visible. Forever. On-chain.',
          ]}
          delay={405}
          fontSize={42}
          lineDelay={14}
          highlight={[1]}
        />

        {/* Exposed fields grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 24,
            marginTop: 30,
          }}
        >
          {exposedFields.map((f, i) => {
            const d = 470 + i * 10;
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
            const scale = spring({ frame: frame - d, fps, config: { damping: 15 } });
            return (
              <div
                key={i}
                style={{
                  backgroundColor: 'rgba(255, 51, 102, 0.05)',
                  border: `1px solid ${colors.red}40`,
                  borderRadius: 14,
                  padding: '24px 32px',
                  opacity,
                  transform: `scale(${scale})`,
                  minWidth: 540,
                }}
              >
                <div style={{ fontFamily: fonts.mono, fontSize: 22, color: colors.red, textTransform: 'uppercase', letterSpacing: 2 }}>
                  {f.label}
                </div>
                <div style={{ fontFamily: fonts.mono, fontSize: 34, color: colors.text, marginTop: 6 }}>
                  {f.value}
                </div>
              </div>
            );
          })}
        </div>

        <TextReveal
          text="No developer has ready-made privacy tools."
          delay={570}
          fontSize={44}
          color={colors.pink}
          font={fonts.body}
          maxWidth="2400px"
        />

        <Typewriter
          text="// every privacy project rebuilds the stack from scratch"
          delay={640}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
