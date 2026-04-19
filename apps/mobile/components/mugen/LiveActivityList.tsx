// ═══════════════════════════════════════════════════════════════════════════
// LiveActivityList — renders the result of listPrivateMatches() as a
// scrollable feed of on-chain MugenReputation commitment PDAs. Pure view
// component; parent owns the fetching + refresh lifecycle.
// ═══════════════════════════════════════════════════════════════════════════

import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import CopyLink from './CopyLink';
import { GojoColors, Mono } from './SharedStyles';
import type { PrivateMatchReceipt } from '../../services/mugen-encrypted/types';

export interface LiveActivityListProps {
  matches: PrivateMatchReceipt[];
  loading: boolean;
  error: string | null;
}

function commitmentPrefix(raw: string | undefined): string {
  if (!raw) return '—';
  return raw.length <= 10 ? raw : `${raw.slice(0, 10)}…`;
}

function timeAgo(tsSeconds: number, nowMs: number): string {
  if (!tsSeconds) return '—';
  const ms = tsSeconds < 1e12 ? tsSeconds * 1000 : tsSeconds;
  const diff = Math.max(0, nowMs - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function LiveActivityList({
  matches,
  loading,
  error,
}: LiveActivityListProps): React.ReactElement {
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <MaterialIcons name="sensors" size={14} color={GojoColors.violetLight} />
        <Text style={styles.headerText}>LIVE ON-CHAIN ACTIVITY</Text>
        {loading ? (
          <ActivityIndicator size="small" color={GojoColors.violetLight} />
        ) : (
          <Text style={styles.counter}>{matches.length}</Text>
        )}
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <MaterialIcons name="error-outline" size={12} color={GojoColors.errorLight} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {!loading && matches.length === 0 && !error ? (
        <Text style={styles.emptyText}>
          no private matches yet — submit or take an encrypted offer to seed the feed
        </Text>
      ) : null}

      {matches.map((m, i) => {
        const key =
          m.txSignature ??
          m.escrowPDA ??
          `${m.makerNoncePubkey ?? 'nil'}-${m.takerNoncePubkey ?? 'nil'}-${i}`;
        const commit = commitmentPrefix(
          m.escrowPDA ?? m.makerNoncePubkey ?? m.takerNoncePubkey,
        );
        return (
          <View key={key} style={styles.row}>
            <View style={styles.rowTop}>
              <View style={styles.dot} />
              <Text style={styles.commitText}>{commit}</Text>
              <Text style={styles.timeText}>{timeAgo(m.matchedAt, nowMs)}</Text>
            </View>
            <View style={styles.rowBody}>
              {m.escrowPDA ? (
                <View style={styles.kvRow}>
                  <Text style={styles.kvLabel}>escrow:</Text>
                  <CopyLink value={m.escrowPDA} type="address" label="escrow PDA" />
                </View>
              ) : null}
              {m.txSignature ? (
                <View style={styles.kvRow}>
                  <Text style={styles.kvLabel}>tx:</Text>
                  <CopyLink value={m.txSignature} type="tx" label="match tx" />
                </View>
              ) : null}
              {m.status ? (
                <Text style={styles.statusText}>status · {m.status.replace('_', ' ')}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerText: {
    color: GojoColors.violetLight,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    flex: 1,
  },
  counter: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.mutedLight,
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: GojoColors.borderError,
    backgroundColor: 'rgba(239,68,68,0.08)',
  },
  errorText: {
    flex: 1,
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.errorLight,
  },
  emptyText: {
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.mutedLight,
    padding: 10,
    textAlign: 'center',
  },
  row: {
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: GojoColors.border,
    backgroundColor: GojoColors.bgCardFilled,
    gap: 6,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: GojoColors.successLight,
  },
  commitText: {
    flex: 1,
    fontFamily: Mono,
    fontSize: 11,
    color: GojoColors.violetLight,
  },
  timeText: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.mutedLight,
  },
  rowBody: {
    gap: 4,
  },
  kvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  kvLabel: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.mutedLight,
  },
  statusText: {
    fontFamily: Mono,
    fontSize: 10,
    color: GojoColors.blueLight,
  },
});
