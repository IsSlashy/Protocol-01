/**
 * StreamCard — one payment stream, as a card.
 *
 * 🎯 REBUILT IN StyleSheet ON THE REALIGNED THEME 2026-08-23.
 *
 * 🚨 THIS FILE WAS THE PINK MODULE IN MINIATURE. It declared its own accent at
 * the top (`ACCENT_PINK`), its own three-colour status table with `rgba` fills,
 * its own `P01_CYAN`/`P01_YELLOW`/`P01_RED` constants — a fourth copy of the
 * palette — and painted the whole card, the progress bar, the icon disc, the
 * private badge and the pause button in it. On top of that it laid a cyan
 * drop shadow on the card, a second glow under the progress fill, a scale
 * bounce on the amount every second and a pulsing dot beside the rate.
 *
 * It also mixed two styling systems: half utility classes (`text-white`,
 * `text-p01-text-secondary`), half inline objects. This app styles in
 * `StyleSheet.create`, so the classes were the half that could not be retuned
 * by a theme change.
 *
 * What is left: a flat panel, one accent, tabular amounts, and a status pill
 * that uses the shared `Badge` rather than a fourth private colour table.
 *
 * ⚠️ Props and the exported `StreamData` shape are unchanged.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { StreamingIndicator } from './StreamingIndicator';
import { Colors, FontFamily, FontSize, BorderRadius, Spacing } from '@/constants/theme';

type StreamStatus = 'active' | 'paused' | 'completed' | 'cancelled';

export interface StreamData {
  id: string;
  name: string;
  recipient?: {
    name: string;
    address: string;
    avatar?: string;
  };
  sender?: {
    name: string;
    address: string;
    avatar?: string;
  };
  totalAmount: number;
  streamedAmount: number;
  token: string;
  symbol: string;
  startTime: Date;
  endTime: Date;
  startDate?: Date;
  endDate?: Date;
  status: StreamStatus;
  ratePerSecond?: number;
  rate?: number; // per day
  isPrivate: boolean;
  direction: 'outgoing' | 'incoming';
}

interface StreamCardProps {
  stream: StreamData;
  onPress?: () => void;
  onPause?: () => void;
  onCancel?: () => void;
}

/** Four states, four tones. No fifth colour, no fourth copy of the palette. */
const STATUS: Record<StreamStatus, { tone: 'good' | 'warn' | 'neutral' | 'bad'; label: string }> = {
  active: { tone: 'good', label: 'Active' },
  paused: { tone: 'warn', label: 'Paused' },
  completed: { tone: 'neutral', label: 'Completed' },
  cancelled: { tone: 'bad', label: 'Stopped' },
};

export const StreamCard: React.FC<StreamCardProps> = ({
  stream,
  onPress,
  onPause,
  onCancel,
}) => {
  const router = useRouter();
  const progressAnim = useRef(new Animated.Value(0)).current;
  const [currentAmount, setCurrentAmount] = useState(stream.streamedAmount);

  const startDate = stream.startDate || stream.startTime;
  const endDate = stream.endDate || stream.endTime;
  const symbol = stream.symbol || stream.token;
  const ratePerSecond = stream.ratePerSecond || (stream.rate ? stream.rate / (24 * 60 * 60) : 0);

  const progress = Math.min((currentAmount / stream.totalAmount) * 100, 100);
  const remaining = stream.totalAmount - currentAmount;
  const statusInfo = STATUS[stream.status];
  const isActive = stream.status === 'active';

  const formatDuration = (start: Date, end: Date): string => {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  const formatTimeRemaining = (end: Date): string => {
    const now = new Date();
    const diff = new Date(end).getTime() - now.getTime();
    if (diff <= 0) return 'Completed';
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (days > 0) return `${days}d ${hours}h left`;
    if (hours > 0) return `${hours}h ${minutes}m left`;
    return `${minutes}m left`;
  };

  const formatAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

  // The counter ticks. ⛔ It no longer bounces: a number that changes SIZE
  // every second is unreadable, and the reader is trying to read a balance.
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      setCurrentAmount((prev) => Math.min(prev + ratePerSecond, stream.totalAmount));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive, ratePerSecond, stream.totalAmount]);

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: progress,
      duration: 800,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else {
      router.push(`/(main)/(streams)/${stream.id}`);
    }
  };

  const displayPerson = stream.direction === 'outgoing' ? stream.recipient : stream.sender;
  const counterparty = displayPerson?.address ? formatAddress(displayPerson.address) : 'Unknown';

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${stream.name}, ${statusInfo.label}`}
    >
      <Card variant="glass" padding="md" style={st.card}>
        {/* Header */}
        <View style={st.head}>
          <View style={st.headLeft}>
            <View style={st.icon}>
              <Ionicons
                name={stream.direction === 'outgoing' ? 'arrow-up' : 'arrow-down'}
                size={18}
                color={Colors.primary}
              />
            </View>
            <View style={st.headText}>
              <Text style={st.name} numberOfLines={1}>{stream.name}</Text>
              <Text style={st.counterparty} numberOfLines={1}>
                {stream.direction === 'outgoing' ? `To ${counterparty}` : `From ${counterparty}`}
              </Text>
            </View>
          </View>

          <View style={st.headRight}>
            {stream.isPrivate && <Badge variant="good" size="sm">Private</Badge>}
            {isActive && <StreamingIndicator size="sm" label="" />}
          </View>
        </View>

        {/* Progress */}
        <View style={st.progressBlock}>
          <View style={st.rowBetween}>
            <Text style={st.dim}>Progress</Text>
            <Text style={st.mono}>{progress.toFixed(1)}%</Text>
          </View>
          <View style={st.progressTrack}>
            <Animated.View style={[st.progressFill, { width: progressWidth }]} />
          </View>
        </View>

        {/* Amounts */}
        <View style={st.amountsRow}>
          <View style={st.amountCell}>
            <Text style={st.dim}>Streamed</Text>
            <Text style={st.amountAccent}>
              {currentAmount.toFixed(4)} {symbol}
            </Text>
          </View>
          <View style={st.amountCellCenter}>
            <Text style={st.dim}>Rate</Text>
            <Text style={st.mono}>{ratePerSecond.toFixed(6)}/s</Text>
          </View>
          <View style={st.amountCellEnd}>
            <Text style={st.dim}>Remaining</Text>
            <Text style={st.mono}>
              {remaining.toFixed(4)} {symbol}
            </Text>
          </View>
        </View>

        {/* Footer */}
        <View style={st.footer}>
          <View style={st.footerLeft}>
            <Ionicons name="time-outline" size={14} color={Colors.textSecondary} />
            <Text style={st.dim}>
              {isActive || stream.status === 'paused'
                ? formatTimeRemaining(endDate)
                : formatDuration(startDate, endDate)}
            </Text>
          </View>

          <View style={st.footerRight}>
            <Badge variant={statusInfo.tone} size="sm">{statusInfo.label}</Badge>

            {(isActive || stream.status === 'paused') && (
              <View style={st.footerActions}>
                {onPause && (
                  <TouchableOpacity
                    onPress={onPause}
                    style={st.footerBtn}
                    accessibilityRole="button"
                    accessibilityLabel={isActive ? 'Pause this stream' : 'Resume this stream'}
                  >
                    <Ionicons
                      name={isActive ? 'pause' : 'play'}
                      size={16}
                      color={Colors.primary}
                    />
                  </TouchableOpacity>
                )}
                {onCancel && (
                  <TouchableOpacity
                    onPress={onCancel}
                    style={[st.footerBtn, st.footerBtnDanger]}
                    accessibilityRole="button"
                    accessibilityLabel="Stop this stream"
                  >
                    <Ionicons name="close" size={16} color={Colors.error} />
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        </View>
      </Card>
    </TouchableOpacity>
  );
};

const st = StyleSheet.create({
  card: { marginBottom: Spacing.md },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginBottom: Spacing.lg,
  },
  headLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  headText: { flex: 1, minWidth: 0 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryDim,
  },
  name: {
    fontFamily: FontFamily.medium,
    fontSize: FontSize.md,
    color: Colors.text,
  },
  counterparty: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

  progressBlock: { gap: Spacing.sm, marginBottom: Spacing.lg },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: Colors.surfaceTertiary,
  },
  progressFill: { height: '100%', borderRadius: 2, backgroundColor: Colors.primary },

  amountsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: Spacing.lg,
  },
  amountCell: { flex: 1, gap: 2 },
  amountCellCenter: { flex: 1, alignItems: 'center', gap: 2 },
  amountCellEnd: { flex: 1, alignItems: 'flex-end', gap: 2 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderSoft,
  },
  footerLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  footerRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  footerActions: { flexDirection: 'row', gap: Spacing.sm },
  footerBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.sm,
  },
  footerBtnDanger: { backgroundColor: Colors.errorDim },

  dim: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  mono: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.text,
  },
  amountAccent: {
    fontFamily: FontFamily.mono,
    fontSize: FontSize.sm,
    color: Colors.primary,
  },
});

export default StreamCard;
