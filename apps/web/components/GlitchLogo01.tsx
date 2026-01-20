"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";

// ULTRAKILL STYLE - Chaotic random X+Y displacement, not linear
interface GlitchState {
  cyanX: number;
  cyanY: number;
  pinkX: number;
  pinkY: number;
  mainX: number;
  mainY: number;
  rotation: number;
  scale: number;
  showSlice: boolean;
  sliceY: number;
  sliceX: number;
  sliceColor: string;
}

export default function GlitchLogo01() {
  // Logo glitch state - chaotic random displacement
  const [glitchState, setGlitchState] = useState<GlitchState>({
    cyanX: 0,
    cyanY: 0,
    pinkX: 0,
    pinkY: 0,
    mainX: 0,
    mainY: 0,
    rotation: 0,
    scale: 1,
    showSlice: false,
    sliceY: 0,
    sliceX: 0,
    sliceColor: "#39c5bb",
  });

  const performGlitch = useCallback(() => {
    const intensity = Math.random();

    if (intensity > 0.3) {
      // Chaotic displacement - random X AND Y for each layer
      setGlitchState({
        cyanX: (Math.random() - 0.5) * 16,
        cyanY: (Math.random() - 0.5) * 10,
        pinkX: (Math.random() - 0.5) * 14,
        pinkY: (Math.random() - 0.5) * 8,
        mainX: (Math.random() - 0.5) * 6,
        mainY: (Math.random() - 0.5) * 4,
        rotation: (Math.random() - 0.5) * 3,
        scale: 0.97 + Math.random() * 0.06,
        showSlice: intensity > 0.6,
        sliceY: Math.random() * 80,
        sliceX: (Math.random() - 0.5) * 50,
        sliceColor: Math.random() > 0.5 ? "#39c5bb" : "#ff2d7a",
      });

      // Quick settle with residual chaos
      setTimeout(() => {
        setGlitchState(prev => ({
          ...prev,
          cyanX: (Math.random() - 0.5) * 5,
          cyanY: (Math.random() - 0.5) * 3,
          pinkX: (Math.random() - 0.5) * 4,
          pinkY: (Math.random() - 0.5) * 3,
          mainX: 0,
          mainY: 0,
          rotation: 0,
          scale: 1,
          showSlice: false,
        }));
      }, 50 + Math.random() * 100);
    }
  }, []);

  useEffect(() => {
    // Fast chaotic interval: 100-400ms (ULTRAKILL style)
    let timerId: NodeJS.Timeout;

    const scheduleGlitch = () => {
      const delay = 100 + Math.random() * 300; // Fast, irregular
      timerId = setTimeout(() => {
        performGlitch();
        scheduleGlitch();
      }, delay);
    };

    scheduleGlitch();
    return () => clearTimeout(timerId);
  }, [performGlitch]);

  return (
    <div
      className="relative w-[300px] md:w-[400px] lg:w-[500px]"
      style={{
        transform: `translate(${glitchState.mainX}px, ${glitchState.mainY}px) rotate(${glitchState.rotation}deg) scale(${glitchState.scale})`,
        transition: "transform 0.05s ease-out",
      }}
    >
      {/* Cyan channel - chaotic X+Y displacement */}
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${glitchState.cyanX}px, ${glitchState.cyanY}px)`,
          mixBlendMode: "screen",
          transition: "transform 0.03s ease-out",
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

      {/* Pink channel - chaotic X+Y displacement */}
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${glitchState.pinkX}px, ${glitchState.pinkY}px)`,
          mixBlendMode: "screen",
          transition: "transform 0.03s ease-out",
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

      {/* Main image layer - no soft glow */}
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

      {/* Glitch slice - horizontal tear effect */}
      {glitchState.showSlice && (
        <div
          className="absolute left-0 w-full h-[15px] overflow-hidden"
          style={{
            top: `${glitchState.sliceY}%`,
            transform: `translateX(${glitchState.sliceX}px)`,
            zIndex: 5,
          }}
        >
          <Image
            src="/01-miku.png"
            alt=""
            width={500}
            height={300}
            className="w-full h-auto"
            style={{
              marginTop: `-${glitchState.sliceY}%`,
              filter: `brightness(1.5) sepia(1) saturate(5) hue-rotate(${glitchState.sliceColor === "#39c5bb" ? "130deg" : "300deg"})`,
            }}
          />
        </div>
      )}
    </div>
  );
}
