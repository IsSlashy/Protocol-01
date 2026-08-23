/**
 * Header — the top of a screen: a way back, a title, and at most one action.
 *
 * 🎯 REBUILT ON THE REALIGNED THEME 2026-08-23.
 *   - the title was `text-white font-bold text-xl`. Warm paper, display face.
 *   - the back control was a 40pt disc with no accessible name, so a screen
 *     reader announced the single most important control on the screen as
 *     nothing at all. It is 44pt and labelled.
 *   - the filled disc behind the chevron is gone. A back arrow does not need a
 *     button around it to be found; the extension's `Screen` header proves it.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Colors, Spacing, FontFamily, FontSize } from '@/constants/theme';

interface HeaderProps {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  onBackPress?: () => void;
  leftComponent?: React.ReactNode;
  rightComponent?: React.ReactNode;
  transparent?: boolean;
  className?: string;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  subtitle,
  showBack = false,
  onBackPress,
  leftComponent,
  rightComponent,
  transparent = false,
  className,
}) => {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const handleBack = () => {
    if (onBackPress) {
      onBackPress();
    } else {
      router.back();
    }
  };

  return (
    <View
      style={[!transparent && styles.ground, { paddingTop: insets.top }]}
      className={className}
    >
      <View style={styles.row}>
        <View style={styles.left}>
          {showBack ? (
            <TouchableOpacity
              onPress={handleBack}
              style={styles.back}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Ionicons name="chevron-back" size={22} color={Colors.textSecondary} />
            </TouchableOpacity>
          ) : null}

          {leftComponent}

          {!leftComponent && title ? (
            <View style={styles.titleWrap}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>

        {rightComponent ? <View style={styles.right}>{rightComponent}</View> : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  ground: {
    backgroundColor: Colors.background,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: Spacing.md,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  back: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.xs,
  },
  titleWrap: {
    flex: 1,
    paddingHorizontal: Spacing.xs,
  },
  title: {
    fontFamily: FontFamily.displayMedium,
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  subtitle: {
    fontFamily: FontFamily.regular,
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});

export default Header;
