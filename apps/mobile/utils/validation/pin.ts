/**
 * PIN validation utilities for Protocol 01
 */

export interface PINValidationResult {
  isValid: boolean;
  error?: PINValidationError;
  strength?: PINStrength;
}

export interface PINValidationError {
  code: 'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_CHARACTERS' | 'WEAK_PATTERN' | 'MISMATCH';
  message: string;
}

export type PINStrength = 'weak' | 'medium' | 'strong';

export interface PINValidationOptions {
  minLength?: number;
  maxLength?: number;
  allowWeakPatterns?: boolean;
}

const DEFAULT_MIN_LENGTH = 4;
const DEFAULT_MAX_LENGTH = 8;

// Weak patterns to avoid
const WEAK_PATTERNS = [
  /^(\d)\1+$/, // All same digits (1111, 2222, etc.)
  /^0123/, // Sequential from 0
  /^1234/, // Sequential from 1
  /^2345/, // Sequential from 2
  /^3456/, // Sequential from 3
  /^4567/, // Sequential from 4
  /^5678/, // Sequential from 5
  /^6789/, // Sequential from 6
  /^9876/, // Reverse sequential
  /^8765/, // Reverse sequential
  /^7654/, // Reverse sequential
  /^6543/, // Reverse sequential
  /^5432/, // Reverse sequential
  /^4321/, // Reverse sequential
  /^3210/, // Reverse sequential
  /^0000/, // All zeros
  /^1111/, // All ones
];

// Common weak PINs
const COMMON_WEAK_PINS = [
  '1234', '0000', '1111', '1212', '7777',
  '1004', '2000', '4444', '2222', '6969',
  '9999', '3333', '5555', '6666', '1122',
  '1313', '8888', '4321', '2001', '1010',
];

/**
 * Validate a PIN
 */
export function validatePIN(
  pin: string,
  options: PINValidationOptions = {}
): PINValidationResult {
  const {
    minLength = DEFAULT_MIN_LENGTH,
    maxLength = DEFAULT_MAX_LENGTH,
    allowWeakPatterns = false,
  } = options;

  // Check for empty input
  if (!pin || typeof pin !== 'string') {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'PIN is required',
      },
    };
  }

  const trimmed = pin.trim();

  // Check for empty after trim
  if (trimmed.length === 0) {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'PIN is required',
      },
    };
  }

  // Check for non-digit characters
  if (!/^\d+$/.test(trimmed)) {
    return {
      isValid: false,
      error: {
        code: 'INVALID_CHARACTERS',
        message: 'PIN must contain only digits',
      },
    };
  }

  // Check minimum length
  if (trimmed.length < minLength) {
    return {
      isValid: false,
      error: {
        code: 'TOO_SHORT',
        message: `PIN must be at least ${minLength} digits`,
      },
    };
  }

  // Check maximum length
  if (trimmed.length > maxLength) {
    return {
      isValid: false,
      error: {
        code: 'TOO_LONG',
        message: `PIN must be at most ${maxLength} digits`,
      },
    };
  }

  // Check for weak patterns
  if (!allowWeakPatterns) {
    const isWeakPattern = WEAK_PATTERNS.some(pattern => pattern.test(trimmed));
    const isCommonWeak = COMMON_WEAK_PINS.includes(trimmed);

    if (isWeakPattern || isCommonWeak) {
      return {
        isValid: false,
        error: {
          code: 'WEAK_PATTERN',
          message: 'PIN is too easy to guess. Please choose a stronger PIN.',
        },
      };
    }
  }

  // Calculate strength
  const strength = calculatePINStrength(trimmed);

  return {
    isValid: true,
    strength,
  };
}

/**
 * Validate PIN confirmation matches
 */
export function validatePINConfirmation(
  pin: string,
  confirmPin: string
): PINValidationResult {
  // First validate the PIN itself
  const pinValidation = validatePIN(pin);
  if (!pinValidation.isValid) {
    return pinValidation;
  }

  // Check if confirmation matches
  if (pin !== confirmPin) {
    return {
      isValid: false,
      error: {
        code: 'MISMATCH',
        message: 'PINs do not match',
      },
    };
  }

  return pinValidation;
}

/**
 * Quick check if PIN is valid
 */
export function isValidPIN(pin: string, minLength: number = DEFAULT_MIN_LENGTH): boolean {
  if (!pin || typeof pin !== 'string') {
    return false;
  }

  const trimmed = pin.trim();
  return /^\d+$/.test(trimmed) && trimmed.length >= minLength;
}

/**
 * Check if PIN has only digits
 */
export function hasOnlyDigits(input: string): boolean {
  return /^\d*$/.test(input);
}

/**
 * Calculate PIN strength
 */
export function calculatePINStrength(pin: string): PINStrength {
  if (!pin || pin.length < 4) {
    return 'weak';
  }

  // Check for weak patterns
  const isWeakPattern = WEAK_PATTERNS.some(pattern => pattern.test(pin));
  const isCommonWeak = COMMON_WEAK_PINS.includes(pin);

  if (isWeakPattern || isCommonWeak) {
    return 'weak';
  }

  // Calculate uniqueness
  const uniqueDigits = new Set(pin.split('')).size;
  const uniquenessRatio = uniqueDigits / pin.length;

  // Check for repeated pairs
  const hasRepeatedPairs = /(\d{2})\1/.test(pin);

  // Calculate score
  let score = 0;

  // Length bonus
  if (pin.length >= 6) score += 2;
  else if (pin.length >= 5) score += 1;

  // Uniqueness bonus
  if (uniquenessRatio > 0.7) score += 2;
  else if (uniquenessRatio > 0.5) score += 1;

  // No repeated pairs bonus
  if (!hasRepeatedPairs) score += 1;

  // Determine strength
  if (score >= 4) return 'strong';
  if (score >= 2) return 'medium';
  return 'weak';
}

/**
 * Get PIN strength description
 */
export function getPINStrengthDescription(strength: PINStrength): {
  label: string;
  color: string;
  description: string;
} {
  switch (strength) {
    case 'strong':
      return {
        label: 'Strong',
        color: '#22C55E', // green
        description: 'Your PIN is secure',
      };
    case 'medium':
      return {
        label: 'Medium',
        color: '#F59E0B', // amber
        description: 'Consider using a longer PIN',
      };
    case 'weak':
    default:
      return {
        label: 'Weak',
        color: '#EF4444', // red
        description: 'Your PIN is easy to guess',
      };
  }
}

/**
 * Sanitize PIN input (keep only digits)
 */
export function sanitizePINInput(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Mask PIN for display
 */
export function maskPIN(pin: string, showLast: number = 0): string {
  if (!pin) return '';

  if (showLast <= 0 || showLast >= pin.length) {
    return '*'.repeat(pin.length);
  }

  const maskedLength = pin.length - showLast;
  return '*'.repeat(maskedLength) + pin.slice(-showLast);
}

/**
 * Get PIN requirements text
 */
export function getPINRequirements(options: PINValidationOptions = {}): string[] {
  const { minLength = DEFAULT_MIN_LENGTH, maxLength = DEFAULT_MAX_LENGTH } = options;

  const requirements = [
    `Must be ${minLength}-${maxLength} digits`,
    'Must contain only numbers',
    'Avoid sequential numbers (1234, 4321)',
    'Avoid repeated digits (1111, 0000)',
    'Avoid common PINs',
  ];

  return requirements;
}

/**
 * Check if PIN meets all requirements
 */
export function meetsPINRequirements(pin: string): {
  meetsLength: boolean;
  meetsDigitsOnly: boolean;
  avoidsSequential: boolean;
  avoidsRepeated: boolean;
  avoidsCommon: boolean;
} {
  const trimmed = pin?.trim() || '';

  return {
    meetsLength: trimmed.length >= DEFAULT_MIN_LENGTH && trimmed.length <= DEFAULT_MAX_LENGTH,
    meetsDigitsOnly: /^\d+$/.test(trimmed),
    avoidsSequential: !/(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)/.test(trimmed),
    avoidsRepeated: !/^(\d)\1+$/.test(trimmed),
    avoidsCommon: !COMMON_WEAK_PINS.includes(trimmed),
  };
}
