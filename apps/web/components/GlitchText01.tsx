"use client";

import { memo } from "react";

interface GlitchText01Props {
  className?: string;
}

/**
 * GlitchText01 - Cinematic ULTRAKILL-style glitch "01"
 * Cyan glow with chromatic aberration, screen tearing, flicker bursts
 */
function GlitchText01({ className = "" }: GlitchText01Props) {
  return (
    <div className={`relative select-none ${className}`}>
      <style dangerouslySetInnerHTML={{ __html: `
        /* === CHROMATIC ABERRATION LAYERS === */
        @keyframes t01-chromatic-cyan {
          0%, 100% { transform: translate(0, 0); opacity: 0.6; }
          7% { transform: translate(-8px, 4px); opacity: 0.8; }
          14% { transform: translate(6px, -3px); opacity: 0.5; }
          21% { transform: translate(-5px, 2px); opacity: 0.7; }
          28% { transform: translate(7px, -5px); opacity: 0.4; }
          35% { transform: translate(-3px, 1px); opacity: 0.8; }
          42% { transform: translate(0, 0); opacity: 0.6; }
          /* BURST at 65% */
          63% { transform: translate(0, 0); opacity: 0.6; }
          65% { transform: translate(-15px, 8px); opacity: 1; }
          66% { transform: translate(12px, -6px); opacity: 0.9; }
          67% { transform: translate(-8px, 3px); opacity: 1; }
          68% { transform: translate(4px, -2px); opacity: 0.7; }
          70% { transform: translate(0, 0); opacity: 0.6; }
        }

        @keyframes t01-chromatic-pink {
          0%, 100% { transform: translate(0, 0); opacity: 0.5; }
          5% { transform: translate(7px, -3px); opacity: 0.7; }
          12% { transform: translate(-5px, 4px); opacity: 0.4; }
          19% { transform: translate(6px, -2px); opacity: 0.6; }
          26% { transform: translate(-4px, 3px); opacity: 0.5; }
          33% { transform: translate(3px, -1px); opacity: 0.7; }
          40% { transform: translate(0, 0); opacity: 0.5; }
          /* BURST at 65% */
          63% { transform: translate(0, 0); opacity: 0.5; }
          65% { transform: translate(14px, -7px); opacity: 1; }
          66% { transform: translate(-10px, 5px); opacity: 0.9; }
          67% { transform: translate(7px, -4px); opacity: 1; }
          68% { transform: translate(-3px, 2px); opacity: 0.6; }
          70% { transform: translate(0, 0); opacity: 0.5; }
        }

        /* === MAIN TEXT SHAKE === */
        @keyframes t01-shake {
          0%, 60%, 100% { transform: translate(0, 0) skewX(0deg); }
          /* Subtle drift */
          15% { transform: translate(1px, 0) skewX(0deg); }
          30% { transform: translate(-1px, 0) skewX(0deg); }
          /* VIOLENT BURST */
          62% { transform: translate(0, 0) skewX(0deg); }
          63% { transform: translate(6px, -3px) skewX(3deg); }
          64% { transform: translate(-8px, 2px) skewX(-5deg); }
          65% { transform: translate(5px, -1px) skewX(2deg); }
          66% { transform: translate(-3px, 3px) skewX(-4deg); }
          67% { transform: translate(4px, -2px) skewX(1deg); }
          68% { transform: translate(-2px, 1px) skewX(-1deg); }
          69% { transform: translate(0, 0) skewX(0deg); }
        }

        /* === SCREEN TEAR / HORIZONTAL SLICES === */
        @keyframes t01-tear-1 {
          0%, 60%, 72%, 100% {
            clip-path: inset(0 0 100% 0);
            transform: translateX(0);
            opacity: 0;
          }
          63% {
            clip-path: inset(15% 0 75% 0);
            transform: translateX(25px);
            opacity: 1;
          }
          64% {
            clip-path: inset(15% 0 75% 0);
            transform: translateX(-18px);
            opacity: 1;
          }
          65% {
            clip-path: inset(40% 0 48% 0);
            transform: translateX(30px);
            opacity: 1;
          }
          66% {
            clip-path: inset(40% 0 48% 0);
            transform: translateX(-12px);
            opacity: 1;
          }
          67% {
            clip-path: inset(70% 0 18% 0);
            transform: translateX(20px);
            opacity: 1;
          }
          68% {
            clip-path: inset(70% 0 18% 0);
            transform: translateX(-25px);
            opacity: 1;
          }
        }

        @keyframes t01-tear-2 {
          0%, 62%, 70%, 100% {
            clip-path: inset(0 0 100% 0);
            transform: translateX(0);
            opacity: 0;
          }
          64% {
            clip-path: inset(25% 0 65% 0);
            transform: translateX(-22px);
            opacity: 1;
          }
          65% {
            clip-path: inset(55% 0 33% 0);
            transform: translateX(15px);
            opacity: 1;
          }
          66% {
            clip-path: inset(8% 0 82% 0);
            transform: translateX(-28px);
            opacity: 1;
          }
          67% {
            clip-path: inset(80% 0 8% 0);
            transform: translateX(18px);
            opacity: 1;
          }
        }

        /* === GLOW PULSE === */
        @keyframes t01-glow-pulse {
          0%, 100% {
            text-shadow:
              0 0 20px rgba(57, 197, 187, 0.5),
              0 0 40px rgba(57, 197, 187, 0.3),
              0 0 80px rgba(57, 197, 187, 0.15);
            filter: brightness(1);
          }
          50% {
            text-shadow:
              0 0 30px rgba(57, 197, 187, 0.7),
              0 0 60px rgba(57, 197, 187, 0.4),
              0 0 100px rgba(57, 197, 187, 0.2),
              0 0 150px rgba(57, 197, 187, 0.1);
            filter: brightness(1.1);
          }
          /* FLASH during burst */
          63% {
            text-shadow:
              0 0 40px rgba(57, 197, 187, 1),
              0 0 80px rgba(57, 197, 187, 0.8),
              0 0 120px rgba(57, 197, 187, 0.5),
              0 0 200px rgba(57, 197, 187, 0.3);
            filter: brightness(1.4);
          }
          66% {
            text-shadow:
              0 0 10px rgba(57, 197, 187, 0.3),
              0 0 20px rgba(57, 197, 187, 0.1);
            filter: brightness(0.8);
          }
          69% {
            text-shadow:
              0 0 25px rgba(57, 197, 187, 0.6),
              0 0 50px rgba(57, 197, 187, 0.35),
              0 0 90px rgba(57, 197, 187, 0.18);
            filter: brightness(1);
          }
        }

        /* === FLICKER === */
        @keyframes t01-flicker {
          0%, 100% { opacity: 1; }
          10% { opacity: 1; }
          10.5% { opacity: 0.8; }
          11% { opacity: 1; }
          40% { opacity: 1; }
          40.5% { opacity: 0.85; }
          41% { opacity: 1; }
          63% { opacity: 1; }
          63.5% { opacity: 0.6; }
          64% { opacity: 1; }
          64.5% { opacity: 0.7; }
          65% { opacity: 1; }
          65.5% { opacity: 0.5; }
          66% { opacity: 0.9; }
          67% { opacity: 1; }
        }

        /* === HORIZONTAL NOISE BARS === */
        @keyframes t01-noise-bar {
          0%, 61%, 69%, 100% { opacity: 0; height: 0; }
          63% { opacity: 0.6; height: 3px; top: 22%; }
          64% { opacity: 0.8; height: 2px; top: 55%; }
          65% { opacity: 0.5; height: 4px; top: 38%; }
          66% { opacity: 0.7; height: 2px; top: 72%; }
          67% { opacity: 0.4; height: 3px; top: 15%; }
        }

        @media (prefers-reduced-motion: reduce) {
          .t01-layer { animation: none !important; }
          .t01-glow { text-shadow: 0 0 20px rgba(57, 197, 187, 0.5) !important; }
        }
      `}} />

      {/* Outer container - flicker */}
      <div
        className="relative inline-block t01-layer"
        style={{
          animation: "t01-flicker 4s steps(1) infinite",
          willChange: "opacity",
        }}
      >
        {/* Main shake container */}
        <div
          className="relative t01-layer"
          style={{
            animation: "t01-shake 4s steps(1) infinite",
            willChange: "transform",
          }}
        >
          {/* Layer 1 - Cyan chromatic aberration */}
          <div
            className="absolute inset-0 t01-layer"
            style={{
              fontSize: "clamp(180px, 22vw, 380px)",
              lineHeight: 1,
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              color: "#39c5bb",
              animation: "t01-chromatic-cyan 4s steps(2) infinite",
              mixBlendMode: "screen",
              willChange: "transform, opacity",
            }}
          >
            <span>01</span>
          </div>

          {/* Layer 2 - Pink chromatic aberration */}
          <div
            className="absolute inset-0 t01-layer"
            style={{
              fontSize: "clamp(180px, 22vw, 380px)",
              lineHeight: 1,
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              color: "#ff2d7a",
              animation: "t01-chromatic-pink 4s steps(2) infinite",
              mixBlendMode: "screen",
              willChange: "transform, opacity",
            }}
          >
            <span>01</span>
          </div>

          {/* Layer 3 - Main cyan text with glow */}
          <div
            className="relative t01-glow"
            style={{
              fontSize: "clamp(180px, 22vw, 380px)",
              lineHeight: 1,
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              color: "#39c5bb",
              animation: "t01-glow-pulse 4s ease-in-out infinite",
              willChange: "text-shadow, filter",
            }}
          >
            <span>01</span>
          </div>

          {/* Screen tear slice 1 - cyan */}
          <div
            className="absolute inset-0 t01-layer pointer-events-none"
            style={{
              fontSize: "clamp(180px, 22vw, 380px)",
              lineHeight: 1,
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              color: "#39c5bb",
              animation: "t01-tear-1 4s steps(1) infinite",
              filter: "brightness(1.5)",
              willChange: "clip-path, transform, opacity",
            }}
          >
            <span>01</span>
          </div>

          {/* Screen tear slice 2 - pink tint */}
          <div
            className="absolute inset-0 t01-layer pointer-events-none"
            style={{
              fontSize: "clamp(180px, 22vw, 380px)",
              lineHeight: 1,
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              color: "#ff2d7a",
              animation: "t01-tear-2 4s steps(1) infinite",
              mixBlendMode: "screen",
              opacity: 0.7,
              willChange: "clip-path, transform, opacity",
            }}
          >
            <span>01</span>
          </div>

          {/* Horizontal noise bars */}
          <div
            className="absolute left-0 w-full bg-[#39c5bb]/50 t01-layer pointer-events-none"
            style={{
              animation: "t01-noise-bar 4s steps(1) infinite",
              willChange: "opacity, height, top",
            }}
          />
          <div
            className="absolute left-0 w-full bg-[#ff2d7a]/30 t01-layer pointer-events-none"
            style={{
              animation: "t01-noise-bar 4s steps(1) infinite",
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
  );
}

export default memo(GlitchText01);
