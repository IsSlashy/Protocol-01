/**
 * AlertModal — the app's alert dialog. Driven by useAlertStore, mounted once
 * in _layout.tsx.
 *
 * 🎯 RETUNED ON THE REALIGNED THEME 2026-08-23.
 *   - `question` used `P01Colors.pink`. Pink is retired; it now resolves to
 *     cyan through the alias, but writing the name kept a retired colour alive
 *     in the source. It reads the accent directly.
 *   - the card was `#101014`, the destructive button `#e0574f` and the primary
 *     label `#000` — three literals the theme sweep could not reach. Tokens.
 *   - the title is set in the display face, like every heading in the app.
 *   - both buttons are 44pt tall. They were 12pt of padding around 14pt text,
 *     which lands at 42 and is the sort of miss nobody sees until a thumb does.
 */
import React, { useEffect, useRef } from 'react';
import {
  Modal, View, Text, TouchableOpacity, TouchableWithoutFeedback,
  StyleSheet, Animated, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAlertStore, type AlertButton } from '@/stores/alertStore';
import { Colors, Spacing, FontFamily, FontSize, BorderRadius } from '@/constants/theme';

const ICONS: Record<string, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  warning: { name: 'warning', color: Colors.yellow },
  error:   { name: 'alert-circle', color: Colors.error },
  success: { name: 'checkmark-circle', color: Colors.primary },
  info:    { name: 'information-circle', color: Colors.textSecondary },
  question:{ name: 'help-circle', color: Colors.primary },
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
                  <View style={st.iconWrap}>
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
                    activeOpacity={0.7} style={st.btnCancel}
                    accessibilityRole="button" accessibilityLabel={btn.text}>
                    <Text style={st.btnCancelText}>{btn.text}</Text>
                  </TouchableOpacity>
                ))}
                {buttons.filter(b => b.style !== 'cancel').map((btn, i) => {
                  const destructive = btn.style === 'destructive';
                  return (
                    <TouchableOpacity key={`a${i}`} onPress={() => handleButton(btn)}
                      activeOpacity={0.8}
                      accessibilityRole="button" accessibilityLabel={btn.text}
                      style={[st.btnPrimary, destructive && st.btnDestructive]}>
                      <Text style={[st.btnPrimaryText, destructive && st.btnDestructiveText]}>
                        {btn.text}
                      </Text>
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

/**
 * The scrim behind a modal: the ground colour at 72%, derived from the token
 * rather than written out, so a change to the ink reaches it. `b8` is 0.72 in
 * the 8-digit hex form React Native accepts.
 */
const SCRIM = `${Colors.background}b8`;

const st = StyleSheet.create({
  overlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: SCRIM,
  },
  card: {
    width: '82%', maxWidth: 340,
    backgroundColor: Colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Colors.border,
    borderRadius: BorderRadius.lg,
    padding: Spacing.xl,
  },

  // Header
  headerRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.sm,
  },
  iconWrap: {
    width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
  },
  title: {
    flex: 1, fontSize: FontSize.xl, fontFamily: FontFamily.displayMedium, color: Colors.text,
  },

  // Message
  message: {
    fontSize: FontSize.sm, fontFamily: FontFamily.regular, color: Colors.textSecondary,
    lineHeight: 20, marginBottom: Spacing.xl, marginTop: Spacing.xs,
  },

  // Buttons
  buttons: {
    flexDirection: 'row', gap: Spacing.sm,
  },
  btnPrimary: {
    flex: 1, minHeight: 44, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.primary,
    borderWidth: 1, borderColor: 'transparent',
  },
  btnPrimaryText: {
    fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.background,
  },
  // Destructive is outlined, not filled: the loudest thing in a dialog should
  // not be the button that cannot be undone.
  btnDestructive: {
    backgroundColor: Colors.errorDim, borderColor: Colors.error,
  },
  btnDestructiveText: {
    color: Colors.error,
  },
  btnCancel: {
    flex: 1, minHeight: 44, borderRadius: BorderRadius.md,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.border,
  },
  btnCancelText: {
    fontSize: FontSize.md, fontFamily: FontFamily.medium, color: Colors.textSecondary,
  },
});

export { AlertModal };
