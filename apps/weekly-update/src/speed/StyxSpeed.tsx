import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Series,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { StyxFonts } from '../styx/fonts';
import { Eyebrow, Lede, Mono, Rule, Stack, useEnter } from '../styx/kit';
import { space, styx, styxFonts, tracking, type } from '../styx/theme';
import { FlowField, type FlowProps } from './FlowField';
import { COPY, N, SCENES, TOTAL_FRAMES } from './copy';

/**
 * Styx, the speed film. 4K, 60 fps, 45 seconds.
 *
 * Five scenes, one idea each: the wait (hook), the same withdrawal before and
 * after (the race), the shield number, why (the bars), the line and the
 * address. Words and numbers live in ./copy.ts and nowhere else.
 *
 * The ground is the river: the Grok stills moved by ./FlowField.tsx. The race
 * scene is the film's whole argument as a picture, a stagnant left bank and a
 * fast teal current on the right, so the two timers sit on the water that
 * matches them.
 *
 * RENDERING: never `remotion render` this directly (0x1A MEMORY_MANAGEMENT at
 * 4K, see Root.tsx). Use `pnpm render:speed`.
 */
export const StyxSpeed: React.FC = () => {
  const frame = useCurrentFrame();
  const musicVolume = interpolate(
    frame,
    [0, 180, TOTAL_FRAMES - 240, TOTAL_FRAMES],
    [0, 0.8, 0.8, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill style={{ background: styx.ink }}>
      <StyxFonts />
      <Audio src={staticFile('styx-bed.wav')} volume={musicVolume} />
      <Series>
        <Series.Sequence durationInFrames={SCENES.intro}>
          <Intro />
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENES.race}>
          <Race />
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENES.shield}>
          <Shield />
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENES.breakdown}>
          <Breakdown />
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENES.outro}>
          <Outro />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};

export const STYX_SPEED_FRAMES = TOTAL_FRAMES;

/* ------------------------------------------------------------------------- */
/* Shared                                                                     */
/* ------------------------------------------------------------------------- */

const OUT = Easing.bezier(0.22, 1, 0.36, 1);

/** A count that eases in from 0, so a figure arrives rather than appears. */
const useCount = (to: number, from: number, duration: number, start = 0, easing = OUT) => {
  const frame = useCurrentFrame();
  return interpolate(frame, [from, from + duration], [start, to], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
};

const fmt1 = (v: number) => v.toFixed(1);
const fmtClock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

/**
 * The river under a scene, and the scene's own fade: 16 frames in from ink,
 * 22 frames out to ink, so a cut never lands on the middle of a current.
 */
const Scene: React.FC<{ flow: FlowProps; children: React.ReactNode }> = ({ flow, children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = interpolate(
    frame,
    [0, 16, durationInFrames - 22, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
  return (
    <AbsoluteFill style={{ background: styx.ink, opacity }}>
      <FlowField {...flow} />
      <AbsoluteFill
        style={{
          color: styx.paper,
          fontFamily: styxFonts.sans,
          padding: `${space.frameY}px ${space.frameX}px`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Foot: React.FC<{ children: React.ReactNode; delay?: number }> = ({ children, delay = 0 }) => (
  <Mono delay={delay} size={type.micro} color={styx.faint}>
    <div style={{ lineHeight: 1.6, maxWidth: 3000 }}>{children}</div>
  </Mono>
);

const Big: React.FC<{
  children: React.ReactNode;
  size?: number;
  color?: string;
  style?: React.CSSProperties;
}> = ({ children, size = 420, color = styx.paper, style }) => (
  <div
    style={{
      fontFamily: styxFonts.serif,
      fontWeight: 300,
      fontSize: size,
      lineHeight: 0.92,
      letterSpacing: '-0.035em',
      color,
      fontVariantNumeric: 'tabular-nums',
      ...style,
    }}
  >
    {children}
  </div>
);

const Unit: React.FC<{ children: React.ReactNode; size: number }> = ({ children, size }) => (
  <span style={{ fontSize: size, color: styx.muted, marginLeft: '0.08em' }}>{children}</span>
);

const HERO = staticFile('speed/bg_hero.jpg');
const SPLIT = staticFile('speed/bg_split.jpg');
const SQUARE = staticFile('speed/bg_square.jpg');

/* ------------------------------------------------------------------------- */
/* 1. The hook                                                                */
/* ------------------------------------------------------------------------- */

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const statement = useEnter(24, 36, 50);
  return (
    <Scene
      flow={{
        src: HERO, srcAspect: 16 / 9,
        speedLeft: 0.04, speedRight: 0.04, ampLeft: 0.025, ampRight: 0.025,
        streak: 0.45, dim: 0.35, phase: 3,
      }}
    >
      <div style={{ marginTop: 'auto', marginBottom: 'auto' }}>
        <Stack gap={space.gapLg}>
          <Eyebrow delay={0}>{COPY.intro.eyebrow}</Eyebrow>
          <div
            style={{
              ...statement,
              fontFamily: styxFonts.serif,
              fontWeight: 300,
              fontSize: type.display,
              lineHeight: 1.02,
              letterSpacing: '-0.025em',
              maxWidth: 2800,
            }}
          >
            {COPY.intro.statement}
          </div>
          <Rule delay={70} width={2400} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 56 }}>
            <Spinner from={110} frame={frame} />
            <Lede delay={110} maxWidth={2300}>
              {COPY.intro.lede}
            </Lede>
          </div>
        </Stack>
      </div>
    </Scene>
  );
};

/** The spinner everyone has watched. Faint, and it never stops. */
const Spinner: React.FC<{ from: number; frame: number }> = ({ from, frame }) => {
  const enter = useEnter(from);
  const angle = ((frame - from) * 4) % 360;
  return (
    <div
      style={{
        ...enter,
        width: 72,
        height: 72,
        flex: 'none',
        borderRadius: '50%',
        border: `4px solid ${styx.rule}`,
        borderTopColor: styx.muted,
        transform: `${enter.transform} rotate(${angle}deg)`,
      }}
    />
  );
};

/* ------------------------------------------------------------------------- */
/* 2. The race                                                                */
/* ------------------------------------------------------------------------- */

const Race: React.FC = () => {
  const frame = useCurrentFrame();
  /* Both clocks start at 90. They run at 22x until the right one finishes at
     66.3 s; the left one then accelerates to its 357.9 s and holds. */
  const elapsed =
    frame < 270
      ? interpolate(frame, [90, 270], [0, N.withdrawTestAfter], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
      : interpolate(frame, [270, 660], [N.withdrawTestAfter, N.withdrawTestBefore], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.in(Easing.quad),
        });
  const rightDone = frame >= 270;
  const leftDone = frame >= 660;
  const title = useEnter(16, 36, 50);
  const inner = useEnter(330, 30, 30);
  const sixMin = useEnter(672, 30, 20);
  const clocks = useEnter(60, 30, 40);
  const seal = interpolate(frame, [270, 300], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: OUT });

  return (
    <Scene
      flow={{
        src: SPLIT, srcAspect: 16 / 9,
        speedLeft: 0.012, speedRight: 0.42, ampLeft: 0.012, ampRight: 0.05,
        split: 0.5, softness: 0.06, streak: 1, dim: 0.38,
      }}
    >
      <Stack gap={space.gap}>
        <Eyebrow delay={0}>{COPY.race.eyebrow}</Eyebrow>
        <div
          style={{
            ...title,
            fontFamily: styxFonts.serif,
            fontWeight: 300,
            fontSize: type.h1,
            lineHeight: 1.05,
            letterSpacing: '-0.022em',
            maxWidth: 3200,
          }}
        >
          {COPY.race.title}
        </div>
      </Stack>

      <div style={{ ...clocks, marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        <div style={{ paddingRight: 140 }}>
          <Tag>{COPY.race.before}</Tag>
          <Big size={440} color={leftDone ? styx.paper : styx.muted}>
            {fmtClock(elapsed)}
          </Big>
          <Label>{COPY.race.beforeLabel}</Label>
          <div style={{ ...sixMin, marginTop: 24, fontFamily: styxFonts.serif, fontSize: type.h3, color: styx.muted }}>
            just under six minutes
          </div>
        </div>
        <div style={{ paddingLeft: 140, borderLeft: `2px solid ${styx.rule}` }}>
          <Tag teal>{COPY.race.after}</Tag>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <Big size={440}>
              {fmt1(Math.min(elapsed, N.withdrawTestAfter))}
              <Unit size={180}>s</Unit>
            </Big>
            {/* The seal: the teal rule that says "landed", drawn once the clock stops. */}
            <div
              style={{
                position: 'absolute',
                left: 0,
                bottom: -18,
                height: 8,
                width: 1100 * seal,
                background: styx.seal,
                opacity: rightDone ? 1 : 0,
              }}
            />
          </div>
          <Label>{COPY.race.afterLabel}</Label>
          <div style={{ ...inner, marginTop: 24, fontFamily: styxFonts.serif, fontSize: type.h3, color: styx.paper }}>
            {COPY.race.afterInner}&nbsp;
            <span style={{ color: styx.seal, fontVariantNumeric: 'tabular-nums' }}>{fmt1(N.withdrawAfter)} s</span>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 72 }}>
        <Foot delay={700}>{COPY.race.foot}</Foot>
      </div>
    </Scene>
  );
};

const Tag: React.FC<{ children: React.ReactNode; teal?: boolean }> = ({ children, teal }) => (
  <div
    style={{
      fontFamily: styxFonts.mono,
      fontSize: type.label,
      letterSpacing: tracking.label,
      textTransform: 'uppercase',
      color: teal ? styx.seal : styx.faint,
      marginBottom: 36,
    }}
  >
    {children}
  </div>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: type.lede, color: styx.paper, marginTop: 40 }}>{children}</div>
);

/* ------------------------------------------------------------------------- */
/* 3. The shield                                                              */
/* ------------------------------------------------------------------------- */

const Shield: React.FC = () => {
  const frame = useCurrentFrame();
  const v = useCount(N.shield, 20, 100);
  const trail = interpolate(frame, [20, 120], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: OUT });
  const lede = useEnter(120, 30, 40);
  return (
    <Scene
      flow={{
        src: HERO, srcAspect: 16 / 9,
        speedLeft: 0.3, speedRight: 0.3, ampLeft: 0.04, ampRight: 0.04,
        streak: 0.9, dim: 0.3, phase: 11,
      }}
    >
      <Eyebrow delay={0}>{COPY.shield.eyebrow}</Eyebrow>
      <div style={{ marginTop: 100, position: 'relative', display: 'inline-block', alignSelf: 'flex-start' }}>
        <Big size={620}>
          {fmt1(v)}
          <Unit size={260}>s</Unit>
        </Big>
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: -30,
            height: 8,
            width: 1500 * trail,
            background: `linear-gradient(90deg, ${styx.seal}, rgba(57,197,187,0))`,
          }}
        />
      </div>
      <div style={{ ...lede, marginTop: 110, fontSize: type.lede, lineHeight: 1.4, color: styx.paper, maxWidth: 2500 }}>
        {COPY.shield.lede}
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 56, borderTop: `2px solid ${styx.rule}`, display: 'flex', gap: 200 }}>
        {COPY.shield.stats.map((s, i) => (
          <Stat key={s.k} delay={210 + i * 34} v={s.v} unit={s.unit} k={s.k} />
        ))}
      </div>
      <div style={{ marginTop: 56 }}>
        <Foot delay={330}>{COPY.shield.foot}</Foot>
      </div>
    </Scene>
  );
};

const Stat: React.FC<{ delay: number; v: number; unit: string; k: string }> = ({ delay, v, unit, k }) => {
  const enter = useEnter(delay, 30, 40);
  const count = useCount(v, delay, 50);
  const isInt = Number.isInteger(v);
  return (
    <div style={enter}>
      <Big size={150}>
        {isInt ? Math.round(count) : fmt1(count)}
        <Unit size={72}>{unit}</Unit>
      </Big>
      <div style={{ marginTop: 20, fontSize: type.body, color: styx.muted }}>{k}</div>
    </div>
  );
};

/* ------------------------------------------------------------------------- */
/* 4. Why                                                                     */
/* ------------------------------------------------------------------------- */

const Breakdown: React.FC = () => {
  const frame = useCurrentFrame();
  const title = useEnter(14, 36, 50);
  const scanIn = useEnter(360, 30, 30);
  const scan = useCount(N.scanAfter, 380, 70, N.scanBefore);
  return (
    <Scene
      flow={{
        src: SQUARE, srcAspect: 1,
        speedLeft: 0.07, speedRight: 0.07, ampLeft: 0.03, ampRight: 0.03,
        streak: 0.35, dim: 0.5, phase: 7,
      }}
    >
      <Stack gap={space.gap}>
        <Eyebrow delay={0}>{COPY.breakdown.eyebrow}</Eyebrow>
        <div
          style={{
            ...title,
            fontFamily: styxFonts.serif,
            fontWeight: 300,
            fontSize: type.h1,
            lineHeight: 1.05,
            letterSpacing: '-0.022em',
          }}
        >
          {COPY.breakdown.title}
        </div>
        <Lede delay={40} maxWidth={2600}>
          {COPY.breakdown.lede}
        </Lede>
      </Stack>

      <div style={{ marginTop: 96, display: 'flex', flexDirection: 'column', gap: 64, maxWidth: 3000 }}>
        {COPY.breakdown.bars.map((b, i) => (
          <Bar key={b.label} delay={100 + i * 80} max={N.proofLegacy} {...b} />
        ))}
      </div>

      <div
        style={{
          ...scanIn,
          marginTop: 'auto',
          paddingTop: 48,
          borderTop: `2px solid ${styx.rule}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          maxWidth: 3000,
        }}
      >
        <div style={{ fontSize: type.lede }}>{COPY.breakdown.scan}</div>
        <Big size={150}>
          <span style={{ color: styx.muted }}>{fmt1(N.scanBefore)} s</span>
          <span style={{ color: styx.faint, margin: '0 0.25em' }}>→</span>
          {fmt1(scan)}
          <Unit size={72}>s</Unit>
        </Big>
      </div>
      <div style={{ marginTop: 40 }}>
        <Foot delay={430}>{COPY.breakdown.foot}</Foot>
      </div>
    </Scene>
  );
};

const Bar: React.FC<{
  delay: number;
  label: string;
  v: number;
  max: number;
  note: string;
  teal: boolean;
}> = ({ delay, label, v, max, note, teal }) => {
  const enter = useEnter(delay, 26, 30);
  const w = useCount(v / max, delay + 10, 60);
  const count = useCount(v, delay + 10, 60);
  return (
    <div style={enter}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: type.lede, color: teal ? styx.seal : styx.paper }}>{label}</div>
        <Big size={120}>
          {fmt1(count)}
          <Unit size={60}>s</Unit>
        </Big>
      </div>
      <div style={{ position: 'relative', height: 14, background: styx.ruleSoft, marginTop: 18 }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${w * 100}%`,
            background: styx.paper,
            opacity: teal ? 0.9 : 0.5,
          }}
        />
        {/* The seal on the head of the bar that Solana's change made possible. */}
        {teal ? (
          <div
            style={{
              position: 'absolute',
              left: `calc(${w * 100}% - 96px)`,
              top: -4,
              width: 96,
              height: 22,
              background: styx.seal,
            }}
          />
        ) : null}
      </div>
      <div
        style={{
          marginTop: 16,
          fontFamily: styxFonts.mono,
          fontSize: type.micro,
          letterSpacing: '0.02em',
          color: styx.faint,
        }}
      >
        {note}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------- */
/* 5. The line                                                                */
/* ------------------------------------------------------------------------- */

const Outro: React.FC = () => {
  const statement = useEnter(10, 40, 50);
  const brand = useEnter(70, 30, 30);
  const url = useEnter(100, 30, 30);
  return (
    <Scene
      flow={{
        src: HERO, srcAspect: 16 / 9,
        speedLeft: 0.12, speedRight: 0.12, ampLeft: 0.03, ampRight: 0.03,
        streak: 0.6, dim: 0.42, phase: 29,
      }}
    >
      <div style={{ marginTop: 'auto', marginBottom: 'auto' }}>
        <Stack gap={space.gapLg}>
          <div
            style={{
              ...statement,
              fontFamily: styxFonts.serif,
              fontWeight: 300,
              fontSize: type.display,
              lineHeight: 1.02,
              letterSpacing: '-0.025em',
              maxWidth: 3000,
            }}
          >
            {COPY.outro.statement}
          </div>
          <Rule delay={60} width={2400} />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 72 }}>
            <div
              style={{
                ...brand,
                fontFamily: styxFonts.mono,
                fontSize: type.h3,
                letterSpacing: tracking.label,
                textTransform: 'uppercase',
                color: styx.seal,
              }}
            >
              {COPY.outro.brand}
            </div>
            <div style={{ ...url, fontFamily: styxFonts.mono, fontSize: type.h3, color: styx.paper }}>
              {COPY.outro.url}
            </div>
          </div>
        </Stack>
      </div>
      <Foot delay={140}>{COPY.outro.foot}</Foot>
    </Scene>
  );
};
