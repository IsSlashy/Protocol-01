import React from 'react';
import { AbsoluteFill, Audio, Sequence, Series, staticFile, interpolate, useCurrentFrame } from 'remotion';
import { Week4Intro } from './scenes/week4/Intro';
import { IrelandTrip } from './scenes/week4/IrelandTrip';
import { PeopleMet } from './scenes/week4/PeopleMet';
import { PeteConference } from './scenes/week4/PeteConference';
import { TechUpdate } from './scenes/week4/TechUpdate';
import { WhatsNext } from './scenes/week4/WhatsNext';
import { Week4Outro } from './scenes/week4/Outro';

// 60fps, 4K — 3600 frames = 60s
// Scene starts:  0, 300, 780, 1620, 2340, 2820, 3300
const typingEvents = [
  { frame: 0 + 70,    textLen: 24, startFrom: 0 },   // "// april 27 - may 3, 2026"
  { frame: 300 + 150, textLen: 35, startFrom: 15 },  // "// face-to-face beats..."
  { frame: 780 + 240, textLen: 47, startFrom: 30 },  // "// the room you walk into..."
  { frame: 1620 + 200, textLen: 38, startFrom: 10 }, // "// the talk that re-shaped..."
  { frame: 2340 + 130, textLen: 33, startFrom: 45 }, // "// shielded notes..."
  { frame: 2820 + 170, textLen: 47, startFrom: 20 }, // "// stable foundation..."
];

export const Week4: React.FC = () => {
  const frame = useCurrentFrame();

  const musicVolume = interpolate(
    frame,
    [0, 300, 3420, 3600],
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
          <Week4Intro />
        </Series.Sequence>

        <Series.Sequence durationInFrames={480}>
          <IrelandTrip />
        </Series.Sequence>

        <Series.Sequence durationInFrames={840}>
          <PeopleMet />
        </Series.Sequence>

        <Series.Sequence durationInFrames={720}>
          <PeteConference />
        </Series.Sequence>

        <Series.Sequence durationInFrames={480}>
          <TechUpdate />
        </Series.Sequence>

        <Series.Sequence durationInFrames={480}>
          <WhatsNext />
        </Series.Sequence>

        <Series.Sequence durationInFrames={300}>
          <Week4Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
