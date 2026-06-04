import React from 'react';
import { AbsoluteFill } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { BulletList } from '../../components/TextBlock';
import { colors } from '../../theme';

export const RelWhatsNew: React.FC = () => {
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
        <Badge text="New" delay={0} color={colors.brightCyan} />

        <TextReveal text="What you get this release" delay={10} fontSize={88} />

        <CyanLine delay={22} width="500px" />

        <div
          style={{
            backgroundColor: 'rgba(21, 21, 24, 0.6)',
            border: `1px solid ${colors.cyan}25`,
            borderRadius: 24,
            padding: '42px 58px',
            marginTop: 12,
          }}
        >
          <BulletList
            items={[
              'Subscribe on your phone, see it in the extension',
              'Connect your phone wallet to the extension by QR',
              'On-chain merchant registry, real prices everywhere',
              'Relayer health, in the app and on the site',
              'Mobile v1.0.2 and Chrome extension v0.5.0 beta',
            ]}
            delay={34}
            fontSize={35}
            itemDelay={10}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
