import React from 'react';
import { AbsoluteFill, Audio, Sequence, Series, staticFile, interpolate, useCurrentFrame } from 'remotion';
import { Week3Intro } from './scenes/week3/Intro';
import { ColosseumSubmit } from './scenes/week3/ColosseumSubmit';
import { ServiceRegistry } from './scenes/week3/ServiceRegistry';
import { V09Release } from './scenes/week3/V09Release';
import { PitchSDK } from './scenes/week3/PitchSDK';
import { WhatsNext } from './scenes/week3/WhatsNext';
import { Week3Outro } from './scenes/week3/Outro';

// 60fps, 4K — 3000 frames = 50s
// Scene starts: 0, 300, 780, 1320, 1860, 2340, 2700
const typingEvents = [
  { frame: 0 + 70,    textLen: 22, startFrom: 0 },   // "// april 20 - 26, 2026"
  { frame: 300 + 150, textLen: 26, startFrom: 10 },  // "// the bet is on the table"
  { frame: 780 + 240, textLen: 38, startFrom: 25 },  // "// subscriptions, on-chain, verifiable"
  { frame: 1320 + 200, textLen: 47, startFrom: 5 },  // "// shielded notes, fully recoverable..."
  { frame: 1860 + 130, textLen: 41, startFrom: 35 }, // "// builders, investors, users — one stack"
  { frame: 2340 + 130, textLen: 36, startFrom: 20 }, // "// face-to-face beats a thousand DMs"
];

export const Week3: React.FC = () => {
  const frame = useCurrentFrame();

  const musicVolume = interpolate(
    frame,
    [0, 300, 2820, 3000],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill>
      <Audio
        src={staticFile('bg-music.wav')}
        volume={musicVolume}
        loop
      />

      {typingEvents.map((evt, i) => {
        const typingDuration = evt.textLen * 2;
        return (
          <Sequence key={`typing-${i}`} from={evt.frame} durationInFrames={typingDuration}>
            <Audio
              src={staticFile('typing.mp3')}
              volume={0.5}
              startFrom={evt.startFrom}
            />
          </Sequence>
        );
      })}

      <Series>
        <Series.Sequence durationInFrames={300}>
          <Week3Intro />
        </Series.Sequence>

        <Series.Sequence durationInFrames={480}>
          <ColosseumSubmit />
        </Series.Sequence>

        <Series.Sequence durationInFrames={540}>
          <ServiceRegistry />
        </Series.Sequence>

        <Series.Sequence durationInFrames={540}>
          <V09Release />
        </Series.Sequence>

        <Series.Sequence durationInFrames={480}>
          <PitchSDK />
        </Series.Sequence>

        <Series.Sequence durationInFrames={360}>
          <WhatsNext />
        </Series.Sequence>

        <Series.Sequence durationInFrames={300}>
          <Week3Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
