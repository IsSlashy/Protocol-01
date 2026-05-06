import React from 'react';
import { AbsoluteFill, Img, staticFile, interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { GlowBackground, ScanLine } from '../../components/Background';
import { GlitchText, TextReveal } from '../../components/Typography';
import { CyanLine } from '../../components/Shapes';
import { colors, fonts } from '../../theme';

export const Week4Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoGlow = interpolate(Math.sin(frame * 0.06), [-1, 1], [0.3, 1]);
  const mascotOpacity = interpolate(
    frame,
    [0, 180],
    [0, 0.12],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill>
      <GlowBackground />
      <ScanLine />

      <div
        style={{
          position: 'absolute',
          left: -250,
          bottom: -200,
          opacity: mascotOpacity,
          filter: `drop-shadow(0 0 ${30 * logoGlow}px ${colors.cyanGlow})`,
          zIndex: 0,
        }}
      >
        <Img
          src={staticFile('mascot.png')}
          style={{ height: 1600, objectFit: 'contain', transform: 'scaleX(-1)' }}
        />
      </div>

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 30,
          zIndex: 1,
        }}
      >
        <div
          style={{
            opacity: spring({ frame, fps, config: { damping: 30 } }),
            transform: `scale(${spring({ frame, fps, config: { damping: 12 } })})`,
            filter: `drop-shadow(0 0 ${35 * logoGlow}px ${colors.cyanGlow})`,
          }}
        >
          <Img
            src={staticFile('icon.png')}
            style={{ width: 160, height: 160, borderRadius: 28 }}
          />
        </div>

        <GlitchText text="WEEK 4 DONE" fontSize={120} delay={15} />

        <CyanLine delay={25} width="350px" />

        <TextReveal
          text="Thanks Superteam Ireland."
          delay={35}
          fontSize={44}
          color={colors.textMuted}
          font={fonts.body}
        />

        <div
          style={{
            display: 'flex',
            gap: 30,
            marginTop: 20,
            opacity: spring({ frame: frame - 45, fps, config: { damping: 30 } }),
          }}
        >
          {[
            { label: '@Slashy_fx', platform: 'X' },
            { label: 'protocol-01.dev', platform: 'WEB' },
            { label: 'IsSlashy', platform: 'GITHUB' },
          ].map((link, i) => (
            <div
              key={i}
              style={{
                backgroundColor: 'rgba(21, 21, 24, 0.6)',
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: '16px 32px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <div style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.textDim, letterSpacing: 4 }}>
                {link.platform}
              </div>
              <div style={{ fontFamily: fonts.body, fontSize: 28, color: colors.text }}>
                {link.label}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: 100,
            right: 120,
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            opacity: spring({ frame: frame - 55, fps, config: { damping: 30 } }),
          }}
        >
          <Img
            src={staticFile('founder.png')}
            style={{
              width: 100,
              height: 100,
              borderRadius: 20,
              border: `2px solid ${colors.cyan}40`,
              filter: `drop-shadow(0 0 15px ${colors.cyanGlow})`,
            }}
          />
          <div>
            <div style={{ fontFamily: fonts.display, fontSize: 36, color: colors.text, fontWeight: 700 }}>
              Slashy
            </div>
            <div style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.textDim }}>
              Developer
            </div>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
