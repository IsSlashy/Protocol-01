import React from 'react';
import { AbsoluteFill, Audio, Sequence, Series, staticFile, interpolate, useCurrentFrame } from 'remotion';
import { PitchIntro } from './scenes/pitch/PitchIntro';
import { WhoIAm } from './scenes/pitch/WhoIAm';
import { ProblemReveal } from './scenes/pitch/ProblemReveal';
import { WhatIBuilt } from './scenes/pitch/WhatIBuilt';
import { QuantumResistant } from './scenes/pitch/QuantumResistant';
import { WhyMe } from './scenes/pitch/WhyMe';
import { PitchOutro } from './scenes/pitch/PitchOutro';
import { SceneCueHud } from './components/SceneCue';

/**
 * Talking-point HUD toggle.
 *
 * `true`  — 7 numbered dots + countdown overlay visible. Use this while
 *           recording voiceover so you know which topic is live.
 * `false` — hide the HUD for the final render.
 */
const SHOW_CUES = true;

/**
 * Colosseum Frontier — Pitch Video
 *
 * 60fps, 4K, 120 seconds total = 7200 frames
 *
 * Scene starts: 0, 480, 1800, 3600, 5100, 5580, 6600
 *
 * Script (word-by-word voiceover) lives in the JSDoc of each scene file.
 * Narration runs on the same audio track as a separate pass — record it
 * externally and drop the WAV into public/voiceover.wav, then uncomment the
 * second <Audio> below.
 */

const sceneStarts = {
  intro: 0,
  whoIAm: 480,
  problem: 1800,
  whatBuilt: 3600,
  quantum: 5100,
  whyMe: 5580,
  outro: 6600,
  end: 7200,
};

/** Labels shown in the HUD — keep short, all-caps for readability. */
const sceneCueList = [
  { start: sceneStarts.intro, label: 'Intro · Who I am' },
  { start: sceneStarts.whoIAm, label: 'Cyber → crypto → web3' },
  { start: sceneStarts.problem, label: 'The problem' },
  { start: sceneStarts.whatBuilt, label: 'What I built' },
  { start: sceneStarts.quantum, label: 'Quantum-resistant' },
  { start: sceneStarts.whyMe, label: 'Why me' },
  { start: sceneStarts.outro, label: 'Outro · Live on devnet' },
];

// Typewriter SFX — each entry matches a Typewriter in a scene.
// frame = scene_start + delay_inside_scene
// textLen used to compute duration; startFrom varies the clip offset.
const typingEvents = [
  { frame: sceneStarts.intro + 180, textLen: 24, startFrom: 0 },   // "// pitch · april 23, 2026"
  { frame: sceneStarts.whoIAm + 240, textLen: 29, startFrom: 20 }, // "// that's how i ended up here"
  { frame: sceneStarts.problem + 640, textLen: 56, startFrom: 35 },// "// every privacy project rebuilds..."
  { frame: sceneStarts.whatBuilt + 245, textLen: 47, startFrom: 10 }, // "// any wallet can subscribe..."
  { frame: sceneStarts.quantum + 170, textLen: 51, startFrom: 25 }, // "// hash-based proofs..."
  { frame: sceneStarts.whyMe + 240, textLen: 58, startFrom: 50 },  // "// this is what one engineer..."
  { frame: sceneStarts.outro + 240, textLen: 22, startFrom: 5 },   // "// thanks for watching"
];

export const PitchVideo: React.FC = () => {
  const frame = useCurrentFrame();

  const musicVolume = interpolate(
    frame,
    [0, 240, sceneStarts.end - 240, sceneStarts.end],
    [0, 0.8, 0.8, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill>
      {/* Background music — reuse the Blade Runner ambient cut */}
      <Audio src={staticFile('bg-music.wav')} volume={musicVolume} loop />

      {/* Typing SFX synced to each Typewriter component */}
      {typingEvents.map((evt, i) => {
        const typingDuration = evt.textLen * 2;
        return (
          <Sequence key={`typing-${i}`} from={evt.frame} durationInFrames={typingDuration}>
            <Audio src={staticFile('typing.mp3')} volume={0.4} startFrom={evt.startFrom} />
          </Sequence>
        );
      })}

      {/*
        Voiceover — record externally, export 24-bit WAV, place at
        public/pitch-voiceover.wav, then uncomment below.

        <Audio src={staticFile('pitch-voiceover.wav')} volume={1.0} />
      */}

      <Series>
        <Series.Sequence durationInFrames={sceneStarts.whoIAm - sceneStarts.intro}>
          <PitchIntro />
        </Series.Sequence>

        <Series.Sequence durationInFrames={sceneStarts.problem - sceneStarts.whoIAm}>
          <WhoIAm />
        </Series.Sequence>

        <Series.Sequence durationInFrames={sceneStarts.whatBuilt - sceneStarts.problem}>
          <ProblemReveal />
        </Series.Sequence>

        <Series.Sequence durationInFrames={sceneStarts.quantum - sceneStarts.whatBuilt}>
          <WhatIBuilt />
        </Series.Sequence>

        <Series.Sequence durationInFrames={sceneStarts.whyMe - sceneStarts.quantum}>
          <QuantumResistant />
        </Series.Sequence>

        <Series.Sequence durationInFrames={sceneStarts.outro - sceneStarts.whyMe}>
          <WhyMe />
        </Series.Sequence>

        <Series.Sequence durationInFrames={sceneStarts.end - sceneStarts.outro}>
          <PitchOutro />
        </Series.Sequence>
      </Series>

      {/* Talking-point HUD — 7 dots + countdown. Flip SHOW_CUES=false before final render. */}
      {SHOW_CUES && (
        <SceneCueHud scenes={sceneCueList} totalFrames={sceneStarts.end} />
      )}
    </AbsoluteFill>
  );
};
