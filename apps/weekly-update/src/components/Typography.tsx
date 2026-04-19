import React from 'react';
import { interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { colors, fonts } from '../theme';

interface TextRevealProps {
  text: string;
  delay?: number;
  fontSize?: number;
  color?: string;
  font?: string;
  align?: 'left' | 'center' | 'right';
  uppercase?: boolean;
  letterSpacing?: number;
  maxWidth?: string;
}

export const TextReveal: React.FC<TextRevealProps> = ({
  text,
  delay = 0,
  fontSize = 80,
  color = colors.text,
  font = fonts.display,
  align = 'center',
  uppercase = false,
  letterSpacing = 0,
  maxWidth,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = spring({ frame: frame - delay, fps, config: { damping: 30 } });
  const y = interpolate(
    spring({ frame: frame - delay, fps, config: { damping: 20, stiffness: 80 } }),
    [0, 1],
    [60, 0]
  );

  return (
    <div
      style={{
        fontFamily: font,
        fontSize,
        fontWeight: 700,
        color,
        textAlign: align,
        transform: `translateY(${y}px)`,
        opacity,
        textTransform: uppercase ? 'uppercase' : 'none',
        letterSpacing,
        lineHeight: 1.2,
        maxWidth,
      }}
    >
      {text}
    </div>
  );
};

interface GlitchTextProps {
  text: string;
  fontSize?: number;
  delay?: number;
}

export const GlitchText: React.FC<GlitchTextProps> = ({
  text,
  fontSize = 120,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = spring({ frame: frame - delay, fps, config: { damping: 30 } });
  const glitchOffset = frame % 60 < 3 ? Math.random() * 4 - 2 : 0;

  return (
    <div style={{ position: 'relative', opacity }}>
      {/* Cyan ghost */}
      <div
        style={{
          position: 'absolute',
          fontFamily: fonts.display,
          fontSize,
          fontWeight: 900,
          color: colors.cyan,
          opacity: frame % 60 < 3 ? 0.7 : 0,
          transform: `translate(${glitchOffset}px, ${-glitchOffset}px)`,
          mixBlendMode: 'screen',
        }}
      >
        {text}
      </div>
      {/* Pink ghost */}
      <div
        style={{
          position: 'absolute',
          fontFamily: fonts.display,
          fontSize,
          fontWeight: 900,
          color: colors.pink,
          opacity: frame % 60 < 3 ? 0.7 : 0,
          transform: `translate(${-glitchOffset}px, ${glitchOffset}px)`,
          mixBlendMode: 'screen',
        }}
      >
        {text}
      </div>
      {/* Main text */}
      <div
        style={{
          fontFamily: fonts.display,
          fontSize,
          fontWeight: 900,
          color: colors.text,
          position: 'relative',
        }}
      >
        {text}
      </div>
    </div>
  );
};

interface BadgeProps {
  text: string;
  delay?: number;
  color?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  text,
  delay = 0,
  color = colors.cyan,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = spring({ frame: frame - delay, fps, config: { damping: 30 } });

  return (
    <div
      style={{
        display: 'inline-block',
        fontFamily: fonts.mono,
        fontSize: 28,
        fontWeight: 600,
        color,
        letterSpacing: 8,
        textTransform: 'uppercase',
        opacity,
        border: `2px solid ${color}`,
        padding: '12px 32px',
        borderRadius: 8,
      }}
    >
      {text}
    </div>
  );
};

interface TypewriterProps {
  text: string;
  delay?: number;
  fontSize?: number;
  color?: string;
  speed?: number;
}

export const Typewriter: React.FC<TypewriterProps> = ({
  text,
  delay = 0,
  fontSize = 36,
  color = colors.cyan,
  speed = 2,
}) => {
  const frame = useCurrentFrame();
  const adjustedFrame = Math.max(0, frame - delay);
  const charsToShow = Math.min(Math.floor(adjustedFrame / speed), text.length);
  const showCursor = adjustedFrame % 16 < 10;

  return (
    <div
      style={{
        fontFamily: fonts.mono,
        fontSize,
        color,
        whiteSpace: 'pre',
      }}
    >
      {text.slice(0, charsToShow)}
      {charsToShow < text.length && showCursor && (
        <span style={{ opacity: 0.8 }}>_</span>
      )}
    </div>
  );
};
