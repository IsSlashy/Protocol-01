import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

const Node: React.FC<{ label: string; color: string; delay: number }> = ({ label, color, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 16, stiffness: 80 } });
  return (
    <div
      style={{
        transform: `scale(${s})`,
        padding: '26px 44px',
        borderRadius: 18,
        backgroundColor: 'rgba(21,21,24,0.7)',
        border: `1px solid ${color}55`,
        fontFamily: fonts.display,
        fontSize: 40,
        letterSpacing: 3,
        color,
        boxShadow: `0 0 30px ${color}22`,
      }}
    >
      {label}
    </div>
  );
};

const Arrow: React.FC<{ delay: number }> = ({ delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = spring({ frame: frame - delay, fps, config: { damping: 30 } });
  return <div style={{ fontFamily: fonts.mono, fontSize: 48, color: colors.textDim, opacity: o }}>{'→'}</div>;
};

export const ExtSync: React.FC = () => {
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
          gap: 44,
        }}
      >
        <Badge text="Cross-device" delay={0} color={colors.pink} />

        <TextReveal text="Phone and extension, in sync" delay={10} fontSize={88} />

        <CyanLine delay={22} width="520px" />

        <Narrative
          lines={[
            "Subscribe on your phone — it shows up in the extension. Same wallet, same prices.",
            "No backend, no accounts: subscriptions live on-chain, read by both apps.",
          ]}
          delay={28}
          fontSize={36}
          lineDelay={12}
          highlight={[0]}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 36, marginTop: 30 }}>
          <Node label="PHONE" color={colors.cyan} delay={60} />
          <Arrow delay={70} />
          <Node label="SOLANA" color={colors.yellow} delay={78} />
          <Arrow delay={88} />
          <Node label="EXTENSION" color={colors.pink} delay={96} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
