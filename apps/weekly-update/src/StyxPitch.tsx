import React from 'react';
import { AbsoluteFill, Series } from 'remotion';
// Side-effect import: blocks the render until Newsreader is loaded. See the file.
import './styx/fonts';
import { Beat } from './scenes/styx-pitch/Beat';
import { ALL_BEATS, TOTAL_FRAMES } from './scenes/styx-pitch/script';
import { styx } from './styx/theme';

/**
 * Styx Protocol, the presentation film. 4K, 60fps, 120 seconds.
 *
 * Replaces PitchVideo rather than editing it. The old composition stays
 * registered and untouched: it was cut for Colosseum Frontier in April, that
 * event closed on 2026-07-27, and rewriting a film that was already shown would
 * misrepresent what was shown. This is a new cut for a new audience.
 *
 * WHAT IT SAYS, in the order the founder asked for: the usage, then the system,
 * then the result. The script, including every measured figure and the two
 * uncomfortable admissions, lives in ./scenes/styx-pitch/script.ts and is the
 * single place to edit words.
 *
 * NO TALKING-POINT HUD. PitchVideo ships SHOW_CUES = true, which burns seven
 * numbered dots and a countdown into the frame; it is a recording aid and it was
 * one forgotten boolean away from being in a delivered file. This composition has
 * no such switch.
 *
 * RENDERING: never `remotion render` this directly. A single-pass 4K/60fps render
 * bluescreens this machine with 0x1A MEMORY_MANAGEMENT, because one Chrome
 * process accumulates GPU allocations across thousands of frames. Use
 * `pnpm render:styx`, which drives scripts/render-chunked.mjs at 500 frames per
 * fresh process.
 */
export const StyxPitch: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: styx.ink }}>
      <Series>
        {ALL_BEATS.map((beat, i) => (
          <Series.Sequence key={beat.from} durationInFrames={beat.duration}>
            {/* Alternating ground, so consecutive beats are never the same
                surface and the film reads as chapters rather than as slides. */}
            <Beat beat={beat} band={i % 2 === 1} index={i} />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};

/** Exported so Root.tsx and the render script cannot disagree about the length. */
export const STYX_PITCH_FRAMES = TOTAL_FRAMES;
