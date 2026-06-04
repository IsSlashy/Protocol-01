import React from 'react';
import { AbsoluteFill } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge } from '../../components/Typography';
import { CyanLine, StatCard } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors } from '../../theme';

export const ExtWhatItIs: React.FC = () => {
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
        <Badge text="In your browser" delay={0} />

        <TextReveal text="A private Solana wallet, one tab away" delay={10} fontSize={84} />

        <CyanLine delay={22} width="500px" />

        <Narrative
          lines={[
            "Pay merchants, subscribe, and send — without broadcasting who you are.",
            "Stealth addresses, shielded notes, and anonymous license keys, built in.",
          ]}
          delay={28}
          fontSize={36}
          lineDelay={12}
          highlight={[1]}
        />

        <div style={{ display: 'flex', gap: 50, marginTop: 30 }}>
          <StatCard value="Stealth" label="one-time addresses" delay={55} />
          <StatCard value="Shielded" label="STARK notes" delay={64} color={colors.pink} />
          <StatCard value="Recurring" label="subscriptions" delay={73} color={colors.brightCyan} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
