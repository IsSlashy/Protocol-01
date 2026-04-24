import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Typewriter, Badge } from '../../components/Typography';
import { CyanLine, StatCard } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

/**
 * Scene 4 — 1:00 → 1:25 (1500 frames @ 60fps)
 *
 * Voiceover: "Protocol 01 is the privacy layer that doesn't exist. A complete
 * stack — ZK-STARKs over the Goldilocks field, a custom on-chain FRI verifier,
 * hybrid stealth addresses with ML-KEM-768, and a merchant SDK that lets any
 * wallet publish on-chain as a real service. Netflix, Spotify, YouTube, Disney+
 * are already registered on devnet. Anyone can subscribe privately today."
 */
export const WhatIBuilt: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const stackLayers = [
    { tag: 'CRYPTO', text: 'ZK-STARKs · Goldilocks field · Poseidon AIR', color: colors.cyan },
    { tag: 'ON-CHAIN', text: 'Custom FRI verifier · 14 Anchor programs', color: colors.brightCyan },
    { tag: 'IDENTITY', text: 'Hybrid stealth · X25519 + ML-KEM-768', color: colors.pink },
    { tag: 'MERCHANT', text: 'Service Registry · SDK · access tokens', color: colors.yellow },
  ];

  const demoMerchants = [
    { name: 'Netflix', price: '0.05 SOL / mo' },
    { name: 'Spotify', price: '0.03 SOL / mo' },
    { name: 'YouTube', price: '0.04 SOL / mo' },
    { name: 'Disney+', price: '0.06 SOL / mo' },
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
          padding: 100,
          gap: 36,
        }}
      >
        <Badge text="What I built" delay={0} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <Img src={staticFile('icon.png')} style={{ width: 96, height: 96, borderRadius: 20 }} />
          <TextReveal text="PROTOCOL 01" delay={10} fontSize={100} letterSpacing={8} />
        </div>

        <TextReveal
          text="The privacy layer that doesn't exist — yet."
          delay={28}
          fontSize={44}
          color={colors.textMuted}
          font={fonts.body}
        />

        <CyanLine delay={40} width="700px" />

        {/* Stack layers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 2600 }}>
          {stackLayers.map((l, i) => {
            const d = 55 + i * 14;
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
            const x = spring({ frame: frame - d, fps, config: { damping: 18 } });
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 32,
                  backgroundColor: 'rgba(21, 21, 24, 0.65)',
                  border: `1px solid ${l.color}40`,
                  borderRadius: 16,
                  padding: '24px 36px',
                  opacity,
                  transform: `translateX(${(1 - x) * -40}px)`,
                }}
              >
                <div
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 22,
                    color: l.color,
                    letterSpacing: 4,
                    minWidth: 180,
                    fontWeight: 700,
                  }}
                >
                  [{l.tag}]
                </div>
                <div style={{ fontFamily: fonts.body, fontSize: 34, color: colors.text }}>{l.text}</div>
              </div>
            );
          })}
        </div>

        <TextReveal
          text="Live demo merchants on devnet today:"
          delay={145}
          fontSize={36}
          color={colors.textMuted}
          font={fonts.body}
        />

        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', justifyContent: 'center' }}>
          {demoMerchants.map((m, i) => {
            const d = 160 + i * 10;
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
            const scale = spring({ frame: frame - d, fps, config: { damping: 15 } });
            return (
              <div
                key={i}
                style={{
                  backgroundColor: colors.surface,
                  border: `2px solid ${colors.pink}60`,
                  borderRadius: 18,
                  padding: '28px 40px',
                  opacity,
                  transform: `scale(${scale})`,
                  minWidth: 320,
                  textAlign: 'center',
                }}
              >
                <div style={{ fontFamily: fonts.display, fontSize: 42, color: colors.text, fontWeight: 700 }}>
                  {m.name}
                </div>
                <div style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.pink, marginTop: 6 }}>
                  {m.price}
                </div>
              </div>
            );
          })}
        </div>

        <Typewriter
          text="// any wallet can subscribe privately right now"
          delay={245}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
