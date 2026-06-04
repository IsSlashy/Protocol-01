import React from 'react';
import { AbsoluteFill } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge } from '../../components/Typography';
import { CyanLine, StatCard } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors } from '../../theme';

export const RelPrivyOut: React.FC = () => {
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
          gap: 40,
        }}
      >
        <Badge text="Self-custody" delay={0} />

        <TextReveal text="We removed Privy" delay={10} fontSize={96} />

        <CyanLine delay={22} width="480px" />

        <Narrative
          lines={[
            "No more third-party login. No embedded wallets. No accounts.",
            "Your wallet is a seed phrase, generated on your device and never sent anywhere.",
          ]}
          delay={28}
          fontSize={38}
          lineDelay={13}
          highlight={[1]}
        />

        <div style={{ display: 'flex', gap: 50, marginTop: 30 }}>
          <StatCard value="0" label="third parties" delay={58} />
          <StatCard value="100%" label="on your device" delay={67} color={colors.brightCyan} />
          <StatCard value="1" label="seed, yours" delay={76} color={colors.pink} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
