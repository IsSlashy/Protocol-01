/**
 * Specter Protocol Shadow & Glow System
 * Neon glow effects for the ultra dark theme
 */

import { colors } from './colors';

// ═══════════════════════════════════════════════════════════════
// STANDARD SHADOWS - Elevation system
// ═══════════════════════════════════════════════════════════════
export const shadows = {
  none: 'none',

  // Subtle elevation
  xs: '0 1px 2px rgba(0, 0, 0, 0.5)',
  sm: '0 2px 4px rgba(0, 0, 0, 0.5)',

  // Medium elevation
  md: '0 4px 8px rgba(0, 0, 0, 0.6)',
  lg: '0 8px 16px rgba(0, 0, 0, 0.6)',

  // High elevation
  xl: '0 12px 24px rgba(0, 0, 0, 0.7)',
  '2xl': '0 24px 48px rgba(0, 0, 0, 0.8)',

  // Inner shadows
  inner: 'inset 0 2px 4px rgba(0, 0, 0, 0.5)',
  innerLg: 'inset 0 4px 8px rgba(0, 0, 0, 0.6)',
} as const;

// ═══════════════════════════════════════════════════════════════
// GLOW EFFECTS - Neon aesthetic
// ═══════════════════════════════════════════════════════════════
export const glows = {
  // Green (Primary/Success/Wallet)
  green: `0 0 20px ${colors.greenGlow}, 0 0 40px ${colors.greenGlow}`,
  greenSm: `0 0 10px ${colors.greenGlow}`,
  greenLg: `0 0 30px ${colors.greenGlow2}, 0 0 60px ${colors.greenGlow}`,
  greenIntense: `0 0 20px ${colors.greenGlow2}, 0 0 40px ${colors.greenGlow2}, 0 0 60px ${colors.greenGlow}`,

  // Purple (Streams)
  purple: `0 0 20px ${colors.streamsGlow}, 0 0 40px ${colors.streamsGlow}`,
  purpleSm: `0 0 10px ${colors.streamsGlow}`,
  purpleLg: `0 0 30px rgba(139, 92, 246, 0.3), 0 0 60px ${colors.streamsGlow}`,

  // Blue (Social)
  blue: `0 0 20px ${colors.socialGlow}, 0 0 40px ${colors.socialGlow}`,
  blueSm: `0 0 10px ${colors.socialGlow}`,
  blueLg: `0 0 30px rgba(59, 130, 246, 0.3), 0 0 60px ${colors.socialGlow}`,

  // Amber (Agent)
  amber: `0 0 20px ${colors.agentGlow}, 0 0 40px ${colors.agentGlow}`,
  amberSm: `0 0 10px ${colors.agentGlow}`,
  amberLg: `0 0 30px rgba(245, 158, 11, 0.3), 0 0 60px ${colors.agentGlow}`,

  // Red (Error/Danger)
  red: `0 0 20px ${colors.errorGlow}, 0 0 40px ${colors.errorGlow}`,
  redSm: `0 0 10px ${colors.errorGlow}`,
  redLg: `0 0 30px rgba(239, 68, 68, 0.3), 0 0 60px ${colors.errorGlow}`,

  // White (Neutral highlight)
  white: '0 0 20px rgba(255, 255, 255, 0.1), 0 0 40px rgba(255, 255, 255, 0.05)',
  whiteSm: '0 0 10px rgba(255, 255, 255, 0.1)',
} as const;

// ═══════════════════════════════════════════════════════════════
// TEXT GLOWS - For glowing text effects
// ═══════════════════════════════════════════════════════════════
export const textGlows = {
  green: `0 0 10px ${colors.greenGlow2}, 0 0 20px ${colors.greenGlow}`,
  greenIntense: `0 0 10px ${colors.green}, 0 0 20px ${colors.greenGlow2}, 0 0 40px ${colors.greenGlow}`,
  purple: `0 0 10px rgba(139, 92, 246, 0.5), 0 0 20px ${colors.streamsGlow}`,
  blue: `0 0 10px rgba(59, 130, 246, 0.5), 0 0 20px ${colors.socialGlow}`,
  amber: `0 0 10px rgba(245, 158, 11, 0.5), 0 0 20px ${colors.agentGlow}`,
  red: `0 0 10px rgba(239, 68, 68, 0.5), 0 0 20px ${colors.errorGlow}`,
  white: '0 0 10px rgba(255, 255, 255, 0.3), 0 0 20px rgba(255, 255, 255, 0.1)',
} as const;

// ═══════════════════════════════════════════════════════════════
// BORDER GLOWS - For glowing borders
// ═══════════════════════════════════════════════════════════════
export const borderGlows = {
  green: `0 0 0 1px ${colors.green}, ${glows.greenSm}`,
  greenFocus: `0 0 0 2px ${colors.green}, ${glows.green}`,
  purple: `0 0 0 1px ${colors.streams}, ${glows.purpleSm}`,
  purpleFocus: `0 0 0 2px ${colors.streams}, ${glows.purple}`,
  blue: `0 0 0 1px ${colors.social}, ${glows.blueSm}`,
  blueFocus: `0 0 0 2px ${colors.social}, ${glows.blue}`,
  amber: `0 0 0 1px ${colors.agent}, ${glows.amberSm}`,
  amberFocus: `0 0 0 2px ${colors.agent}, ${glows.amber}`,
  red: `0 0 0 1px ${colors.error}, ${glows.redSm}`,
  redFocus: `0 0 0 2px ${colors.error}, ${glows.red}`,
} as const;

// ═══════════════════════════════════════════════════════════════
// GLASS EFFECTS - Glassmorphism for cards
// ═══════════════════════════════════════════════════════════════
export const glass = {
  // Standard glass card
  card: {
    background: 'rgba(17, 17, 17, 0.8)',
    backdropFilter: 'blur(12px)',
    border: `1px solid ${colors.border}`,
  },

  // Elevated glass
  cardElevated: {
    background: 'rgba(26, 26, 26, 0.9)',
    backdropFilter: 'blur(16px)',
    border: `1px solid ${colors.borderLight}`,
    boxShadow: shadows.lg,
  },

  // Subtle glass
  cardSubtle: {
    background: 'rgba(17, 17, 17, 0.6)',
    backdropFilter: 'blur(8px)',
    border: `1px solid rgba(42, 42, 42, 0.5)`,
  },

  // Modal glass
  modal: {
    background: 'rgba(17, 17, 17, 0.95)',
    backdropFilter: 'blur(20px)',
    border: `1px solid ${colors.border}`,
    boxShadow: shadows['2xl'],
  },

  // Header/Footer glass
  header: {
    background: 'rgba(10, 10, 10, 0.85)',
    backdropFilter: 'blur(12px)',
    borderBottom: `1px solid ${colors.border}`,
  },
} as const;

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Get glow by module color
 */
export const getModuleGlow = (module: 'wallet' | 'streams' | 'social' | 'agent') => {
  const map = {
    wallet: { sm: glows.greenSm, md: glows.green, lg: glows.greenLg },
    streams: { sm: glows.purpleSm, md: glows.purple, lg: glows.purpleLg },
    social: { sm: glows.blueSm, md: glows.blue, lg: glows.blueLg },
    agent: { sm: glows.amberSm, md: glows.amber, lg: glows.amberLg },
  };
  return map[module];
};

/**
 * Get status glow
 */
export const getStatusGlow = (status: 'success' | 'error' | 'warning' | 'info') => {
  const map = {
    success: glows.green,
    error: glows.red,
    warning: glows.amber,
    info: glows.blue,
  };
  return map[status];
};

// Type exports
export type ShadowKey = keyof typeof shadows;
export type GlowKey = keyof typeof glows;
export type TextGlowKey = keyof typeof textGlows;
export type GlassKey = keyof typeof glass;

export default {
  shadows,
  glows,
  textGlows,
  borderGlows,
  glass,
  getModuleGlow,
  getStatusGlow,
};
