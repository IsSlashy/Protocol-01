/**
 * RelayerHealthDot — a discrete traffic-light dot for privacy-relayer health.
 * Green = a relayer is healthy, Orange = degraded/slow, Red = all down.
 * Tap for a per-relayer breakdown. Placed in the Privacy dashboard header.
 */
import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { p01Alert } from '@/stores/alertStore';
import { useRelayerHealth, type RelayerStatusLevel } from '@/services/relayer/health';

const DOT_COLOR: Record<RelayerStatusLevel | 'unknown', string> = {
  green: '#39c5bb',
  orange: '#f5a623',
  red: '#ff3b3b',
  unknown: '#555560',
};

export function RelayerHealthDot() {
  const health = useRelayerHealth();
  const level: RelayerStatusLevel | 'unknown' = health?.status ?? 'unknown';
  const color = DOT_COLOR[level];

  const onPress = () => {
    if (!health) {
      p01Alert('Relay', 'Checking relayer status…', [{ text: 'OK' }], 'info');
      return;
    }
    const lines = health.relayers
      .map((r) => {
        const age = r.lastPollAgeMs != null ? ` · ${Math.round(r.lastPollAgeMs / 1000)}s ago` : '';
        const err = r.lastError ? `\n   ${r.lastError.slice(0, 60)}` : '';
        return `${r.label}: ${r.state}${age}${err}`;
      })
      .join('\n');
    const title =
      health.status === 'green' ? 'Privacy relay: healthy'
      : health.status === 'orange' ? 'Privacy relay: degraded'
      : 'Privacy relay: down';
    const icon = health.status === 'green' ? 'success' : health.status === 'orange' ? 'warning' : 'error';
    p01Alert(title, lines, [{ text: 'OK' }], icon as any);
  };

  return (
    <TouchableOpacity
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityRole="button"
      accessibilityLabel={`Privacy relay status: ${level}`}
      style={{ paddingHorizontal: 2 }}
    >
      <View
        style={{
          width: 9,
          height: 9,
          borderRadius: 5,
          backgroundColor: color,
          shadowColor: color,
          shadowOpacity: 0.85,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 0 },
        }}
      />
    </TouchableOpacity>
  );
}

export default RelayerHealthDot;
