// Shared progress bar for long-running ZK operations (shield/unshield/subscribe/cancel).
//
// 🎯 RETUNED 2026-08-23. Three things were off the system:
//   - the track was `rgba(0,224,255,0.12)`, a neon cyan that appears nowhere in
//     `constants/theme.ts` and nowhere on the site. The fill and the track were
//     therefore two different cyans, one of them invented here.
//   - the sticky bar was a filled cyan panel inside a solid cyan border, which
//     made a progress indicator the loudest element on a screen the user is
//     waiting on. It is a panel with a hairline rule now, and the accent is
//     carried by the spinner and the bar.
//   - the status line was set in mono. Mono is for addresses, hashes and
//     amounts; a sentence in mono reads as machine output, not as an update.
//     The counter stays mono, because it is a number that ticks.
//   - the cancel control was a 28pt target. It is 44.
import React from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

export interface OperationProgressBarProps {
  progress: string | null;
  variant?: 'inline' | 'sticky';
  onCancel?: () => void;
  step?: { current: number; total: number };
  showKeepOpenWarning?: boolean;
}

export function OperationProgressBar({
  progress,
  variant = 'inline',
  onCancel,
  step,
  showKeepOpenWarning,
}: OperationProgressBarProps) {
  const text = progress || '';
  const batchMatch = text.match(/batch\s+(\d+)\s*\/\s*(\d+)/i);
  // Resize emits `Resizing proof buffer (X/Y)...` — same pattern, different verb.
  const resizeXYMatch = text.match(/resiz[a-z]*\s+[^()]*\((\d+)\s*\/\s*(\d+)\)/i);
  const provingMatch = text.match(/proof|commitment|STARK/i);

  let current = 0;
  let total = 0;
  let label = text;

  if (batchMatch) {
    current = parseInt(batchMatch[1], 10);
    total = parseInt(batchMatch[2], 10);
    label = `Uploading proof · batch ${current}/${total}`;
  } else if (resizeXYMatch) {
    current = parseInt(resizeXYMatch[1], 10);
    total = parseInt(resizeXYMatch[2], 10);
    label = `Resizing proof buffer · ${current}/${total}`;
  } else if (provingMatch) {
    label = text;
  }

  if (step) {
    label = `Step ${step.current}/${step.total} · ${label}`;
  }

  // Bar fill: interpolate batch X/Y inside the current step's range so the
  // fill advances smoothly across long sub-phases (e.g. 11-tx resize bursts,
  // N-batch proof uploads). Falls back to coarse step.current/step.total
  // when no sub-progress is parsed, and to an 8% idle hint when neither is
  // available but a status string is present.
  let pct = 0;
  if (step && total > 0) {
    const stepSpan = 100 / step.total;
    const stepStart = (step.current - 1) * stepSpan;
    pct = Math.min(100, Math.round(stepStart + (current / total) * stepSpan));
  } else if (total > 0) {
    pct = Math.min(100, Math.round((current / total) * 100));
  } else if (step) {
    pct = Math.min(100, Math.round((step.current / step.total) * 100));
  } else if (text) {
    pct = 8;
  }

  const fill = (
    <View style={st.progressWrap}>
      <View style={st.progressRow}>
        <Text style={st.progressLabel} numberOfLines={1}>{label}</Text>
        {total > 0 && <Text style={st.progressCount}>{current}/{total}</Text>}
      </View>
      <View style={st.progressTrack}>
        <View style={[st.progressFill, { width: `${pct}%` }]} />
      </View>
    </View>
  );

  if (variant === 'sticky') {
    return (
      <View>
        <View style={st.stickyProgress}>
          <ActivityIndicator size="small" color={Colors.primary} />
          <Text style={st.stickyProgressText} numberOfLines={2}>{label}</Text>
          {onCancel && (
            <TouchableOpacity
              style={st.stickyCancel}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel stuck operation"
            >
              <Ionicons name="close" size={16} color={Colors.text} />
            </TouchableOpacity>
          )}
        </View>
        {fill}
        {showKeepOpenWarning && (
          <Text style={st.keepOpenWarning}>Don't close the app until this completes.</Text>
        )}
      </View>
    );
  }

  return fill;
}

const st = StyleSheet.create({
  stickyProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    gap: Spacing.sm,
  },
  stickyProgressText: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.sm,
    fontFamily: FontFamily.medium,
  },
  stickyCancel: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  progressWrap: { marginTop: Spacing.md, paddingHorizontal: 2 },
  progressRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 6,
  },
  progressLabel: {
    flex: 1, fontSize: FontSize.xs, fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  progressCount: {
    fontSize: FontSize.xs, fontFamily: FontFamily.monoMedium,
    color: Colors.primary, marginLeft: Spacing.sm,
  },
  progressTrack: {
    height: 3, borderRadius: 2, overflow: 'hidden',
    backgroundColor: Colors.borderSoft,
  },
  progressFill: {
    height: '100%', backgroundColor: Colors.primary, borderRadius: 2,
  },
  keepOpenWarning: {
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.xs,
    fontSize: FontSize.xs,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
  },
});

export default OperationProgressBar;
