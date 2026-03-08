/**
 * Biometric gate for sensitive operations (unshield, send, withdraw).
 * Requires fingerprint/face auth before proceeding.
 * Falls back to device passcode if biometrics unavailable.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';

export async function requireBiometricAuth(
  promptMessage = 'Authenticate to continue',
): Promise<boolean> {
  const hasHardware = await LocalAuthentication.hasHardwareAsync();
  const isEnrolled = await LocalAuthentication.isEnrolledAsync();

  if (!hasHardware || !isEnrolled) {
    // No biometrics available — fall back to device-level auth (PIN/pattern)
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      disableDeviceFallback: false,
      fallbackLabel: 'Use Passcode',
    });
    return result.success;
  }

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
    fallbackLabel: 'Use Passcode',
  });

  if (result.success) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }

  return result.success;
}
