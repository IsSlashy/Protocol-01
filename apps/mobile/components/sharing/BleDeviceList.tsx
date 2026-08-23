/**
 * BleDeviceList — the nearby devices a note can be sent to.
 *
 * 🎯 REALIGNED ON constants/theme.ts 2026-08-23.
 *
 * ⛔ THE SIGNAL RAMP WAS FOUR COLOURS: a green for Excellent, cyan for Good,
 * amber for Fair and red for Weak. Three of those are accents spent on a number
 * that changes when the user's hand moves, and the amber is the caution colour —
 * so a perfectly workable link rendered in the same colour as a warning. The
 * BARS carry strength; the label only turns amber when the link is weak enough
 * to actually be the reason a transfer fails.
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';
import type { PeerInfo } from '@/services/sharing/types';

interface Props {
  peers: PeerInfo[];
  isScanning: boolean;
  onSelectPeer: (peer: PeerInfo) => void;
  onRefresh: () => void;
}

function signalStrength(rssi?: number): { label: string; color: string; bars: number } {
  if (!rssi || rssi === 0) return { label: 'Unknown', color: Colors.textTertiary, bars: 0 };
  if (rssi > -50) return { label: 'Excellent', color: Colors.textSecondary, bars: 4 };
  if (rssi > -65) return { label: 'Good', color: Colors.textSecondary, bars: 3 };
  if (rssi > -80) return { label: 'Fair', color: Colors.textSecondary, bars: 2 };
  return { label: 'Weak', color: Colors.warning, bars: 1 };
}

function SignalBars({ bars }: { bars: number }) {
  return (
    <View style={styles.barsRow}>
      {[1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={[
            styles.bar,
            { height: 4 + i * 3 },
            i <= bars ? styles.barActive : styles.barInactive,
          ]}
        />
      ))}
    </View>
  );
}

export default function BleDeviceList({ peers, isScanning, onSelectPeer, onRefresh }: Props) {
  const renderPeer = ({ item }: { item: PeerInfo }) => {
    const signal = signalStrength(item.rssi);
    return (
      <TouchableOpacity
        style={styles.peerCard}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onSelectPeer(item);
        }}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Send to ${item.displayName || 'P01 Device'}, signal ${signal.label}`}
      >
        <View style={styles.peerIcon}>
          <Ionicons name="phone-portrait-outline" size={20} color={Colors.textSecondary} />
        </View>
        <View style={styles.peerInfo}>
          <Text style={styles.peerName}>
            {item.displayName || 'P01 Device'}
          </Text>
          <Text style={[styles.peerSignal, { color: signal.color }]}>
            {signal.label}
            {item.rssi ? ` (${item.rssi} dBm)` : ''}
          </Text>
        </View>
        <SignalBars bars={signal.bars} />
        <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>Nearby devices</Text>
        {isScanning && (
          <View style={styles.scanningBadge}>
            <ActivityIndicator size="small" color={Colors.primary} />
            <Text style={styles.scanningText}>Scanning...</Text>
          </View>
        )}
      </View>

      {peers.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="bluetooth" size={40} color={Colors.textTertiary} />
          <Text style={styles.emptyTitle}>
            {isScanning ? 'Looking for nearby P01 users...' : 'No devices found'}
          </Text>
          <Text style={styles.emptyHint}>
            Make sure the other device has P01 open with Bluetooth sharing active.
          </Text>
          {!isScanning && (
            <TouchableOpacity
              style={styles.refreshBtn}
              onPress={onRefresh}
              accessibilityRole="button"
              accessibilityLabel="Scan again"
            >
              <Ionicons name="refresh" size={16} color={Colors.primary} />
              <Text style={styles.refreshText}>Scan again</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={peers}
          renderItem={renderPeer}
          keyExtractor={(item) => item.id}
          scrollEnabled={false}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: Spacing.lg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.textSecondary,
  },
  scanningBadge: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  scanningText: {
    fontSize: FontSize.xs, fontFamily: FontFamily.regular, color: Colors.textSecondary,
  },
  peerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    minHeight: 64,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
  },
  peerIcon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceTertiary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  peerInfo: { flex: 1 },
  peerName: { fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.text },
  peerSignal: { fontSize: FontSize.xs, fontFamily: FontFamily.regular, marginTop: 2 },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginRight: 4 },
  bar: { width: 4, borderRadius: 1 },
  barActive: { backgroundColor: Colors.primary },
  barInactive: { backgroundColor: Colors.border },
  separator: { height: Spacing.sm },
  emptyState: { alignItems: 'center', paddingVertical: Spacing['4xl'], gap: Spacing.md },
  emptyTitle: {
    fontSize: FontSize.lg, fontFamily: FontFamily.displayMedium,
    color: Colors.text, textAlign: 'center',
  },
  emptyHint: {
    fontSize: FontSize.sm,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: Spacing.xl,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    paddingHorizontal: Spacing.lg,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: Spacing.sm,
  },
  refreshText: { fontSize: FontSize.sm, fontFamily: FontFamily.medium, color: Colors.primary },
});
