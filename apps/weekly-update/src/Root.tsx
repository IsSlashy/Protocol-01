import React from 'react';
import { Composition } from 'remotion';
import { WeeklyUpdate } from './WeeklyUpdate';

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
    </>
  );
};
