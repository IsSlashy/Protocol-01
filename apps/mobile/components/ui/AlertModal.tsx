/**
 * AlertModal — Minimal P01 alert dialog.
 * Driven by useAlertStore. Mount once in _layout.tsx.
 */
import React, { useEffect, useRef } from 'react';
import {
  Modal, View, Text, TouchableOpacity, TouchableWithoutFeedback,
  StyleSheet, Animated, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAlertStore, type AlertButton } from '@/stores/alertStore';
import { Colors, FontFamily, BorderRadius, P01Colors } from '@/constants/theme';

const ICONS: Record<string, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  warning: { name: 'warning', color: P01Colors.yellow },
  error:   { name: 'alert-circle', color: '#ff3366' },
  success: { name: 'checkmark-circle', color: P01Colors.cyan },
  info:    { name: 'information-circle', color: P01Colors.cyan },
  question:{ name: 'help-circle', color: P01Colors.pink },
};

export default function AlertModal() {
  const { visible, title, message, buttons, icon, dismiss } = useAlertStore();

  const scale = useRef(new Animated.Value(0.92)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      scale.setValue(0.92);
      opacity.setValue(0);
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, friction: 10, tension: 80, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  const handleButton = (btn: AlertButton) => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    dismiss();
    setTimeout(() => btn.onPress?.(), 120);
  };

  const iconInfo = icon ? ICONS[icon] : null;

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <TouchableWithoutFeedback onPress={dismiss}>
        <View style={st.overlay}>
          <TouchableWithoutFeedback>
            <Animated.View style={[st.card, { opacity, transform: [{ scale }] }]}>

              {/* Icon + Title row */}
              <View style={st.headerRow}>
                {iconInfo && (
                  <View style={[st.iconWrap, { backgroundColor: `${iconInfo.color}15` }]}>
                    <Ionicons name={iconInfo.name} size={20} color={iconInfo.color} />
                  </View>
                )}
                <Text style={st.title} numberOfLines={2}>{title}</Text>
              </View>

              {/* Message */}
              {!!message && <Text style={st.message}>{message}</Text>}

              {/* Buttons */}
              <View style={st.buttons}>
                {buttons.length > 1 && buttons.filter(b => b.style === 'cancel').map((btn, i) => (
                  <TouchableOpacity key={`c${i}`} onPress={() => handleButton(btn)}
                    activeOpacity={0.7} style={st.btnCancel}>
                    <Text style={st.btnCancelText}>{btn.text}</Text>
                  </TouchableOpacity>
                ))}
                {buttons.filter(b => b.style !== 'cancel').map((btn, i) => {
                  const destructive = btn.style === 'destructive';
                  return (
                    <TouchableOpacity key={`a${i}`} onPress={() => handleButton(btn)}
                      activeOpacity={0.8}
                      style={[st.btnPrimary, destructive && { backgroundColor: '#ff3366' }]}>
                      <Text style={st.btnPrimaryText}>{btn.text}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const st = StyleSheet.create({
  overlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  card: {
    width: '82%', maxWidth: 340,
    backgroundColor: '#151518',
    borderRadius: BorderRadius.xl,
    padding: 20,
  },

  // Header
  headerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8,
  },
  iconWrap: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  title: {
    flex: 1, fontSize: 16, fontFamily: FontFamily.semibold, color: Colors.text,
  },

  // Message
  message: {
    fontSize: 13, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    lineHeight: 19, marginBottom: 18, marginTop: 4,
  },

  // Buttons
  buttons: {
    flexDirection: 'row', gap: 8,
  },
  btnPrimary: {
    flex: 1, paddingVertical: 12, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: P01Colors.cyan,
  },
  btnPrimaryText: {
    fontSize: 14, fontFamily: FontFamily.semibold, color: '#000',
  },
  btnCancel: {
    flex: 1, paddingVertical: 12, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  btnCancelText: {
    fontSize: 14, fontFamily: FontFamily.medium, color: Colors.textSecondary,
  },
});

export { AlertModal };
