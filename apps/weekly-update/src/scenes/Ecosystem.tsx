import React from 'react';
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../components/Background';
import { TextReveal, Badge, Typewriter } from '../components/Typography';
import { CyanLine } from '../components/Shapes';
import { Narrative, BulletList } from '../components/TextBlock';
import { colors, fonts } from '../theme';

export const Ecosystem: React.FC = () => {
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
          padding: 120,
          gap: 40,
        }}
      >
        <Badge text="Ecosystem" delay={0} color={colors.brightCyan} />

        <TextReveal text="Joining Superteam Ireland" delay={10} fontSize={90} />

        <CyanLine delay={25} width="500px" />

        <Narrative
          lines={[
            "This week, Protocol 01 got listed as an official Superteam Ireland project.",
            "Superteam is the largest Solana community \u2014 builders, grants, hackathons.",
            "Being listed means visibility, feedback, and access to the ecosystem.",
          ]}
          delay={30}
          fontSize={38}
          lineDelay={12}
          highlight={[0]}
          maxWidth={2800}
        />

        <div style={{ display: 'flex', gap: 40, marginTop: 20, maxWidth: 3200 }}>
          <div
            style={{
              flex: 1,
              backgroundColor: 'rgba(21, 21, 24, 0.6)',
              border: `1px solid ${colors.cyan}25`,
              borderRadius: 24,
              padding: '40px 50px',
              opacity: spring({ frame: frame - 75, fps, config: { damping: 30 } }),
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 28, color: colors.cyan, marginBottom: 20, letterSpacing: 4 }}>
              COLOSSEUM FRONTIER
            </div>
            <BulletList
              items={[
                "Solana's biggest hackathon \u2014 live now",
                'Protocol 01 entered as a Superteam Ireland project',
                'Deadline: May 11, 2026',
                '29 days to ship the best version',
              ]}
              delay={80}
              fontSize={30}
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
              opacity: spring({ frame: frame - 85, fps, config: { damping: 30 } }),
            }}
          >
            <div style={{ fontFamily: fonts.display, fontSize: 28, color: colors.brightCyan, marginBottom: 20, letterSpacing: 4 }}>
              DOGPATCH DUBLIN
            </div>
            <BulletList
              items={[
                'Heading to Ireland to build with the team IRL',
                'Meeting Diarmuid and the ST Ireland builders',
                'Face-to-face > 1000 DMs',
                'Real connections, real momentum',
              ]}
              delay={90}
              fontSize={30}
              itemDelay={8}
              bulletColor={colors.brightCyan}
            />
          </div>
        </div>

        <Typewriter
          text="// the best things happen when you show up in person"
          delay={130}
          fontSize={30}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
