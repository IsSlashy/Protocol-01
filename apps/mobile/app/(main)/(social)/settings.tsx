import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Switch,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';

import { useMeshStore } from '@/stores/meshStore';
import { generateAlias } from '@/services/mesh';

// Theme colors
const COLORS = {
  primary: '#00ff88',
  cyan: '#00D1FF',
  purple: '#9945FF',
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  border: '#1f1f1f',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
  error: '#ef4444',
};

export default function MeshSettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { identity, isBroadcasting, updateAlias, startBroadcasting, stopBroadcasting } = useMeshStore();

  const [newAlias, setNewAlias] = useState(identity?.alias || '');
  const [isEditing, setIsEditing] = useState(false);

  const handleCopyId = async () => {
    if (identity?.id) {
      await Clipboard.setStringAsync(identity.id);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      Alert.alert('Copied', 'Mesh ID copied to clipboard');
    }
  };

  const handleCopyPublicKey = async () => {
    if (identity?.publicKey) {
      await Clipboard.setStringAsync(identity.publicKey);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      Alert.alert('Copied', 'Public key copied to clipboard');
    }
  };

  const handleSaveAlias = async () => {
    if (newAlias.trim().length < 3) {
      Alert.alert('Invalid Alias', 'Alias must be at least 3 characters');
      return;
    }
    await updateAlias(newAlias.trim());
    setIsEditing(false);
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const handleRandomAlias = () => {
    const randomAlias = generateAlias();
    setNewAlias(randomAlias);
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const toggleBroadcast = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    if (isBroadcasting) {
      stopBroadcasting();
    } else {
      startBroadcasting();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: COLORS.background }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top,
          paddingHorizontal: 20,
          paddingBottom: 16,
          backgroundColor: COLORS.surface,
          borderBottomWidth: 1,
          borderBottomColor: COLORS.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: COLORS.surfaceSecondary,
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 12,
            }}
          >
            <Ionicons name="arrow-back" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '600' }}>
            Mesh Settings
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
      >
        {/* Identity Section */}
        <Animated.View entering={FadeInDown.delay(100)}>
          <Text style={{ color: COLORS.textTertiary, fontSize: 12, fontWeight: '600', letterSpacing: 1, marginBottom: 12 }}>
            YOUR IDENTITY
          </Text>

          <LinearGradient
            colors={[COLORS.surfaceSecondary, COLORS.surface]}
            style={{
              borderRadius: 16,
              padding: 16,
              borderWidth: 1,
              borderColor: COLORS.cyan + '30',
              marginBottom: 24,
            }}
          >
            {/* Avatar and Alias */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  backgroundColor: COLORS.cyan + '20',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <Ionicons name="finger-print" size={28} color={COLORS.cyan} />
              </View>

              <View style={{ marginLeft: 16, flex: 1 }}>
                {isEditing ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <TextInput
                      style={{
                        flex: 1,
                        color: COLORS.text,
                        fontSize: 18,
                        fontWeight: '600',
                        backgroundColor: COLORS.surfaceSecondary,
                        borderRadius: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderWidth: 1,
                        borderColor: COLORS.cyan,
                      }}
                      value={newAlias}
                      onChangeText={setNewAlias}
                      maxLength={20}
                      autoFocus
                    />
                    <TouchableOpacity
                      onPress={handleRandomAlias}
                      style={{ marginLeft: 8 }}
                    >
                      <Ionicons name="shuffle" size={22} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <Text style={{ color: COLORS.text, fontSize: 18, fontWeight: '600' }}>
                    {identity?.alias || 'Anonymous'}
                  </Text>
                )}
                <Text style={{ color: COLORS.textTertiary, fontSize: 11, fontFamily: 'monospace', marginTop: 4 }}>
                  {identity?.id || 'Loading...'}
                </Text>
              </View>

              {isEditing ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    onPress={() => {
                      setNewAlias(identity?.alias || '');
                      setIsEditing(false);
                    }}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      backgroundColor: COLORS.error + '20',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Ionicons name="close" size={18} color={COLORS.error} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleSaveAlias}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      backgroundColor: COLORS.primary + '20',
                      justifyContent: 'center',
                      alignItems: 'center',
                    }}
                  >
                    <Ionicons name="checkmark" size={18} color={COLORS.primary} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => setIsEditing(true)}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: COLORS.surfaceSecondary,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <Ionicons name="pencil" size={16} color={COLORS.textSecondary} />
                </TouchableOpacity>
              )}
            </View>

            {/* Copy buttons */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                onPress={handleCopyId}
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: COLORS.surfaceSecondary,
                  paddingVertical: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: COLORS.border,
                }}
              >
                <Ionicons name="copy-outline" size={16} color={COLORS.textSecondary} />
                <Text style={{ color: COLORS.textSecondary, fontSize: 13, marginLeft: 6 }}>
                  Copy ID
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleCopyPublicKey}
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: COLORS.surfaceSecondary,
                  paddingVertical: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: COLORS.border,
                }}
              >
                <Ionicons name="key-outline" size={16} color={COLORS.textSecondary} />
                <Text style={{ color: COLORS.textSecondary, fontSize: 13, marginLeft: 6 }}>
                  Copy Key
                </Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>
        </Animated.View>

        {/* Broadcast Settings */}
        <Animated.View entering={FadeInDown.delay(200)}>
          <Text style={{ color: COLORS.textTertiary, fontSize: 12, fontWeight: '600', letterSpacing: 1, marginBottom: 12 }}>
            VISIBILITY
          </Text>

          <View
            style={{
              backgroundColor: COLORS.surfaceSecondary,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: COLORS.border,
              marginBottom: 24,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 16,
                borderBottomWidth: 1,
                borderBottomColor: COLORS.border,
              }}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  backgroundColor: isBroadcasting ? COLORS.primary + '20' : COLORS.surfaceSecondary,
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginRight: 12,
                }}
              >
                <Ionicons
                  name="radio"
                  size={20}
                  color={isBroadcasting ? COLORS.primary : COLORS.textTertiary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '500' }}>
                  Broadcast Presence
                </Text>
                <Text style={{ color: COLORS.textTertiary, fontSize: 12, marginTop: 2 }}>
                  Allow nearby users to discover you
                </Text>
              </View>
              <Switch
                value={isBroadcasting}
                onValueChange={toggleBroadcast}
                trackColor={{ false: COLORS.border, true: COLORS.primary + '50' }}
                thumbColor={isBroadcasting ? COLORS.primary : COLORS.textTertiary}
              />
            </View>

            <View style={{ padding: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="information-circle" size={16} color={COLORS.textTertiary} />
                <Text style={{ color: COLORS.textTertiary, fontSize: 12, marginLeft: 8, flex: 1 }}>
                  When broadcasting is off, you won't appear in nearby scans but can still connect to known peers.
                </Text>
              </View>
            </View>
          </View>
        </Animated.View>

        {/* Privacy Info */}
        <Animated.View entering={FadeInDown.delay(300)}>
          <Text style={{ color: COLORS.textTertiary, fontSize: 12, fontWeight: '600', letterSpacing: 1, marginBottom: 12 }}>
            PRIVACY & SECURITY
          </Text>

          <View
            style={{
              backgroundColor: COLORS.surfaceSecondary,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: COLORS.border,
              overflow: 'hidden',
            }}
          >
            {[
              {
                icon: 'lock-closed',
                title: 'End-to-End Encryption',
                desc: 'All messages are encrypted with your keys',
                color: COLORS.primary,
              },
              {
                icon: 'eye-off',
                title: 'Anonymous Identity',
                desc: 'Your real identity is never shared',
                color: COLORS.cyan,
              },
              {
                icon: 'cloud-offline',
                title: 'No Servers',
                desc: 'Messages travel directly between devices',
                color: COLORS.purple,
              },
              {
                icon: 'trash-bin',
                title: 'Auto-Delete',
                desc: 'Messages are deleted after 24 hours',
                color: COLORS.error,
              },
            ].map((item, index) => (
              <View
                key={item.title}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: 16,
                  borderBottomWidth: index < 3 ? 1 : 0,
                  borderBottomColor: COLORS.border,
                }}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    backgroundColor: item.color + '15',
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginRight: 12,
                  }}
                >
                  <Ionicons name={item.icon as any} size={20} color={item.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '500' }}>
                    {item.title}
                  </Text>
                  <Text style={{ color: COLORS.textTertiary, fontSize: 12, marginTop: 2 }}>
                    {item.desc}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </Animated.View>
      </ScrollView>
    </View>
  );
}
