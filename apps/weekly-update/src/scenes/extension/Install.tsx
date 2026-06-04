import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { BulletList } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

export const ExtInstall: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const browsersOpacity = spring({ frame: frame - 95, fps, config: { damping: 30 } });

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
        <Badge text="Beta · Devnet" delay={0} color={colors.yellow} />

        <TextReveal text="Install in 30 seconds" delay={10} fontSize={92} />

        <CyanLine delay={22} width="460px" />

        <div
          style={{
            backgroundColor: 'rgba(21, 21, 24, 0.6)',
            border: `1px solid ${colors.cyan}25`,
            borderRadius: 24,
            padding: '44px 60px',
            marginTop: 10,
          }}
        >
          <BulletList
            items={[
              'Download the .zip from protocol-01.dev/extension',
              'Open chrome://extensions',
              'Turn on Developer mode',
              'Load unpacked → select the folder',
            ]}
            delay={30}
            fontSize={36}
            itemDelay={11}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 28,
            marginTop: 24,
            opacity: browsersOpacity,
            fontFamily: fonts.display,
            fontSize: 36,
            letterSpacing: 4,
            color: colors.textMuted,
          }}
        >
          <span style={{ color: colors.cyan }}>CHROME</span>
          <span style={{ color: colors.textDim }}>·</span>
          <span>OPERA</span>
          <span style={{ color: colors.textDim }}>·</span>
          <span>EDGE</span>
          <span style={{ color: colors.textDim }}>·</span>
          <span>BRAVE</span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
