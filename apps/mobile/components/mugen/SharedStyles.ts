// ═══════════════════════════════════════════════════════════════════════════
// SharedStyles — Gojo theme palette + shared RN StyleSheets for Mugen UI.
// Consumed by PrivacyReceiptRN + TradeLifecycleCardRN + CopyLink.
// ═══════════════════════════════════════════════════════════════════════════

import { StyleSheet } from 'react-native';

export const GojoColors = {
  bg: '#050510',
  bgCard: 'rgba(255,255,255,0.03)',
  bgCardFilled: 'rgba(10,10,24,0.5)',
  violet: '#8b5cf6',
  violetLight: '#c4b5fd',
  blue: '#3b82f6',
  blueLight: '#93c5fd',
  white: '#ffffff',
  muted: '#71717a',
  mutedLight: '#8888aa',
  subtle: '#555570',
  success: '#10b981',
  successLight: '#86efac',
  error: '#ef4444',
  errorLight: '#fca5a5',
  warning: '#f59e0b',
  warningLight: '#fcd34d',
  text: '#d1d5db',
  border: 'rgba(139,92,246,0.2)',
  borderActive: 'rgba(139,92,246,0.5)',
  borderSubtle: 'rgba(255,255,255,0.12)',
  borderSuccess: 'rgba(34,197,94,0.4)',
  borderError: 'rgba(239,68,68,0.35)',
  borderWarning: 'rgba(245,158,11,0.3)',
} as const;

export const Mono = 'monospace';

export const Shared = StyleSheet.create({
  card: {
    backgroundColor: GojoColors.bgCard,
    borderWidth: 1,
    borderColor: GojoColors.border,
    borderRadius: 16,
    padding: 14,
  },
  sectionTitle: {
    color: GojoColors.white,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },
  mono: {
    fontFamily: Mono,
    color: GojoColors.text,
    fontSize: 11,
  },
  monoMuted: {
    fontFamily: Mono,
    color: GojoColors.mutedLight,
    fontSize: 11,
  },
  monoSmall: {
    fontFamily: Mono,
    color: GojoColors.text,
    fontSize: 10,
  },
  badgePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  primaryButtonText: {
    color: GojoColors.white,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  errorText: {
    color: GojoColors.errorLight,
    fontFamily: Mono,
    fontSize: 10,
  },
});
