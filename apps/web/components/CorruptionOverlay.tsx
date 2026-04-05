"use client";

import { useEffect, useState, useRef } from "react";
import { usePathname } from "next/navigation";

// ─── Corruption state lives on window — survives SPA navigation, dies on F5 ─
declare global {
  interface Window {
    __p01_corrupted?: boolean;
    __p01_corruption_level?: number;
  }
}

// ─── Zalgo ──────────────────────────────────────────────────────────────────
const ZA = '\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u030D\u030E\u030F\u0310\u0311\u0312\u0313\u0314\u0315\u031A\u033D\u034A\u034B\u034C';
const ZM = '\u0334\u0335\u0336\u0337\u0338\u0339\u033A\u033B\u033C\u0347\u0348\u0349';
const ZB = '\u0316\u0317\u0318\u0319\u031C\u031D\u031E\u031F\u0320\u0321\u0322\u0323\u0324\u0325\u0326\u0327\u0328\u0329';
const rc = (s: string) => s[Math.floor(Math.random() * s.length)];

const PALETTE = ['#ff6b9d', '#ff2d78', '#e91e84', '#c77dff', '#00f5d4', '#fee440', '#ff0044', '#39ff14'];

const W = (...codes: number[]) => String.fromCharCode(...codes);
const WHY_BASES = [
  W(0x30CA, 0x30BC),                               // ナゼ
  W(0x306A, 0x305C),                               // なぜ
  W(0x6BBA, 0x3059),                               // 殺す
  W(0x6B7B, 0x306B, 0x305F, 0x3044),               // 死にたい
  W(0x6B7B, 0x306D),                               // 死ね
  W(0x81EA, 0x6BBA),                               // 自殺
  W(0x52A9, 0x3051, 0x3066),                       // 助けて
  W(0x75DB, 0x3044),                               // 痛い
  W(0x82E6, 0x3057, 0x3044),                       // 苦しい
  W(0x3084, 0x3081, 0x3066),                       // やめて
  W(0x8AB0, 0x3082, 0x3044, 0x306A, 0x3044),       // 誰もいない
  W(0x6D88, 0x3048, 0x305F, 0x3044),               // 消えたい
  W(0x5B64, 0x72EC),                               // 孤独
  W(0x7D76, 0x671B),                               // 絶望
  W(0x865A, 0x7121),                               // 虚無
  W(0x95C7),                                       // 闇
  W(0x8840),                                       // 血
  W(0x50B7),                                       // 傷
  W(0x5207, 0x308B),                               // 切る
  W(0x7E04),                                       // 縄
  W(0x9996, 0x540A, 0x308A),                       // 首吊り
  W(0x58CA, 0x308C, 0x305F),                       // 壊れた
  W(0x3082, 0x3046, 0x7121, 0x7406),               // もう無理
  W(0x8650, 0x5F85),                               // 虐待
  W(0x6BCD, 0x89AA),                               // 母親
  W(0x8A31, 0x3057, 0x3066),                       // 許して
  W(0x30EA, 0x30B9, 0x30C8, 0x30AB, 0x30C3, 0x30C8), // リストカット
  W(0x9003, 0x3052, 0x3089, 0x308C, 0x306A, 0x3044), // 逃げられない
  W(0x5FD8, 0x308C, 0x3066),                       // 忘れて
  W(0x8981, 0x3089, 0x306A, 0x3044),               // 要らない
  W(0x751F, 0x304D, 0x3066, 0x3044, 0x3066, 0x3054, 0x3081, 0x3093), // 生きていてごめん
  W(0x79C1, 0x306F, 0x3082, 0x3046, 0x3044, 0x306A, 0x3044), // 私はもういない
  W(0x8AB0, 0x3082, 0x52A9, 0x3051, 0x3066, 0x304F, 0x308C, 0x306A, 0x3044), // 誰も助けてくれない
  W(0x8840, 0x304C, 0x6B62, 0x307E, 0x3089, 0x306A, 0x3044), // 血が止まらない
  W(0x611B, 0x3055, 0x308C, 0x305F, 0x304B, 0x3063, 0x305F), // 愛されたかった
];

function corruptText(text: string, intensity: number): string {
  return text.split('').map(c => {
    if (Math.random() > intensity * 0.3) return c;
    let o = c;
    for (let i = 0; i < Math.floor(Math.random() * 2 * intensity); i++) o += rc(ZA);
    for (let i = 0; i < Math.floor(Math.random() * intensity); i++) o += rc(ZM);
    if (Math.random() < 0.2 * intensity) o += rc(ZB);
    return o;
  }).join('');
}

export default function CorruptionOverlay() {
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0); // 0→10+, each nav +1
  const [tick, setTick] = useState(0);
  const [shake, setShake] = useState({ x: 0, y: 0 });
  const [bars, setBars] = useState<{ top: number; h: number; color: string; offset: number }[]>([]);
  const [ghosts, setGhosts] = useState<{ text: string; x: number; y: number; size: number; rot: number; color: string; opacity: number }[]>([]);
  const [flashColor, setFlashColor] = useState('');
  const [glitchBlocks, setGlitchBlocks] = useState<{ x: number; y: number; w: number; h: number; color: string }[]>([]);
  const prevPathRef = useRef(pathname);
  const rafRef = useRef<number>(0);

  // ── Detect activation — poll window flag until found ──
  useEffect(() => {
    if (active) return;
    const id = setInterval(() => {
      if (typeof window !== 'undefined' && window.__p01_corrupted) {
        setActive(true);
        setLevel(window.__p01_corruption_level ?? 1);
        clearInterval(id);
      }
    }, 200);
    return () => clearInterval(id);
  }, [active]);

  // ── Escalate on route change ──
  useEffect(() => {
    if (!active) return;

    if (pathname !== prevPathRef.current) {
      prevPathRef.current = pathname;
      if (pathname === '/void') return;
      setLevel(prev => {
        const next = prev + 1;
        window.__p01_corruption_level = next;
        return next;
      });
    }
  }, [pathname, active]);

  // ── Main glitch loop ──
  useEffect(() => {
    if (!active || level === 0) return;

    const c = Math.min(level / 8, 1); // normalize: 0→1 over 8 navigations

    const loop = () => {
      setTick(t => t + 1);

      // Shake — grows with level
      const mag = c * c * 12;
      if (mag > 0.5) {
        setShake({ x: (Math.random() - 0.5) * mag, y: (Math.random() - 0.5) * mag });
      }

      // VHS bars
      if (Math.random() < 0.02 + c * 0.08) {
        setBars(
          Array.from({ length: Math.floor(1 + c * 6) }, () => ({
            top: Math.random() * 100,
            h: 1 + Math.random() * (2 + c * 10),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            offset: (Math.random() - 0.5) * (10 + c * 60),
          }))
        );
      } else if (Math.random() < 0.1) {
        setBars([]);
      }

      // Ghost text — WHY / japanese appearing randomly
      if (Math.random() < 0.01 + c * 0.04) {
        setGhosts(
          Array.from({ length: Math.floor(c * 4) }, () => ({
            text: corruptText(WHY_BASES[Math.floor(Math.random() * WHY_BASES.length)], c * 3),
            x: Math.random() * 90,
            y: Math.random() * 90,
            size: 12 + Math.random() * (c * 60),
            rot: (Math.random() - 0.5) * (30 + c * 90),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            opacity: 0.03 + c * 0.15,
          }))
        );
      } else if (Math.random() < 0.05) {
        setGhosts([]);
      }

      // Color flash
      if (Math.random() < c * 0.015) {
        setFlashColor(PALETTE[Math.floor(Math.random() * PALETTE.length)]);
        setTimeout(() => setFlashColor(''), 50 + Math.random() * 100);
      }

      // Glitch blocks
      if (Math.random() < 0.005 + c * 0.03) {
        setGlitchBlocks(
          Array.from({ length: Math.floor(1 + c * 4) }, () => ({
            x: Math.random() * 100,
            y: Math.random() * 100,
            w: 3 + Math.random() * (c * 25),
            h: 1 + Math.random() * (c * 10),
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
          }))
        );
      } else if (Math.random() < 0.08) {
        setGlitchBlocks([]);
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, level]);

  // ── Corrupt page text at high levels ──
  useEffect(() => {
    if (!active || level < 3) return;

    const c = Math.min(level / 8, 1);
    const interval = setInterval(() => {
      // Find random text nodes and corrupt them
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            // Don't corrupt our own overlay or scripts
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest('[data-corruption-overlay]')) return NodeFilter.FILTER_REJECT;
            if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
            if ((node.textContent?.trim().length ?? 0) < 2) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

      const nodes: Text[] = [];
      let n: Node | null;
      while ((n = walker.nextNode())) nodes.push(n as Text);

      // Corrupt a few random text nodes
      const count = Math.floor(1 + c * 3);
      for (let i = 0; i < count && nodes.length > 0; i++) {
        const idx = Math.floor(Math.random() * nodes.length);
        const node = nodes[idx];
        if (!node.textContent) continue;

        // Light corruption: swap a char, add zalgo to one char
        const text = node.textContent;
        const pos = Math.floor(Math.random() * text.length);
        const chars = text.split('');

        if (Math.random() < 0.4 * c) {
          // Add zalgo to one char
          chars[pos] = chars[pos] + rc(ZA) + (Math.random() < 0.5 ? rc(ZM) : '');
        } else if (Math.random() < 0.3 * c) {
          // Replace with glitch char
          chars[pos] = '!@#$%&?'[Math.floor(Math.random() * 7)];
        } else if (Math.random() < 0.2 * c) {
          // Insert a distress fragment
          const fragment = WHY_BASES[Math.floor(Math.random() * WHY_BASES.length)];
          chars.splice(pos, 0, ` ${fragment} `);
        }

        node.textContent = chars.join('');
        nodes.splice(idx, 1);
      }
    }, Math.max(800, 4000 - level * 400));

    return () => clearInterval(interval);
  }, [active, level, pathname]); // re-run on navigation (new DOM)

  // ── Title corruption ──
  useEffect(() => {
    if (!active || level < 2) return;

    const c = Math.min(level / 8, 1);
    const interval = setInterval(() => {
      const original = document.title;
      document.title = corruptText(original, c * 2);
    }, Math.max(500, 3000 - level * 300));

    return () => clearInterval(interval);
  }, [active, level, pathname]);

  if (!active || level === 0) return null;

  const c = Math.min(level / 8, 1);

  return (
    <div data-corruption-overlay className="fixed inset-0 z-[9998] pointer-events-none" style={{
      mixBlendMode: 'screen',
    }}>
      {/* ── Scanlines — subtle at first ── */}
      <div className="absolute inset-0" style={{
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.2) 2px, rgba(0,0,0,0.2) 4px)',
        opacity: 0.05 + c * 0.2,
      }} />

      {/* ── Page shake via CSS transform on body ── */}
      {(shake.x !== 0 || shake.y !== 0) && (
        <style>{`
          body > div:first-child {
            transform: translate(${shake.x}px, ${shake.y}px) !important;
          }
        `}</style>
      )}

      {/* ── CSS filter corruption on entire page ── */}
      <style>{`
        body > div:first-child {
          filter:
            saturate(${1 + c * 0.8})
            contrast(${1 + c * 0.15})
            hue-rotate(${Math.random() < c * 0.1 ? Math.random() * 30 : 0}deg)
            ${c > 0.5 && Math.random() < c * 0.05 ? `invert(1)` : ''}
          ;
        }
      `}</style>

      {/* ── VHS horizontal bars ── */}
      {bars.map((bar, i) => (
        <div key={`cb${i}`} className="absolute left-0 right-0" style={{
          top: `${bar.top}%`,
          height: `${bar.h}px`,
          backgroundColor: bar.color,
          opacity: 0.05 + c * 0.15,
          transform: `translateX(${bar.offset}px)`,
          mixBlendMode: 'screen',
        }} />
      ))}

      {/* ── Ghost text ── */}
      {ghosts.map((g, i) => (
        <div key={`cg${i}`} className="absolute" style={{
          left: `${g.x}%`,
          top: `${g.y}%`,
          fontSize: `${g.size}px`,
          fontFamily: "'Noto Sans JP', monospace",
          fontWeight: 900,
          color: g.color,
          opacity: g.opacity,
          transform: `rotate(${g.rot}deg)`,
          mixBlendMode: 'screen',
          whiteSpace: 'nowrap',
          lineHeight: 1,
        }}>
          <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@900&display=swap" rel="stylesheet" />
          {g.text}
        </div>
      ))}

      {/* ── Glitch blocks ── */}
      {glitchBlocks.map((b, i) => (
        <div key={`cbl${i}`} className="absolute" style={{
          left: `${b.x}%`,
          top: `${b.y}%`,
          width: `${b.w}%`,
          height: `${b.h}%`,
          backgroundColor: b.color,
          opacity: 0.04 + c * 0.12,
          mixBlendMode: ['screen', 'difference', 'exclusion'][i % 3] as any,
        }} />
      ))}

      {/* ── Color flash ── */}
      {flashColor && (
        <div className="absolute inset-0" style={{
          backgroundColor: flashColor,
          opacity: 0.08 + c * 0.15,
          mixBlendMode: 'overlay',
        }} />
      )}

      {/* ── Chromatic aberration on whole page (at high levels) ── */}
      {level >= 4 && (
        <style>{`
          body > div:first-child > * {
            text-shadow:
              ${c * 2}px 0 rgba(255,45,120,${c * 0.15}),
              ${-c * 2}px 0 rgba(0,245,212,${c * 0.15}) !important;
          }
        `}</style>
      )}

      {/* ── Vignette burn ── */}
      {level >= 2 && (
        <div className="absolute inset-0" style={{
          boxShadow: `inset 0 0 ${50 + c * 150}px rgba(255,0,68,${0.02 + c * 0.08})`,
        }} />
      )}

      {/* ── Random cursor glitch at high levels ── */}
      {level >= 5 && (
        <style>{`
          * { cursor: ${Math.random() < 0.3 ? 'none' : Math.random() < 0.5 ? 'crosshair' : 'wait'} !important; }
        `}</style>
      )}

      {/* ── Static noise at high levels ── */}
      {level >= 3 && (
        <div className="absolute inset-0" style={{
          opacity: c * 0.06,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' seed='${tick % 50}' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          mixBlendMode: 'overlay',
        }} />
      )}
    </div>
  );
}
