'use client';

import { memo } from 'react';

/**
 * GlitchLogoMugen — ULTRAKILL-style glitch text "MUGEN"
 * Blue/violet chromatic aberration, screen tearing, flicker bursts.
 * Matches GlitchText01 quality from Protocol 01 main site.
 */
function GlitchLogoMugen({ className = '' }: { className?: string }) {
  return (
    <div className={`relative select-none ${className}`}>
      <style dangerouslySetInnerHTML={{ __html: `
        /* === CHROMATIC ABERRATION === */
        @keyframes mugen-chromatic-blue {
          0%, 100% { transform: translate(0, 0); opacity: 0.6; }
          7% { transform: translate(-8px, 4px); opacity: 0.8; }
          14% { transform: translate(6px, -3px); opacity: 0.5; }
          21% { transform: translate(-5px, 2px); opacity: 0.7; }
          28% { transform: translate(7px, -5px); opacity: 0.4; }
          35% { transform: translate(-3px, 1px); opacity: 0.8; }
          42% { transform: translate(0, 0); opacity: 0.6; }
          63% { transform: translate(0, 0); opacity: 0.6; }
          65% { transform: translate(-15px, 8px); opacity: 1; }
          66% { transform: translate(12px, -6px); opacity: 0.9; }
          67% { transform: translate(-8px, 3px); opacity: 1; }
          68% { transform: translate(4px, -2px); opacity: 0.7; }
          70% { transform: translate(0, 0); opacity: 0.6; }
        }

        @keyframes mugen-chromatic-violet {
          0%, 100% { transform: translate(0, 0); opacity: 0.5; }
          5% { transform: translate(7px, -3px); opacity: 0.7; }
          12% { transform: translate(-5px, 4px); opacity: 0.4; }
          19% { transform: translate(6px, -2px); opacity: 0.6; }
          26% { transform: translate(-4px, 3px); opacity: 0.5; }
          33% { transform: translate(3px, -1px); opacity: 0.7; }
          40% { transform: translate(0, 0); opacity: 0.5; }
          63% { transform: translate(0, 0); opacity: 0.5; }
          65% { transform: translate(14px, -7px); opacity: 1; }
          66% { transform: translate(-10px, 5px); opacity: 0.9; }
          67% { transform: translate(7px, -4px); opacity: 1; }
          68% { transform: translate(-3px, 2px); opacity: 0.6; }
          70% { transform: translate(0, 0); opacity: 0.5; }
        }

        /* === MAIN TEXT SHAKE === */
        @keyframes mugen-shake {
          0%, 60%, 100% { transform: translate(0, 0) skewX(0deg); }
          15% { transform: translate(1px, 0) skewX(0deg); }
          30% { transform: translate(-1px, 0) skewX(0deg); }
          62% { transform: translate(0, 0) skewX(0deg); }
          63% { transform: translate(6px, -3px) skewX(3deg); }
          64% { transform: translate(-8px, 2px) skewX(-5deg); }
          65% { transform: translate(5px, -1px) skewX(2deg); }
          66% { transform: translate(-3px, 3px) skewX(-4deg); }
          67% { transform: translate(4px, -2px) skewX(1deg); }
          68% { transform: translate(-2px, 1px) skewX(-1deg); }
          69% { transform: translate(0, 0) skewX(0deg); }
        }

        /* === SCREEN TEAR === */
        @keyframes mugen-tear-1 {
          0%, 60%, 72%, 100% { clip-path: inset(0 0 100% 0); transform: translateX(0); opacity: 0; }
          63% { clip-path: inset(15% 0 75% 0); transform: translateX(25px); opacity: 1; }
          65% { clip-path: inset(20% 0 70% 0); transform: translateX(-15px); opacity: 0.8; }
          67% { clip-path: inset(10% 0 80% 0); transform: translateX(10px); opacity: 0.6; }
          69% { clip-path: inset(0 0 100% 0); transform: translateX(0); opacity: 0; }
        }

        @keyframes mugen-tear-2 {
          0%, 62%, 74%, 100% { clip-path: inset(100% 0 0 0); transform: translateX(0); opacity: 0; }
          64% { clip-path: inset(60% 0 25% 0); transform: translateX(-20px); opacity: 1; }
          66% { clip-path: inset(55% 0 30% 0); transform: translateX(18px); opacity: 0.9; }
          68% { clip-path: inset(65% 0 25% 0); transform: translateX(-8px); opacity: 0.5; }
          70% { clip-path: inset(100% 0 0 0); transform: translateX(0); opacity: 0; }
        }

        /* === FLICKER === */
        @keyframes mugen-flicker {
          0%, 100% { opacity: 1; }
          62% { opacity: 1; }
          63% { opacity: 0.4; }
          64% { opacity: 1; }
          65% { opacity: 0.2; }
          66% { opacity: 0.8; }
          67% { opacity: 1; }
        }

        /* === GLOW PULSE === */
        @keyframes mugen-glow {
          0%, 60%, 72%, 100% { text-shadow: 0 0 20px rgba(59, 130, 246, 0.3), 0 0 40px rgba(59, 130, 246, 0.1); }
          65% { text-shadow: 0 0 40px rgba(59, 130, 246, 0.8), 0 0 80px rgba(139, 92, 246, 0.4), 0 0 120px rgba(59, 130, 246, 0.2); }
        }

        @media (prefers-reduced-motion: reduce) {
          .mugen-glitch { animation: none !important; }
        }
      `}} />

      {/* Blue chromatic layer */}
      <span
        className="absolute top-0 left-0 text-[#3b82f6] mugen-glitch"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'inherit',
          fontWeight: 'inherit',
          letterSpacing: 'inherit',
          animation: 'mugen-chromatic-blue 3.5s steps(1) infinite',
          mixBlendMode: 'screen',
          willChange: 'transform, opacity',
        }}
      >
        MUGEN
      </span>

      {/* Violet chromatic layer */}
      <span
        className="absolute top-0 left-0 text-[#8b5cf6] mugen-glitch"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'inherit',
          fontWeight: 'inherit',
          letterSpacing: 'inherit',
          animation: 'mugen-chromatic-violet 3.5s steps(1) infinite',
          animationDelay: '0.15s',
          mixBlendMode: 'screen',
          willChange: 'transform, opacity',
        }}
      >
        MUGEN
      </span>

      {/* Screen tear 1 */}
      <span
        className="absolute top-0 left-0 text-[#60a5fa] mugen-glitch"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'inherit',
          fontWeight: 'inherit',
          letterSpacing: 'inherit',
          animation: 'mugen-tear-1 3.5s steps(1) infinite',
          willChange: 'clip-path, transform, opacity',
        }}
      >
        MUGEN
      </span>

      {/* Screen tear 2 */}
      <span
        className="absolute top-0 left-0 text-[#a78bfa] mugen-glitch"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'inherit',
          fontWeight: 'inherit',
          letterSpacing: 'inherit',
          animation: 'mugen-tear-2 3.5s steps(1) infinite',
          willChange: 'clip-path, transform, opacity',
        }}
      >
        MUGEN
      </span>

      {/* Main text */}
      <span
        className="relative text-white mugen-glitch"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'inherit',
          fontWeight: 'inherit',
          letterSpacing: 'inherit',
          animation: 'mugen-shake 3.5s steps(1) infinite, mugen-flicker 3.5s steps(1) infinite, mugen-glow 3.5s ease-in-out infinite',
          willChange: 'transform, opacity',
        }}
      >
        MUGEN
      </span>
    </div>
  );
}

export default memo(GlitchLogoMugen);
