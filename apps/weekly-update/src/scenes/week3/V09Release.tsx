import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge, Typewriter, GlitchText } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative, BulletList } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

export const V09Release: React.FC = () => {
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
          padding: 90,
          gap: 30,
        }}
      >
        <Badge text="Release" delay={0} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
          <TextReveal text="v0.9.9" delay={5} fontSize={130} color={colors.cyan} />
          <GlitchText text="SHIPPED" fontSize={100} delay={15} />
        </div>

        <CyanLine delay={25} width="450px" />

        <Narrative
          lines={[
            "Fresh denominated pools, full chain-rebuild recovery, unrecoverable-note safety net.",
            "The week the privacy layer became actually usable.",
          ]}
          delay={30}
          fontSize={34}
          lineDelay={10}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 50, marginTop: 24, maxWidth: 3400 }}>
          <div
            style={{
              flex: 1,
              backgroundColor: 'rgba(21, 21, 24, 0.6)',
              border: `1px solid ${colors.cyan}25`,
              borderRadius: 24,
              padding: '36px 44px',
              opacity: spring({ frame: frame - 50, fps, config: { damping: 30 } }),
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 28, color: colors.cyan, marginBottom: 22, letterSpacing: 4 }}>
              ON-CHAIN
            </div>
            <BulletList
              items={[
                'denominated_pool_v2 seed bump — 13 fresh pools',
                'paginated getSignaturesForAddress for full pool history',
                'multi-layout event decoder for ShieldDenominatedEvent',
                'MerkleRootChanged decoded for full leaf coverage',
                'native SOL pool PDAs corrected (SystemProgram ID)',
              ]}
              delay={55}
              fontSize={26}
              itemDelay={6}
            />
          </div>

          <div
            style={{
              flex: 1,
              backgroundColor: 'rgba(21, 21, 24, 0.6)',
              border: `1px solid ${colors.brightCyan}25`,
              borderRadius: 24,
              padding: '36px 44px',
              opacity: spring({ frame: frame - 60, fps, config: { damping: 30 } }),
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 28, color: colors.brightCyan, marginBottom: 22, letterSpacing: 4 }}>
              MOBILE
            </div>
            <BulletList
              items={[
                'Merkle proof rebuild from full leaves on recovered notes',
                'abandonNote action for unrecoverable pre-hardening notes',
                'deterministic stealth keypair + crash-sweep on failure',
                "don't trust stored merkleRoot unless it matches current",
                'walletStore destructive init wipe — fixed',
              ]}
              delay={65}
              fontSize={26}
              itemDelay={6}
              bulletColor={colors.brightCyan}
            />
          </div>
        </div>

        <Typewriter
          text="// shielded notes, fully recoverable from chain"
          delay={200}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
