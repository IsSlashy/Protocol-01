import React from 'react';
import {
  AbsoluteFill,
  Audio,
  staticFile,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { colors, fonts } from './theme';

/**
 * FROST — v0.9.9 release intro.
 *
 * Concept: a luminous shattered-crystal burst. A dense cluster of sharp
 * triangular shards radiates from a blinding white core. Each shard
 * breathes independently — length and angle oscillate out of phase so the
 * whole cluster morphs continuously, as if the crystal is a living form.
 * Chromatic aberration fringes the edges with cyan/magenta ghosts. The
 * core throws lens streaks out across the frame.
 *
 * Pure black field. No orbs, no hex fragments, no starfield. A few bokeh
 * specks with rainbow rims drift in the background for depth.
 *
 * Real 3D comes from CSS perspective + per-shard rotateY tilts, so the
 * cluster has actual volume as it spins.
 *
 * Duration: 25 seconds @ 60fps = 1500 frames. 4K (3840×2160).
 */

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function progress(frame: number, start: number, end: number, ease: (t: number) => number = easeOut): number {
  const raw = (frame - start) / (end - start);
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return ease(raw);
}

// Cheap deterministic pseudo-random based on index seed — avoids Math.random
// (which would hydrate differently per chunk, breaking frame continuity).
function rand(seed: number) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Shard — one sharp spike radiating from origin.
//
// Rendered as an SVG polygon: a very thin elongated diamond.
// Drawn with a length→0 alpha gradient so the tip fades to transparent,
// which gives the "light shard" feel.
// ---------------------------------------------------------------------------

type ShardConfig = {
  angle: number;      // base angle (deg)
  length: number;     // base length at rest (px)
  width: number;      // shard thickness at widest point (px)
  tilt: number;       // 3D Y tilt (deg) — adds volume
  phase: number;      // morph phase offset
  breathSpan: number; // length oscillation amplitude (0..1)
};

const SHARD_COUNT = 42;

function makeShards(): ShardConfig[] {
  return Array.from({ length: SHARD_COUNT }, (_, i) => {
    const baseAngle = (i / SHARD_COUNT) * 360;
    // Cluster jitter: shift some shards so the arrangement feels chaotic, not radial-regular
    const jitter = (rand(i * 1.7) - 0.5) * 28;
    return {
      angle: baseAngle + jitter,
      length: 260 + rand(i * 2.3) * 460,
      width: 3 + rand(i * 3.1) * 12,
      tilt: (rand(i * 4.7) - 0.5) * 80,
      phase: rand(i * 5.3) * Math.PI * 2,
      breathSpan: 0.3 + rand(i * 6.1) * 0.35,
    };
  });
}

const SHARDS = makeShards();

const Shard: React.FC<{ config: ShardConfig; revealT: number; morphT: number }> = ({
  config,
  revealT,
  morphT,
}) => {
  const frame = useCurrentFrame();

  // Breathing: length oscillates around its base by ±breathSpan
  const breath = Math.sin(frame * 0.015 + config.phase);
  const lengthScale = 0.55 + breath * config.breathSpan * 0.5 + 0.45;
  const length = config.length * lengthScale * revealT;

  // Morph: angle drifts slowly, bigger drift during explicit morph windows
  const angleNow = config.angle + Math.sin(frame * 0.006 + config.phase) * 6 + morphT * 22 * Math.sin(config.phase);

  // Shard polygon: diamond with sharp tip.
  //   base (0, width/2) → shoulder (length*0.12, 0) → tip (length, width/2)
  //                    → shoulder (length*0.12, width) → back to base
  const w = config.width;
  const pts = `0,${w / 2} ${length * 0.12},0 ${length},${w / 2} ${length * 0.12},${w}`;

  return (
    <svg
      width={length}
      height={w}
      viewBox={`0 0 ${length} ${w}`}
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        overflow: 'visible',
        transform: `translate(0, ${-w / 2}px) rotate(${angleNow}deg) rotateY(${config.tilt}deg)`,
        transformOrigin: '0 50%',
        opacity: revealT,
      }}
    >
      <defs>
        <linearGradient id={`g-${Math.round(config.angle)}-${Math.round(config.length)}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="10%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="60%" stopColor="#dfeaff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={pts}
        fill={`url(#g-${Math.round(config.angle)}-${Math.round(config.length)})`}
      />
    </svg>
  );
};

// ---------------------------------------------------------------------------
// Shard cluster — all shards, wrapped so we can rotate the whole thing in 3D
// and duplicate it for chromatic aberration.
// ---------------------------------------------------------------------------

const ShardCluster: React.FC<{ revealT: number; morphT: number }> = ({ revealT, morphT }) => {
  return (
    <>
      {SHARDS.map((s, i) => (
        <Shard key={i} config={s} revealT={revealT} morphT={morphT} />
      ))}
    </>
  );
};

// ---------------------------------------------------------------------------
// Core burst — blinding white center with lens streaks.
// ---------------------------------------------------------------------------

const CoreBurst: React.FC<{ intensity: number }> = ({ intensity }) => {
  const frame = useCurrentFrame();
  const flicker = interpolate(Math.sin(frame * 0.06), [-1, 1], [0.88, 1]);
  const breath = interpolate(Math.sin(frame * 0.02), [-1, 1], [0.92, 1.08]);

  const size = 760 * intensity * breath;

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
    >
      {/* Wide soft bloom */}
      <div
        style={{
          position: 'absolute',
          width: size * 1.6,
          height: size * 1.6,
          marginLeft: -size * 0.8,
          marginTop: -size * 0.8,
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(255,255,255,${0.45 * intensity}) 0%, rgba(200,220,255,${0.18 * intensity}) 30%, transparent 65%)`,
          filter: 'blur(40px)',
          mixBlendMode: 'screen',
        }}
      />
      {/* Mid bloom */}
      <div
        style={{
          position: 'absolute',
          width: size,
          height: size,
          marginLeft: -size / 2,
          marginTop: -size / 2,
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(255,255,255,${0.9 * flicker * intensity}) 0%, rgba(240,250,255,${0.4 * intensity}) 28%, transparent 60%)`,
          filter: 'blur(14px)',
          mixBlendMode: 'screen',
        }}
      />
      {/* Tight hot core */}
      <div
        style={{
          position: 'absolute',
          width: 90 * intensity * breath,
          height: 90 * intensity * breath,
          marginLeft: -45 * intensity * breath,
          marginTop: -45 * intensity * breath,
          borderRadius: '50%',
          background: '#ffffff',
          boxShadow: `0 0 80px rgba(255,255,255,${intensity}), 0 0 40px #ffffff`,
          filter: 'blur(2px)',
        }}
      />
      {/* Horizontal streak */}
      <div
        style={{
          position: 'absolute',
          width: 2400 * intensity,
          height: 3,
          marginLeft: -1200 * intensity,
          marginTop: -1.5,
          background: `linear-gradient(90deg, transparent 0%, rgba(255,255,255,${0.85 * intensity * flicker}) 50%, transparent 100%)`,
          filter: 'blur(1.5px)',
          mixBlendMode: 'screen',
        }}
      />
      {/* Vertical streak */}
      <div
        style={{
          position: 'absolute',
          width: 3,
          height: 2400 * intensity,
          marginLeft: -1.5,
          marginTop: -1200 * intensity,
          background: `linear-gradient(180deg, transparent 0%, rgba(255,255,255,${0.75 * intensity * flicker}) 50%, transparent 100%)`,
          filter: 'blur(1.5px)',
          mixBlendMode: 'screen',
        }}
      />
      {/* Diagonal streaks */}
      {[45, -45].map((deg) => (
        <div
          key={deg}
          style={{
            position: 'absolute',
            width: 1800 * intensity,
            height: 2,
            marginLeft: -900 * intensity,
            marginTop: -1,
            background: `linear-gradient(90deg, transparent 0%, rgba(255,240,220,${0.55 * intensity * flicker}) 50%, transparent 100%)`,
            filter: 'blur(1px)',
            transform: `rotate(${deg}deg)`,
            mixBlendMode: 'screen',
          }}
        />
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Crystal — one "layer" of the render (cluster + core) that can be stacked
// multiple times with color/offset for chromatic aberration.
// ---------------------------------------------------------------------------

const CrystalLayer: React.FC<{
  revealT: number;
  morphT: number;
  rotZ: number;
  rotX: number;
  scale: number;
  tint?: string;       // e.g. 'rgba(255, 80, 180, 0.9)' — if set, applies as a hue tint
  offsetX?: number;    // horizontal offset in px (for chromatic aberration)
  offsetY?: number;
  intensity: number;
}> = ({ revealT, morphT, rotZ, rotX, scale, tint, offsetX = 0, offsetY = 0, intensity }) => {
  return (
    <AbsoluteFill
      style={{
        perspective: 2400,
        perspectiveOrigin: '50% 50%',
        mixBlendMode: 'screen',
        transform: `translate(${offsetX}px, ${offsetY}px)`,
      }}
    >
      <AbsoluteFill
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            position: 'relative',
            width: 0,
            height: 0,
            transformStyle: 'preserve-3d',
            transform: `scale(${scale}) rotateX(${rotX}deg) rotateZ(${rotZ}deg)`,
          }}
        >
          <ShardCluster revealT={revealT} morphT={morphT} />
          <CoreBurst intensity={intensity} />
        </div>
      </AbsoluteFill>
      {tint ? (
        <AbsoluteFill
          style={{
            background: tint,
            mixBlendMode: 'multiply',
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Bokeh field — a few scattered soft specks with rainbow rims.
// ---------------------------------------------------------------------------

type BokehSpeck = { x: number; y: number; r: number; phase: number; hue: number };

function makeBokeh(): BokehSpeck[] {
  return Array.from({ length: 14 }, (_, i) => ({
    x: rand(i * 9.1) * 3840,
    y: rand(i * 11.3) * 2160,
    r: 14 + rand(i * 3.7) * 32,
    phase: rand(i * 7.9) * Math.PI * 2,
    hue: rand(i * 5.2) * 360,
  }));
}

const BOKEH = makeBokeh();

const BokehField: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const fieldOpacity = interpolate(
    frame,
    [0, 90, durationInFrames - 120, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <>
      {BOKEH.map((b, i) => {
        const drift = Math.sin(frame * 0.005 + b.phase) * 20;
        const twinkle = interpolate(Math.sin(frame * 0.02 + b.phase), [-1, 1], [0.35, 1]);
        const op = twinkle * fieldOpacity * 0.75;
        // Three concentric circles tinted RGB to create a rainbow rim
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: b.x + drift,
              top: b.y - drift * 0.5,
              width: b.r * 2,
              height: b.r * 2,
              marginLeft: -b.r,
              marginTop: -b.r,
              filter: 'blur(2px)',
              mixBlendMode: 'screen',
              opacity: op,
            }}
          >
            {/* Red rim, offset */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                border: `2px solid hsl(${b.hue}, 90%, 60%)`,
                transform: 'translate(-3px, 0) scale(1.0)',
                opacity: 0.7,
              }}
            />
            {/* Cyan rim, opposite offset */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                border: `2px solid hsl(${(b.hue + 180) % 360}, 90%, 65%)`,
                transform: 'translate(3px, 0) scale(1.0)',
                opacity: 0.7,
              }}
            />
            {/* White core */}
            <div
              style={{
                position: 'absolute',
                inset: '30%',
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.85)',
                filter: 'blur(4px)',
              }}
            />
          </div>
        );
      })}
    </>
  );
};

// ---------------------------------------------------------------------------
// Subtle product lockup — bottom of frame, mono stack.
// ---------------------------------------------------------------------------

const ProductLockup: React.FC = () => {
  const frame = useCurrentFrame();

  const lineIn = progress(frame, 900, 1020, easeOut);
  const nameIn = progress(frame, 960, 1140, easeOut);
  const versionIn = progress(frame, 1080, 1260, easeOut);

  const globalOut = 1 - progress(frame, 1400, 1500, easeInOut);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 260,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 22,
        opacity: globalOut,
      }}
    >
      <div
        style={{
          width: 420 * lineIn,
          height: 1,
          background: `linear-gradient(90deg, transparent 0%, ${colors.cyan} 50%, transparent 100%)`,
          opacity: lineIn,
        }}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          fontFamily: fonts.mono,
          fontSize: 30,
          letterSpacing: 14,
          textTransform: 'uppercase',
          color: 'rgba(220, 240, 255, 0.92)',
          opacity: nameIn,
          transform: `translateY(${(1 - nameIn) * 12}px)`,
        }}
      >
        <span>Protocol 01</span>
        <span style={{ color: colors.cyan, opacity: 0.7 }}>·</span>
        <span style={{ fontFamily: fonts.display, fontWeight: 300, fontSize: 42, letterSpacing: 10, color: '#f4faff' }}>
          Frost
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          fontFamily: fonts.mono,
          fontSize: 18,
          color: colors.textMuted,
          letterSpacing: 6,
          textTransform: 'uppercase',
          opacity: versionIn,
          transform: `translateY(${(1 - versionIn) * 8}px)`,
        }}
      >
        <span>v0.9.9</span>
        <span style={{ color: colors.textDim }}>—</span>
        <span>Your own ecosystem</span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Fade bookends
// ---------------------------------------------------------------------------

const FadeIn: React.FC = () => {
  const frame = useCurrentFrame();
  const alpha = 1 - progress(frame, 0, 30, easeOut);
  if (alpha <= 0) return null;
  return <AbsoluteFill style={{ backgroundColor: '#000', opacity: alpha, pointerEvents: 'none' }} />;
};

const FadeOut: React.FC = () => {
  const frame = useCurrentFrame();
  const alpha = progress(frame, 1440, 1500, easeInOut);
  if (alpha <= 0) return null;
  return <AbsoluteFill style={{ backgroundColor: '#000', opacity: alpha, pointerEvents: 'none' }} />;
};

// ---------------------------------------------------------------------------
// Root composition
// ---------------------------------------------------------------------------

export const FrostIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const musicVolume = interpolate(
    frame,
    [0, 90, durationInFrames - 120, durationInFrames],
    [0, 0.55, 0.55, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // --- Story beats ---
  // 0–60   : fade in from black
  // 60–300 : shards burst outward from the core (reveal)
  // 300–720: crystal spins, first big morph
  // 720–1140: second morph — different pose
  // 900–1260: lockup lands
  // 1260–1440: hold
  // 1440–1500: fade to black

  const revealT = progress(frame, 60, 300, easeOut);

  // Morph parameter — oscillates slowly, stronger peaks during the two
  // "morph windows" so the cluster visibly reconfigures twice.
  const morphWave = Math.sin(frame * 0.009);
  const morphWindowA = progress(frame, 360, 600, easeInOut) * (1 - progress(frame, 600, 840, easeInOut));
  const morphWindowB = progress(frame, 840, 1080, easeInOut) * (1 - progress(frame, 1080, 1320, easeInOut));
  const morphT = morphWave * 0.4 + morphWindowA * 0.8 - morphWindowB * 0.8;

  // Camera
  let scale = 0.85 + revealT * 0.15;
  if (frame >= 300) {
    scale = 1 + Math.sin((frame - 300) * 0.003) * 0.04;
  }

  // Slow continuous rotation on Z, subtle X tilt
  const rotZ = (frame - 60) * 0.08;
  const rotX = Math.sin(frame * 0.004) * 4;

  // Core intensity — bright during reveal, brightens through morphs, holds,
  // wanes slightly at the end.
  const coreIntensity = (() => {
    if (frame < 60) return 0;
    if (frame < 240) return progress(frame, 60, 240, easeOut) * 0.9;
    if (frame < 1380) return 0.9 + Math.sin(frame * 0.012) * 0.08;
    return 0.9 - progress(frame, 1380, 1500, easeInOut) * 0.4;
  })();

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Audio src={staticFile('bg-music.wav')} volume={musicVolume} loop />

      <BokehField />

      {/* Chromatic aberration: 3 stacked crystal layers, offset + tinted,
          combined via screen blend so the overlap reads as bright white
          and the mis-registered edges fringe cyan/magenta. */}
      <CrystalLayer
        revealT={revealT}
        morphT={morphT}
        rotZ={rotZ}
        rotX={rotX}
        scale={scale}
        tint="rgba(255, 40, 120, 0.9)"
        offsetX={-4}
        intensity={coreIntensity}
      />
      <CrystalLayer
        revealT={revealT}
        morphT={morphT}
        rotZ={rotZ}
        rotX={rotX}
        scale={scale}
        tint="rgba(40, 200, 255, 0.9)"
        offsetX={4}
        intensity={coreIntensity}
      />
      {/* Main white crystal on top — no tint, no offset */}
      <CrystalLayer
        revealT={revealT}
        morphT={morphT}
        rotZ={rotZ}
        rotX={rotX}
        scale={scale}
        intensity={coreIntensity}
      />

      <ProductLockup />

      <FadeIn />
      <FadeOut />
    </AbsoluteFill>
  );
};
