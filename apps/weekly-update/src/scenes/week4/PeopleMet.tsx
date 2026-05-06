import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { TextReveal, Badge, Typewriter } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { Narrative } from '../../components/TextBlock';
import { colors, fonts } from '../../theme';

const people = [
  {
    photo: 'diarmuid.jpg',
    name: 'Diarmuid',
    role: 'Superteam Ireland',
    bio: 'Solana builder · Dublin community',
    contribution: 'Walked us through the Dublin Solana scene and made the right introductions.',
    color: colors.cyan,
  },
  {
    photo: 'alejandro.jpg',
    name: 'Alejandro Gutierrez',
    role: 'Lead · Superteam Ireland',
    bio: 'Director · Blockchain Ireland',
    contribution: 'Pushed us hard on positioning and traction — exactly the feedback we needed.',
    color: colors.brightCyan,
  },
];

export const PeopleMet: React.FC = () => {
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
        <Badge text="People We Met" delay={0} />

        <TextReveal text="Real builders, real conversations" delay={10} fontSize={78} />

        <CyanLine delay={20} width="500px" />

        <Narrative
          lines={[
            "Superteam Ireland opened the doors and the calendar.",
            "We sat down with people building, funding, and shipping in this ecosystem.",
          ]}
          delay={25}
          fontSize={34}
          lineDelay={10}
          highlight={[0]}
        />

        <div style={{ display: 'flex', gap: 80, marginTop: 20 }}>
          {people.map((p, i) => {
            const d = 50 + i * 22;
            const scale = spring({ frame: frame - d, fps, config: { damping: 14, stiffness: 70 } });
            const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
            const glowPulse = interpolate(Math.sin(frame * 0.04 + i), [-1, 1], [0.4, 0.9]);

            const contribOpacity = spring({
              frame: frame - (d + 130),
              fps,
              config: { damping: 30 },
            });
            const contribY = interpolate(
              spring({ frame: frame - (d + 130), fps, config: { damping: 18 } }),
              [0, 1],
              [20, 0]
            );

            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 22,
                  width: 720,
                }}
              >
                <div
                  style={{
                    transform: `scale(${scale})`,
                    opacity,
                    width: 420,
                    height: 420,
                    borderRadius: '50%',
                    overflow: 'hidden',
                    border: `4px solid ${p.color}`,
                    boxShadow: `0 0 ${50 * glowPulse}px ${p.color}`,
                  }}
                >
                  <Img
                    src={staticFile(p.photo)}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </div>

                <div style={{ textAlign: 'center', opacity }}>
                  <div style={{ fontFamily: fonts.display, fontSize: 52, fontWeight: 700, color: colors.text }}>
                    {p.name}
                  </div>
                  <div style={{ fontFamily: fonts.mono, fontSize: 22, color: p.color, letterSpacing: 3, marginTop: 8 }}>
                    {p.role.toUpperCase()}
                  </div>
                  <div style={{ fontFamily: fonts.body, fontSize: 22, color: colors.textMuted, marginTop: 6 }}>
                    {p.bio}
                  </div>
                </div>

                <div
                  style={{
                    backgroundColor: 'rgba(21, 21, 24, 0.65)',
                    border: `1px solid ${p.color}30`,
                    borderRadius: 16,
                    padding: '20px 26px',
                    fontFamily: fonts.body,
                    fontSize: 24,
                    color: colors.text,
                    lineHeight: 1.5,
                    maxWidth: 640,
                    textAlign: 'center',
                    opacity: contribOpacity,
                    transform: `translateY(${contribY}px)`,
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: -10,
                      left: 24,
                      backgroundColor: colors.void,
                      padding: '0 12px',
                      fontFamily: fonts.mono,
                      fontSize: 16,
                      color: p.color,
                      letterSpacing: 3,
                    }}
                  >
                    WHAT THEY BROUGHT
                  </div>
                  {p.contribution}
                </div>
              </div>
            );
          })}
        </div>

        <Typewriter
          text="// the room you walk into changes the trajectory"
          delay={240}
          fontSize={28}
          color={colors.textDim}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
