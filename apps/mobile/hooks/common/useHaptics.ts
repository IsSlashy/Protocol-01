/**
 * useHaptics - Haptic feedback for touch interactions
 * @module hooks/common/useHaptics
 */

import { useCallback, useMemo } from 'react';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';

export type HapticFeedbackType =
  | 'selection'  // Light tap for selections
  | 'success'   // Success notification
  | 'warning'   // Warning notification
  | 'error'     // Error notification
  | 'light'     // Light impact
  | 'medium'    // Medium impact
  | 'heavy'     // Heavy impact
  | 'soft'      // Soft impact (iOS 13+)
  | 'rigid';    // Rigid impact (iOS 13+)

export interface HapticsSettings {
  enabled: boolean;
  intensity: 'light' | 'medium' | 'heavy';
  enabledFeedbacks: {
    selection: boolean;
    success: boolean;
    warning: boolean;
    error: boolean;
    impact: boolean;
  };
}

const DEFAULT_SETTINGS: HapticsSettings = {
  enabled: true,
  intensity: 'medium',
  enabledFeedbacks: {
    selection: true,
    success: true,
    warning: true,
    error: true,
    impact: true,
  },
};

interface UseHapticsReturn {
  isEnabled: boolean;
  settings: HapticsSettings;
  trigger: (type: HapticFeedbackType) => void;
  selection: () => void;
  success: () => void;
  warning: () => void;
  error: () => void;
  impact: (style?: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid') => void;
  updateSettings: (updates: Partial<HapticsSettings>) => Promise<boolean>;
  enable: () => Promise<boolean>;
  disable: () => Promise<boolean>;
}

export function useHaptics(): UseHapticsReturn {
  const {
    value: settings,
    setValue: setSettings,
  } = useAsyncStorage<HapticsSettings>({
    key: `${ASYNC_KEYS.SETTINGS}_haptics`,
    defaultValue: DEFAULT_SETTINGS,
  });

  const currentSettings = settings ?? DEFAULT_SETTINGS;
  const isEnabled = currentSettings.enabled && Platform.OS !== 'web';

  // Map feedback type to Haptics function
  const triggerHaptic = useCallback(async (type: HapticFeedbackType) => {
    if (!isEnabled) return;

    // Check if this specific feedback type is enabled
    const feedbackCategory = ['selection', 'success', 'warning', 'error'].includes(type)
      ? type as keyof typeof currentSettings.enabledFeedbacks
      : 'impact';

    if (!currentSettings.enabledFeedbacks[feedbackCategory]) return;

    try {
      switch (type) {
        case 'selection':
          await Haptics.selectionAsync();
          break;

        case 'success':
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Success
          );
          break;

        case 'warning':
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning
          );
          break;

        case 'error':
          await Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Error
          );
          break;

        case 'light':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          break;

        case 'medium':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          break;

        case 'heavy':
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          break;

        case 'soft':
          // Soft is iOS 13+ only, fall back to light
          if (Platform.OS === 'ios') {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
          } else {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
          break;

        case 'rigid':
          // Rigid is iOS 13+ only, fall back to heavy
          if (Platform.OS === 'ios') {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
          } else {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          }
          break;
      }
    } catch (error) {
      // Silently fail - haptics are not critical
      console.debug('Haptic feedback failed:', error);
    }
  }, [isEnabled, currentSettings.enabledFeedbacks]);

  // Convenience methods
  const selection = useCallback(() => {
    triggerHaptic('selection');
  }, [triggerHaptic]);

  const success = useCallback(() => {
    triggerHaptic('success');
  }, [triggerHaptic]);

  const warning = useCallback(() => {
    triggerHaptic('warning');
  }, [triggerHaptic]);

  const error = useCallback(() => {
    triggerHaptic('error');
  }, [triggerHaptic]);

  const impact = useCallback((
    style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' = 'medium'
  ) => {
    triggerHaptic(style);
  }, [triggerHaptic]);

  const trigger = useCallback((type: HapticFeedbackType) => {
    triggerHaptic(type);
  }, [triggerHaptic]);

  const updateSettings = useCallback(async (
    updates: Partial<HapticsSettings>
  ): Promise<boolean> => {
    try {
      const newSettings = {
        ...currentSettings,
        ...updates,
        enabledFeedbacks: {
          ...currentSettings.enabledFeedbacks,
          ...updates.enabledFeedbacks,
        },
      };
      await setSettings(newSettings);
      return true;
    } catch {
      return false;
    }
  }, [currentSettings, setSettings]);

  const enable = useCallback(async (): Promise<boolean> => {
    return updateSettings({ enabled: true });
  }, [updateSettings]);

  const disable = useCallback(async (): Promise<boolean> => {
    return updateSettings({ enabled: false });
  }, [updateSettings]);

  return {
    isEnabled,
    settings: currentSettings,
    trigger,
    selection,
    success,
    warning,
    error,
    impact,
    updateSettings,
    enable,
    disable,
  };
}

// Hook for button press haptics
export function useButtonHaptics(
  onPress?: () => void,
  hapticType: HapticFeedbackType = 'selection'
): () => void {
  const { trigger } = useHaptics();

  return useCallback(() => {
    trigger(hapticType);
    onPress?.();
  }, [trigger, hapticType, onPress]);
}

// Hook for list item haptics
export function useListHaptics(): {
  onPressIn: () => void;
  onLongPress: () => void;
} {
  const { trigger } = useHaptics();

  const onPressIn = useCallback(() => {
    trigger('selection');
  }, [trigger]);

  const onLongPress = useCallback(() => {
    trigger('medium');
  }, [trigger]);

  return { onPressIn, onLongPress };
}

// Hook for swipe haptics
export function useSwipeHaptics(): {
  onSwipeStart: () => void;
  onSwipeThreshold: () => void;
  onSwipeComplete: () => void;
  onSwipeCancel: () => void;
} {
  const { trigger } = useHaptics();

  return useMemo(() => ({
    onSwipeStart: () => trigger('selection'),
    onSwipeThreshold: () => trigger('medium'),
    onSwipeComplete: () => trigger('success'),
    onSwipeCancel: () => trigger('light'),
  }), [trigger]);
}
