"use client";

import { memo } from "react";
import Image from "next/image";

/**
 * GlitchLogo01 - Cinematic glitch on 01-miku.png
 * PNG is pink-on-white, so we invert (→ cyan-on-black) + screen blend to kill the background.
 */

function GlitchLogo01() {
  return (
    <div className="relative w-[300px] md:w-[400px] lg:w-[500px]">
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes gl01-cyan {
          0%, 55%, 75%, 100% { transform: translate(0, 0); opacity: 0.5; }
          10% { transform: translate(-4px, 2px); opacity: 0.6; }
          25% { transform: translate(3px, -2px); opacity: 0.4; }
          40% { transform: translate(-2px, 1px); opacity: 0.5; }
          58% { transform: translate(-12px, 6px); opacity: 0.9; }
          60% { transform: translate(10px, -5px); opacity: 0.8; }
          62% { transform: translate(-7px, 3px); opacity: 0.9; }
          64% { transform: translate(4px, -2px); opacity: 0.7; }
          66% { transform: translate(-2px, 1px); opacity: 0.5; }
        }

        @keyframes gl01-shake {
          0%, 54%, 70%, 100% { transform: translate(0, 0) skewX(0deg) scale(1); }
          15% { transform: translate(1px, 0) skewX(0deg) scale(1); }
          30% { transform: translate(-1px, 0) skewX(0deg) scale(1); }
          56% { transform: translate(5px, -3px) skewX(2deg) scale(1.01); }
          58% { transform: translate(-7px, 2px) skewX(-4deg) scale(0.99); }
          60% { transform: translate(6px, -1px) skewX(3deg) scale(1.02); }
          62% { transform: translate(-4px, 3px) skewX(-2deg) scale(0.98); }
          64% { transform: translate(3px, -2px) skewX(1deg) scale(1.01); }
          66% { transform: translate(-1px, 1px) skewX(-0.5deg) scale(1); }
          68% { transform: translate(0, 0) skewX(0deg) scale(1); }
        }

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

        @keyframes gl01-glow {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.05); }
          58% { opacity: 0.9; transform: scale(1.15); }
          62% { opacity: 0.15; transform: scale(0.95); }
          68% { opacity: 0.35; transform: scale(1); }
        }

        @keyframes gl01-flicker {
          0%, 100% { opacity: 1; }
          12.4% { opacity: 0.82; }
          12.8% { opacity: 1; }
          42.3% { opacity: 0.88; }
          42.6% { opacity: 1; }
          56.5% { opacity: 0.6; }
          57% { opacity: 0.95; }
          58% { opacity: 0.5; }
          58.5% { opacity: 0.9; }
          59% { opacity: 0.65; }
          60% { opacity: 1; }
          61% { opacity: 0.75; }
          62% { opacity: 1; }
        }

        @keyframes gl01-noise {
          0%, 55%, 67%, 100% { opacity: 0; height: 0; }
          57% { opacity: 0.5; height: 3px; top: 18%; }
          59% { opacity: 0.7; height: 2px; top: 52%; }
          61% { opacity: 0.4; height: 4px; top: 35%; }
          63% { opacity: 0.6; height: 2px; top: 70%; }
          65% { opacity: 0.3; height: 3px; top: 10%; }
        }

        @media (prefers-reduced-motion: reduce) {
          .gl01-layer { animation: none !important; }
          .gl01-glow-bg { animation: none !important; opacity: 0.3 !important; }
        }
      `}} />

      {/* Flicker wrapper */}
      <div
        className="gl01-layer"
        style={{
          animation: "gl01-flicker 4s steps(1) infinite",
          willChange: "opacity",
        }}
      >
        {/* Ambient cyan glow behind */}
        <div
          className="absolute inset-0 gl01-glow-bg pointer-events-none"
          style={{
            background: "radial-gradient(ellipse 60% 70% at 50% 50%, rgba(57, 197, 187, 0.4) 0%, rgba(57, 197, 187, 0.1) 40%, transparent 70%)",
            animation: "gl01-glow 4s ease-in-out infinite",
            willChange: "opacity, transform",
          }}
        />

        <div className="relative">
          {/* Shake container */}
          <div
            className="gl01-layer"
            style={{
              animation: "gl01-shake 4s steps(1) infinite",
              willChange: "transform",
            }}
          >
            {/* Cyan chromatic aberration layer */}
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
                className="w-full h-auto"
                style={{
                  filter: "invert(1) brightness(1.4)",
                  mixBlendMode: "screen",
                }}
              />
            </div>

            {/* Main image: invert (pink→cyan, white→black) + screen (black=invisible) */}
            <div className="relative">
              <Image
                src="/01-miku.png"
                alt="01"
                width={500}
                height={300}
                className="w-full h-auto"
                style={{
                  filter: "invert(1) brightness(1.1)",
                  mixBlendMode: "screen",
                }}
                priority
              />
            </div>

            {/* Screen tear slice 1 */}
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
                  filter: "invert(1) brightness(1.8)",
                  mixBlendMode: "screen",
                }}
              />
            </div>

            {/* Screen tear slice 2 */}
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
                  filter: "invert(1) brightness(1.5)",
                  mixBlendMode: "screen",
                }}
              />
            </div>

            {/* Noise bar */}
            <div
              className="absolute left-0 w-full bg-[#39c5bb]/50 gl01-layer pointer-events-none"
              style={{
                animation: "gl01-noise 4s steps(1) infinite",
                willChange: "opacity, height, top",
              }}
            />

            {/* Scanlines */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: `repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(57,197,187,0.03) 2px, rgba(57,197,187,0.03) 4px)`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(GlitchLogo01);
