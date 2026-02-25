import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Colors, FontFamily, BorderRadius, Spacing, P01Colors } from '@/constants/theme';

interface PrivacyInfoCardProps {
  title: string;
  description: string;
  gradientColors?: [string, string];
  delay?: number;
}

export default function PrivacyInfoCard({
  title,
  description,
  gradientColors = [P01Colors.cyanDim, P01Colors.pinkDim] as [string, string],
  delay = 500,
}: PrivacyInfoCardProps) {
  return (
    <Animated.View entering={FadeInDown.delay(delay)}>
      <LinearGradient
        colors={gradientColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.card}
      >
        <View style={styles.icon}>
          <Ionicons name="shield-checkmark" size={24} color={P01Colors.cyan} />
        </View>
        <View style={styles.content}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.text}>{description}</Text>
        </View>
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.md,
    gap: 12,
    borderWidth: 1,
    borderColor: `${P01Colors.cyan}30`,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: P01Colors.cyanDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontFamily: FontFamily.bold,
    color: Colors.textPrimary,
    marginBottom: 4,
  },
  text: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
});
