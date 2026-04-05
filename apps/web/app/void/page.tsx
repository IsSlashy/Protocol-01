"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

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
};
const PALETTE = [K.pink, K.hotPink, K.magenta, K.purple, K.cyan, K.yellow, K.white, K.red];

// ─── Zalgo ──────────────────────────────────────────────────────────────────
const ZA = '\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u030D\u030E\u030F\u0310\u0311\u0312\u0313\u0314\u0315\u031A\u033D\u034A\u034B\u034C\u0350\u0351\u0352\u0357\u035B';
const ZM = '\u0334\u0335\u0336\u0337\u0338\u0339\u033A\u033B\u033C\u0347\u0348\u0349';
const ZB = '\u0316\u0317\u0318\u0319\u031C\u031D\u031E\u031F\u0320\u0321\u0322\u0323\u0324\u0325\u0326\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F';
const rc = (s: string) => s[Math.floor(Math.random() * s.length)];

// ナゼ (naze - WHY in katakana) with random kanji corruption
const WHY_BASES = ['\u30CA\u30BC', '\u306A\u305C', '\u4F55\u6545', 'WHY', '\uFF1F\uFF1F'];
//                  ナゼ            なぜ            何故           WHY    ？？

function corruptWhy(intensity: number): string {
  const base = WHY_BASES[Math.floor(Math.random() * (intensity > 2 ? WHY_BASES.length : 2))];
  return base.split('').map(c => {
    if (Math.random() < 0.1 * intensity) c = '!@#$%&?'[Math.floor(Math.random() * 7)];
    let o = c;
    for (let i = 0; i < Math.floor(1 + Math.random() * 3 * intensity); i++) o += rc(ZA);
    for (let i = 0; i < Math.floor(Math.random() * 2 * intensity); i++) o += rc(ZM);
    for (let i = 0; i < Math.floor(Math.random() * 2 * intensity); i++) o += rc(ZB);
    return o;
  }).join('');
}

export default function VoidPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const router = useRouter();

  const [phase, setPhase] = useState<'video' | 'why'>('video');
  const [whyText, setWhyText] = useState('WHY');
  const [tick, setTick] = useState(0);        // global frame counter
  const [shake, setShake] = useState({ x: 0, y: 0 });
  const [corruption, setCorruption] = useState(0); // 0→1 over time, increases forever
  const [colorIdx, setColorIdx] = useState(0);
  const [glitchBars, setGlitchBars] = useState<{ top: number; h: number; color: string; offset: number }[]>([]);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [inverted, setInverted] = useState(false);
  const [splitOffset, setSplitOffset] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [scaleX, setScaleX] = useState(1);

  // ── Init ────────────────────────────────────────────────────────────
  useEffect(() => {
    window.history.replaceState(null, '', '/\uFF1F\uFF1F\uFF1F\uFF1F');
    document.title = '\uFF1F\uFF1F\uFF1F\uFF1F';
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

  // ── Video end → WHY phase ──────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnd = () => setPhase('why');
    v.addEventListener('ended', onEnd);
    return () => v.removeEventListener('ended', onEnd);
  }, []);

  // ── WHY master loop — everything driven from one RAF ────────────────
  useEffect(() => {
    if (phase !== 'why') return;

    let frame = 0;
    let startTime = Date.now();
    let rafId: number;

    const loop = () => {
      frame++;
      const elapsed = (Date.now() - startTime) / 1000;
      const c = Math.min(elapsed / 10, 1); // corruption: 0→1 over 10 SECONDS (violent)
      setCorruption(c);
      setTick(frame);

      // ── Text glitch: faster and more corrupt over time ──
      if (frame % Math.max(1, Math.floor(4 - c * 3)) === 0) {
        setWhyText(corruptWhy(1 + c * 3));
      }

      // ── Shake: starts mild, becomes seizure ──
      const mag = 5 + c * 40;
      setShake({
        x: (Math.random() - 0.5) * mag,
        y: (Math.random() - 0.5) * mag,
      });

      // ── Color cycling: faster as corruption grows ──
      if (frame % Math.max(2, Math.floor(8 - c * 6)) === 0) {
        setColorIdx(i => (i + 1) % PALETTE.length);
      }

      // ── VHS glitch bars: more frequent and taller ──
      if (frame % Math.max(3, Math.floor(12 - c * 10)) === 0) {
        const count = 2 + Math.floor(c * 8);
        setGlitchBars(
          Array.from({ length: count }, () => ({
            top: Math.random() * 100,
            h: 1 + Math.random() * (3 + c * 15),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            offset: (Math.random() - 0.5) * (10 + c * 60),
          }))
        );
      }

      // ── Music slowdown: VIOLENT — 1.0 → 0.1 in 10s with stutters ──
      const baseRate = Math.max(0.08, 1 - c * 0.92);
      // Frequent brutal stutters: sudden freeze then resume
      const isStutter = Math.random() < 0.08 + c * 0.25;
      const isSpeedup = Math.random() < c * 0.05; // rare sudden 2x burst
      const glitchRate = isStutter
        ? 0.05 + Math.random() * 0.1  // near-freeze
        : isSpeedup
          ? Math.min(2, baseRate * (2 + Math.random() * 3)) // violent speedup
          : baseRate;
      setPlaybackRate(glitchRate);

      // ── Random inversion (negative flash) ──
      setInverted(Math.random() < 0.02 + c * 0.06);

      // ── Chromatic split: gets worse ──
      setSplitOffset(Math.random() < 0.15 + c * 0.3
        ? (Math.random() - 0.5) * (5 + c * 30)
        : 0
      );

      // ── Text rotation: starts tilting, eventually flips ──
      const baseRot = (Math.random() - 0.5) * (2 + c * 25);
      // Occasional full inversion
      const flip = Math.random() < c * 0.04 ? 180 : 0;
      setRotation(baseRot + flip);

      // ── Scale X: mirror/stretch glitch ──
      setScaleX(Math.random() < 0.04 + c * 0.06
        ? (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 0.5)
        : 1
      );

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [phase]);

  // ── Audio playback rate sync ───────────────────────────────────────
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    try { a.playbackRate = playbackRate; } catch { /* browser limit */ }
  }, [playbackRate]);

  const handleClick = useCallback(() => {
    if (phase === 'video') return;
    window.history.replaceState(null, '', '/');
    router.push('/');
  }, [phase, router]);

  const col = PALETTE[colorIdx];
  const col2 = PALETTE[(colorIdx + 3) % PALETTE.length];

  return (
    <div
      className="fixed inset-0 bg-black z-[9999] overflow-hidden"
      onClick={handleClick}
      style={{
        filter: inverted
          ? `invert(1) hue-rotate(${Math.random() * 360}deg)`
          : `saturate(${1 + corruption * 2}) contrast(${1 + corruption * 0.5}) brightness(${1 - corruption * 0.15})`,
        transition: inverted ? 'none' : 'filter 0.3s',
      }}
    >
      {/* CRT scanlines — always */}
      <div className="absolute inset-0 z-30 pointer-events-none" style={{
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0.35) 4px)',
        opacity: 0.2 + corruption * 0.3,
      }} />

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
      ) : (
        <>
          {/* ── Music: real <audio> element for playbackRate control ── */}
          <audio
            ref={audioRef}
            src="https://www.youtube.com/embed/Ub5Wy8IFRWM"
            crossOrigin="anonymous"
            style={{ display: 'none' }}
          />
          {/* Fallback: YouTube iframe for actual playback */}
          <iframe
            src="https://www.youtube.com/embed/Ub5Wy8IFRWM?autoplay=1&loop=1&playlist=Ub5Wy8IFRWM&controls=0&showinfo=0&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&start=0"
            allow="autoplay; encrypted-media"
            className="absolute opacity-0 pointer-events-none"
            style={{ width: 1, height: 1 }}
            tabIndex={-1}
          />

          {/* ── Radial background pulse ── */}
          <div className="absolute inset-0 z-0" style={{
            background: `radial-gradient(ellipse at ${50 + (Math.random()-0.5)*20}% ${50 + (Math.random()-0.5)*20}%, ${col}${Math.floor(15 + corruption * 25).toString(16).padStart(2,'0')} 0%, transparent 60%)`,
          }} />

          {/* ── VHS horizontal glitch bars ── */}
          {glitchBars.map((bar, i) => (
            <div key={i} className="absolute left-0 right-0 z-20 pointer-events-none" style={{
              top: `${bar.top}%`,
              height: `${bar.h}px`,
              backgroundColor: bar.color,
              opacity: 0.1 + corruption * 0.25,
              transform: `translateX(${bar.offset}px)`,
              mixBlendMode: 'screen',
            }} />
          ))}

          {/* ── Vertical tear (VHS tracking error) ── */}
          {corruption > 0.3 && Math.random() < corruption * 0.4 && (
            <div className="absolute z-20 pointer-events-none" style={{
              top: 0,
              bottom: 0,
              left: `${30 + Math.random() * 40}%`,
              width: `${2 + Math.random() * (corruption * 30)}px`,
              background: `linear-gradient(to bottom, transparent, ${col}40, transparent)`,
              transform: `translateX(${(Math.random()-0.5) * 50}px)`,
            }} />
          )}

          {/* ── THE WHY — chromatic split layers ── */}
          <div className="absolute inset-0 z-10 flex items-center justify-center" style={{
            transform: `translate(${shake.x}px, ${shake.y}px)`,
          }}>
            {/* Red/cyan chromatic ghost layers */}
            {splitOffset !== 0 && (
              <>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{
                  transform: `translateX(${splitOffset}px)`,
                  opacity: 0.5 + corruption * 0.3,
                  mixBlendMode: 'screen',
                }}>
                  <span style={{
                    fontSize: 'clamp(80px, 22vw, 350px)',
                    fontFamily: 'monospace',
                    fontWeight: 900,
                    color: K.cyan,
                    lineHeight: 1,
                    transform: `rotate(${rotation}deg) scaleX(${scaleX})`,
                  }}>{whyText}</span>
                </div>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{
                  transform: `translateX(${-splitOffset}px)`,
                  opacity: 0.5 + corruption * 0.3,
                  mixBlendMode: 'screen',
                }}>
                  <span style={{
                    fontSize: 'clamp(80px, 22vw, 350px)',
                    fontFamily: 'monospace',
                    fontWeight: 900,
                    color: K.hotPink,
                    lineHeight: 1,
                    transform: `rotate(${rotation}deg) scaleX(${scaleX})`,
                  }}>{whyText}</span>
                </div>
              </>
            )}

            {/* Main text */}
            <div className="select-none" style={{
              fontSize: 'clamp(80px, 22vw, 350px)',
              fontFamily: 'monospace',
              fontWeight: 900,
              color: col,
              textShadow: `
                ${-3 - corruption * 8}px 0 ${K.cyan}${Math.floor(180 + corruption * 75).toString(16)},
                ${3 + corruption * 8}px 0 ${K.hotPink}${Math.floor(180 + corruption * 75).toString(16)},
                0 ${-2 - corruption * 4}px ${K.purple}60,
                0 0 ${20 + corruption * 80}px ${col}60,
                0 0 ${40 + corruption * 160}px ${col2}30
              `,
              lineHeight: 1,
              transform: `rotate(${rotation}deg) scaleX(${scaleX})`,
              transition: 'color 0.05s',
            }}>
              {whyText}
            </div>
          </div>

          {/* ── Screen burn / vignette — intensifies ── */}
          <div className="absolute inset-0 z-25 pointer-events-none" style={{
            boxShadow: `
              inset 0 0 ${100 + corruption * 200}px ${K.hotPink}${Math.floor(20 + corruption * 40).toString(16).padStart(2,'0')},
              inset 0 0 ${200 + corruption * 400}px rgba(0,0,0,${0.4 + corruption * 0.3})
            `,
          }} />

          {/* ── Static noise overlay — grows with corruption ── */}
          {corruption > 0.2 && (
            <div className="absolute inset-0 z-25 pointer-events-none" style={{
              opacity: corruption * 0.12,
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' seed='${tick % 100}' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
              mixBlendMode: 'overlay',
            }} />
          )}

          {/* ── Full white/color flash at high corruption ── */}
          {corruption > 0.5 && Math.random() < corruption * 0.03 && (
            <div className="absolute inset-0 z-40 pointer-events-none" style={{
              backgroundColor: PALETTE[Math.floor(Math.random() * PALETTE.length)],
              opacity: 0.15 + Math.random() * 0.2,
            }} />
          )}
        </>
      )}
    </div>
  );
}
