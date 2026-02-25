import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withSpring,
  useSharedValue,
  runOnJS,
} from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

type Segment = 'shielded' | 'confidential';

interface PrivacySegmentedControlProps {
  selected: Segment;
  onChange: (segment: Segment) => void;
}

export default function PrivacySegmentedControl({
  selected,
  onChange,
}: PrivacySegmentedControlProps) {
  const isShielded = selected === 'shielded';

  const pillStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: withSpring(isShielded ? 0 : 1, {
          damping: 20,
          stiffness: 200,
        }),
      },
    ],
    left: isShielded ? '2%' : '50%',
    width: '48%',
  }));

  return (
    <View style={styles.container}>
      {/* Animated pill background */}
      <Animated.View style={[styles.pill, pillStyle]} />

      {/* Shielded tab */}
      <TouchableOpacity
        style={styles.tab}
        onPress={() => onChange('shielded')}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.tabText,
            isShielded && { color: P01Colors.cyan },
          ]}
        >
          Shielded
        </Text>
      </TouchableOpacity>

      {/* Confidential tab */}
      <TouchableOpacity
        style={styles.tab}
        onPress={() => onChange('confidential')}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.tabText,
            !isShielded && { color: P01Colors.blue },
          ]}
        >
          Confidential
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.md,
    padding: 3,
    position: 'relative',
    marginBottom: Spacing.lg,
  },
  pill: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md - 1,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  tabText: {
    fontSize: 14,
    fontFamily: FontFamily.semibold,
    color: Colors.textTertiary,
  },
});
