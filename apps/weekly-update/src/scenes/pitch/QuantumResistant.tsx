import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { GlitchText, TextReveal, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

/**
 * Scene 5 — 1:25 → 1:33 (480 frames @ 60fps)
 *
 * Voiceover: "No trusted setup. No ceremony. No zkey files. Because Groth16
 * doesn't survive the quantum transition."
 */
export const QuantumResistant: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const negations = [
    'No trusted setup',
    'No ceremony',
    'No .zkey files',
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
          gap: 48,
        }}
      >
        <GlitchText text="QUANTUM-RESISTANT" fontSize={140} delay={0} />

        <CyanLine delay={20} width="800px" />

        <div style={{ display: 'flex', gap: 48, flexWrap: 'wrap', justifyContent: 'center' }}>
          {negations.map((n, i) => {
            const d = 30 + i * 14;
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
            const scale = spring({ frame: frame - d, fps, config: { damping: 15 } });
            return (
              <div
                key={i}
                style={{
                  backgroundColor: 'rgba(21, 21, 24, 0.8)',
                  border: `2px solid ${colors.cyan}80`,
                  borderRadius: 18,
                  padding: '32px 56px',
                  opacity,
                  transform: `scale(${scale})`,
                }}
              >
                <div style={{ fontFamily: fonts.display, fontSize: 48, color: colors.cyan, fontWeight: 700 }}>
                  {n}
                </div>
              </div>
            );
          })}
        </div>

        <TextReveal
          text="Groth16 doesn't survive the quantum transition."
          delay={100}
          fontSize={56}
          color={colors.textMuted}
          font={fonts.body}
          maxWidth="2800px"
        />

        <Typewriter
          text="// hash-based proofs. no elliptic curves. by design."
          delay={170}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
