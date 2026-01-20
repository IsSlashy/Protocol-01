/**
 * Specter Protocol Animation System
 * Smooth, performant animations for the ghostly aesthetic
 */

// ═══════════════════════════════════════════════════════════════
// DURATION SCALE
// ═══════════════════════════════════════════════════════════════
export const durations = {
  instant: 0,
  fastest: 50,
  faster: 100,
  fast: 150,
  normal: 200,
  slow: 300,
  slower: 400,
  slowest: 500,
  lazy: 700,
  glacial: 1000,
} as const;

// ═══════════════════════════════════════════════════════════════
// EASING FUNCTIONS
// ═══════════════════════════════════════════════════════════════
export const easings = {
  // Standard easings
  linear: 'linear',
  ease: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',

  // Custom cubic-bezier easings
  easeInQuad: 'cubic-bezier(0.55, 0.085, 0.68, 0.53)',
  easeOutQuad: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  easeInOutQuad: 'cubic-bezier(0.455, 0.03, 0.515, 0.955)',

  easeInCubic: 'cubic-bezier(0.55, 0.055, 0.675, 0.19)',
  easeOutCubic: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
  easeInOutCubic: 'cubic-bezier(0.645, 0.045, 0.355, 1)',

  easeInExpo: 'cubic-bezier(0.95, 0.05, 0.795, 0.035)',
  easeOutExpo: 'cubic-bezier(0.19, 1, 0.22, 1)',
  easeInOutExpo: 'cubic-bezier(1, 0, 0, 1)',

  // Bounce & spring
  easeOutBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  easeInBack: 'cubic-bezier(0.36, 0, 0.66, -0.56)',
  spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',

  // Specter signature easing
  specter: 'cubic-bezier(0.23, 1, 0.32, 1)',
  specterIn: 'cubic-bezier(0.4, 0, 1, 1)',
  specterOut: 'cubic-bezier(0, 0, 0.2, 1)',
} as const;

// ═══════════════════════════════════════════════════════════════
// CSS KEYFRAMES - For web (CSS-in-JS compatible)
// ═══════════════════════════════════════════════════════════════
export const keyframes = {
  // Glow pulsation effect
  glow: `
    @keyframes glow {
      0%, 100% {
        box-shadow: 0 0 20px rgba(0, 255, 136, 0.15), 0 0 40px rgba(0, 255, 136, 0.15);
        opacity: 1;
      }
      50% {
        box-shadow: 0 0 30px rgba(0, 255, 136, 0.3), 0 0 60px rgba(0, 255, 136, 0.2);
        opacity: 0.9;
      }
    }
  `,

  // Soft floating effect
  float: `
    @keyframes float {
      0%, 100% {
        transform: translateY(0);
      }
      50% {
        transform: translateY(-10px);
      }
    }
  `,

  // Fade animations
  fadeIn: `
    @keyframes fadeIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  `,

  fadeOut: `
    @keyframes fadeOut {
      from {
        opacity: 1;
      }
      to {
        opacity: 0;
      }
    }
  `,

  // Slide animations
  slideUp: `
    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `,

  slideDown: `
    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `,

  slideLeft: `
    @keyframes slideLeft {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
  `,

  slideRight: `
    @keyframes slideRight {
      from {
        opacity: 0;
        transform: translateX(-20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
  `,

  // Scale animations
  scaleIn: `
    @keyframes scaleIn {
      from {
        opacity: 0;
        transform: scale(0.9);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
  `,

  scaleOut: `
    @keyframes scaleOut {
      from {
        opacity: 1;
        transform: scale(1);
      }
      to {
        opacity: 0;
        transform: scale(0.9);
      }
    }
  `,

  // Typing effect (cursor blink)
  typing: `
    @keyframes typing {
      0%, 50% {
        opacity: 1;
      }
      51%, 100% {
        opacity: 0;
      }
    }
  `,

  // Spin animation
  spin: `
    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `,

  // Pulse animation
  pulse: `
    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.5;
      }
    }
  `,

  // Bounce animation
  bounce: `
    @keyframes bounce {
      0%, 100% {
        transform: translateY(0);
        animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
      }
      50% {
        transform: translateY(-25%);
        animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
      }
    }
  `,

  // Shake animation (for errors)
  shake: `
    @keyframes shake {
      0%, 100% {
        transform: translateX(0);
      }
      10%, 30%, 50%, 70%, 90% {
        transform: translateX(-4px);
      }
      20%, 40%, 60%, 80% {
        transform: translateX(4px);
      }
    }
  `,

  // Ghost loader animation
  ghostFloat: `
    @keyframes ghostFloat {
      0%, 100% {
        transform: translateY(0) scale(1);
        opacity: 0.8;
      }
      25% {
        transform: translateY(-5px) scale(1.02);
        opacity: 1;
      }
      50% {
        transform: translateY(-10px) scale(1);
        opacity: 0.9;
      }
      75% {
        transform: translateY(-5px) scale(0.98);
        opacity: 1;
      }
    }
  `,

  // Shimmer loading effect
  shimmer: `
    @keyframes shimmer {
      0% {
        background-position: -200% 0;
      }
      100% {
        background-position: 200% 0;
      }
    }
  `,

  // Ripple effect
  ripple: `
    @keyframes ripple {
      0% {
        transform: scale(0);
        opacity: 0.5;
      }
      100% {
        transform: scale(4);
        opacity: 0;
      }
    }
  `,
} as const;

// ═══════════════════════════════════════════════════════════════
// ANIMATION PRESETS - Ready-to-use animation strings
// ═══════════════════════════════════════════════════════════════
export const animations = {
  // Glow
  glow: `glow 2s ${easings.easeInOut} infinite`,
  glowSlow: `glow 3s ${easings.easeInOut} infinite`,
  glowFast: `glow 1s ${easings.easeInOut} infinite`,

  // Float
  float: `float 3s ${easings.easeInOut} infinite`,
  floatSlow: `float 5s ${easings.easeInOut} infinite`,
  floatFast: `float 2s ${easings.easeInOut} infinite`,

  // Fade
  fadeIn: `fadeIn ${durations.normal}ms ${easings.specter}`,
  fadeInSlow: `fadeIn ${durations.slow}ms ${easings.specter}`,
  fadeOut: `fadeOut ${durations.normal}ms ${easings.specter}`,
  fadeOutSlow: `fadeOut ${durations.slow}ms ${easings.specter}`,

  // Slide
  slideUp: `slideUp ${durations.normal}ms ${easings.specterOut}`,
  slideDown: `slideDown ${durations.normal}ms ${easings.specterOut}`,
  slideLeft: `slideLeft ${durations.normal}ms ${easings.specterOut}`,
  slideRight: `slideRight ${durations.normal}ms ${easings.specterOut}`,

  // Scale
  scaleIn: `scaleIn ${durations.fast}ms ${easings.spring}`,
  scaleOut: `scaleOut ${durations.fast}ms ${easings.easeIn}`,

  // Utility
  spin: `spin 1s ${easings.linear} infinite`,
  spinSlow: `spin 2s ${easings.linear} infinite`,
  pulse: `pulse 2s ${easings.easeInOut} infinite`,
  bounce: `bounce 1s ${easings.easeInOut} infinite`,
  shake: `shake 0.5s ${easings.easeInOut}`,

  // Specter specific
  ghostFloat: `ghostFloat 3s ${easings.easeInOut} infinite`,
  shimmer: `shimmer 2s ${easings.linear} infinite`,
  typing: `typing 1s ${easings.linear} infinite`,
  ripple: `ripple 0.6s ${easings.easeOut}`,
} as const;

// ═══════════════════════════════════════════════════════════════
// TRANSITION PRESETS
// ═══════════════════════════════════════════════════════════════
export const transitions = {
  // All properties
  all: `all ${durations.normal}ms ${easings.specter}`,
  allFast: `all ${durations.fast}ms ${easings.specter}`,
  allSlow: `all ${durations.slow}ms ${easings.specter}`,

  // Specific properties
  opacity: `opacity ${durations.normal}ms ${easings.specter}`,
  transform: `transform ${durations.normal}ms ${easings.specter}`,
  colors: `color ${durations.normal}ms ${easings.specter}, background-color ${durations.normal}ms ${easings.specter}, border-color ${durations.normal}ms ${easings.specter}`,
  shadow: `box-shadow ${durations.normal}ms ${easings.specter}`,

  // Combined
  button: `all ${durations.fast}ms ${easings.specter}, box-shadow ${durations.normal}ms ${easings.specter}`,
  card: `transform ${durations.normal}ms ${easings.specter}, box-shadow ${durations.slow}ms ${easings.specter}`,
  input: `border-color ${durations.fast}ms ${easings.specter}, box-shadow ${durations.fast}ms ${easings.specter}`,
} as const;

// ═══════════════════════════════════════════════════════════════
// REACT NATIVE COMPATIBLE VALUES
// ═══════════════════════════════════════════════════════════════
export const rnAnimationConfig = {
  // Spring configs for React Native Reanimated
  spring: {
    default: { damping: 15, stiffness: 150, mass: 1 },
    gentle: { damping: 20, stiffness: 100, mass: 1 },
    bouncy: { damping: 10, stiffness: 200, mass: 0.8 },
    stiff: { damping: 25, stiffness: 300, mass: 1 },
  },

  // Timing configs
  timing: {
    fast: { duration: durations.fast },
    normal: { duration: durations.normal },
    slow: { duration: durations.slow },
  },
} as const;

// Type exports
export type DurationKey = keyof typeof durations;
export type EasingKey = keyof typeof easings;
export type KeyframeKey = keyof typeof keyframes;
export type AnimationKey = keyof typeof animations;
export type TransitionKey = keyof typeof transitions;

export default {
  durations,
  easings,
  keyframes,
  animations,
  transitions,
  rnAnimationConfig,
};
