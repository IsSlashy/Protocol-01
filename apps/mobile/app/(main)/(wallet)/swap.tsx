import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';

const P01 = {
  cyan: '#39c5bb',
  pink: '#ff77a8',
};

export default function SwapScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <Ionicons name="arrow-back" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Swap</Text>
        <View style={styles.placeholder} />
      </View>

      {/* Coming Soon Content */}
      <View style={styles.content}>
        <Animated.View entering={FadeInDown.delay(100)} style={styles.centerContent}>
          {/* Icon */}
          <LinearGradient
            colors={[P01.cyan, '#00ffe5']}
            style={styles.iconContainer}
          >
            <Ionicons name="swap-horizontal" size={40} color="#0a0a0c" />
          </LinearGradient>

          {/* Title */}
          <Text style={styles.title}>Coming Soon</Text>

          {/* Description */}
          <Text style={styles.description}>
            Token swap is currently under development. This feature will be available in the next update.
          </Text>

          {/* Status Badge */}
          <View style={styles.badge}>
            <Ionicons name="construct" size={16} color={P01.pink} />
            <Text style={styles.badgeText}>In Development</Text>
          </View>
        </Animated.View>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.goBackButton}
          onPress={() => router.back()}
        >
          <Text style={styles.goBackText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  placeholder: {
    width: 40,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing['3xl'],
  },
  centerContent: {
    alignItems: 'center',
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing['2xl'],
  },
  title: {
    fontSize: 28,
    fontFamily: FontFamily.bold,
    color: Colors.text,
    marginBottom: Spacing.md,
  },
  description: {
    fontSize: 15,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing['2xl'],
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: BorderRadius.full,
  },
  badgeText: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: Colors.textSecondary,
  },
  footer: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  goBackButton: {
    backgroundColor: Colors.surfaceSecondary,
    paddingVertical: Spacing.lg,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
  },
  goBackText: {
    fontSize: 16,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
});
