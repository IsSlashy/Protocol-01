"use client";

import { memo } from "react";
import Image from "next/image";

/**
 * GlitchLogo01 - Cinematic ULTRAKILL-style glitch on 01-miku.png
 * Cyan glow, chromatic aberration, screen tearing, flicker bursts
 */

function GlitchLogo01() {
  return (
    <div className="relative w-[300px] md:w-[400px] lg:w-[500px]" style={{ mixBlendMode: "lighten" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        /* === CHROMATIC ABERRATION - subtle drift + violent burst === */
        @keyframes gl01-cyan {
          0%, 55%, 75%, 100% { transform: translate(0, 0); opacity: 0.6; }
          10% { transform: translate(-4px, 2px); opacity: 0.7; }
          25% { transform: translate(3px, -2px); opacity: 0.5; }
          40% { transform: translate(-2px, 1px); opacity: 0.6; }
          /* BURST */
          58% { transform: translate(-12px, 6px); opacity: 1; }
          60% { transform: translate(10px, -5px); opacity: 0.9; }
          62% { transform: translate(-7px, 3px); opacity: 1; }
          64% { transform: translate(4px, -2px); opacity: 0.8; }
          66% { transform: translate(-2px, 1px); opacity: 0.7; }
        }

        @keyframes gl01-pink {
          0%, 55%, 75%, 100% { transform: translate(0, 0); opacity: 0.5; }
          8% { transform: translate(3px, -2px); opacity: 0.6; }
          22% { transform: translate(-3px, 2px); opacity: 0.4; }
          38% { transform: translate(2px, -1px); opacity: 0.5; }
          /* BURST */
          58% { transform: translate(11px, -6px); opacity: 1; }
          60% { transform: translate(-9px, 4px); opacity: 0.9; }
          62% { transform: translate(6px, -3px); opacity: 1; }
          64% { transform: translate(-3px, 2px); opacity: 0.7; }
          66% { transform: translate(1px, -1px); opacity: 0.6; }
        }

        /* === MAIN SHAKE - calm then violent === */
        @keyframes gl01-shake {
          0%, 54%, 70%, 100% { transform: translate(0, 0) skewX(0deg) scale(1); }
          15% { transform: translate(1px, 0) skewX(0deg) scale(1); }
          30% { transform: translate(-1px, 0) skewX(0deg) scale(1); }
          /* VIOLENT BURST */
          56% { transform: translate(5px, -3px) skewX(2deg) scale(1.01); }
          58% { transform: translate(-7px, 2px) skewX(-4deg) scale(0.99); }
          60% { transform: translate(6px, -1px) skewX(3deg) scale(1.02); }
          62% { transform: translate(-4px, 3px) skewX(-2deg) scale(0.98); }
          64% { transform: translate(3px, -2px) skewX(1deg) scale(1.01); }
          66% { transform: translate(-1px, 1px) skewX(-0.5deg) scale(1); }
          68% { transform: translate(0, 0) skewX(0deg) scale(1); }
        }

        /* === SCREEN TEAR SLICES === */
        @keyframes gl01-tear-1 {
          0%, 54%, 70%, 100% {
            clip-path: inset(0 0 100% 0);
            transform: translateX(0);
            opacity: 0;
          }
          57% { clip-path: inset(12% 0 78% 0); transform: translateX(20px); opacity: 1; }
          58% { clip-path: inset(12% 0 78% 0); transform: translateX(-15px); opacity: 1; }
          60% { clip-path: inset(35% 0 53% 0); transform: translateX(25px); opacity: 1; }
          61% { clip-path: inset(35% 0 53% 0); transform: translateX(-10px); opacity: 1; }
          63% { clip-path: inset(62% 0 25% 0); transform: translateX(18px); opacity: 1; }
          64% { clip-path: inset(62% 0 25% 0); transform: translateX(-22px); opacity: 1; }
          66% { clip-path: inset(0 0 100% 0); transform: translateX(0); opacity: 0; }
        }

        @keyframes gl01-tear-2 {
          0%, 56%, 68%, 100% {
            clip-path: inset(0 0 100% 0);
            transform: translateX(0);
            opacity: 0;
          }
          58% { clip-path: inset(22% 0 68% 0); transform: translateX(-18px); opacity: 1; }
          60% { clip-path: inset(48% 0 40% 0); transform: translateX(14px); opacity: 1; }
          62% { clip-path: inset(5% 0 85% 0); transform: translateX(-24px); opacity: 1; }
          64% { clip-path: inset(75% 0 12% 0); transform: translateX(16px); opacity: 1; }
          66% { clip-path: inset(0 0 100% 0); transform: translateX(0); opacity: 0; }
        }

        /* === CYAN GLOW PULSE === */
        @keyframes gl01-glow {
          0%, 100% {
            filter: drop-shadow(0 0 15px rgba(57, 197, 187, 0.4))
                    drop-shadow(0 0 30px rgba(57, 197, 187, 0.2))
                    drop-shadow(0 0 60px rgba(57, 197, 187, 0.1));
          }
          50% {
            filter: drop-shadow(0 0 20px rgba(57, 197, 187, 0.6))
                    drop-shadow(0 0 45px rgba(57, 197, 187, 0.3))
                    drop-shadow(0 0 80px rgba(57, 197, 187, 0.15));
          }
          /* FLASH */
          58% {
            filter: drop-shadow(0 0 30px rgba(57, 197, 187, 1))
                    drop-shadow(0 0 60px rgba(57, 197, 187, 0.7))
                    drop-shadow(0 0 100px rgba(57, 197, 187, 0.4))
                    drop-shadow(0 0 160px rgba(57, 197, 187, 0.2));
          }
          62% {
            filter: drop-shadow(0 0 8px rgba(57, 197, 187, 0.2))
                    drop-shadow(0 0 15px rgba(57, 197, 187, 0.1));
          }
          68% {
            filter: drop-shadow(0 0 18px rgba(57, 197, 187, 0.5))
                    drop-shadow(0 0 35px rgba(57, 197, 187, 0.25))
                    drop-shadow(0 0 70px rgba(57, 197, 187, 0.12));
          }
        }

        /* === FLICKER === */
        @keyframes gl01-flicker {
          0%, 100% { opacity: 1; }
          12% { opacity: 1; }
          12.4% { opacity: 0.82; }
          12.8% { opacity: 1; }
          42% { opacity: 1; }
          42.3% { opacity: 0.88; }
          42.6% { opacity: 1; }
          /* BURST flicker */
          56% { opacity: 1; }
          56.5% { opacity: 0.6; }
          57% { opacity: 0.95; }
          58% { opacity: 0.5; }
          58.5% { opacity: 0.9; }
          59% { opacity: 0.65; }
          60% { opacity: 1; }
          61% { opacity: 0.75; }
          62% { opacity: 1; }
        }

        /* === NOISE BARS === */
        @keyframes gl01-noise {
          0%, 55%, 67%, 100% { opacity: 0; height: 0; }
          57% { opacity: 0.5; height: 3px; top: 18%; }
          59% { opacity: 0.7; height: 2px; top: 52%; }
          61% { opacity: 0.4; height: 4px; top: 35%; }
          63% { opacity: 0.6; height: 2px; top: 70%; }
          65% { opacity: 0.3; height: 3px; top: 10%; }
        }

        @media (prefers-reduced-motion: reduce) {
          .gl01-layer {
            animation: none !important;
          }
          .gl01-glow-wrap {
            filter: drop-shadow(0 0 15px rgba(57, 197, 187, 0.4)) !important;
          }
        }
      `}} />

      {/* Outer flicker wrapper */}
      <div
        className="gl01-layer"
        style={{
          animation: "gl01-flicker 4s steps(1) infinite",
          willChange: "opacity",
        }}
      >
        {/* Glow wrapper - cyan drop-shadow on the whole image */}
        <div
          className="gl01-glow-wrap"
          style={{
            animation: "gl01-glow 4s ease-in-out infinite",
            willChange: "filter",
          }}
        >
          {/* Shake container */}
          <div
            className="gl01-layer"
            style={{
              animation: "gl01-shake 4s steps(1) infinite",
              willChange: "transform",
            }}
          >
            {/* Cyan channel layer */}
            <div
              className="absolute inset-0 gl01-layer"
              style={{
                animation: "gl01-cyan 4s steps(2) infinite",
                mixBlendMode: "screen",
                willChange: "transform, opacity",
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
              className="absolute inset-0 gl01-layer"
              style={{
                animation: "gl01-pink 4s steps(2) infinite",
                mixBlendMode: "screen",
                willChange: "transform, opacity",
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

            {/* Main image layer - tinted cyan */}
            <div className="relative">
              <Image
                src="/01-miku.png"
                alt="01"
                width={500}
                height={300}
                className="w-full h-auto"
                style={{
                  filter: "brightness(1.1) sepia(0.3) saturate(2) hue-rotate(130deg)",
                }}
                priority
              />
            </div>

            {/* Screen tear slice 1 - cyan */}
            <div
              className="absolute inset-0 gl01-layer pointer-events-none"
              style={{
                animation: "gl01-tear-1 4s steps(1) infinite",
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
                  filter: "brightness(1.6) sepia(1) saturate(5) hue-rotate(130deg)",
                }}
              />
            </div>

            {/* Screen tear slice 2 - pink */}
            <div
              className="absolute inset-0 gl01-layer pointer-events-none"
              style={{
                animation: "gl01-tear-2 4s steps(1) infinite",
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

            {/* Horizontal noise bars */}
            <div
              className="absolute left-0 w-full bg-[#39c5bb]/50 gl01-layer pointer-events-none"
              style={{
                animation: "gl01-noise 4s steps(1) infinite",
                willChange: "opacity, height, top",
              }}
            />
            <div
              className="absolute left-0 w-full bg-[#ff2d7a]/30 gl01-layer pointer-events-none"
              style={{
                animation: "gl01-noise 4s steps(1) infinite",
                animationDelay: "0.15s",
                willChange: "opacity, height, top",
              }}
            />

            {/* Scanline overlay */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: `repeating-linear-gradient(
                  0deg,
                  transparent,
                  transparent 2px,
                  rgba(57, 197, 187, 0.03) 2px,
                  rgba(57, 197, 187, 0.03) 4px
                )`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(GlitchLogo01);
