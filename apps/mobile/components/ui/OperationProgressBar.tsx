// Shared progress bar for long-running ZK operations (shield/unshield/subscribe/cancel).
import React from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, P01Colors, Spacing, FontFamily } from '@/constants/theme';

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
          <ActivityIndicator size="small" color={P01Colors.cyan} />
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
    borderRadius: 12,
    backgroundColor: 'rgba(57, 197, 187, 0.15)',
    borderWidth: 1,
    borderColor: P01Colors.cyan,
    gap: Spacing.sm,
  },
  stickyProgressText: {
    flex: 1,
    color: Colors.text,
    fontSize: 13,
    fontFamily: FontFamily.medium,
  },
  stickyCancel: {
    width: 28,
    height: 28,
    borderRadius: 9999,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  progressWrap: { marginTop: 12, paddingHorizontal: 2 },
  progressRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 6,
  },
  progressLabel: {
    flex: 1, fontSize: 11, fontFamily: FontFamily.mono,
    color: Colors.textSecondary, letterSpacing: 0.3,
  },
  progressCount: {
    fontSize: 11, fontFamily: FontFamily.bold,
    color: P01Colors.cyan, marginLeft: 8,
  },
  progressTrack: {
    height: 4, borderRadius: 2, overflow: 'hidden',
    backgroundColor: 'rgba(0,224,255,0.12)',
  },
  progressFill: {
    height: '100%', backgroundColor: P01Colors.cyan, borderRadius: 2,
  },
  keepOpenWarning: {
    marginHorizontal: Spacing.xl,
    marginTop: 4,
    fontSize: 11,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
  },
});

export default OperationProgressBar;
