/**
 * NymStatusBadge — tiny status pill for the Nym mixnet on mobile.
 *
 * Reads live metadata from `services/nym/client.ts` so it reflects whatever
 * state the (currently scaffolded) client is in. Today that is always
 * `'unsupported'` and the badge reads "Nym: Phase 2". Once the WebView
 * transport lands, the same component will show "Nym: live" without any
 * call-site changes.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { P01Colors } from '@/constants/theme';
import {
  getNymState,
  onNymStateChange,
  type NymMetadata,
} from '@/services/nym';

interface NymStatusBadgeProps {
  /** Optional click-through handler — wire this to an info modal. */
  onPress?: () => void;
  /** Compact mode drops the label and only shows the icon + dot. */
  compact?: boolean;
}

interface BadgeView {
  label: string;
  dotColor: string;
  iconColor: string;
}

function describe(meta: NymMetadata): BadgeView {
  switch (meta.state) {
    case 'ready':
      return {
        label: 'Nym: live',
        dotColor: P01Colors.cyanBright,
        iconColor: P01Colors.cyanBright,
      };
    case 'initializing':
      return {
        label: 'Nym: connecting',
        dotColor: P01Colors.cyan,
        iconColor: P01Colors.cyan,
      };
    case 'error':
      return {
        label: 'Nym: error',
        dotColor: '#ff5c7a',
        iconColor: '#ff5c7a',
      };
    case 'unsupported':
    case 'uninitialized':
    default:
      return {
        label: 'Nym: Phase 2',
        dotColor: '#8a8a9a',
        iconColor: '#b5b5c5',
      };
  }
}

export function NymStatusBadge({
  onPress,
  compact = false,
}: NymStatusBadgeProps): React.ReactElement {
  const [meta, setMeta] = useState<NymMetadata>(() => getNymState());

  useEffect(() => {
    return onNymStateChange(setMeta);
  }, []);

  const view = describe(meta);
  const Wrapper = onPress ? PressableWrapper : View;

  return (
    <Wrapper style={styles.badge} onPress={onPress}>
      <Ionicons name="shuffle" size={12} color={view.iconColor} />
      {!compact ? <Text style={styles.label}>{view.label}</Text> : null}
      <View style={[styles.dot, { backgroundColor: view.dotColor }]} />
    </Wrapper>
  );
}

// Small wrapper so we can conditionally switch between View / Pressable
// without conditionally calling hooks or changing the JSX structure.
interface PressableWrapperProps {
  style: object;
  onPress?: () => void;
  children: React.ReactNode;
}

function PressableWrapper({
  style,
  onPress,
  children,
}: PressableWrapperProps): React.ReactElement {
  // Lazy import to avoid importing Pressable when unused.
  const { Pressable } = require('react-native') as typeof import('react-native');
  return (
    <Pressable style={style} onPress={onPress}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: P01Colors.cyanDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: P01Colors.cyan,
    alignSelf: 'flex-start',
  },
  label: {
    color: '#e5e5f0',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});

export default NymStatusBadge;
