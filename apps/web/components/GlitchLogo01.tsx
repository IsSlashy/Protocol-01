"use client";

import { useState, useEffect, memo } from "react";
import { motion } from "framer-motion";

/**
 * GlitchLogo01 - Same glitch as extension's GlitchLogo
 * JS-driven chaotic random displacement, not CSS keyframes.
 */
function GlitchLogo01() {
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

  useEffect(() => {
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

    const scheduleLogoGlitch = () => {
      const delay = 100 + Math.random() * 400;
      return setTimeout(() => {
        logoGlitchLoop();
        logoTimerId = scheduleLogoGlitch();
      }, delay);
    };

    let logoTimerId = scheduleLogoGlitch();

    return () => {
      clearTimeout(logoTimerId);
    };
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className="relative w-[300px] h-[240px] md:w-[400px] md:h-[321px] lg:w-[500px] lg:h-[401px]"
      style={{
        transform: `translate(${glitchState.mainX}px, ${glitchState.mainY}px) rotate(${glitchState.rotation}deg) scale(${glitchState.scale})`,
      }}
    >
      {/* Cyan channel */}
      <img
        src="/01-miku.png"
        alt=""
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
        style={{
          opacity: 0.6,
          filter: 'brightness(0) saturate(100%) invert(68%) sepia(62%) saturate(449%) hue-rotate(127deg) brightness(93%) contrast(91%)',
          mixBlendMode: 'screen',
          transform: `translate(${glitchState.cyanX}px, ${glitchState.cyanY}px)`,
        }}
      />

      {/* Pink channel */}
      <img
        src="/01-miku.png"
        alt=""
        className="absolute top-0 left-0 w-full h-full pointer-events-none"
        style={{
          opacity: 0.5,
          filter: 'brightness(0) saturate(100%) invert(35%) sepia(98%) saturate(5765%) hue-rotate(328deg) brightness(99%) contrast(106%)',
          mixBlendMode: 'screen',
          transform: `translate(${glitchState.pinkX}px, ${glitchState.pinkY}px)`,
        }}
      />

      {/* Main image */}
      <img
        src="/01-miku.png"
        alt="01"
        className="absolute top-0 left-0 w-full h-full"
      />

      {/* Slice glitch */}
      {glitchState.showSlice && (
        <div
          className="absolute left-0 w-full overflow-hidden z-10"
          style={{
            top: `${glitchState.sliceY}%`,
            height: 15,
            transform: `translateX(${glitchState.sliceX}px)`,
          }}
        >
          <img
            src="/01-miku.png"
            alt=""
            className="w-full"
            style={{
              height: '100%',
              marginTop: `-${glitchState.sliceY}%`,
              filter:
                Math.random() > 0.5
                  ? 'brightness(0) saturate(100%) invert(68%) sepia(62%) saturate(449%) hue-rotate(127deg) brightness(93%) contrast(91%)'
                  : 'brightness(0) saturate(100%) invert(35%) sepia(98%) saturate(5765%) hue-rotate(328deg) brightness(99%) contrast(106%)',
            }}
          />
        </div>
      )}
    </motion.div>
  );
}

export default memo(GlitchLogo01);
