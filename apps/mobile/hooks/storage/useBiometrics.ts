/**
 * useBiometrics - Biometric authentication hook
 * @module hooks/storage/useBiometrics
 */

import { useState, useEffect, useCallback } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import { useSecureStorage, SECURE_KEYS } from './useSecureStorage';

export type BiometricType =
  | 'fingerprint'
  | 'facial'
  | 'iris'
  | 'none';

interface BiometricStatus {
  isAvailable: boolean;
  isEnrolled: boolean;
  biometricTypes: BiometricType[];
  securityLevel: LocalAuthentication.SecurityLevel;
}

interface AuthenticateOptions {
  promptMessage?: string;
  cancelLabel?: string;
  fallbackLabel?: string;
  disableDeviceFallback?: boolean;
  requireConfirmation?: boolean;
}

interface UseBiometricsReturn {
  status: BiometricStatus;
  isEnabled: boolean;
  isLoading: boolean;
  error: Error | null;
  authenticate: (options?: AuthenticateOptions) => Promise<boolean>;
  enableBiometrics: () => Promise<boolean>;
  disableBiometrics: () => Promise<boolean>;
  checkStatus: () => Promise<BiometricStatus>;
}

const DEFAULT_PROMPT = 'Authenticate to access P-01';
const DEFAULT_CANCEL = 'Cancel';
const DEFAULT_FALLBACK = 'Use PIN';

function mapBiometricType(
  type: LocalAuthentication.AuthenticationType
): BiometricType {
  switch (type) {
    case LocalAuthentication.AuthenticationType.FINGERPRINT:
      return 'fingerprint';
    case LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION:
      return 'facial';
    case LocalAuthentication.AuthenticationType.IRIS:
      return 'iris';
    default:
      return 'none';
  }
}

export function useBiometrics(): UseBiometricsReturn {
  const [status, setStatus] = useState<BiometricStatus>({
    isAvailable: false,
    isEnrolled: false,
    biometricTypes: [],
    securityLevel: LocalAuthentication.SecurityLevel.NONE,
  });
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const { getSecure, setSecure, removeSecure } = useSecureStorage();

  const checkStatus = useCallback(async (): Promise<BiometricStatus> => {
    try {
      const [
        isAvailable,
        isEnrolled,
        supportedTypes,
        securityLevel,
      ] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        LocalAuthentication.supportedAuthenticationTypesAsync(),
        LocalAuthentication.getEnrolledLevelAsync(),
      ]);

      const biometricTypes = supportedTypes.map(mapBiometricType);

      const newStatus: BiometricStatus = {
        isAvailable,
        isEnrolled,
        biometricTypes,
        securityLevel,
      };

      setStatus(newStatus);
      return newStatus;
    } catch (err) {
      const error = err instanceof Error
        ? err
        : new Error('Failed to check biometric status');
      setError(error);
      return status;
    }
  }, [status]);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      await checkStatus();
      const enabled = await getSecure<boolean>(SECURE_KEYS.BIOMETRIC_ENABLED);
      setIsEnabled(enabled === true);
    } catch (err) {
      const error = err instanceof Error
        ? err
        : new Error('Failed to load biometric settings');
      setError(error);
    } finally {
      setIsLoading(false);
    }
  }, [checkStatus, getSecure]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const authenticate = useCallback(async (
    options: AuthenticateOptions = {}
  ): Promise<boolean> => {
    setError(null);

    const {
      promptMessage = DEFAULT_PROMPT,
      cancelLabel = DEFAULT_CANCEL,
      fallbackLabel = DEFAULT_FALLBACK,
      disableDeviceFallback = false,
      requireConfirmation = true,
    } = options;

    try {
      // Check if biometrics are available and enrolled
      if (!status.isAvailable) {
        throw new Error('Biometric hardware not available');
      }

      if (!status.isEnrolled) {
        throw new Error('No biometrics enrolled on device');
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage,
        cancelLabel,
        fallbackLabel,
        disableDeviceFallback,
        requireConfirmation,
      });

      if (result.success) {
        return true;
      }

      // Handle specific error types
      if (result.error === 'user_cancel') {
        return false;
      }

      if (result.error === 'user_fallback') {
        // User chose fallback (PIN)
        return false;
      }

      if (result.error === 'lockout') {
        throw new Error('Too many failed attempts. Please try again later.');
      }

      if (result.error === 'lockout_permanent') {
        throw new Error('Biometrics permanently locked. Please use PIN.');
      }

      return false;
    } catch (err) {
      const error = err instanceof Error
        ? err
        : new Error('Authentication failed');
      setError(error);
      return false;
    }
  }, [status]);

  const enableBiometrics = useCallback(async (): Promise<boolean> => {
    setError(null);

    try {
      // First verify biometrics work
      const authenticated = await authenticate({
        promptMessage: 'Verify to enable biometric login',
      });

      if (!authenticated) {
        return false;
      }

      // Save preference
      const saved = await setSecure(SECURE_KEYS.BIOMETRIC_ENABLED, true);
      if (saved) {
        setIsEnabled(true);
        return true;
      }

      return false;
    } catch (err) {
      const error = err instanceof Error
        ? err
        : new Error('Failed to enable biometrics');
      setError(error);
      return false;
    }
  }, [authenticate, setSecure]);

  const disableBiometrics = useCallback(async (): Promise<boolean> => {
    setError(null);

    try {
      // Verify identity before disabling
      const authenticated = await authenticate({
        promptMessage: 'Verify to disable biometric login',
      });

      if (!authenticated) {
        return false;
      }

      // Remove preference
      const removed = await removeSecure(SECURE_KEYS.BIOMETRIC_ENABLED);
      if (removed) {
        setIsEnabled(false);
        return true;
      }

      return false;
    } catch (err) {
      const error = err instanceof Error
        ? err
        : new Error('Failed to disable biometrics');
      setError(error);
      return false;
    }
  }, [authenticate, removeSecure]);

  return {
    status,
    isEnabled,
    isLoading,
    error,
    authenticate,
    enableBiometrics,
    disableBiometrics,
    checkStatus,
  };
}

// Quick authentication utility
export async function quickAuthenticate(
  promptMessage: string = DEFAULT_PROMPT
): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
