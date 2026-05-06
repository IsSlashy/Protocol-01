import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative, BulletList } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

export const TechUpdate: React.FC = () => {
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
          padding: 100,
          gap: 35,
        }}
      >
        <Badge text="Engineering" delay={0} />

        <TextReveal text="ZK now works end-to-end" delay={10} fontSize={88} />

        <CyanLine delay={20} width="450px" />

        <Narrative
          lines={[
            "While in Dublin, we shipped the fixes that close the recovery loop.",
            "Every shielded note can now be recovered, replayed, and unshielded — live on devnet.",
          ]}
          delay={25}
          fontSize={36}
          lineDelay={10}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 60, marginTop: 20, maxWidth: 3400 }}>
          <div
            style={{
              flex: 1,
              backgroundColor: 'rgba(21, 21, 24, 0.6)',
              border: `1px solid ${colors.cyan}25`,
              borderRadius: 24,
              padding: '40px 50px',
              opacity: spring({ frame: frame - 50, fps, config: { damping: 30 } }),
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 30, color: colors.cyan, marginBottom: 24, letterSpacing: 4 }}>
              CRITICAL FIXES
            </div>
            <BulletList
              items={[
                'Merkle root divergence — replayMerkleProofFromEvents shipped',
                'Note recovery from chain history works for every pool',
                'Per-pool counter via findSafeShieldCounter',
                'Unshield lifecycle: 5 cascading bugs closed',
                'V3 STARK pools live on devnet — v0.9.11 tagged',
              ]}
              delay={55}
              fontSize={28}
              itemDelay={8}
            />
          </div>

          <div
            style={{
              flex: 1,
              backgroundColor: 'rgba(21, 21, 24, 0.6)',
              border: `1px solid ${colors.brightCyan}25`,
              borderRadius: 24,
              padding: '40px 50px',
              opacity: spring({ frame: frame - 60, fps, config: { damping: 30 } }),
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 30, color: colors.brightCyan, marginBottom: 24, letterSpacing: 4 }}>
              WHAT IT MEANS
            </div>
            <BulletList
              items={[
                'No more lost notes after wallet reinstall',
                'Cross-device recovery works without a relayer',
                'Quantum-resistant STARK path validated end-to-end',
                'Foundation is now stable enough to build on top of',
                'Time to focus on what comes next: enterprise SDKs',
              ]}
              delay={65}
              fontSize={28}
              itemDelay={8}
              bulletColor={colors.brightCyan}
            />
          </div>
        </div>

        <Typewriter
          text="// shielded notes, fully recoverable"
          delay={130}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
