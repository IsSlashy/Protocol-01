import React from 'react';
import { AbsoluteFill } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative, BulletList } from '../../components/TextBlock';
import { colors } from '../../theme';

export const RelStabilized: React.FC = () => {
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
        <Badge text="Hardened" delay={0} />

        <TextReveal text="Every core flow, end to end" delay={10} fontSize={86} />

        <CyanLine delay={22} width="500px" />

        <Narrative
          lines={["Weeks of fixes closed the loop. The privacy stack now just works, live on devnet."]}
          delay={28}
          fontSize={36}
          lineDelay={10}
          highlight={[0]}
        />

        <div
          style={{
            backgroundColor: 'rgba(21, 21, 24, 0.6)',
            border: `1px solid ${colors.cyan}25`,
            borderRadius: 24,
            padding: '40px 56px',
            marginTop: 14,
          }}
        >
          <BulletList
            items={[
              'Shield, unshield and sweep, end to end',
              'Private denominated transfers fixed',
              'Recurring subscriptions on-chain',
              'Relayers made self-healing',
              'V3 STARK pipeline, live on devnet',
            ]}
            delay={42}
            fontSize={34}
            itemDelay={9}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
