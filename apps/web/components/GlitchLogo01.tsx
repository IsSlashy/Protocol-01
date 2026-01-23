"use client";

import { memo } from "react";
import Image from "next/image";

/**
 * GlitchLogo01 - Optimized ULTRAKILL style glitch
 *
 * Changes from original:
 * - Replaced JS setState animations with pure CSS keyframes
 * - GPU-accelerated transforms via will-change
 * - No React re-renders during animation
 * - Maintains chaotic glitch aesthetic
 */

function GlitchLogo01() {
  return (
    <div className="relative w-[300px] md:w-[400px] lg:w-[500px]">
      {/* CSS Keyframes for chaotic glitch effect */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes glitch-cyan {
          0%, 100% { transform: translate(0, 0); }
          10% { transform: translate(-8px, 5px); }
          20% { transform: translate(6px, -3px); }
          30% { transform: translate(-4px, 2px); }
          40% { transform: translate(7px, -4px); }
          50% { transform: translate(-5px, 3px); }
          60% { transform: translate(4px, -2px); }
          70% { transform: translate(-6px, 4px); }
          80% { transform: translate(8px, -5px); }
          90% { transform: translate(-3px, 2px); }
        }

        @keyframes glitch-pink {
          0%, 100% { transform: translate(0, 0); }
          15% { transform: translate(7px, -4px); }
          25% { transform: translate(-5px, 3px); }
          35% { transform: translate(4px, -2px); }
          45% { transform: translate(-6px, 4px); }
          55% { transform: translate(5px, -3px); }
          65% { transform: translate(-4px, 2px); }
          75% { transform: translate(6px, -4px); }
          85% { transform: translate(-7px, 5px); }
          95% { transform: translate(3px, -2px); }
        }

        @keyframes glitch-main {
          0%, 85%, 100% { transform: translate(0, 0) rotate(0deg) scale(1); }
          86% { transform: translate(2px, -1px) rotate(0.5deg) scale(1.01); }
          88% { transform: translate(-3px, 2px) rotate(-0.8deg) scale(0.99); }
          90% { transform: translate(1px, -1px) rotate(0.3deg) scale(1.02); }
          92% { transform: translate(-2px, 1px) rotate(-0.5deg) scale(0.98); }
          94% { transform: translate(0, 0) rotate(0deg) scale(1); }
        }

        @keyframes glitch-slice {
          0%, 70%, 100% { opacity: 0; clip-path: inset(0 0 100% 0); }
          72% { opacity: 1; clip-path: inset(20% 0 70% 0); transform: translateX(15px); }
          74% { opacity: 1; clip-path: inset(45% 0 45% 0); transform: translateX(-20px); }
          76% { opacity: 1; clip-path: inset(65% 0 25% 0); transform: translateX(10px); }
          78% { opacity: 0; clip-path: inset(0 0 100% 0); }
          85% { opacity: 1; clip-path: inset(30% 0 60% 0); transform: translateX(-15px); }
          87% { opacity: 0; clip-path: inset(0 0 100% 0); }
        }

        @media (prefers-reduced-motion: reduce) {
          .glitch-layer { animation: none !important; }
        }
      `}} />

      {/* Main container with subtle shake */}
      <div
        className="glitch-layer"
        style={{
          animation: "glitch-main 3s steps(1) infinite",
          willChange: "transform",
        }}
      >
        {/* Cyan channel layer */}
        <div
          className="absolute inset-0 glitch-layer"
          style={{
            animation: "glitch-cyan 0.8s steps(2) infinite",
            mixBlendMode: "screen",
            willChange: "transform",
          }}
        >
          <Image
            src="/01-miku.png"
            alt=""
            width={500}
            height={300}
            className="w-full h-auto opacity-60"
            style={{
              filter: "brightness(1.3) sepia(1) saturate(5) hue-rotate(130deg)",
            }}
          />
        </div>

        {/* Pink channel layer */}
        <div
          className="absolute inset-0 glitch-layer"
          style={{
            animation: "glitch-pink 0.9s steps(2) infinite",
            mixBlendMode: "screen",
            willChange: "transform",
          }}
        >
          <Image
            src="/01-miku.png"
            alt=""
            width={500}
            height={300}
            className="w-full h-auto opacity-50"
            style={{
              filter: "brightness(1.2) sepia(1) saturate(5) hue-rotate(300deg)",
            }}
          />
        </div>

        {/* Main image layer */}
        <div className="relative">
          <Image
            src="/01-miku.png"
            alt="01"
            width={500}
            height={300}
            className="w-full h-auto"
            priority
          />
        </div>

        {/* Glitch slice effect - CSS-driven */}
        <div
          className="absolute inset-0 glitch-layer pointer-events-none"
          style={{
            animation: "glitch-slice 4s steps(1) infinite",
            willChange: "clip-path, transform, opacity",
          }}
        >
          <Image
            src="/01-miku.png"
            alt=""
            width={500}
            height={300}
            className="w-full h-auto"
            style={{
              filter: "brightness(1.5) sepia(1) saturate(5) hue-rotate(130deg)",
            }}
          />
        </div>

        {/* Second slice with pink */}
        <div
          className="absolute inset-0 glitch-layer pointer-events-none"
          style={{
            animation: "glitch-slice 4.5s steps(1) infinite",
            animationDelay: "0.5s",
            willChange: "clip-path, transform, opacity",
          }}
        >
          <Image
            src="/01-miku.png"
            alt=""
            width={500}
            height={300}
            className="w-full h-auto"
            style={{
              filter: "brightness(1.5) sepia(1) saturate(5) hue-rotate(300deg)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default memo(GlitchLogo01);
