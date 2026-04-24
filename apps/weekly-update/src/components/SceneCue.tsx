import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { colors, fonts } from '../theme';

export interface SceneCue {
  /** Frame at which this scene starts. */
  start: number;
  /** Short label displayed when this scene is active. */
  label: string;
}

interface SceneCueHudProps {
  /** Ordered scene list. `start` must be ascending. */
  scenes: SceneCue[];
  /** Total composition length in frames — used for the last-scene countdown. */
  totalFrames: number;
}

/**
 * Talking-point HUD for voiceover recording.
 *
 * Displays 7 numbered dots at the top of the composition. The active dot
 * pulses cyan, past dots stay dim-cyan, future dots are outlined only.
 * Below: the active scene title + seconds remaining inside the current
 * scene, so the speaker knows how long to hold each topic.
 *
 * Designed to be recorded over — toggle off (`SHOW_CUES = false` in
 * `PitchVideo.tsx`) for the final render.
 */
export const SceneCueHud: React.FC<SceneCueHudProps> = ({ scenes, totalFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Resolve the currently active scene index.
  let currentIndex = 0;
  for (let i = scenes.length - 1; i >= 0; i--) {
    if (frame >= scenes[i].start) {
      currentIndex = i;
      break;
    }
  }

  const currentScene = scenes[currentIndex];
  const nextStart = scenes[currentIndex + 1]?.start ?? totalFrames;
  const sceneLength = nextStart - currentScene.start;
  const framesIntoScene = frame - currentScene.start;
  const framesLeft = Math.max(0, nextStart - frame);
  const secondsLeft = Math.ceil(framesLeft / fps);
  const sceneProgress = Math.min(1, Math.max(0, framesIntoScene / sceneLength));

  const activePulse = interpolate(Math.sin(frame * 0.08), [-1, 1], [0.55, 1]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 60,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 18,
        zIndex: 200,
        pointerEvents: 'none',
      }}
    >
      {/* Dot row */}
      <div style={{ display: 'flex', gap: 28, alignItems: 'center' }}>
        {scenes.map((_, i) => {
          const isCurrent = i === currentIndex;
          const isPast = i < currentIndex;

          return (
            <div
              key={i}
              style={{
                width: isCurrent ? 72 : 48,
                height: isCurrent ? 72 : 48,
                borderRadius: '50%',
                backgroundColor: isCurrent
                  ? colors.cyan
                  : isPast
                    ? 'rgba(57, 197, 187, 0.18)'
                    : 'rgba(21, 21, 24, 0.65)',
                border: `2px solid ${
                  isCurrent
                    ? colors.brightCyan
                    : isPast
                      ? colors.cyanDim
                      : colors.border
                }`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: fonts.mono,
                fontSize: isCurrent ? 30 : 22,
                fontWeight: 700,
                color: isCurrent
                  ? colors.void
                  : isPast
                    ? colors.cyan
                    : colors.textDim,
                boxShadow: isCurrent
                  ? `0 0 ${40 * activePulse}px ${colors.cyanGlow}`
                  : 'none',
                transition: 'none',
              }}
            >
              {i + 1}
            </div>
          );
        })}
      </div>

      {/* Progress bar inside the current scene */}
      <div
        style={{
          width: 560,
          height: 4,
          borderRadius: 2,
          backgroundColor: 'rgba(21, 21, 24, 0.7)',
          border: `1px solid ${colors.border}`,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${sceneProgress * 100}%`,
            height: '100%',
            background: `linear-gradient(to right, ${colors.cyan}, ${colors.brightCyan})`,
            boxShadow: `0 0 12px ${colors.cyanGlow}`,
          }}
        />
      </div>

      {/* Current scene label + countdown */}
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 24,
          color: colors.cyan,
          letterSpacing: 6,
          textTransform: 'uppercase',
          textAlign: 'center',
          textShadow: `0 0 14px ${colors.cyanGlow}`,
        }}
      >
        {currentIndex + 1} / {scenes.length} · {currentScene.label} ·{' '}
        <span style={{ color: colors.textMuted }}>{secondsLeft}s left</span>
      </div>
    </div>
  );
};
