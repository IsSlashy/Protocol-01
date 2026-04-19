import React from 'react';
import { AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../components/Background';
import { TextReveal, GlitchText, Badge, Typewriter } from '../components/Typography';
import { CyanLine } from '../components/Shapes';
import { Narrative } from '../components/TextBlock';
import { colors, fonts } from '../theme';

export const MugenReveal: React.FC = () => {
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
          gap: 25,
        }}
      >
        <Badge text="This Week's Build" delay={0} color={colors.mugenBlue} />

        <GlitchText text="MUGEN EXCHANGE" fontSize={130} delay={10} />

        <div
          style={{
            opacity: spring({ frame: frame - 25, fps, config: { damping: 30 } }),
            transform: `scale(${spring({ frame: frame - 25, fps, config: { damping: 12 } })})`,
            filter: `drop-shadow(0 0 30px rgba(139, 92, 246, 0.5))`,
          }}
        >
          <Img
            src={staticFile('mugen-icon.png')}
            style={{ width: 260, height: 260, borderRadius: 48 }}
          />
        </div>

        <CyanLine delay={30} width="500px" />

        <Narrative
          lines={[
            "So we built our own fiat-to-crypto bridge.",
            "Mugen is a peer-to-peer exchange built directly into Protocol 01.",
            "No KYC. No middleman. No identity stored anywhere.",
            "Instead of trusting a centralized provider,",
            "buyers and sellers match directly \u2014 and ZK proofs",
            "handle compliance without revealing who you are.",
          ]}
          delay={40}
          fontSize={38}
          lineDelay={10}
          highlight={[0, 1]}
          maxWidth={2600}
        />

        <div style={{ display: 'flex', gap: 60, marginTop: 30 }}>
          {[
            { value: '0%', label: 'KYC Required', color: colors.cyan },
            { value: '<0.5%', label: 'Protocol Fee', color: colors.mugenBlue },
            { value: 'P2P', label: 'Direct Match', color: colors.mugenViolet },
            { value: 'ZK', label: 'Compliance', color: colors.brightCyan },
          ].map((stat, i) => {
            const d = 110 + i * 8;
            const s = spring({ frame: frame - d, fps, config: { damping: 15 } });
            const o = spring({ frame: frame - d, fps, config: { damping: 30 } });
            return (
              <div key={i} style={{ textAlign: 'center', transform: `scale(${s})`, opacity: o }}>
                <div style={{ fontFamily: fonts.display, fontSize: 58, fontWeight: 900, color: stat.color }}>
                  {stat.value}
                </div>
                <div style={{ fontFamily: fonts.mono, fontSize: 20, color: colors.textMuted, letterSpacing: 3, marginTop: 8 }}>
                  {stat.label.toUpperCase()}
                </div>
              </div>
            );
          })}
        </div>

        <Typewriter
          text="// replacing moonpay with zero-knowledge compliance"
          delay={145}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
