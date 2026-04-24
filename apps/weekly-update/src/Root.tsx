import React from 'react';
import { Composition } from 'remotion';
import { WeeklyUpdate } from './WeeklyUpdate';
import { PitchVideo } from './PitchVideo';
import { FrostIntro } from './FrostIntro';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="WeeklyUpdate"
        component={WeeklyUpdate}
        durationInFrames={3240}
        fps={60}
        width={3840}
        height={2160}
      />
      <Composition
        id="PitchVideo"
        component={PitchVideo}
        durationInFrames={7200}
        fps={60}
        width={3840}
        height={2160}
      />
      <Composition
        id="FrostIntro"
        component={FrostIntro}
        durationInFrames={1500}
        fps={60}
        width={3840}
        height={2160}
      />
    </>
  );
};
