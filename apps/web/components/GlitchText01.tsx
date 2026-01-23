"use client";

import { memo } from "react";

interface GlitchText01Props {
  className?: string;
}

/**
 * GlitchText01 - Optimized ULTRAKILL style glitch text
 *
 * Changes from original:
 * - Replaced JS setState animations with pure CSS keyframes
 * - GPU-accelerated transforms via will-change
 * - No React re-renders during animation
 * - Maintains chaotic industrial aesthetic
 */
function GlitchText01({ className = "" }: GlitchText01Props) {
  return (
    <div className={`relative ${className}`}>
      {/* CSS Keyframes for chaotic glitch effect */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes text-glitch-cyan {
          0%, 100% { transform: translate(0, 0); }
          8% { transform: translate(-6px, 4px); }
          16% { transform: translate(5px, -3px); }
          24% { transform: translate(-4px, 2px); }
          32% { transform: translate(6px, -4px); }
          40% { transform: translate(-3px, 2px); }
          48% { transform: translate(4px, -2px); }
          56% { transform: translate(-5px, 3px); }
          64% { transform: translate(6px, -4px); }
          72% { transform: translate(-2px, 1px); }
          80% { transform: translate(3px, -2px); }
          88% { transform: translate(-4px, 3px); }
          96% { transform: translate(2px, -1px); }
        }

        @keyframes text-glitch-pink {
          0%, 100% { transform: translate(0, 0); }
          12% { transform: translate(5px, -3px); }
          20% { transform: translate(-4px, 2px); }
          28% { transform: translate(3px, -2px); }
          36% { transform: translate(-5px, 3px); }
          44% { transform: translate(4px, -2px); }
          52% { transform: translate(-3px, 2px); }
          60% { transform: translate(5px, -3px); }
          68% { transform: translate(-4px, 3px); }
          76% { transform: translate(2px, -1px); }
          84% { transform: translate(-3px, 2px); }
          92% { transform: translate(4px, -2px); }
        }

        @keyframes text-glitch-main {
          0%, 80%, 100% { transform: translate(0, 0); }
          82% { transform: translate(2px, -1px); }
          84% { transform: translate(-2px, 1px); }
          86% { transform: translate(1px, -1px); }
          88% { transform: translate(-1px, 0px); }
          90% { transform: translate(0, 0); }
        }

        @keyframes text-slice {
          0%, 65%, 100% {
            opacity: 0;
            transform: translateX(0);
          }
          67% {
            opacity: 1;
            transform: translateX(15px);
          }
          69% {
            opacity: 1;
            transform: translateX(-10px);
          }
          71% {
            opacity: 0;
            transform: translateX(0);
          }
          85% {
            opacity: 1;
            transform: translateX(-20px);
          }
          87% {
            opacity: 0;
            transform: translateX(0);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .text-glitch-layer { animation: none !important; }
        }
      `}} />

      {/* Main container for the massive 01 */}
      <div
        className="relative inline-block text-glitch-layer"
        style={{
          animation: "text-glitch-main 2.5s steps(1) infinite",
          willChange: "transform",
        }}
      >
        {/* Layer 1 - Cyan (back) - chaotic X+Y */}
        <div
          className="absolute inset-0 text-[#39c5bb] font-display font-black text-glitch-layer"
          style={{
            fontSize: "clamp(200px, 25vw, 400px)",
            lineHeight: 1,
            animation: "text-glitch-cyan 0.7s steps(2) infinite",
            mixBlendMode: "screen",
            opacity: 0.7,
            willChange: "transform",
          }}
        >
          <span>01</span>
        </div>

        {/* Layer 2 - Pink (middle) - chaotic X+Y */}
        <div
          className="absolute inset-0 text-[#ff2d7a] font-display font-black text-glitch-layer"
          style={{
            fontSize: "clamp(200px, 25vw, 400px)",
            lineHeight: 1,
            animation: "text-glitch-pink 0.85s steps(2) infinite",
            mixBlendMode: "screen",
            opacity: 0.6,
            willChange: "transform",
          }}
        >
          <span>01</span>
        </div>

        {/* Layer 3 - White (front) - raw */}
        <div
          className="relative text-white font-display font-black"
          style={{
            fontSize: "clamp(200px, 25vw, 400px)",
            lineHeight: 1,
          }}
        >
          <span>01</span>
        </div>

        {/* Horizontal glitch slices - CSS-driven */}
        <div
          className="absolute left-0 w-full h-[8px] bg-[#39c5bb]/40 text-glitch-layer"
          style={{
            top: "30%",
            animation: "text-slice 3s steps(1) infinite",
            willChange: "transform, opacity",
          }}
        />
        <div
          className="absolute left-0 w-full h-[6px] bg-[#ff2d7a]/40 text-glitch-layer"
          style={{
            top: "60%",
            animation: "text-slice 3.5s steps(1) infinite",
            animationDelay: "0.3s",
            willChange: "transform, opacity",
          }}
        />

        {/* Scanline overlay - industrial */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `repeating-linear-gradient(
              0deg,
              transparent,
              transparent 2px,
              rgba(57, 197, 187, 0.02) 2px,
              rgba(57, 197, 187, 0.02) 4px
            )`,
          }}
        />
      </div>
    </div>
  );
}

export default memo(GlitchText01);
