import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Series,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { StyxFonts } from './styx/fonts';
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
  const frame = useCurrentFrame();

  /**
   * The bed, on the house curve: four seconds up, hold at 0.8, four seconds down.
   * Same shape every film in this project has used.
   */
  const musicVolume = interpolate(
    frame,
    [0, 240, TOTAL_FRAMES - 240, TOTAL_FRAMES],
    [0, 0.8, 0.8, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill style={{ background: styx.ink }}>
      {/* Blocks the render until Newsreader is ready. See ./styx/fonts.tsx. */}
      <StyxFonts />

      {/*
        The usual Blade Runner ambient bed, rebuilt to cover 120 seconds in one
        piece instead of looping a 58 second cut. The old films looped that cut,
        which replayed its fade-in every 58 seconds; public/styx-bed.wav is three
        crossfaded copies trimmed to 124s, so the fade-in happens once and the
        film's own fade handles the rest. WAV and stripped of metadata, which is
        what this setup needs to play it at all.

        The level swings between about -16 and -27 dB across the piece. That is
        the music breathing, not an artefact: the source does the same thing, and
        it was worth measuring before trying to flatten it.
      */}
      <Audio src={staticFile('styx-bed.wav')} volume={musicVolume} />
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
