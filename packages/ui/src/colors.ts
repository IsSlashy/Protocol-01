/**
 * Protocol 01 (P-01) Design System
 * Cyberpunk-inspired theme with cyan/pink accent colors
 *
 * Inspired by:
 * - Hatsune Miku (cyan turquoise)
 * - NEEDY STREAMER OVERLOAD / KAngel (pink neon, internet aesthetic)
 * - ULTRAKILL (brutal red accents)
 *
 * RULES:
 * - NO purple colors anywhere
 * - NO black text (use white/muted/dim)
 * - NO green #00ff88 (old Specter green)
 */

export const colors = {
  // ═══════════════════════════════════════════════════════════════
  // BACKGROUNDS - Deep dark layers (P-01 Void)
  // ═══════════════════════════════════════════════════════════════
  void: '#0a0a0c',
  dark: '#0f0f12',
  surface: '#151518',
  surface2: '#1a1a1e',
  surface3: '#25252b',
  elevated: '#1f1f24',

  // ═══════════════════════════════════════════════════════════════
  // BORDERS - Subtle separators
  // ═══════════════════════════════════════════════════════════════
  border: '#2a2a30',
  borderLight: '#3a3a42',
  borderHover: '#3a3a42',
  borderFocus: '#39c5bb',

  // ═══════════════════════════════════════════════════════════════
  // PRIMARY - P-01 Cyan (Miku inspired)
  // ═══════════════════════════════════════════════════════════════
  cyan: '#39c5bb',
  cyanDim: '#2a9d95',
  cyanBright: '#00ffe5',
  cyanGlow: 'rgba(57, 197, 187, 0.15)',
  cyanGlow2: 'rgba(57, 197, 187, 0.3)',
  cyanGlow3: 'rgba(57, 197, 187, 0.5)',

  // Aliases for shadow/glow system (maps to cyan primary)
  green: '#39c5bb',
  greenDim: '#2a9d95',
  greenDark: '#1e8a82',
  greenGlow: 'rgba(57, 197, 187, 0.15)',
  greenGlow2: 'rgba(57, 197, 187, 0.3)',

  // ═══════════════════════════════════════════════════════════════
  // SECONDARY - P-01 Pink (KAngel inspired)
  // ═══════════════════════════════════════════════════════════════
  pink: '#ff77a8',
  pinkHot: '#ff2d7a',
  pinkLight: '#ff9dc4',
  pinkGlow: 'rgba(255, 119, 168, 0.15)',
  pinkGlow2: 'rgba(255, 119, 168, 0.3)',

  // ═══════════════════════════════════════════════════════════════
  // ACCENT COLORS
  // ═══════════════════════════════════════════════════════════════
  yellow: '#ffcc00',
  yellowDim: '#cc9900',
  yellowGlow: 'rgba(255, 204, 0, 0.15)',

  red: '#ff3366',
  redDim: '#cc2952',
  redGlow: 'rgba(255, 51, 102, 0.15)',

  blue: '#3b82f6',
  blueDim: '#2563eb',
  blueGlow: 'rgba(59, 130, 246, 0.15)',

  chrome: '#c0c0c8',

  // ═══════════════════════════════════════════════════════════════
  // MODULE COLORS - Distinct identity per module
  // ═══════════════════════════════════════════════════════════════
  wallet: '#39c5bb',      // Cyan - Financial
  walletGlow: 'rgba(57, 197, 187, 0.2)',

  streams: '#ff77a8',     // Pink - Flow & movement
  streamsGlow: 'rgba(255, 119, 168, 0.2)',

  social: '#00ffe5',      // Bright Cyan - Connection
  socialGlow: 'rgba(0, 255, 229, 0.2)',

  agent: '#ffcc00',       // Yellow - Intelligence
  agentGlow: 'rgba(255, 204, 0, 0.2)',

  // ═══════════════════════════════════════════════════════════════
  // STATUS COLORS - Semantic feedback (cyan for success, NOT green)
  // ═══════════════════════════════════════════════════════════════
  success: '#39c5bb',
  successDim: '#2a9d95',
  successGlow: 'rgba(57, 197, 187, 0.2)',

  error: '#ff3366',
  errorDim: '#cc2952',
  errorGlow: 'rgba(255, 51, 102, 0.2)',

  warning: '#ffcc00',
  warningDim: '#cc9900',
  warningGlow: 'rgba(255, 204, 0, 0.2)',

  info: '#39c5bb',
  infoDim: '#2a9d95',
  infoGlow: 'rgba(57, 197, 187, 0.2)',

  // ═══════════════════════════════════════════════════════════════
  // TEXT COLORS - Hierarchy (NO black text)
  // ═══════════════════════════════════════════════════════════════
  text: '#ffffff',
  textSecondary: '#888892',
  textMuted: '#555560',
  textDim: '#555560',
  textDisabled: '#3a3a40',

  // ═══════════════════════════════════════════════════════════════
  // OVERLAY COLORS - For modals, toasts, etc.
  // ═══════════════════════════════════════════════════════════════
  overlay: 'rgba(10, 10, 12, 0.9)',
  overlayLight: 'rgba(10, 10, 12, 0.7)',
  overlayDark: 'rgba(10, 10, 12, 0.95)',

  // ═══════════════════════════════════════════════════════════════
  // UTILITY COLORS
  // ═══════════════════════════════════════════════════════════════
  black: '#000000',
  transparent: 'transparent',
  white: '#ffffff',
  whiteAlpha10: 'rgba(255, 255, 255, 0.1)',
  whiteAlpha20: 'rgba(255, 255, 255, 0.2)',
} as const;

// Gradients
export const gradients = {
  primary: ['#39c5bb', '#00ffe5'] as const,
  secondary: ['#ff77a8', '#ff2d7a'] as const,
  p01: ['#39c5bb', '#ff77a8'] as const,
  accent: ['#ffcc00', '#ff9900'] as const,
  success: ['#39c5bb', '#2a9d95'] as const,
  error: ['#ff3366', '#cc2952'] as const,
  dark: ['#0f0f12', '#0a0a0c'] as const,
  card: ['rgba(57, 197, 187, 0.1)', 'rgba(255, 119, 168, 0.1)'] as const,
} as const;

// Type exports
export type ColorKey = keyof typeof colors;
export type ColorValue = (typeof colors)[ColorKey];

// Helper to get module color
export const getModuleColor = (module: 'wallet' | 'streams' | 'social' | 'agent') => ({
  primary: colors[module],
  glow: colors[`${module}Glow` as keyof typeof colors],
});

// Helper to get status color
export const getStatusColor = (status: 'success' | 'error' | 'warning' | 'info') => ({
  primary: colors[status],
  dim: colors[`${status}Dim` as keyof typeof colors],
  glow: colors[`${status}Glow` as keyof typeof colors],
});

export default colors;
