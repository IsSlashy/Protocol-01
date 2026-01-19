/**
 * Protocol 01 - Proximity Bump Animation
 *
 * AirDrop-like animation when devices are close
 * Shows connection request with options to send
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Platform,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
  withSpring,
  runOnJS,
  FadeIn,
  FadeOut,
  SlideInUp,
  SlideOutDown,
} from 'react-native-reanimated';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const COLORS = {
  primary: '#39c5bb',
  cyan: '#39c5bb',
  pink: '#ff77a8',
  orange: '#f59e0b',
  background: '#0a0a0c',
  surface: '#0f0f12',
  surfaceSecondary: '#151518',
  text: '#ffffff',
  textSecondary: '#888892',
  textTertiary: '#555560',
};

interface PeerInfo {
  id: string;
  alias: string;
  address: string;
  distance: string;
  rssi: number;
}

interface ProximityBumpProps {
  visible: boolean;
  peer: PeerInfo | null;
  onClose: () => void;
  onConnect: () => void;
  onSendMessage: () => void;
  onSendCrypto: () => void;
  onSharePhoto: () => void;
  isConnecting?: boolean;
  isConnected?: boolean;
}

export function ProximityBump({
  visible,
  peer,
  onClose,
  onConnect,
  onSendMessage,
  onSendCrypto,
  onSharePhoto,
  isConnecting = false,
  isConnected = false,
}: ProximityBumpProps) {
  const [showActions, setShowActions] = useState(false);

  // Animation values
  const pulseScale = useSharedValue(1);
  const ringScale1 = useSharedValue(0.8);
  const ringScale2 = useSharedValue(0.6);
  const ringScale3 = useSharedValue(0.4);
  const ringOpacity1 = useSharedValue(0.4);
  const ringOpacity2 = useSharedValue(0.3);
  const ringOpacity3 = useSharedValue(0.2);
  const avatarScale = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      // Haptic feedback
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      // Start pulse animation
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 1000 }),
          withTiming(1, { duration: 1000 })
        ),
        -1,
        true
      );

      // Ring animations
      ringScale1.value = withRepeat(
        withSequence(
          withTiming(1.5, { duration: 2000 }),
          withTiming(0.8, { duration: 0 })
        ),
        -1
      );
      ringOpacity1.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 2000 }),
          withTiming(0.4, { duration: 0 })
        ),
        -1
      );

      ringScale2.value = withRepeat(
        withSequence(
          withTiming(1.3, { duration: 2000 }),
          withTiming(0.6, { duration: 0 })
        ),
        -1
      );
      ringOpacity2.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 2000 }),
          withTiming(0.3, { duration: 0 })
        ),
        -1
      );

      ringScale3.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 2000 }),
          withTiming(0.4, { duration: 0 })
        ),
        -1
      );
      ringOpacity3.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 2000 }),
          withTiming(0.2, { duration: 0 })
        ),
        -1
      );

      // Avatar entrance
      avatarScale.value = withSpring(1, { damping: 12 });

      // Show actions after avatar appears
      setTimeout(() => setShowActions(true), 500);
    } else {
      setShowActions(false);
      avatarScale.value = 0;
    }
  }, [visible]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  const ring1Style = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale1.value }],
    opacity: ringOpacity1.value,
  }));

  const ring2Style = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale2.value }],
    opacity: ringOpacity2.value,
  }));

  const ring3Style = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale3.value }],
    opacity: ringOpacity3.value,
  }));

  const avatarStyle = useAnimatedStyle(() => ({
    transform: [{ scale: avatarScale.value }],
  }));

  if (!peer) return null;

  const handleAction = (action: () => void) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    action();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <TouchableOpacity style={styles.backdrop} onPress={onClose} activeOpacity={1} />

        <Animated.View entering={FadeIn} style={styles.content}>
          {/* Close button */}
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>

          {/* Proximity indicator */}
          <View style={styles.proximityContainer}>
            {/* Pulse rings */}
            <Animated.View style={[styles.ring, styles.ring3, ring3Style]} />
            <Animated.View style={[styles.ring, styles.ring2, ring2Style]} />
            <Animated.View style={[styles.ring, styles.ring1, ring1Style]} />

            {/* Avatar */}
            <Animated.View style={[styles.avatarContainer, avatarStyle, pulseStyle]}>
              <LinearGradient
                colors={[COLORS.cyan + '30', COLORS.pink + '30']}
                style={styles.avatarGradient}
              >
                <Text style={styles.avatarText}>
                  {peer.alias.charAt(0).toUpperCase()}
                </Text>
              </LinearGradient>
            </Animated.View>
          </View>

          {/* Peer info */}
          <Animated.View entering={SlideInUp.delay(200)} style={styles.peerInfo}>
            <Text style={styles.peerName}>{peer.alias}</Text>
            <View style={styles.peerMeta}>
              <View style={styles.distanceBadge}>
                <Ionicons name="radio-outline" size={14} color={COLORS.cyan} />
                <Text style={styles.distanceText}>{peer.distance}</Text>
              </View>
              <Text style={styles.peerAddress}>
                {peer.address.slice(0, 4)}...{peer.address.slice(-4)}
              </Text>
            </View>
          </Animated.View>

          {/* Connection status */}
          {!isConnected && !isConnecting && (
            <Animated.View entering={FadeIn.delay(400)}>
              <TouchableOpacity
                onPress={() => handleAction(onConnect)}
                style={styles.connectButton}
              >
                <LinearGradient
                  colors={[COLORS.cyan, COLORS.pink]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.connectGradient}
                >
                  <Ionicons name="bluetooth" size={20} color="#0a0a0c" />
                  <Text style={styles.connectText}>Connect</Text>
                </LinearGradient>
              </TouchableOpacity>
            </Animated.View>
          )}

          {isConnecting && (
            <Animated.View entering={FadeIn} style={styles.connectingContainer}>
              <View style={styles.connectingDots}>
                <Animated.View style={[styles.dot, { backgroundColor: COLORS.cyan }]} />
                <Animated.View style={[styles.dot, { backgroundColor: COLORS.pink }]} />
                <Animated.View style={[styles.dot, { backgroundColor: COLORS.primary }]} />
              </View>
              <Text style={styles.connectingText}>Connecting...</Text>
            </Animated.View>
          )}

          {/* Actions (when connected) */}
          {isConnected && showActions && (
            <Animated.View entering={SlideInUp.delay(100)} style={styles.actionsContainer}>
              <Text style={styles.actionsTitle}>What would you like to send?</Text>

              <View style={styles.actionsGrid}>
                <TouchableOpacity
                  onPress={() => handleAction(onSendMessage)}
                  style={styles.actionButton}
                >
                  <View style={[styles.actionIcon, { backgroundColor: COLORS.cyan + '20' }]}>
                    <Ionicons name="chatbubble" size={24} color={COLORS.cyan} />
                  </View>
                  <Text style={styles.actionText}>Message</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => handleAction(onSendCrypto)}
                  style={styles.actionButton}
                >
                  <View style={[styles.actionIcon, { backgroundColor: COLORS.primary + '20' }]}>
                    <Ionicons name="wallet" size={24} color={COLORS.primary} />
                  </View>
                  <Text style={styles.actionText}>Crypto</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => handleAction(onSharePhoto)}
                  style={styles.actionButton}
                >
                  <View style={[styles.actionIcon, { backgroundColor: COLORS.pink + '20' }]}>
                    <Ionicons name="image" size={24} color={COLORS.pink} />
                  </View>
                  <Text style={styles.actionText}>Photo</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.securityNote}>
                <Ionicons name="shield-checkmark" size={14} color={COLORS.primary} />
                <Text style={styles.securityText}>End-to-end encrypted</Text>
              </View>
            </Animated.View>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
  },
  content: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingTop: 24,
    paddingBottom: 40,
    paddingHorizontal: 24,
    minHeight: SCREEN_HEIGHT * 0.6,
  },
  closeButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  proximityContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 200,
    marginTop: 20,
  },
  ring: {
    position: 'absolute',
    borderRadius: 100,
    borderWidth: 2,
    borderColor: COLORS.cyan,
  },
  ring1: {
    width: 160,
    height: 160,
  },
  ring2: {
    width: 200,
    height: 200,
  },
  ring3: {
    width: 240,
    height: 240,
  },
  avatarContainer: {
    width: 100,
    height: 100,
    borderRadius: 50,
    overflow: 'hidden',
  },
  avatarGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: COLORS.cyan,
    borderRadius: 50,
  },
  avatarText: {
    color: COLORS.text,
    fontSize: 40,
    fontWeight: 'bold',
  },
  peerInfo: {
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 24,
  },
  peerName: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  peerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  distanceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.cyan + '20',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 4,
  },
  distanceText: {
    color: COLORS.cyan,
    fontSize: 12,
    fontWeight: '600',
  },
  peerAddress: {
    color: COLORS.textTertiary,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  connectButton: {
    borderRadius: 25,
    overflow: 'hidden',
    alignSelf: 'center',
  },
  connectGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingVertical: 14,
    gap: 8,
  },
  connectText: {
    color: '#0a0a0c',
    fontSize: 16,
    fontWeight: 'bold',
  },
  connectingContainer: {
    alignItems: 'center',
    gap: 12,
  },
  connectingDots: {
    flexDirection: 'row',
    gap: 8,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  connectingText: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  actionsContainer: {
    marginTop: 8,
  },
  actionsTitle: {
    color: COLORS.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
  },
  actionsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 24,
  },
  actionButton: {
    alignItems: 'center',
    gap: 8,
  },
  actionIcon: {
    width: 64,
    height: 64,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  securityText: {
    color: COLORS.textTertiary,
    fontSize: 12,
  },
});

export default ProximityBump;
