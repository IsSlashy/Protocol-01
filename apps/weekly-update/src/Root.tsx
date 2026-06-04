import React from 'react';
import { Composition } from 'remotion';
import { WeeklyUpdate } from './WeeklyUpdate';
import { Week3 } from './Week3';
import { Week4 } from './Week4';
import { PitchVideo } from './PitchVideo';
import { FrostIntro } from './FrostIntro';
import { ExtensionLaunch } from './ExtensionLaunch';
import { ReleaseUpdate } from './ReleaseUpdate';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ReleaseUpdate"
        component={ReleaseUpdate}
        durationInFrames={3060}
        fps={60}
        width={3840}
        height={2160}
      />
      <Composition
        id="ExtensionLaunch"
        component={ExtensionLaunch}
        durationInFrames={2100}
        fps={60}
        width={3840}
        height={2160}
      />
      <Composition
        id="Week4"
        component={Week4}
        durationInFrames={3600}
        fps={60}
        width={3840}
        height={2160}
      />
      <Composition
        id="Week3"
        component={Week3}
        durationInFrames={3000}
        fps={60}
        width={3840}
        height={2160}
      />
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
