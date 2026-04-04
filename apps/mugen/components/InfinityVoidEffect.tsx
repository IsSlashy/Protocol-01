'use client';

import { memo } from 'react';

/**
 * InfinityVoidEffect — Gojo's Unlimited Void domain.
 * Multi-layer background: gradient base, perspective grid, floating particles,
 * SVG mesh, scanlines, shimmer. Matches Protocol 01 DepthBackground quality.
 */

const particles = [
  { id: 1, symbol: '∞', x: '15%', y: '20%', size: 12, color: '#3b82f6', delay: '0s' },
  { id: 2, symbol: '◇', x: '78%', y: '12%', size: 10, color: '#8b5cf6', delay: '1.2s' },
  { id: 3, symbol: '○', x: '88%', y: '42%', size: 8, color: '#3b82f6', delay: '2.4s' },
  { id: 4, symbol: '×', x: '22%', y: '72%', size: 14, color: '#8b5cf6', delay: '3.1s' },
  { id: 5, symbol: '△', x: '62%', y: '82%', size: 10, color: '#60a5fa', delay: '4.3s' },
  { id: 6, symbol: '∞', x: '42%', y: '32%', size: 16, color: '#7c3aed', delay: '5.5s' },
  { id: 7, symbol: '◇', x: '8%', y: '58%', size: 9, color: '#3b82f6', delay: '6.2s' },
  { id: 8, symbol: '○', x: '92%', y: '68%', size: 11, color: '#8b5cf6', delay: '7.0s' },
  { id: 9, symbol: '×', x: '55%', y: '15%', size: 8, color: '#60a5fa', delay: '1.8s' },
  { id: 10, symbol: '△', x: '35%', y: '90%', size: 13, color: '#7c3aed', delay: '3.7s' },
];

const meshPoints = [
  { x: '12%', y: '18%', size: 2 },
  { x: '35%', y: '8%', size: 1.5 },
  { x: '58%', y: '22%', size: 2.5 },
  { x: '82%', y: '12%', size: 2 },
  { x: '90%', y: '45%', size: 3 },
  { x: '72%', y: '68%', size: 1.5 },
  { x: '45%', y: '78%', size: 2 },
  { x: '18%', y: '62%', size: 2 },
  { x: '50%', y: '45%', size: 3 },
];

const meshLines = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0],
  [0, 8], [2, 8], [5, 8], [7, 8],
];

function InfinityVoidEffect() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes void-float-particle {
          0%, 100% { transform: translateY(0) rotate(0deg); opacity: 0.12; }
          50% { transform: translateY(-25px) rotate(8deg); opacity: 0.3; }
        }

        @keyframes void-scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }

        @keyframes void-shimmer {
          0% { background-position: -200% -200%; }
          100% { background-position: 200% 200%; }
        }

        @keyframes void-pulse-point {
          0%, 100% { opacity: 0.08; transform: scale(1); }
          50% { opacity: 0.25; transform: scale(1.3); }
        }

        @keyframes void-ring-pulse {
          0% { transform: translate(-50%, -50%) scale(0.8); opacity: 0.08; }
          50% { transform: translate(-50%, -50%) scale(1.1); opacity: 0.15; }
          100% { transform: translate(-50%, -50%) scale(0.8); opacity: 0.08; }
        }

        @keyframes void-ring-rotate {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to { transform: translate(-50%, -50%) rotate(360deg); }
        }

        @keyframes void-noise-flash {
          0%, 70%, 100% { opacity: 0; }
          72% { opacity: 0.12; }
          74% { opacity: 0; }
          85% { opacity: 0.1; }
          87% { opacity: 0; }
        }

        @keyframes void-data-scroll {
          0% { transform: translateY(0); }
          100% { transform: translateY(-50%); }
        }

        @media (prefers-reduced-motion: reduce) {
          .void-animate { animation: none !important; opacity: 0.15 !important; }
        }
      `}} />

      {/* LAYER 1 — Base gradient (Unlimited Void) */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 30% 20%, rgba(59, 130, 246, 0.07) 0%, transparent 50%),
            radial-gradient(ellipse 60% 40% at 70% 80%, rgba(139, 92, 246, 0.05) 0%, transparent 50%),
            radial-gradient(ellipse 100% 100% at 50% 50%, rgba(96, 165, 250, 0.02) 0%, transparent 70%),
            #050510
          `,
        }}
      />

      {/* LAYER 2 — Perspective grid */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute w-[300%] h-[150%] left-[-100%] top-[35%]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(59, 130, 246, 0.04) 1px, transparent 1px),
              linear-gradient(90deg, rgba(139, 92, 246, 0.03) 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px',
            transform: 'perspective(400px) rotateX(65deg)',
            transformOrigin: 'center top',
          }}
        />
      </div>

      {/* LAYER 3 — Concentric infinity rings */}
      {[1, 2, 3, 4, 5].map((ring) => (
        <div
          key={ring}
          className="absolute left-1/2 top-1/2 rounded-full border void-animate"
          style={{
            width: `${ring * 200}px`,
            height: `${ring * 200}px`,
            borderColor: ring % 2 === 0
              ? 'rgba(139, 92, 246, 0.06)'
              : 'rgba(59, 130, 246, 0.05)',
            animation: `void-ring-pulse ${4 + ring}s ease-in-out infinite`,
            animationDelay: `${ring * 0.5}s`,
          }}
        />
      ))}

      {/* LAYER 4 — SVG mesh network */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {meshLines.map(([a, b], i) => (
          <line
            key={i}
            x1={meshPoints[a].x}
            y1={meshPoints[a].y}
            x2={meshPoints[b].x}
            y2={meshPoints[b].y}
            stroke="rgba(59, 130, 246, 0.06)"
            strokeWidth="0.1"
          />
        ))}
        {meshPoints.map((point, i) => (
          <circle
            key={i}
            cx={point.x}
            cy={point.y}
            r={point.size * 0.15}
            fill="rgba(139, 92, 246, 0.15)"
            className="void-animate"
            style={{
              animation: `void-pulse-point ${3 + i * 0.5}s ease-in-out infinite`,
              animationDelay: `${i * 0.4}s`,
            }}
          />
        ))}
      </svg>

      {/* LAYER 5 — Floating particles */}
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute font-mono void-animate"
          style={{
            left: p.x,
            top: p.y,
            fontSize: `${p.size}px`,
            color: p.color,
            animation: `void-float-particle ${5 + p.id * 0.3}s ease-in-out infinite`,
            animationDelay: p.delay,
            willChange: 'transform, opacity',
          }}
        >
          {p.symbol}
        </div>
      ))}

      {/* LAYER 6 — Scanline */}
      <div
        className="absolute inset-0 void-animate"
        style={{
          background: 'linear-gradient(transparent 50%, rgba(59, 130, 246, 0.015) 50%)',
          backgroundSize: '100% 4px',
        }}
      />
      <div
        className="absolute left-0 w-full h-[200px] void-animate"
        style={{
          background: 'linear-gradient(transparent, rgba(59, 130, 246, 0.03), transparent)',
          animation: 'void-scanline 8s linear infinite',
          willChange: 'transform',
        }}
      />

      {/* LAYER 7 — Shimmer overlay */}
      <div
        className="absolute inset-0 void-animate"
        style={{
          background: 'linear-gradient(135deg, transparent 40%, rgba(139, 92, 246, 0.02) 45%, transparent 50%)',
          backgroundSize: '400% 400%',
          animation: 'void-shimmer 12s linear infinite',
        }}
      />

      {/* LAYER 8 — Noise overlay */}
      <div
        className="absolute inset-0 void-animate"
        style={{
          animation: 'void-noise-flash 4s steps(1) infinite',
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          mixBlendMode: 'overlay',
          willChange: 'opacity',
        }}
      />
    </div>
  );
}

export default memo(InfinityVoidEffect);
