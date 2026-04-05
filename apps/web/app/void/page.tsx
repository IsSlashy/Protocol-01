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

// WHY bases — Japanese + English rotation
const WHY_BASES = [
  String.fromCharCode(0x30CA, 0x30BC),           // ナゼ
  String.fromCharCode(0x306A, 0x305C),           // なぜ
  String.fromCharCode(0x4F55, 0x6545),           // 何故
  'WHY',
  String.fromCharCode(0x30CA, 0x30BC, 0xFF1F),   // ナゼ？
];

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
  const [whiteOverlay, setWhiteOverlay] = useState(0); // 0→1 for fadeout
  const [musicVolume, setMusicVolume] = useState(0);   // 0→1 fade in during video
  const [playCrash, setPlayCrash] = useState(false);   // triggers crash sound

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

  // ── Video: start music fade-in before end, then switch to WHY ──────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onEnd = () => setPhase('why');
    v.addEventListener('ended', onEnd);

    // Fade music in during last 5s of video + lower video volume
    const checkTime = () => {
      if (!v.duration || v.duration === Infinity) return;
      const remaining = v.duration - v.currentTime;
      if (remaining <= 5) {
        const t = Math.min(1, (5 - remaining) / 5); // 0→1
        setMusicVolume(t);
        // Cross-fade: video audio goes down as music comes up
        try { v.volume = Math.max(0, 1 - t * 0.8); } catch { /* */ }
      }
    };
    v.addEventListener('timeupdate', checkTime);

    return () => {
      v.removeEventListener('ended', onEnd);
      v.removeEventListener('timeupdate', checkTime);
    };
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
      const c = Math.min(elapsed / 10, 1); // corruption: 0→1 over 10s
      setCorruption(c);
      setTick(frame);

      // ── At max corruption → trigger fadeout ──
      if (elapsed >= 12) {
        setPhase('fadeout');
        return;
      }

      // ── Text glitch ──
      if (frame % Math.max(1, Math.floor(4 - c * 3)) === 0) {
        setWhyText(corruptWhy(1 + c * 3));
      }

      // ── Shake ──
      const mag = 5 + c * 40;
      setShake({ x: (Math.random() - 0.5) * mag, y: (Math.random() - 0.5) * mag });

      // ── Colors ──
      if (frame % Math.max(2, Math.floor(8 - c * 6)) === 0) {
        setColorIdx(i => (i + 1) % PALETTE.length);
      }

      // ── VHS bars ──
      if (frame % Math.max(3, Math.floor(12 - c * 10)) === 0) {
        setGlitchBars(
          Array.from({ length: 2 + Math.floor(c * 8) }, () => ({
            top: Math.random() * 100,
            h: 1 + Math.random() * (3 + c * 15),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            offset: (Math.random() - 0.5) * (10 + c * 60),
          }))
        );
      }

      // ── Music slowdown ──
      const baseRate = Math.max(0.08, 1 - c * 0.92);
      const isStutter = Math.random() < 0.08 + c * 0.25;
      const isSpeedup = Math.random() < c * 0.05;
      setPlaybackRate(
        isStutter ? 0.05 + Math.random() * 0.1
        : isSpeedup ? Math.min(2, baseRate * (2 + Math.random() * 3))
        : baseRate
      );

      // ── Inversion ──
      setInverted(Math.random() < 0.02 + c * 0.06);

      // ── Chromatic split ──
      setSplitOffset(Math.random() < 0.15 + c * 0.3 ? (Math.random() - 0.5) * (5 + c * 30) : 0);

      // ── Rotation ──
      const flip = Math.random() < c * 0.04 ? 180 : 0;
      setRotation((Math.random() - 0.5) * (2 + c * 25) + flip);

      // ── Scale ──
      setScaleX(Math.random() < 0.04 + c * 0.06
        ? (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 0.5)
        : 1
      );

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [phase]);

  // ── FADEOUT PHASE: everything stops, white takes over, tab closes ──
  useEffect(() => {
    if (phase !== 'fadeout') return;

    // Don't kill glitch — let it keep running under the white
    // The WHY phase RAF already stopped (elapsed >= 12 exits loop)
    // But we keep the last corrupted state frozen as the white rises

    // White overlay fades in over 4 seconds
    let start = Date.now();
    let rafId: number;
    const fade = () => {
      const t = Math.min((Date.now() - start) / 4000, 1); // 0→1 over 4s
      setWhiteOverlay(t);

      // Music volume implied by overlay (iframe can't control volume, but rate → 0)
      setPlaybackRate(Math.max(0.01, 0.05 * (1 - t)));

      if (t < 1) {
        rafId = requestAnimationFrame(fade);
      } else {
        // Fully white — crash sound + kill the page
        setPlayCrash(true);
        setTimeout(() => {
          // Nuke the entire page — replace DOM with white void
          document.title = '';
          document.body.innerHTML = '';
          document.body.style.background = '#fff';
          document.documentElement.style.background = '#fff';
          // Try to close (works if opened by JS)
          try { window.close(); } catch { /* blocked by browser */ }
          // Page is now a blank white tab — user must close manually
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

      {/* ── Music iframe — loads early, fades in during last 5s of video ── */}
      {musicVolume > 0 && (
        <iframe
          src="https://www.youtube.com/embed/Ub5Wy8IFRWM?autoplay=1&loop=1&playlist=Ub5Wy8IFRWM&controls=0&showinfo=0&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&start=0"
          allow="autoplay; encrypted-media"
          className="absolute pointer-events-none"
          style={{ width: 1, height: 1, opacity: 0 }}
          tabIndex={-1}
        />
      )}
      {/* Hidden audio ref for playbackRate control in WHY phase */}
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
            style={{
              filter: 'contrast(1.1) saturate(1.2) brightness(0.95)',
              // Lower video audio as music fades in
              opacity: 1,
            }}
          />
        </>
      ) : (phase === 'why' || phase === 'fadeout') ? (
        <>

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
              {/* Load JP font for kanji/kana rendering */}
              <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@900&display=swap" rel="stylesheet" />
              <span style={{ fontFamily: "'Noto Sans JP', monospace" }}>{whyText}</span>
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
      ) : null}
      {/* ── Crash sound — Windows error, plays at white screen ── */}
      {playCrash && (
        <iframe
          src="https://www.youtube.com/embed/1POE8JVBe0w?autoplay=1&controls=0&showinfo=0&modestbranding=1&start=0&end=2"
          allow="autoplay; encrypted-media"
          className="absolute pointer-events-none"
          style={{ width: 1, height: 1, opacity: 0 }}
          tabIndex={-1}
        />
      )}
      {/* ── White fadeout overlay — above everything ── */}
      {whiteOverlay > 0 && (
        <div
          className="absolute inset-0 z-[100] pointer-events-none"
          style={{
            backgroundColor: `rgba(255, 255, 255, ${whiteOverlay})`,
            transition: 'none',
          }}
        />
      )}
    </div>
  );
}
