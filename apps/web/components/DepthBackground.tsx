"use client";

import { memo } from "react";

/**
 * DepthBackground - Optimized version
 *
 * Changes from original:
 * - Removed 65+ framer-motion infinite animations
 * - Using pure CSS animations (GPU-accelerated)
 * - Reduced particle count from 33 to 8
 * - Removed SVG mesh animations (static only)
 * - Added prefers-reduced-motion support
 * - Memoized component to prevent re-renders
 */

// Static particles - no state needed
const particles = [
  { id: 1, symbol: "+", x: "15%", y: "20%", size: 10, color: "#39c5bb", delay: "0s" },
  { id: 2, symbol: "◇", x: "75%", y: "15%", size: 12, color: "#ff77a8", delay: "1s" },
  { id: 3, symbol: "○", x: "85%", y: "45%", size: 8, color: "#39c5bb", delay: "2s" },
  { id: 4, symbol: "×", x: "25%", y: "70%", size: 14, color: "#ff77a8", delay: "3s" },
  { id: 5, symbol: "△", x: "60%", y: "80%", size: 10, color: "#39c5bb", delay: "4s" },
  { id: 6, symbol: "+", x: "45%", y: "35%", size: 16, color: "#ff77a8", delay: "5s" },
  { id: 7, symbol: "◇", x: "10%", y: "55%", size: 9, color: "#39c5bb", delay: "6s" },
  { id: 8, symbol: "○", x: "90%", y: "75%", size: 11, color: "#ff77a8", delay: "7s" },
];

// Static mesh points for SVG
const meshPoints = [
  { x: "12%", y: "18%", size: 2 },
  { x: "35%", y: "8%", size: 1.5 },
  { x: "58%", y: "22%", size: 2.5 },
  { x: "82%", y: "12%", size: 2 },
  { x: "88%", y: "45%", size: 3 },
  { x: "72%", y: "68%", size: 1.5 },
  { x: "45%", y: "78%", size: 2 },
  { x: "18%", y: "62%", size: 2 },
  { x: "50%", y: "45%", size: 3 },
];

// Mesh connections
const meshLines = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0],
  [0, 8], [2, 8], [5, 8], [7, 8],
];

function DepthBackground() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
      {/* CSS for animations - injected once */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes float-particle {
          0%, 100% { transform: translateY(0) rotate(0deg); opacity: 0.15; }
          50% { transform: translateY(-20px) rotate(5deg); opacity: 0.3; }
        }

        @keyframes scanline-move {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }

        @keyframes shimmer {
          0% { background-position: -200% -200%; }
          100% { background-position: 200% 200%; }
        }

        @keyframes pulse-point {
          0%, 100% { opacity: 0.1; transform: scale(1); }
          50% { opacity: 0.3; transform: scale(1.2); }
        }

        @media (prefers-reduced-motion: reduce) {
          .animate-float, .animate-scanline, .animate-shimmer, .animate-pulse {
            animation: none !important;
          }
        }
      `}} />

      {/* LAYER 1 - Base gradient (static) */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 25% 0%, rgba(57, 197, 187, 0.06) 0%, transparent 50%),
            radial-gradient(ellipse 60% 40% at 75% 100%, rgba(255, 119, 168, 0.04) 0%, transparent 50%),
            radial-gradient(ellipse 100% 100% at 50% 50%, rgba(57, 197, 187, 0.02) 0%, transparent 70%),
            #0a0a0c
          `,
        }}
      />

      {/* LAYER 2 - Perspective grid (static, no animation) */}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute w-[300%] h-[150%] left-[-100%] top-[35%]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(57, 197, 187, 0.05) 1px, transparent 1px),
              linear-gradient(90deg, rgba(57, 197, 187, 0.03) 1px, transparent 1px)
            `,
            backgroundSize: "100px 100px",
            transform: "perspective(500px) rotateX(70deg)",
            transformOrigin: "center top",
            maskImage: "linear-gradient(to bottom, transparent 0%, black 15%, black 60%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 15%, black 60%, transparent 100%)",
          }}
        />
      </div>

      {/* LAYER 3 - Static mesh network SVG with CSS pulse */}
      <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="mesh-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#39c5bb" />
            <stop offset="100%" stopColor="#ff77a8" />
          </linearGradient>
        </defs>

        {/* Static lines */}
        {meshLines.map(([from, to], i) => (
          <line
            key={i}
            x1={meshPoints[from].x}
            y1={meshPoints[from].y}
            x2={meshPoints[to].x}
            y2={meshPoints[to].y}
            stroke="url(#mesh-grad)"
            strokeWidth="1"
            opacity="0.04"
          />
        ))}

        {/* Points with CSS animation */}
        {meshPoints.map((point, i) => (
          <circle
            key={i}
            cx={point.x}
            cy={point.y}
            r={point.size}
            fill={i % 2 === 0 ? "#39c5bb" : "#ff77a8"}
            className="animate-pulse"
            style={{
              animation: `pulse-point ${3 + (i % 2)}s ease-in-out infinite`,
              animationDelay: `${i * 0.3}s`,
            }}
          />
        ))}
      </svg>

      {/* LAYER 4 - Floating particles (CSS animation, only 8) */}
      {particles.map((p) => (
        <span
          key={p.id}
          className="absolute font-light select-none pointer-events-none"
          style={{
            left: p.x,
            top: p.y,
            fontSize: p.size,
            color: p.color,
            opacity: 0.15,
            animation: `float-particle 8s ease-in-out infinite`,
            animationDelay: p.delay,
            willChange: "transform, opacity",
          }}
        >
          {p.symbol}
        </span>
      ))}

      {/* LAYER 5 - Single scanline (CSS animation) */}
      <div
        className="absolute left-0 right-0 h-[2px] pointer-events-none"
        style={{
          background: "linear-gradient(90deg, transparent, rgba(57, 197, 187, 0.1), transparent)",
          animation: "scanline-move 10s linear infinite",
          willChange: "transform",
        }}
      />

      {/* LAYER 6 - Vignette (static) */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 120% 80% at 50% 50%, transparent 30%, rgba(10, 10, 12, 0.4) 70%, rgba(10, 10, 12, 0.7) 100%)`,
        }}
      />

      {/* LAYER 7 - Shimmer effect (single CSS animation) */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `linear-gradient(
            135deg,
            transparent 40%,
            rgba(57, 197, 187, 0.02) 45%,
            rgba(255, 119, 168, 0.02) 50%,
            rgba(57, 197, 187, 0.02) 55%,
            transparent 60%
          )`,
          backgroundSize: "200% 200%",
          animation: "shimmer 20s linear infinite",
          willChange: "background-position",
        }}
      />

      {/* LAYER 8 - Noise texture (static) */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.02] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />
    </div>
  );
}

// Memoize to prevent unnecessary re-renders
export default memo(DepthBackground);
