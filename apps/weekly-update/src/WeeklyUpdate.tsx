import React from 'react';
import { AbsoluteFill, Audio, Sequence, Series, staticFile, interpolate, useCurrentFrame } from 'remotion';
import { Intro } from './scenes/Intro';
import { TheProblem } from './scenes/TheProblem';
import { MugenReveal } from './scenes/MugenReveal';
import { HowItWorks } from './scenes/HowItWorks';
import { TechStack } from './scenes/TechStack';
import { Ecosystem } from './scenes/Ecosystem';
import { Outro } from './scenes/Outro';

// 60fps, 4K — ~54 seconds total = 3240 frames
// Scene starts:  0, 300, 780, 1320, 1860, 2400, 2940

// Each Typewriter: absolute_frame = scene_start + delay
// Duration = text.length * speed(2)
// Audio startFrom = random offset into the 2s typing clip
const typingEvents = [
  { frame: 0 + 70,    textLen: 22, startFrom: 0 },   // "// april 6 - 12, 2026"
  { frame: 300 + 120,  textLen: 61, startFrom: 15 },  // "// you expose your identity..."
  { frame: 780 + 145,  textLen: 52, startFrom: 30 },  // "// replacing moonpay..."
  { frame: 1320 + 120, textLen: 42, startFrom: 10 },  // "// fully on-chain escrow..."
  { frame: 1860 + 120, textLen: 38, startFrom: 45 },  // "// deployed: devnet..."
  { frame: 2400 + 130, textLen: 53, startFrom: 20 },  // "// the best things happen..."
];

export const WeeklyUpdate: React.FC = () => {
  const frame = useCurrentFrame();

  const musicVolume = interpolate(
    frame,
    [0, 300, 3060, 3240],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill>
      {/* Background music */}
      <Audio
        src={staticFile('bg-music.wav')}
        volume={musicVolume}
        loop
      />

      {/* Typing SFX — synced to each Typewriter, duration matches text length */}
      {typingEvents.map((evt, i) => {
        const typingDuration = evt.textLen * 2; // 2 frames per char
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

      {/* Scenes */}
      <Series>
        <Series.Sequence durationInFrames={300}>
          <Intro />
        </Series.Sequence>

        <Series.Sequence durationInFrames={480}>
          <TheProblem />
        </Series.Sequence>

        <Series.Sequence durationInFrames={540}>
          <MugenReveal />
        </Series.Sequence>

        <Series.Sequence durationInFrames={540}>
          <HowItWorks />
        </Series.Sequence>

        <Series.Sequence durationInFrames={540}>
          <TechStack />
        </Series.Sequence>

        <Series.Sequence durationInFrames={540}>
          <Ecosystem />
        </Series.Sequence>

        <Series.Sequence durationInFrames={300}>
          <Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
