/**
 * BleDeviceList — Shows discovered BLE peers for note sharing
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
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';
import type { PeerInfo } from '@/services/sharing/types';

interface Props {
  peers: PeerInfo[];
  isScanning: boolean;
  onSelectPeer: (peer: PeerInfo) => void;
  onRefresh: () => void;
}

function signalStrength(rssi?: number): { label: string; color: string; bars: number } {
  if (!rssi || rssi === 0) return { label: 'Unknown', color: Colors.textTertiary, bars: 0 };
  if (rssi > -50) return { label: 'Excellent', color: P01Colors.green, bars: 4 };
  if (rssi > -65) return { label: 'Good', color: P01Colors.cyan, bars: 3 };
  if (rssi > -80) return { label: 'Fair', color: P01Colors.yellow, bars: 2 };
  return { label: 'Weak', color: Colors.error, bars: 1 };
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
      >
        <View style={styles.peerIcon}>
          <Ionicons name="phone-portrait" size={20} color={P01Colors.cyan} />
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
        <Text style={styles.sectionTitle}>Nearby Devices</Text>
        {isScanning && (
          <View style={styles.scanningBadge}>
            <ActivityIndicator size="small" color={P01Colors.cyan} />
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
            <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh}>
              <Ionicons name="refresh" size={16} color={P01Colors.cyan} />
              <Text style={styles.refreshText}>Scan Again</Text>
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
  sectionTitle: { fontSize: 14, fontFamily: FontFamily.semibold, color: Colors.textSecondary },
  scanningBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scanningText: { fontSize: 12, fontFamily: FontFamily.medium, color: P01Colors.cyan },
  peerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  peerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P01Colors.cyanDim,
    justifyContent: 'center',
    alignItems: 'center',
  },
  peerInfo: { flex: 1 },
  peerName: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.text },
  peerSignal: { fontSize: 12, fontFamily: FontFamily.regular, marginTop: 2 },
  barsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginRight: 4 },
  bar: { width: 4, borderRadius: 1 },
  barActive: { backgroundColor: P01Colors.cyan },
  barInactive: { backgroundColor: Colors.border },
  separator: { height: Spacing.sm },
  emptyState: { alignItems: 'center', paddingVertical: Spacing.xl * 2, gap: Spacing.md },
  emptyTitle: { fontSize: 15, fontFamily: FontFamily.semibold, color: Colors.textSecondary },
  emptyHint: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textTertiary,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: BorderRadius.md,
    backgroundColor: P01Colors.cyanDim,
    marginTop: Spacing.sm,
  },
  refreshText: { fontSize: 13, fontFamily: FontFamily.medium, color: P01Colors.cyan },
});
