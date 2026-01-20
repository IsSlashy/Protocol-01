"use client";

import { motion } from "framer-motion";
import { useEffect, useState, useCallback } from "react";

interface GlitchText01Props {
  className?: string;
}

// ULTRAKILL STYLE - Industrial, chaotic, no soft effects
export default function GlitchText01({ className = "" }: GlitchText01Props) {
  const [glitchState, setGlitchState] = useState({
    cyanX: 0,
    cyanY: 0,
    pinkX: 0,
    pinkY: 0,
    mainX: 0,
    mainY: 0,
    showSlice: false,
    sliceY: 0,
    sliceOffset: 0,
  });

  const performGlitch = useCallback(() => {
    const intensity = Math.random();

    if (intensity > 0.4) {
      // Chaotic X+Y displacement for each layer
      setGlitchState({
        cyanX: (Math.random() - 0.5) * 12,
        cyanY: (Math.random() - 0.5) * 8,
        pinkX: (Math.random() - 0.5) * 10,
        pinkY: (Math.random() - 0.5) * 6,
        mainX: (Math.random() - 0.5) * 4,
        mainY: (Math.random() - 0.5) * 2,
        showSlice: intensity > 0.7,
        sliceY: 10 + Math.random() * 80,
        sliceOffset: (Math.random() - 0.5) * 30,
      });

      setTimeout(
        () => {
          setGlitchState((prev) => ({
            ...prev,
            cyanX: (Math.random() - 0.5) * 4,
            cyanY: (Math.random() - 0.5) * 2,
            pinkX: (Math.random() - 0.5) * 3,
            pinkY: (Math.random() - 0.5) * 2,
            mainX: 0,
            mainY: 0,
            showSlice: false,
          }));
        },
        50 + Math.random() * 80
      );
    }
  }, []);

  useEffect(() => {
    // Fast chaotic interval: 100-400ms (ULTRAKILL style)
    let timerId: NodeJS.Timeout;

    const scheduleGlitch = () => {
      const delay = 100 + Math.random() * 300;
      timerId = setTimeout(() => {
        performGlitch();
        scheduleGlitch();
      }, delay);
    };

    scheduleGlitch();
    return () => clearTimeout(timerId);
  }, [performGlitch]);

  return (
    <div className={`relative ${className}`}>
      {/* Main container for the massive 01 */}
      <div
        className="relative inline-block"
        style={{
          transform: `translate(${glitchState.mainX}px, ${glitchState.mainY}px)`,
          transition: "transform 0.03s ease-out",
        }}
      >
        {/* Layer 1 - Cyan (back) - chaotic X+Y */}
        <div
          className="absolute inset-0 text-[#39c5bb] font-display font-black"
          style={{
            fontSize: "clamp(200px, 25vw, 400px)",
            lineHeight: 1,
            transform: `translate(${glitchState.cyanX}px, ${glitchState.cyanY}px)`,
            mixBlendMode: "screen",
            opacity: 0.7,
            transition: "transform 0.03s ease-out",
          }}
        >
          <span>01</span>
        </div>

        {/* Layer 2 - Pink (middle) - chaotic X+Y */}
        <div
          className="absolute inset-0 text-[#ff2d7a] font-display font-black"
          style={{
            fontSize: "clamp(200px, 25vw, 400px)",
            lineHeight: 1,
            transform: `translate(${glitchState.pinkX}px, ${glitchState.pinkY}px)`,
            mixBlendMode: "screen",
            opacity: 0.6,
            transition: "transform 0.03s ease-out",
          }}
        >
          <span>01</span>
        </div>

        {/* Layer 3 - White (front) - no soft glow, raw */}
        <div
          className="relative text-white font-display font-black"
          style={{
            fontSize: "clamp(200px, 25vw, 400px)",
            lineHeight: 1,
          }}
        >
          <span>01</span>
        </div>

        {/* Horizontal glitch slices - raw, not animated smoothly */}
        {glitchState.showSlice && (
          <div
            className="absolute left-0 w-full h-[8px] overflow-hidden bg-[#39c5bb]/20"
            style={{
              top: `${glitchState.sliceY}%`,
              transform: `translateX(${glitchState.sliceOffset}px)`,
            }}
          />
        )}

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
