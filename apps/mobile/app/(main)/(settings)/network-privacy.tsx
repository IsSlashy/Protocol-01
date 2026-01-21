/**
 * Network Privacy Settings Screen
 *
 * Configure IP privacy settings:
 * - Privacy level selection
 * - RPC rotation
 * - Timing protection
 * - Tor integration (when available)
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Switch,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
import {
  TorProxy,
  getTorProxy,
  PrivacyLevel,
  DEFAULT_PRIVACY_NETWORK_SETTINGS,
} from '@/services/privacy/torProxy';

// P-01 Design System Colors
const P01 = {
  cyan: '#39c5bb',
  cyanDim: 'rgba(57, 197, 187, 0.15)',
  pink: '#ff77a8',
  pinkDim: 'rgba(255, 119, 168, 0.15)',
  blue: '#3b82f6',
  blueDim: 'rgba(59, 130, 246, 0.15)',
  yellow: '#ffcc00',
  yellowDim: 'rgba(255, 204, 0, 0.15)',
};

interface PrivacyLevelOption {
  level: PrivacyLevel;
  title: string;
  description: string;
  icon: string;
  color: string;
  colorDim: string;
  privacyScore: number;
}

const PRIVACY_LEVELS: PrivacyLevelOption[] = [
  {
    level: 'direct',
    title: 'Direct',
    description: 'No IP protection. Fastest but your IP is visible to RPC.',
    icon: 'flash',
    color: P01.pink,
    colorDim: P01.pinkDim,
    privacyScore: 25,
  },
  {
    level: 'rotation',
    title: 'RPC Rotation',
    description: 'Rotate between multiple RPC endpoints. IP exposed to multiple parties.',
    icon: 'shuffle',
    color: P01.yellow,
    colorDim: P01.yellowDim,
    privacyScore: 50,
  },
  {
    level: 'proxy',
    title: 'Proxy',
    description: 'Route through proxy server. IP hidden from RPC providers.',
    icon: 'globe',
    color: P01.blue,
    colorDim: P01.blueDim,
    privacyScore: 75,
  },
  {
    level: 'tor',
    title: 'Tor Network',
    description: 'Maximum privacy. Route through Tor for complete IP anonymity.',
    icon: 'shield-checkmark',
    color: P01.cyan,
    colorDim: P01.cyanDim,
    privacyScore: 100,
  },
];

export default function NetworkPrivacyScreen() {
  const router = useRouter();
  const [privacyLevel, setPrivacyLevel] = useState<PrivacyLevel>('rotation');
  const [rpcRotation, setRpcRotation] = useState(true);
  const [timingProtection, setTimingProtection] = useState(true);
  const [torAvailable, setTorAvailable] = useState(false);
  const [currentEndpoint, setCurrentEndpoint] = useState('');

  // Initialize from proxy
  useEffect(() => {
    const proxy = getTorProxy();
    const status = proxy.getPrivacyStatus();
    setPrivacyLevel(status.level);
    setCurrentEndpoint(status.currentEndpoint);
    setTimingProtection(status.randomDelays);

    // Check Tor availability
    proxy.checkTorAvailability().then(setTorAvailable);
  }, []);

  const handlePrivacyLevelChange = (level: PrivacyLevel) => {
    if (level === 'tor' && !torAvailable) {
      Alert.alert(
        'Tor Not Available',
        'Tor integration requires the Orbot app to be installed and running.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Learn More', onPress: () => {} },
        ]
      );
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPrivacyLevel(level);

    const proxy = getTorProxy();
    proxy.updateConfig({ privacyLevel: level });
  };

  const handleRpcRotationChange = (value: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRpcRotation(value);

    const proxy = getTorProxy();
    if (value) {
      proxy.updateConfig({ privacyLevel: 'rotation' });
      setPrivacyLevel('rotation');
    } else {
      proxy.updateConfig({ privacyLevel: 'direct' });
      setPrivacyLevel('direct');
    }
  };

  const handleTimingProtectionChange = (value: boolean) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTimingProtection(value);

    const proxy = getTorProxy();
    proxy.updateConfig({ addRandomDelays: value });
  };

  const forceRotate = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const proxy = getTorProxy();
    const newEndpoint = proxy.rotateEndpoint();
    setCurrentEndpoint(newEndpoint.url);

    Alert.alert('Rotated', `Now using: ${newEndpoint.name}`);
  };

  const selectedLevel = PRIVACY_LEVELS.find(l => l.level === privacyLevel);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#ffffff" />
        </TouchableOpacity>
        <Text style={styles.headerText}>Network Privacy</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent}>
        {/* Privacy Score Card */}
        <Animated.View entering={FadeInDown.delay(100)}>
          <LinearGradient
            colors={[selectedLevel?.colorDim || P01.cyanDim, 'transparent']}
            style={styles.scoreCard}
          >
            <View style={styles.scoreHeader}>
              <View style={[styles.scoreIcon, { backgroundColor: selectedLevel?.colorDim }]}>
                <Ionicons
                  name={selectedLevel?.icon as any || 'shield'}
                  size={28}
                  color={selectedLevel?.color || P01.cyan}
                />
              </View>
              <View>
                <Text style={styles.scoreTitle}>IP Privacy Level</Text>
                <Text style={[styles.scoreValue, { color: selectedLevel?.color }]}>
                  {selectedLevel?.title}
                </Text>
              </View>
            </View>

            {/* Privacy Meter */}
            <View style={styles.privacyMeter}>
              <View style={styles.meterBackground}>
                <View
                  style={[
                    styles.meterFill,
                    {
                      width: `${selectedLevel?.privacyScore || 0}%`,
                      backgroundColor: selectedLevel?.color,
                    },
                  ]}
                />
              </View>
              <Text style={styles.meterLabel}>
                {selectedLevel?.privacyScore}% Protected
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Privacy Level Selection */}
        <Animated.View entering={FadeInDown.delay(200)}>
          <Text style={styles.sectionTitle}>SELECT PRIVACY LEVEL</Text>

          {PRIVACY_LEVELS.map((option) => (
            <TouchableOpacity
              key={option.level}
              style={[
                styles.levelCard,
                privacyLevel === option.level && styles.levelCardSelected,
                privacyLevel === option.level && { borderColor: option.color },
              ]}
              onPress={() => handlePrivacyLevelChange(option.level)}
            >
              <View style={[styles.levelIcon, { backgroundColor: option.colorDim }]}>
                <Ionicons name={option.icon as any} size={22} color={option.color} />
              </View>
              <View style={styles.levelContent}>
                <View style={styles.levelHeader}>
                  <Text style={styles.levelTitle}>{option.title}</Text>
                  {option.level === 'tor' && !torAvailable && (
                    <View style={styles.unavailableBadge}>
                      <Text style={styles.unavailableBadgeText}>Requires Orbot</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.levelDesc}>{option.description}</Text>
              </View>
              <View style={[
                styles.radioOuter,
                privacyLevel === option.level && { borderColor: option.color },
              ]}>
                {privacyLevel === option.level && (
                  <View style={[styles.radioInner, { backgroundColor: option.color }]} />
                )}
              </View>
            </TouchableOpacity>
          ))}
        </Animated.View>

        {/* Additional Settings */}
        <Animated.View entering={FadeInDown.delay(300)}>
          <Text style={styles.sectionTitle}>ADDITIONAL PROTECTION</Text>

          {/* Timing Protection */}
          <View style={styles.settingRow}>
            <View style={styles.settingIcon}>
              <Ionicons name="time" size={20} color={P01.cyan} />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.settingTitle}>Timing Protection</Text>
              <Text style={styles.settingDesc}>
                Add random delays to prevent timing correlation
              </Text>
            </View>
            <Switch
              value={timingProtection}
              onValueChange={handleTimingProtectionChange}
              trackColor={{ false: Colors.border, true: P01.cyanDim }}
              thumbColor={timingProtection ? P01.cyan : '#888'}
            />
          </View>

          {/* RPC Rotation */}
          <View style={styles.settingRow}>
            <View style={styles.settingIcon}>
              <Ionicons name="shuffle" size={20} color={P01.blue} />
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.settingTitle}>Auto RPC Rotation</Text>
              <Text style={styles.settingDesc}>
                Automatically switch RPC endpoints periodically
              </Text>
            </View>
            <Switch
              value={rpcRotation}
              onValueChange={handleRpcRotationChange}
              trackColor={{ false: Colors.border, true: P01.blueDim }}
              thumbColor={rpcRotation ? P01.blue : '#888'}
            />
          </View>
        </Animated.View>

        {/* Current Endpoint */}
        <Animated.View entering={FadeInDown.delay(400)}>
          <Text style={styles.sectionTitle}>CURRENT RPC ENDPOINT</Text>
          <View style={styles.endpointCard}>
            <View style={styles.endpointInfo}>
              <Ionicons name="server" size={18} color={P01.cyan} />
              <Text style={styles.endpointUrl} numberOfLines={1}>
                {currentEndpoint}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.rotateButton}
              onPress={forceRotate}
            >
              <Ionicons name="refresh" size={18} color={P01.cyan} />
              <Text style={styles.rotateButtonText}>Rotate</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>

        {/* Info Box */}
        <Animated.View entering={FadeInDown.delay(500)}>
          <View style={styles.infoBox}>
            <Ionicons name="information-circle" size={20} color={P01.cyan} />
            <Text style={styles.infoText}>
              Higher privacy levels may result in slower transaction speeds.
              Tor requires the Orbot app to be installed and connected.
            </Text>
          </View>
        </Animated.View>
      </ScrollView>
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
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerText: {
    fontSize: 18,
    fontFamily: FontFamily.bold,
    color: '#ffffff',
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.md,
    paddingBottom: 40,
  },
  scoreCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  scoreHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.lg,
  },
  scoreIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreTitle: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: '#888892',
  },
  scoreValue: {
    fontSize: 20,
    fontFamily: FontFamily.bold,
  },
  privacyMeter: {
    gap: 8,
  },
  meterBackground: {
    height: 8,
    backgroundColor: Colors.background,
    borderRadius: 4,
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: 4,
  },
  meterLabel: {
    fontSize: 12,
    fontFamily: FontFamily.medium,
    color: '#888892',
    textAlign: 'right',
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: FontFamily.bold,
    color: '#555560',
    letterSpacing: 1,
    marginBottom: Spacing.md,
    marginTop: Spacing.md,
  },
  levelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    borderWidth: 2,
    borderColor: 'transparent',
    gap: 12,
  },
  levelCardSelected: {
    backgroundColor: Colors.surfaceTertiary,
  },
  levelIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  levelContent: {
    flex: 1,
  },
  levelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  levelTitle: {
    fontSize: 15,
    fontFamily: FontFamily.semibold,
    color: '#ffffff',
  },
  levelDesc: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#888892',
    marginTop: 2,
    lineHeight: 18,
  },
  unavailableBadge: {
    backgroundColor: P01.pinkDim,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  unavailableBadgeText: {
    fontSize: 9,
    fontFamily: FontFamily.semibold,
    color: P01.pink,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    gap: 12,
  },
  settingIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingContent: {
    flex: 1,
  },
  settingTitle: {
    fontSize: 14,
    fontFamily: FontFamily.medium,
    color: '#ffffff',
  },
  settingDesc: {
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#555560',
    marginTop: 2,
  },
  endpointCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
  },
  endpointInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  endpointUrl: {
    fontSize: 12,
    fontFamily: FontFamily.mono,
    color: '#888892',
    flex: 1,
  },
  rotateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: P01.cyanDim,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: BorderRadius.sm,
  },
  rotateButtonText: {
    fontSize: 12,
    fontFamily: FontFamily.semibold,
    color: P01.cyan,
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: P01.cyanDim,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    marginTop: Spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(57, 197, 187, 0.2)',
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FontFamily.regular,
    color: '#888892',
    lineHeight: 18,
  },
});
