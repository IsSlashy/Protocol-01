import React from 'react';
import { Composition } from 'remotion';
import { StyxPitch, STYX_PITCH_FRAMES } from './StyxPitch';

/**
 * One film.
 *
 * This project used to hold eight compositions: five weekly or launch updates, a
 * Colosseum pitch cut in April, and an intro sting. Every event they were made
 * for is over, so they were deleted on 2026-08-11 at the founder's request rather
 * than left to rot as code nobody renders but everybody has to keep compiling.
 * Their rendered files are what survives them, and git has the source if a cut
 * ever needs to be reproduced.
 *
 * Render with `pnpm render:styx`. Never `remotion render` directly: a single-pass
 * 4K/60fps render bluescreens this machine with 0x1A MEMORY_MANAGEMENT, which is
 * the whole reason scripts/render-chunked.mjs exists.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="StyxPitch"
      component={StyxPitch}
      durationInFrames={STYX_PITCH_FRAMES}
      fps={60}
      width={3840}
      height={2160}
    />
  );
};
