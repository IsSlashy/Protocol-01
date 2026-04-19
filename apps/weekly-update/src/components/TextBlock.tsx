import React from 'react';
import { interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { colors, fonts } from '../theme';

interface NarrativeProps {
  lines: string[];
  delay?: number;
  fontSize?: number;
  lineDelay?: number;
  align?: 'left' | 'center';
  maxWidth?: number;
  color?: string;
  highlight?: number[];
}

export const Narrative: React.FC<NarrativeProps> = ({
  lines,
  delay = 0,
  fontSize = 40,
  lineDelay = 10,
  align = 'center',
  maxWidth = 2800,
  color = colors.textMuted,
  highlight = [],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div style={{ maxWidth, textAlign: align }}>
      {lines.map((line, i) => {
        const d = delay + i * lineDelay;
        const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
        const y = interpolate(
          spring({ frame: frame - d, fps, config: { damping: 20, stiffness: 80 } }),
          [0, 1],
          [30, 0]
        );
        const isHighlight = highlight.includes(i);

        return (
          <div
            key={i}
            style={{
              fontFamily: isHighlight ? fonts.display : fonts.body,
              fontSize: isHighlight ? fontSize * 1.1 : fontSize,
              fontWeight: isHighlight ? 700 : 400,
              color: isHighlight ? colors.text : color,
              opacity,
              transform: `translateY(${y}px)`,
              marginBottom: fontSize * 0.6,
              lineHeight: 1.5,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

interface QuoteBlockProps {
  text: string;
  delay?: number;
  fontSize?: number;
  maxWidth?: number;
}

export const QuoteBlock: React.FC<QuoteBlockProps> = ({
  text,
  delay = 0,
  fontSize = 44,
  maxWidth = 2600,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = spring({ frame: frame - delay, fps, config: { damping: 30 } });
  const scaleX = spring({ frame: frame - delay, fps, config: { damping: 20 } });

  return (
    <div
      style={{
        maxWidth,
        opacity,
        display: 'flex',
        gap: 30,
        alignItems: 'stretch',
      }}
    >
      <div
        style={{
          width: 4,
          backgroundColor: colors.cyan,
          borderRadius: 2,
          transform: `scaleY(${scaleX})`,
          transformOrigin: 'top',
          boxShadow: `0 0 15px ${colors.cyanGlow}`,
          flexShrink: 0,
        }}
      />
      <div
        style={{
          fontFamily: fonts.body,
          fontSize,
          color: colors.textMuted,
          fontStyle: 'italic',
          lineHeight: 1.6,
          padding: '8px 0',
        }}
      >
        {text}
      </div>
    </div>
  );
};

interface BulletListProps {
  items: string[];
  delay?: number;
  fontSize?: number;
  itemDelay?: number;
  color?: string;
  bulletColor?: string;
}

export const BulletList: React.FC<BulletListProps> = ({
  items,
  delay = 0,
  fontSize = 36,
  itemDelay = 8,
  color = colors.textMuted,
  bulletColor = colors.cyan,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {items.map((item, i) => {
        const d = delay + i * itemDelay;
        const opacity = spring({ frame: frame - d, fps, config: { damping: 30 } });
        const x = interpolate(
          spring({ frame: frame - d, fps, config: { damping: 18 } }),
          [0, 1],
          [-40, 0]
        );

        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 20,
              opacity,
              transform: `translateX(${x}px)`,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: bulletColor,
                marginTop: fontSize * 0.35,
                flexShrink: 0,
                boxShadow: `0 0 12px ${colors.cyanGlow}`,
              }}
            />
            <div style={{ fontFamily: fonts.body, fontSize, color, lineHeight: 1.5 }}>
              {item}
            </div>
          </div>
        );
      })}
    </div>
  );
};
