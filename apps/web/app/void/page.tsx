"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

declare global {
  interface Window {
    __p01_corrupted?: boolean;
    __p01_corruption_level?: number;
  }
}

// ─── Kangel palette ─────────────────────────────────────────────────────────
const K = {
  pink: '#ff6b9d',
  hotPink: '#ff2d78',
  magenta: '#e91e84',
  purple: '#c77dff',
  cyan: '#00f5d4',
  yellow: '#fee440',
  red: '#ff0044',
  white: '#ffffff',
  blood: '#8b0000',
  glitchGreen: '#39ff14',
};
const PALETTE = [K.pink, K.hotPink, K.magenta, K.purple, K.cyan, K.yellow, K.white, K.red, K.glitchGreen];

// ─── Zalgo — extended combining set ────────────────────────────────────────
const ZA = '\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u030D\u030E\u030F\u0310\u0311\u0312\u0313\u0314\u0315\u031A\u033D\u034A\u034B\u034C\u0350\u0351\u0352\u0357\u035B\u0360\u0361\u0362';
const ZM = '\u0334\u0335\u0336\u0337\u0338\u0339\u033A\u033B\u033C\u0347\u0348\u0349\u034D\u034E';
const ZB = '\u0316\u0317\u0318\u0319\u031C\u031D\u031E\u031F\u0320\u0321\u0322\u0323\u0324\u0325\u0326\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F\u0330\u0331\u0332\u0333';
const rc = (s: string) => s[Math.floor(Math.random() * s.length)];
const SWAP = '!@#$%^&*?/|~<>_=+{}[]();:"\u2588\u2591\u2592\u2593\u2580\u2584\u258C\u2590';

// ─── Distress lexicon — JP only ─────────────────────────────────────────────
const W = (...codes: number[]) => String.fromCharCode(...codes);
const WHY_BASES = [
  // ── Why / Questions ──
  W(0x30CA, 0x30BC),                               // ナゼ
  W(0x306A, 0x305C),                               // なぜ
  W(0x4F55, 0x6545),                               // 何故
  W(0x30CA, 0x30BC, 0xFF1F),                       // ナゼ？
  W(0x3069, 0x3046, 0x3057, 0x3066),               // どうして
  // ── Death / Kill ──
  W(0x6BBA, 0x3059),                               // 殺す
  W(0x6B7B, 0x306C),                               // 死ぬ
  W(0x6B7B, 0x306D),                               // 死ね
  W(0x6B7B, 0x3093, 0x3067),                       // 死んで
  W(0x6B7B, 0x306B, 0x305F, 0x3044),               // 死にたい
  W(0x81EA, 0x6BBA),                               // 自殺
  W(0x7D5E, 0x9996),                               // 絞首 (strangulation)
  // ── Pain / Suffering ──
  W(0x75DB, 0x3044),                               // 痛い
  W(0x82E6, 0x3057, 0x3044),                       // 苦しい
  W(0x8F9B, 0x3044),                               // 辛い
  W(0x60B2, 0x9E23),                               // 悲鳴 (scream)
  W(0x53EB, 0x3073),                               // 叫び (cry out)
  W(0x6D99),                                       // 涙 (tears)
  W(0x6CE3, 0x304F),                               // 泣く (to cry)
  W(0x58F0, 0x304C, 0x51FA, 0x306A, 0x3044),       // 声が出ない (can't speak)
  // ── Help / Desperation ──
  W(0x52A9, 0x3051, 0x3066),                       // 助けて (help me)
  W(0x8AB0, 0x304B),                               // 誰か (someone)
  W(0x8AB0, 0x3082, 0x3044, 0x306A, 0x3044),       // 誰もいない (nobody)
  W(0x3084, 0x3081, 0x3066),                       // やめて (stop it)
  W(0x9003, 0x3052, 0x305F, 0x3044),               // 逃げたい (want to escape)
  W(0x9003, 0x3052, 0x3089, 0x308C, 0x306A, 0x3044), // 逃げられない (can't escape)
  W(0x58CA, 0x308C, 0x305F, 0x3044),               // 壊れたい (want to break)
  W(0x6D88, 0x3048, 0x305F, 0x3044),               // 消えたい (want to disappear)
  // ── Abuse / Family ──
  W(0x6BCD, 0x89AA),                               // 母親 (mother)
  W(0x7236, 0x89AA),                               // 父親 (father)
  W(0x8650, 0x5F85),                               // 虐待 (abuse)
  W(0x6B96, 0x3089, 0x306A, 0x3044, 0x3067),       // 殴らないで (don't hit me)
  W(0x8A31, 0x3057, 0x3066),                       // 許して (forgive me)
  W(0x3054, 0x3081, 0x3093, 0x306A, 0x3055, 0x3044), // ごめんなさい (I'm sorry)
  W(0x611B, 0x3055, 0x308C, 0x305F, 0x304B, 0x3063, 0x305F), // 愛されたかった (wanted to be loved)
  // ── Self-harm / Cutting ──
  W(0x5207, 0x308B),                               // 切る (to cut)
  W(0x5207, 0x308A, 0x50B7),                       // 切り傷 (cut wound)
  W(0x50B7),                                       // 傷 (wound/scar)
  W(0x8840),                                       // 血 (blood)
  W(0x8840, 0x304C, 0x6B62, 0x307E, 0x3089, 0x306A, 0x3044), // 血が止まらない (blood won't stop)
  W(0x30EA, 0x30B9, 0x30C8, 0x30AB, 0x30C3, 0x30C8), // リストカット (wrist cut)
  W(0x5257),                                       // 刃 (blade)
  W(0x5200),                                       // 刀 (knife)
  // ── Loneliness / Despair ──
  W(0x5B64, 0x72EC),                               // 孤独 (solitude)
  W(0x7D76, 0x671B),                               // 絶望 (despair)
  W(0x865A, 0x7121),                               // 虚無 (void/emptiness)
  W(0x95C7),                                       // 闇 (darkness)
  W(0x4E00, 0x4EBA, 0x307C, 0x3063, 0x3061),       // 一人ぼっち (all alone)
  W(0x5BC2, 0x3057, 0x3044),                       // 寂しい (lonely)
  W(0x3082, 0x3046, 0x3044, 0x3044),               // もういい (enough already)
  W(0x3082, 0x3046, 0x7121, 0x7406),               // もう無理 (can't anymore)
  W(0x58CA, 0x308C, 0x305F),                       // 壊れた (broken)
  // ── Hanging / Rope ──
  W(0x7E04),                                       // 縄 (rope)
  W(0x9996, 0x540A, 0x308A),                       // 首吊り (hanging)
  W(0x7E1B, 0x308B),                               // 縛る (to bind)
  // ── Erasure / Disappearing ──
  W(0x6D88, 0x3048, 0x308D),                       // 消えろ (disappear)
  W(0x5FD8, 0x308C, 0x3066),                       // 忘れて (forget me)
  W(0x8981, 0x3089, 0x306A, 0x3044),               // 要らない (not needed)
  W(0x5B58, 0x5728, 0x304C, 0x6D88, 0x3048, 0x305F, 0x3044), // 存在が消えたい (want my existence to vanish)
  // ── Sentences ──
  W(0x5F7C, 0x5973, 0x306F, 0x79C1, 0x3092, 0x6905, 0x5B50, 0x306B, 0x7E1B, 0x308A, 0x4ED8, 0x3051, 0x305F), // 彼女は私を椅子に縛り付けた
  W(0x8AB0, 0x3082, 0x52A9, 0x3051, 0x3066, 0x304F, 0x308C, 0x306A, 0x3044), // 誰も助けてくれない (nobody helps me)
  W(0x751F, 0x304D, 0x3066, 0x3044, 0x3066, 0x3054, 0x3081, 0x3093), // 生きていてごめん (sorry for being alive)
  W(0x79C1, 0x306F, 0x3082, 0x3046, 0x3044, 0x306A, 0x3044), // 私はもういない (I'm already gone)
  W(0x604B, 0x3057, 0x304F, 0x3066, 0x6B7B, 0x306B, 0x305F, 0x3044), // 恋しくて死にたい (miss you so much I want to die)
];

function corruptWhy(intensity: number): string {
  const base = WHY_BASES[Math.floor(Math.random() * (intensity > 2 ? WHY_BASES.length : 3))];
  return base.split('').map(c => {
    // More aggressive char swap at high intensity
    if (Math.random() < 0.15 * intensity) c = SWAP[Math.floor(Math.random() * SWAP.length)];
    // Occasionally duplicate char
    let o = Math.random() < 0.05 * intensity ? c + c : c;
    // Heavier zalgo stacking
    for (let i = 0; i < Math.floor(1 + Math.random() * 4 * intensity); i++) o += rc(ZA);
    for (let i = 0; i < Math.floor(Math.random() * 3 * intensity); i++) o += rc(ZM);
    for (let i = 0; i < Math.floor(Math.random() * 3 * intensity); i++) o += rc(ZB);
    return o;
  }).join('');
}

// ─── Ghost echo type ───────────────────────────────────────────────────────
interface GhostEcho {
  text: string;
  x: number;
  y: number;
  size: number;
  rotation: number;
  color: string;
  opacity: number;
  blend: string;
}

// ─── Glitch block type ─────────────────────────────────────────────────────
interface GlitchBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  clipX: number;
  clipY: number;
}

export default function VoidPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const router = useRouter();

  const [phase, setPhase] = useState<'video' | 'why' | 'fadeout'>('video');
  const [whyText, setWhyText] = useState('WHY');
  const [tick, setTick] = useState(0);
  const [shake, setShake] = useState({ x: 0, y: 0 });
  const [corruption, setCorruption] = useState(0);
  const [colorIdx, setColorIdx] = useState(0);
  const [glitchBars, setGlitchBars] = useState<{ top: number; h: number; color: string; offset: number }[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [inverted, setInverted] = useState(false);
  const [splitOffset, setSplitOffset] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [scaleX, setScaleX] = useState(1);
  const [whiteOverlay, setWhiteOverlay] = useState(0);
  const [playCrash, setPlayCrash] = useState(false);
  // New glitch states
  const [ghosts, setGhosts] = useState<GhostEcho[]>([]);
  const [glitchBlocks, setGlitchBlocks] = useState<GlitchBlock[]>([]);
  const [perspective, setPerspective] = useState({ x: 0, y: 0 });
  const [screenTear, setScreenTear] = useState(0);
  const [fontSize, setFontSize] = useState(22);
  const [strobe, setStrobe] = useState(false);
  const [doubleVision, setDoubleVision] = useState({ x: 0, y: 0 });
  const [bloodDrips, setBloodDrips] = useState<{ x: number; h: number; delay: number }[]>([]);
  const [skewY, setSkewY] = useState(0);
  const [pixelate, setPixelate] = useState(0);
  // ── Init ────────────────────────────────────────────────────────────
  useEffect(() => {
    window.history.replaceState(null, '', '/????');
    document.title = '????';
    document.body.style.overflow = 'hidden';
    document.body.style.background = '#000';
    document.body.style.cursor = 'none';
    return () => {
      document.body.style.overflow = '';
      document.body.style.background = '';
      document.body.style.cursor = '';
      document.title = 'Protocol 01';
    };
  }, []);

  // ── Video ended → switch to WHY ──────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnd = () => setPhase('why');
    v.addEventListener('ended', onEnd);
    return () => v.removeEventListener('ended', onEnd);
  }, []);

  // ── 16s after WHY starts (= when music is playing) → crash ──────────
  useEffect(() => {
    if (phase !== 'why') return;
    const id = setTimeout(() => {
      setPhase('fadeout');
    }, 10000);
    return () => clearTimeout(id);
  }, [phase]);

  // ── WHY master loop — everything driven from one RAF ────────────────
  useEffect(() => {
    if (phase !== 'why') return;

    let frame = 0;
    let whyStart = Date.now();
    let rafId: number;

    const loop = () => {
      frame++;
      const whyElapsed = (Date.now() - whyStart) / 1000;
      const c = Math.min(whyElapsed / 14, 1); // corruption: 0→1 over 14s
      setCorruption(c);
      setTick(frame);

      // ── Text glitch — faster at high corruption ──
      if (frame % Math.max(1, Math.floor(3 - c * 2.5)) === 0) {
        setWhyText(corruptWhy(1 + c * 4));
      }

      // ── Shake — exponential at high corruption ──
      const mag = 5 + c * c * 80;
      setShake({ x: (Math.random() - 0.5) * mag, y: (Math.random() - 0.5) * mag });

      // ── Colors — seizure-fast at high ──
      if (frame % Math.max(1, Math.floor(6 - c * 5)) === 0) {
        setColorIdx(Math.floor(Math.random() * PALETTE.length));
      }

      // ── VHS bars — thicker, more frequent ──
      if (frame % Math.max(2, Math.floor(8 - c * 7)) === 0) {
        setGlitchBars(
          Array.from({ length: 3 + Math.floor(c * 15) }, () => ({
            top: Math.random() * 100,
            h: 1 + Math.random() * (5 + c * 25),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            offset: (Math.random() - 0.5) * (20 + c * 120),
          }))
        );
      }

      // ── Ghost echoes — scattered WHY copies ──
      if (frame % Math.max(2, Math.floor(10 - c * 8)) === 0) {
        const count = Math.floor(1 + c * 7);
        setGhosts(
          Array.from({ length: count }, () => ({
            text: corruptWhy(0.5 + c * 2),
            x: (Math.random() - 0.5) * 160,
            y: (Math.random() - 0.5) * 160,
            size: 10 + Math.random() * (c * 50),
            rotation: (Math.random() - 0.5) * (60 + c * 300),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            opacity: 0.05 + Math.random() * (0.1 + c * 0.35),
            blend: ['screen', 'overlay', 'difference', 'exclusion', 'color-dodge'][Math.floor(Math.random() * 5)],
          }))
        );
      }

      // ── Glitch blocks — displaced rectangles ──
      if (c > 0.2 && frame % Math.max(3, Math.floor(15 - c * 12)) === 0) {
        setGlitchBlocks(
          Array.from({ length: Math.floor(c * 6) }, () => ({
            x: Math.random() * 100,
            y: Math.random() * 100,
            w: 5 + Math.random() * (20 + c * 30),
            h: 2 + Math.random() * (10 + c * 20),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            clipX: (Math.random() - 0.5) * 50,
            clipY: (Math.random() - 0.5) * 30,
          }))
        );
      }

      // ── 3D perspective warp ──
      setPerspective({
        x: (Math.random() - 0.5) * c * 25,
        y: (Math.random() - 0.5) * c * 25,
      });

      // ── Screen tear — horizontal slice displacement ──
      setScreenTear(Math.random() < 0.1 + c * 0.3 ? (Math.random() - 0.5) * (30 + c * 100) : 0);

      // ── Font size oscillation ──
      setFontSize(18 + Math.random() * (8 + c * 20) + (Math.random() < c * 0.1 ? 30 : 0));

      // ── Strobe flash ──
      setStrobe(Math.random() < c * 0.08);

      // ── Double vision ──
      if (Math.random() < 0.05 + c * 0.15) {
        setDoubleVision({
          x: (Math.random() - 0.5) * (10 + c * 40),
          y: (Math.random() - 0.5) * (5 + c * 20),
        });
      } else {
        setDoubleVision({ x: 0, y: 0 });
      }

      // ── Blood drips — red streaks from top ──
      if (c > 0.4 && frame % Math.max(5, Math.floor(30 - c * 25)) === 0) {
        setBloodDrips(
          Array.from({ length: Math.floor(c * 5) }, () => ({
            x: Math.random() * 100,
            h: 10 + Math.random() * (30 + c * 60),
            delay: Math.random() * 2,
          }))
        );
      }

      // ── SkewY distortion ──
      setSkewY(Math.random() < 0.08 + c * 0.12 ? (Math.random() - 0.5) * (5 + c * 20) : 0);

      // ── Pixelation bursts ──
      setPixelate(Math.random() < c * 0.06 ? 3 + Math.floor(c * 8) : 0);

      // ── Music slowdown ──
      const baseRate = Math.max(0.08, 1 - c * 0.92);
      const isStutter = Math.random() < 0.08 + c * 0.25;
      const isSpeedup = Math.random() < c * 0.05;
      const isReverse = Math.random() < c * 0.02; // rare reverse stutter feel
      setPlaybackRate(
        isReverse ? 0.01
        : isStutter ? 0.05 + Math.random() * 0.1
        : isSpeedup ? Math.min(3, baseRate * (2 + Math.random() * 4))
        : baseRate
      );

      // ── Inversion — more frequent ──
      setInverted(Math.random() < 0.03 + c * 0.1);

      // ── Chromatic split — wider ──
      setSplitOffset(Math.random() < 0.2 + c * 0.4 ? (Math.random() - 0.5) * (8 + c * 50) : 0);

      // ── Rotation — more violent ──
      const flip = Math.random() < c * 0.06 ? (Math.random() < 0.5 ? 180 : 90) : 0;
      setRotation((Math.random() - 0.5) * (3 + c * 40) + flip);

      // ── Scale — more extreme ──
      setScaleX(Math.random() < 0.05 + c * 0.1
        ? (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 1.5)
        : Math.random() < c * 0.03 ? 0.01 : 1 // occasional near-collapse
      );

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [phase]);

  // ── FADEOUT PHASE: everything stops, white takes over, tab closes ──
  useEffect(() => {
    if (phase !== 'fadeout') return;

    let start = Date.now();
    let rafId: number;
    const fade = () => {
      const t = Math.min((Date.now() - start) / 4000, 1);
      setWhiteOverlay(t);
      setPlaybackRate(Math.max(0.01, 0.05 * (1 - t)));

      // Glitch keeps going under white — last spasms
      if (t < 0.8) {
        setShake({ x: (Math.random() - 0.5) * 30 * (1 - t), y: (Math.random() - 0.5) * 30 * (1 - t) });
        setStrobe(Math.random() < 0.1 * (1 - t));
      }

      if (t < 1) {
        rafId = requestAnimationFrame(fade);
      } else {
        // Crash sound
        setPlayCrash(true);
        // Activate persistent corruption — sessionStorage survives full reloads
        window.__p01_corrupted = true;
        window.__p01_corruption_level = 1;
        sessionStorage.setItem('p01_corrupted', '1');
        sessionStorage.setItem('p01_corruption_level', '1');
        setTimeout(() => {
          // Clear the white overlay BEFORE navigating so it doesn't stay stuck
          setWhiteOverlay(0);
          setPhase('video'); // reset phase to unmount all WHY/fadeout DOM
          // Navigate home — site is now haunted
          router.replace('/');
        }, 2000);
      }
    };
    rafId = requestAnimationFrame(fade);
    return () => cancelAnimationFrame(rafId);
  }, [phase, router]);

  // ── Audio playback rate sync ───────────────────────────────────────
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    try { a.playbackRate = playbackRate; } catch { /* browser limit */ }
  }, [playbackRate]);

  const handleClick = useCallback(() => {
    if (phase === 'video' || phase === 'fadeout') return;
    window.history.replaceState(null, '', '/');
    router.push('/');
  }, [phase, router]);

  const col = PALETTE[colorIdx];
  const col2 = PALETTE[(colorIdx + 3) % PALETTE.length];
  const col3 = PALETTE[(colorIdx + 5) % PALETTE.length];

  return (
    <div
      className="fixed inset-0 bg-black z-[9999] overflow-hidden"
      onClick={handleClick}
      style={{
        filter: [
          inverted ? `invert(1) hue-rotate(${Math.random() * 360}deg)` : '',
          `saturate(${1 + corruption * 3})`,
          `contrast(${1 + corruption * 0.8})`,
          `brightness(${strobe ? 2.5 : 1 - corruption * 0.15})`,
          pixelate > 0 ? `blur(${pixelate}px)` : '',
        ].filter(Boolean).join(' '),
        transition: inverted || strobe ? 'none' : 'filter 0.1s',
      }}
    >
      {/* CRT scanlines — always */}
      <div className="absolute inset-0 z-30 pointer-events-none" style={{
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0.35) 4px)',
        opacity: 0.2 + corruption * 0.4,
      }} />

      {/* ── Music iframe — plays from the start alongside video ── */}
      <iframe
        src="https://www.youtube.com/embed/Ub5Wy8IFRWM?autoplay=1&loop=1&playlist=Ub5Wy8IFRWM&controls=0&showinfo=0&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&start=0"
        allow="autoplay; encrypted-media"
        className="absolute pointer-events-none"
        style={{ width: 1, height: 1, opacity: 0 }}
        tabIndex={-1}
      />
      <audio ref={audioRef} style={{ display: 'none' }} />

      {phase === 'video' ? (
        <>
          <div className="absolute inset-0 z-10 pointer-events-none" style={{
            boxShadow: 'inset 0 0 100px rgba(255,0,50,0.15), inset 0 0 200px rgba(0,0,0,0.5)',
          }} />
          <video
            ref={videoRef}
            src="/void.mp4"
            autoPlay
            playsInline
            muted={false}
            className="w-full h-full object-contain relative z-0"
            style={{ filter: 'contrast(1.1) saturate(1.2) brightness(0.95)' }}
          />
        </>
      ) : (phase === 'why' || phase === 'fadeout') ? (
        <>
          {/* ── Radial background pulse ── */}
          <div className="absolute inset-0 z-0" style={{
            background: `
              radial-gradient(ellipse at ${50 + (Math.random()-0.5)*30}% ${50 + (Math.random()-0.5)*30}%, ${col}${Math.floor(15 + corruption * 35).toString(16).padStart(2,'0')} 0%, transparent 60%),
              radial-gradient(circle at ${Math.random()*100}% ${Math.random()*100}%, ${col2}${Math.floor(corruption * 20).toString(16).padStart(2,'0')} 0%, transparent 40%)
            `,
          }} />

          {/* ── VHS horizontal glitch bars ── */}
          {glitchBars.map((bar, i) => (
            <div key={i} className="absolute left-0 right-0 z-20 pointer-events-none" style={{
              top: `${bar.top}%`,
              height: `${bar.h}px`,
              backgroundColor: bar.color,
              opacity: 0.1 + corruption * 0.35,
              transform: `translateX(${bar.offset}px) skewX(${(Math.random()-0.5) * corruption * 10}deg)`,
              mixBlendMode: 'screen',
            }} />
          ))}

          {/* ── Vertical tears — multiple ── */}
          {corruption > 0.2 && Array.from({ length: Math.floor(corruption * 4) }, (_, i) => (
            Math.random() < corruption * 0.5 && (
              <div key={`vt${i}`} className="absolute z-20 pointer-events-none" style={{
                top: 0,
                bottom: 0,
                left: `${10 + Math.random() * 80}%`,
                width: `${1 + Math.random() * (corruption * 40)}px`,
                background: `linear-gradient(to bottom, transparent, ${PALETTE[Math.floor(Math.random() * PALETTE.length)]}60, transparent)`,
                transform: `translateX(${(Math.random()-0.5) * 80}px)`,
              }} />
            )
          ))}

          {/* ── Screen tear — displaces top/bottom halves ── */}
          {screenTear !== 0 && (
            <div className="absolute inset-0 z-15 pointer-events-none" style={{
              clipPath: 'inset(0 0 50% 0)',
              transform: `translateX(${screenTear}px)`,
            }}>
              <div className="w-full h-full" style={{
                background: `linear-gradient(90deg, transparent 40%, ${col}08 50%, transparent 60%)`,
              }} />
            </div>
          )}

          {/* ── Glitch blocks — displaced color rectangles ── */}
          {glitchBlocks.map((block, i) => (
            <div key={`gb${i}`} className="absolute z-22 pointer-events-none" style={{
              left: `${block.x}%`,
              top: `${block.y}%`,
              width: `${block.w}%`,
              height: `${block.h}%`,
              backgroundColor: block.color,
              opacity: 0.08 + corruption * 0.2,
              transform: `translate(${block.clipX}px, ${block.clipY}px)`,
              mixBlendMode: ['screen', 'multiply', 'difference', 'exclusion'][i % 4] as any,
            }} />
          ))}

          {/* ── Blood drips — dark red streaks ── */}
          {bloodDrips.map((drip, i) => (
            <div key={`bd${i}`} className="absolute z-18 pointer-events-none" style={{
              left: `${drip.x}%`,
              top: 0,
              width: '3px',
              height: `${drip.h}%`,
              background: `linear-gradient(to bottom, ${K.blood}cc, ${K.red}40, transparent)`,
              filter: 'blur(1px)',
              animation: `drip ${1 + drip.delay}s ease-in forwards`,
            }} />
          ))}

          {/* ── Ghost echoes — scattered text copies ── */}
          {ghosts.map((g, i) => (
            <div key={`ghost${i}`} className="absolute inset-0 z-8 pointer-events-none flex items-center justify-center" style={{
              transform: `translate(${g.x}%, ${g.y}%)`,
              mixBlendMode: g.blend as any,
            }}>
              <span style={{
                fontSize: `${g.size}vw`,
                fontFamily: "'Noto Sans JP', monospace",
                fontWeight: 900,
                color: g.color,
                opacity: g.opacity,
                transform: `rotate(${g.rotation}deg)`,
                lineHeight: 1,
                whiteSpace: 'nowrap',
              }}>{g.text}</span>
            </div>
          ))}

          {/* ── Double vision layer ── */}
          {(doubleVision.x !== 0 || doubleVision.y !== 0) && (
            <div className="absolute inset-0 z-9 pointer-events-none flex items-center justify-center" style={{
              transform: `translate(${shake.x + doubleVision.x}px, ${shake.y + doubleVision.y}px)`,
              opacity: 0.3 + corruption * 0.3,
              mixBlendMode: 'screen',
            }}>
              <span style={{
                fontSize: `clamp(80px, ${fontSize}vw, 400px)`,
                fontFamily: "'Noto Sans JP', monospace",
                fontWeight: 900,
                color: col3,
                lineHeight: 1,
                transform: `rotate(${-rotation}deg) scaleX(${-scaleX}) skewY(${skewY}deg)`,
                filter: `blur(${1 + corruption * 3}px)`,
              }}>{whyText}</span>
            </div>
          )}

          {/* ── THE WHY — main text with chromatic split ── */}
          <div className="absolute inset-0 z-10 flex items-center justify-center" style={{
            transform: `translate(${shake.x}px, ${shake.y}px) perspective(800px) rotateX(${perspective.x}deg) rotateY(${perspective.y}deg)`,
          }}>
            {/* Chromatic ghost — cyan */}
            {splitOffset !== 0 && (
              <>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{
                  transform: `translateX(${splitOffset}px) translateY(${splitOffset * 0.3}px)`,
                  opacity: 0.5 + corruption * 0.4,
                  mixBlendMode: 'screen',
                }}>
                  <span style={{
                    fontSize: `clamp(80px, ${fontSize}vw, 400px)`,
                    fontFamily: "'Noto Sans JP', monospace",
                    fontWeight: 900,
                    color: K.cyan,
                    lineHeight: 1,
                    transform: `rotate(${rotation}deg) scaleX(${scaleX}) skewY(${skewY * 0.5}deg)`,
                  }}>{whyText}</span>
                </div>
                {/* Chromatic ghost — hot pink */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{
                  transform: `translateX(${-splitOffset}px) translateY(${-splitOffset * 0.3}px)`,
                  opacity: 0.5 + corruption * 0.4,
                  mixBlendMode: 'screen',
                }}>
                  <span style={{
                    fontSize: `clamp(80px, ${fontSize}vw, 400px)`,
                    fontFamily: "'Noto Sans JP', monospace",
                    fontWeight: 900,
                    color: K.hotPink,
                    lineHeight: 1,
                    transform: `rotate(${rotation}deg) scaleX(${scaleX}) skewY(${-skewY * 0.5}deg)`,
                  }}>{whyText}</span>
                </div>
                {/* Chromatic ghost — green (new third channel) */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{
                  transform: `translateY(${splitOffset * 0.7}px)`,
                  opacity: 0.2 + corruption * 0.2,
                  mixBlendMode: 'screen',
                }}>
                  <span style={{
                    fontSize: `clamp(80px, ${fontSize}vw, 400px)`,
                    fontFamily: "'Noto Sans JP', monospace",
                    fontWeight: 900,
                    color: K.glitchGreen,
                    lineHeight: 1,
                    transform: `rotate(${rotation + 2}deg) scaleX(${scaleX})`,
                  }}>{whyText}</span>
                </div>
              </>
            )}

            {/* Main text */}
            <div className="select-none" style={{
              fontSize: `clamp(80px, ${fontSize}vw, 400px)`,
              fontFamily: "'Noto Sans JP', monospace",
              fontWeight: 900,
              color: col,
              textShadow: `
                ${-3 - corruption * 12}px 0 ${K.cyan}${Math.floor(180 + corruption * 75).toString(16)},
                ${3 + corruption * 12}px 0 ${K.hotPink}${Math.floor(180 + corruption * 75).toString(16)},
                0 ${-2 - corruption * 6}px ${K.purple}80,
                0 ${2 + corruption * 6}px ${K.glitchGreen}40,
                0 0 ${30 + corruption * 120}px ${col}80,
                0 0 ${60 + corruption * 200}px ${col2}50,
                ${(Math.random()-0.5) * corruption * 20}px ${(Math.random()-0.5) * corruption * 20}px ${corruption * 40}px ${col3}30
              `,
              lineHeight: 1,
              transform: `rotate(${rotation}deg) scaleX(${scaleX}) skewY(${skewY}deg)`,
              transition: 'color 0.03s',
            }}>
              <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@900&display=swap" rel="stylesheet" />
              <span>{whyText}</span>
            </div>
          </div>

          {/* ── Fragmented mini-copies at high corruption ── */}
          {corruption > 0.5 && Array.from({ length: Math.floor(corruption * 8) }, (_, i) => (
            <div key={`frag${i}`} className="absolute z-12 pointer-events-none" style={{
              left: `${Math.random() * 90}%`,
              top: `${Math.random() * 90}%`,
              fontSize: `${8 + Math.random() * 20}px`,
              fontFamily: "'Noto Sans JP', monospace",
              fontWeight: 900,
              color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
              opacity: 0.1 + Math.random() * 0.4,
              transform: `rotate(${Math.random() * 360}deg)`,
              mixBlendMode: 'screen',
              whiteSpace: 'nowrap',
            }}>
              {corruptWhy(corruption * 2)}
            </div>
          ))}

          {/* ── Screen burn / vignette ── */}
          <div className="absolute inset-0 z-25 pointer-events-none" style={{
            boxShadow: `
              inset 0 0 ${100 + corruption * 300}px ${K.hotPink}${Math.floor(20 + corruption * 50).toString(16).padStart(2,'0')},
              inset 0 0 ${200 + corruption * 500}px rgba(0,0,0,${0.4 + corruption * 0.35})
            `,
          }} />

          {/* ── Static noise overlay ── */}
          {corruption > 0.15 && (
            <div className="absolute inset-0 z-25 pointer-events-none" style={{
              opacity: corruption * 0.18,
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='${0.6 + corruption * 0.4}' numOctaves='4' seed='${tick % 100}' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
              mixBlendMode: 'overlay',
            }} />
          )}

          {/* ── Full-screen color flash ── */}
          {corruption > 0.3 && Math.random() < corruption * 0.06 && (
            <div className="absolute inset-0 z-40 pointer-events-none" style={{
              backgroundColor: PALETTE[Math.floor(Math.random() * PALETTE.length)],
              opacity: 0.15 + Math.random() * 0.35,
            }} />
          )}

          {/* ── Strobe white flash ── */}
          {strobe && (
            <div className="absolute inset-0 z-45 pointer-events-none" style={{
              backgroundColor: '#fff',
              opacity: 0.6 + Math.random() * 0.4,
              mixBlendMode: 'overlay',
            }} />
          )}

          {/* ── Horizontal interlace jitter ── */}
          {corruption > 0.4 && (
            <div className="absolute inset-0 z-28 pointer-events-none" style={{
              backgroundImage: `repeating-linear-gradient(
                0deg,
                transparent 0px,
                transparent ${3 + Math.floor(Math.random() * 3)}px,
                ${col}${Math.floor(corruption * 15).toString(16).padStart(2,'0')} ${3 + Math.floor(Math.random() * 3)}px,
                ${col}${Math.floor(corruption * 15).toString(16).padStart(2,'0')} ${4 + Math.floor(Math.random() * 3)}px
              )`,
              transform: `translateX(${(Math.random()-0.5) * corruption * 30}px)`,
            }} />
          )}
        </>
      ) : null}

      {/* ── Crash sound ── */}
      {playCrash && (
        <iframe
          src="https://www.youtube.com/embed/1POE8JVBe0w?autoplay=1&controls=0&showinfo=0&modestbranding=1&start=0&end=2"
          allow="autoplay; encrypted-media"
          className="absolute pointer-events-none"
          style={{ width: 1, height: 1, opacity: 0 }}
          tabIndex={-1}
        />
      )}

      {/* ── White fadeout overlay ── */}
      {whiteOverlay > 0 && (
        <div
          className="absolute inset-0 z-[100] pointer-events-none"
          style={{
            backgroundColor: `rgba(255, 255, 255, ${whiteOverlay})`,
            transition: 'none',
          }}
        />
      )}

      {/* ── Drip animation keyframes ── */}
      <style>{`
        @keyframes drip {
          from { transform: translateY(-100%); opacity: 0; }
          10% { opacity: 1; }
          to { transform: translateY(0); opacity: 0.6; }
        }
      `}</style>
    </div>
  );
}
