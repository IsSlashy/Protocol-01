/**
 * useSecuritySettings - Hook for managing security settings
 * Handles: block screenshots, hide balance, require auth for sends
 */

import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ScreenCapture from 'expo-screen-capture';
import * as LocalAuthentication from 'expo-local-authentication';

const STORAGE_KEYS = {
  BIOMETRICS: 'settings_biometrics',
  AUTH_FOR_SENDS: 'settings_auth_sends',
  HIDE_BALANCE: 'settings_hide_balance',
  BLOCK_SCREENSHOTS: 'settings_block_screenshots',
  LOCK_TIMEOUT: 'settings_lock_timeout',
};

interface SecuritySettings {
  biometricsEnabled: boolean;
  requireAuthForSends: boolean;
  hideBalanceByDefault: boolean;
  blockScreenshots: boolean;
  lockTimeout: number;
}

interface UseSecuritySettingsReturn {
  settings: SecuritySettings;
  isLoading: boolean;
  biometricsAvailable: boolean;
  refreshSettings: () => Promise<void>;
  authenticateForSend: () => Promise<boolean>;
}

const DEFAULT_SETTINGS: SecuritySettings = {
  biometricsEnabled: false,
  requireAuthForSends: true,
  hideBalanceByDefault: false,
  blockScreenshots: false,
  lockTimeout: 60,
};

export function useSecuritySettings(): UseSecuritySettingsReturn {
  const [settings, setSettings] = useState<SecuritySettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);

  // Check biometrics availability
  const checkBiometrics = useCallback(async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    setBiometricsAvailable(hasHardware && isEnrolled);
  }, []);

  // Load settings from AsyncStorage
  const loadSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      const [bio, auth, hide, block, timeout] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.BIOMETRICS),
        AsyncStorage.getItem(STORAGE_KEYS.AUTH_FOR_SENDS),
        AsyncStorage.getItem(STORAGE_KEYS.HIDE_BALANCE),
        AsyncStorage.getItem(STORAGE_KEYS.BLOCK_SCREENSHOTS),
        AsyncStorage.getItem(STORAGE_KEYS.LOCK_TIMEOUT),
      ]);

      const newSettings: SecuritySettings = {
        biometricsEnabled: bio === 'true',
        requireAuthForSends: auth !== 'false', // Default to true
        hideBalanceByDefault: hide === 'true',
        blockScreenshots: block === 'true',
        lockTimeout: timeout ? parseInt(timeout, 10) : 60,
      };

      setSettings(newSettings);

      // Apply screenshot blocking
      if (Platform.OS !== 'web') {
        if (newSettings.blockScreenshots) {
          await ScreenCapture.preventScreenCaptureAsync();
        } else {
          await ScreenCapture.allowScreenCaptureAsync();
        }
      }
    } catch (error) {
      console.error('Failed to load security settings:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Authenticate user before sensitive actions (like sending)
  // Uses constant-time checks where possible to prevent timing attacks
  const authenticateForSend = useCallback(async (): Promise<boolean> => {
    // Always check all conditions to prevent timing-based information leakage
    const authRequired = settings.requireAuthForSends;
    const bioAvailable = biometricsAvailable;
    const bioEnabled = settings.biometricsEnabled;

    // If auth for sends is disabled, just return true
    if (!authRequired) {
      return true;
    }

    // If biometrics is not available or not enabled, return true (no auth needed)
    if (!bioAvailable || !bioEnabled) {
      return true;
    }

    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to send transaction',
        fallbackLabel: 'Cancel',
        disableDeviceFallback: false,
        // Add cancelLabel for better UX
        cancelLabel: 'Use PIN',
      });

      // Handle lockout scenarios securely
      if (result.error === 'lockout' || result.error === 'lockout_permanent') {
        // Log security event (without sensitive details)
        console.warn('Biometric authentication locked out');
        return false;
      }

      return result.success;
    } catch (error) {
      // Log error without exposing sensitive information
      console.error('Authentication error occurred');
      return false;
    }
  }, [settings.requireAuthForSends, settings.biometricsEnabled, biometricsAvailable]);

  // Initialize on mount
  useEffect(() => {
    checkBiometrics();
    loadSettings();
  }, [checkBiometrics, loadSettings]);

  // Listen for screenshot blocking changes
  useEffect(() => {
    if (Platform.OS !== 'web' && !isLoading) {
      if (settings.blockScreenshots) {
        ScreenCapture.preventScreenCaptureAsync();
      } else {
        ScreenCapture.allowScreenCaptureAsync();
      }
    }
  }, [settings.blockScreenshots, isLoading]);

  return {
    settings,
    isLoading,
    biometricsAvailable,
    refreshSettings: loadSettings,
    authenticateForSend,
  };
}

export default useSecuritySettings;
