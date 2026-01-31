/**
 * Mock: expo-local-authentication
 */
export const AuthenticationType = {
  FINGERPRINT: 1,
  FACIAL_RECOGNITION: 2,
  IRIS: 3,
};

let _enrolled = true;
let _hardwareSupported = true;

export async function hasHardwareAsync(): Promise<boolean> {
  return _hardwareSupported;
}

export async function isEnrolledAsync(): Promise<boolean> {
  return _enrolled;
}

export async function authenticateAsync(options?: any): Promise<{ success: boolean; error?: string }> {
  if (!_hardwareSupported || !_enrolled) {
    return { success: false, error: 'not_enrolled' };
  }
  return { success: true };
}

export async function supportedAuthenticationTypesAsync(): Promise<number[]> {
  return [AuthenticationType.FINGERPRINT];
}

/** Test helpers */
export function __setEnrolled(enrolled: boolean): void { _enrolled = enrolled; }
export function __setHardwareSupported(supported: boolean): void { _hardwareSupported = supported; }
export function __reset(): void { _enrolled = true; _hardwareSupported = true; }
