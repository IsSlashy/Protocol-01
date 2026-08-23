/**
 * GlitchButton — RETIRED AS A LOOK. This now renders the ordinary `Button`.
 *
 * ⛔ WHAT WAS DELETED, AND WHY. This component drew a button, then drew the
 * same label twice more offset by ±2px in two accent colours, then flashed a
 * scan line across it, then jittered the whole thing sideways on a loop every
 * two to five seconds — permanently, whether or not anybody was looking at it.
 * That is the arcade house style the brand is removing: it is the loudest thing
 * on any screen it appears on, it competes with the one action the screen is
 * asking for, and an element that moves on its own is hostile to anyone with a
 * vestibular disorder. It also carried a `#ff6699` glow that no longer exists
 * in the palette.
 *
 * ⚠️ THE FILE STAYS, AND THE EXPORT STAYS. It is exported from
 * `components/ui/index.ts` and screens import it; deleting it would break
 * builds for no gain. Keeping it as a thin alias means every existing call site
 * lands on the new button system with no edit, and the next person to touch one
 * of those screens can simply write `Button`.
 *
 * The prop surface is unchanged: `variant`, `onPress`, `children`, `fullWidth`,
 * `disabled`. `variant="danger"` is now a real Button variant, so nothing is
 * lost in the translation.
 */

import React, { useCallback } from 'react';
import { Platform, TouchableOpacityProps } from 'react-native';
import * as Haptics from 'expo-haptics';

import { Button } from './Button';

type ButtonVariant = 'primary' | 'danger' | 'ghost';

interface GlitchButtonProps extends Omit<TouchableOpacityProps, 'onPress'> {
  variant?: ButtonVariant;
  onPress?: () => void;
  children: string;
  fullWidth?: boolean;
}

export const GlitchButton: React.FC<GlitchButtonProps> = ({
  variant = 'primary',
  onPress,
  children,
  fullWidth = false,
  disabled,
  ...props
}) => {
  // The one thing worth keeping from the old component: a light tap on press.
  // Haptics are a platform convention, not a house style.
  const handlePress = useCallback(() => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    onPress?.();
  }, [onPress]);

  return (
    <Button
      variant={variant}
      size="md"
      fullWidth={fullWidth}
      disabled={disabled}
      onPress={handlePress}
      {...props}
    >
      {children}
    </Button>
  );
};

export default GlitchButton;
