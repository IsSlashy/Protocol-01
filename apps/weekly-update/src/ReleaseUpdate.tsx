import React from 'react';
import { AbsoluteFill, Audio, Sequence, Series, staticFile, interpolate, useCurrentFrame } from 'remotion';
import { RelIntro } from './scenes/release/Intro';
import { RelPrivyOut } from './scenes/release/PrivyOut';
import { RelStabilized } from './scenes/release/Stabilized';
import { RelExtensionParity } from './scenes/release/ExtensionParity';
import { RelWhatsNew } from './scenes/release/WhatsNew';
import { RelOutro } from './scenes/release/Outro';

// 60fps, 4K — 3060 frames = 51s
// Scene starts: 0, 360, 900, 1500, 2100, 2640
const typingEvents = [
  { frame: 0 + 70, textLen: 48, startFrom: 0 }, // Intro Typewriter
];

export const ReleaseUpdate: React.FC = () => {
  const frame = useCurrentFrame();

  const musicVolume = interpolate(
    frame,
    [0, 240, 2820, 3060],
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
        <Series.Sequence durationInFrames={360}>
          <RelIntro />
        </Series.Sequence>
        <Series.Sequence durationInFrames={540}>
          <RelPrivyOut />
        </Series.Sequence>
        <Series.Sequence durationInFrames={600}>
          <RelStabilized />
        </Series.Sequence>
        <Series.Sequence durationInFrames={600}>
          <RelExtensionParity />
        </Series.Sequence>
        <Series.Sequence durationInFrames={540}>
          <RelWhatsNew />
        </Series.Sequence>
        <Series.Sequence durationInFrames={420}>
          <RelOutro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
