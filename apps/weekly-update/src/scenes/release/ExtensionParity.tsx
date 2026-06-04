import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

const FEATURES = ['Wallet & send', 'Stealth addresses', 'Shielded notes', 'Subscriptions', 'Cross-device sync'];

const Panel: React.FC<{ title: string; color: string; delay: number }> = ({ title, color, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const o = spring({ frame: frame - delay, fps, config: { damping: 26 } });
  return (
    <div
      style={{
        flex: 1,
        opacity: o,
        backgroundColor: 'rgba(21,21,24,0.6)',
        border: `1px solid ${color}40`,
        borderRadius: 24,
        padding: '36px 44px',
        boxShadow: `0 0 40px ${color}18`,
      }}
    >
      <div style={{ fontFamily: fonts.display, fontSize: 38, color, letterSpacing: 4, marginBottom: 22 }}>{title}</div>
      {FEATURES.map((f, i) => {
        const fo = spring({ frame: frame - delay - 8 - i * 6, fps, config: { damping: 30 } });
        return (
          <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, opacity: fo }}>
            <span style={{ color, fontSize: 28 }}>{'✓'}</span>
            <span style={{ fontFamily: fonts.body, fontSize: 30, color: colors.text }}>{f}</span>
          </div>
        );
      })}
    </div>
  );
};

export const RelExtensionParity: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const eqScale = spring({ frame: frame - 70, fps, config: { damping: 12, stiffness: 90 } });

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
          gap: 38,
        }}
      >
        <Badge text="Mobile = Browser" delay={0} color={colors.pink} />

        <TextReveal text="The Chrome extension caught up" delay={10} fontSize={84} />

        <CyanLine delay={22} width="540px" />

        <Narrative
          lines={["Everything the mobile app does, the extension now does too. Feature for feature."]}
          delay={28}
          fontSize={36}
          lineDelay={10}
          highlight={[0]}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 30, marginTop: 24, maxWidth: 3200, width: '100%' }}>
          <Panel title="MOBILE" color={colors.cyan} delay={48} />
          <div style={{ fontFamily: fonts.display, fontSize: 90, color: colors.pink, transform: `scale(${eqScale})` }}>=</div>
          <Panel title="EXTENSION" color={colors.pink} delay={58} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
