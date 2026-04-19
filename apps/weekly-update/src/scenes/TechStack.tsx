import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../components/Background';
import { TextReveal, Badge, Typewriter } from '../components/Typography';
import { CyanLine } from '../components/Shapes';
import { Narrative, BulletList } from '../components/TextBlock';
import { colors, fonts } from '../theme';

export const TechStack: React.FC = () => {
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
        <Badge text="What Was Built" delay={0} />

        <TextReveal text="Full-stack shipped in one week" delay={10} fontSize={80} />

        <CyanLine delay={20} width="350px" />

        <Narrative
          lines={[
            "This isn't just a landing page. Everything was built from scratch this week \u2014",
            "the on-chain program, the SDK, the frontend, and the integrations.",
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
              ON-CHAIN
            </div>
            <BulletList
              items={[
                'Solana program \u2014 9 instructions (create, escrow, dispute, reputation)',
                'PDA vault escrow \u2014 funds locked until both parties confirm',
                'Reputation system \u2014 Poseidon hash-based trust scoring',
                'Dispute resolution \u2014 arbiter flow with timeout protection',
                'ZK compliance \u2014 innocence proofs, no identity disclosure',
              ]}
              delay={55}
              fontSize={30}
              itemDelay={8}
            />
          </div>

          <div
            style={{
              flex: 1,
              backgroundColor: 'rgba(21, 21, 24, 0.6)',
              border: `1px solid ${colors.mugenBlue}25`,
              borderRadius: 24,
              padding: '40px 50px',
              opacity: spring({ frame: frame - 60, fps, config: { damping: 30 } }),
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 30, color: colors.mugenBlue, marginBottom: 24, letterSpacing: 4 }}>
              OFF-CHAIN
            </div>
            <BulletList
              items={[
                'Privacy SDK \u2014 Mugen is the 15th module integrated',
                'Web app \u2014 Next.js 16, live on Vercel',
                'Order indexer \u2014 real-time on-chain polling, deployed on Railway',
                'Mobile integration \u2014 QR auth flow wired end-to-end',
                'Chrome extension \u2014 live order book + signing',
              ]}
              delay={65}
              fontSize={30}
              itemDelay={8}
              bulletColor={colors.mugenBlue}
            />
          </div>
        </div>

        <Typewriter
          text="// deployed: devnet + vercel + railway"
          delay={120}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
