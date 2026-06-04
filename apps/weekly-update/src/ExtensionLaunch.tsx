import React from 'react';
import { AbsoluteFill, Audio, Sequence, Series, staticFile, interpolate, useCurrentFrame } from 'remotion';
import { ExtIntro } from './scenes/extension/Intro';
import { ExtWhatItIs } from './scenes/extension/WhatItIs';
import { ExtSync } from './scenes/extension/Sync';
import { ExtInstall } from './scenes/extension/Install';
import { ExtOutro } from './scenes/extension/Outro';

// 60fps, 4K — 2100 frames = 35s
// Scene starts: 0, 330, 780, 1260, 1740
const typingEvents = [
  { frame: 0 + 70, textLen: 44, startFrom: 0 }, // Intro Typewriter "// the private wallet…"
];

export const ExtensionLaunch: React.FC = () => {
  const frame = useCurrentFrame();

  const musicVolume = interpolate(
    frame,
    [0, 240, 1860, 2100],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill>
      <Audio src={staticFile('bg-music.wav')} volume={musicVolume} loop />

      {typingEvents.map((evt, i) => (
        <Sequence key={`typing-${i}`} from={evt.frame} durationInFrames={evt.textLen * 2}>
          <Audio src={staticFile('typing.mp3')} volume={0.5} startFrom={evt.startFrom} />
        </Sequence>
      ))}

      <Series>
        <Series.Sequence durationInFrames={330}>
          <ExtIntro />
        </Series.Sequence>
        <Series.Sequence durationInFrames={450}>
          <ExtWhatItIs />
        </Series.Sequence>
        <Series.Sequence durationInFrames={480}>
          <ExtSync />
        </Series.Sequence>
        <Series.Sequence durationInFrames={480}>
          <ExtInstall />
        </Series.Sequence>
        <Series.Sequence durationInFrames={360}>
          <ExtOutro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
