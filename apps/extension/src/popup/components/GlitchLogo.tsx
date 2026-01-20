import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

interface GlitchLogoProps {
  size?: number;
  showText?: boolean;
  animated?: boolean;
}

// ULTRAKILL STYLE - Chaotic, not linear glitch effect
export default function GlitchLogo({
  size = 140,
  showText = false,
  animated = true,
}: GlitchLogoProps) {
  // Logo glitch state - chaotic random X+Y displacement
  const [glitchState, setGlitchState] = useState({
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
  });

  // Text glitch state - separate timing for more chaos
  const [textGlitch, setTextGlitch] = useState({
    offsetX: 0,
    skew: 0,
    showCyan: false,
    showPink: false,
    cyanX: 0,
    pinkX: 0,
  });

  useEffect(() => {
    if (!animated) return;

    // LOGO glitch - fast chaotic
    const logoGlitchLoop = () => {
      const intensity = Math.random();
      if (intensity > 0.3) {
        setGlitchState({
          cyanX: (Math.random() - 0.5) * 12,
          cyanY: (Math.random() - 0.5) * 8,
          pinkX: (Math.random() - 0.5) * 10,
          pinkY: (Math.random() - 0.5) * 6,
          mainX: (Math.random() - 0.5) * 4,
          mainY: (Math.random() - 0.5) * 3,
          rotation: (Math.random() - 0.5) * 2,
          scale: 0.98 + Math.random() * 0.04,
          showSlice: intensity > 0.7,
          sliceY: Math.random() * 80,
          sliceX: (Math.random() - 0.5) * 40,
        });

        setTimeout(() => {
          setGlitchState((prev) => ({
            ...prev,
            cyanX: (Math.random() - 0.5) * 4,
            cyanY: (Math.random() - 0.5) * 2,
            pinkX: (Math.random() - 0.5) * 3,
            pinkY: (Math.random() - 0.5) * 2,
            mainX: 0,
            mainY: 0,
            rotation: 0,
            scale: 1,
            showSlice: false,
          }));
        }, 50 + Math.random() * 100);
      }
    };

    // TEXT glitch - slower, different rhythm
    const textGlitchLoop = () => {
      const intensity = Math.random();
      if (intensity > 0.5) {
        setTextGlitch({
          offsetX: (Math.random() - 0.5) * 6,
          skew: (Math.random() - 0.5) * 4,
          showCyan: true,
          showPink: true,
          cyanX: -2 - Math.random() * 3,
          pinkX: 2 + Math.random() * 3,
        });

        setTimeout(() => {
          setTextGlitch({
            offsetX: 0,
            skew: 0,
            showCyan: false,
            showPink: false,
            cyanX: 0,
            pinkX: 0,
          });
        }, 80 + Math.random() * 120);
      }
    };

    // Logo: fast irregular interval
    const scheduleLogoGlitch = () => {
      const delay = 100 + Math.random() * 400;
      return setTimeout(() => {
        logoGlitchLoop();
        logoTimerId = scheduleLogoGlitch();
      }, delay);
    };

    // Text: slower, different rhythm
    const scheduleTextGlitch = () => {
      const delay = 800 + Math.random() * 1500;
      return setTimeout(() => {
        textGlitchLoop();
        textTimerId = scheduleTextGlitch();
      }, delay);
    };

    let logoTimerId = scheduleLogoGlitch();
    let textTimerId = scheduleTextGlitch();

    return () => {
      clearTimeout(logoTimerId);
      clearTimeout(textTimerId);
    };
  }, [animated]);

  const imageHeight = size * 0.5;

  return (
    <div className="flex flex-col items-center">
      {/* Main logo container */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="relative"
        style={{
          width: size,
          height: imageHeight,
          transform: `translate(${glitchState.mainX}px, ${glitchState.mainY}px) rotate(${glitchState.rotation}deg) scale(${glitchState.scale})`,
        }}
      >
        {/* Cyan channel - offset layer */}
        <img
          src="/01-miku.png"
          alt=""
          className="absolute top-0 left-0 pointer-events-none"
          style={{
            width: size,
            height: imageHeight,
            opacity: 0.6,
            filter: 'brightness(0) saturate(100%) invert(68%) sepia(62%) saturate(449%) hue-rotate(127deg) brightness(93%) contrast(91%)',
            mixBlendMode: 'screen',
            transform: `translate(${glitchState.cyanX}px, ${glitchState.cyanY}px)`,
          }}
        />

        {/* Pink channel - offset layer */}
        <img
          src="/01-miku.png"
          alt=""
          className="absolute top-0 left-0 pointer-events-none"
          style={{
            width: size,
            height: imageHeight,
            opacity: 0.5,
            filter: 'brightness(0) saturate(100%) invert(35%) sepia(98%) saturate(5765%) hue-rotate(328deg) brightness(99%) contrast(106%)',
            mixBlendMode: 'screen',
            transform: `translate(${glitchState.pinkX}px, ${glitchState.pinkY}px)`,
          }}
        />

        {/* Main image */}
        <img
          src="/01-miku.png"
          alt="Protocol 01"
          className="absolute top-0 left-0"
          style={{
            width: size,
            height: imageHeight,
          }}
        />

        {/* Slice glitch */}
        {glitchState.showSlice && (
          <div
            className="absolute left-0 overflow-hidden z-10"
            style={{
              top: glitchState.sliceY,
              width: size,
              height: 15,
              transform: `translateX(${glitchState.sliceX}px)`,
            }}
          >
            <img
              src="/01-miku.png"
              alt=""
              style={{
                width: size,
                height: imageHeight,
                marginTop: -glitchState.sliceY,
                filter:
                  Math.random() > 0.5
                    ? 'brightness(0) saturate(100%) invert(68%) sepia(62%) saturate(449%) hue-rotate(127deg) brightness(93%) contrast(91%)'
                    : 'brightness(0) saturate(100%) invert(35%) sepia(98%) saturate(5765%) hue-rotate(328deg) brightness(99%) contrast(106%)',
              }}
            />
          </div>
        )}
      </motion.div>

      {/* PROTOCOL text with own glitch rhythm */}
      {showText && (
        <div className="mt-6 relative h-6 flex items-center justify-center">
          {/* Cyan ghost layer */}
          {textGlitch.showCyan && (
            <span
              className="absolute text-[#39c5bb] text-sm font-black tracking-[6px] opacity-70 font-display"
              style={{ transform: `translateX(${textGlitch.cyanX}px)` }}
            >
              PROTOCOL
            </span>
          )}

          {/* Pink ghost layer */}
          {textGlitch.showPink && (
            <span
              className="absolute text-[#ff2d7a] text-sm font-black tracking-[6px] opacity-60 font-display"
              style={{ transform: `translateX(${textGlitch.pinkX}px)` }}
            >
              PROTOCOL
            </span>
          )}

          {/* Main text */}
          <span
            className="absolute text-white text-sm font-black tracking-[6px] font-display"
            style={{
              transform: `translateX(${textGlitch.offsetX}px) skewX(${textGlitch.skew}deg)`,
            }}
          >
            PROTOCOL
          </span>
        </div>
      )}
    </div>
  );
}
