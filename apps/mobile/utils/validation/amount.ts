/**
 * Amount validation utilities for Protocol 01
 */

const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_SOL_SUPPLY = 500_000_000; // ~500M total supply
const MAX_LAMPORTS = MAX_SOL_SUPPLY * LAMPORTS_PER_SOL;

export interface AmountValidationResult {
  isValid: boolean;
  error?: AmountValidationError;
  parsedAmount?: number;
  lamports?: number;
}

export interface AmountValidationError {
  code: 'EMPTY' | 'INVALID_FORMAT' | 'NEGATIVE' | 'ZERO' | 'TOO_SMALL' | 'TOO_LARGE' | 'INSUFFICIENT_BALANCE' | 'EXCEEDS_MAX';
  message: string;
}

export interface AmountValidationOptions {
  allowZero?: boolean;
  minAmount?: number;
  maxAmount?: number;
  balance?: number;
  decimals?: number;
  reserveForFee?: number;
}

/**
 * Validate SOL amount string
 */
export function validateSOLAmount(
  amount: string,
  options: AmountValidationOptions = {}
): AmountValidationResult {
  const {
    allowZero = false,
    minAmount,
    maxAmount,
    balance,
    reserveForFee = 0,
  } = options;

  // Check for empty input
  if (!amount || typeof amount !== 'string') {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'Amount is required',
      },
    };
  }

  const trimmed = amount.trim();
  if (trimmed.length === 0) {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'Amount is required',
      },
    };
  }

  // Parse the amount
  const parsed = parseFloat(trimmed);

  // Check for valid number
  if (isNaN(parsed) || !isFinite(parsed)) {
    return {
      isValid: false,
      error: {
        code: 'INVALID_FORMAT',
        message: 'Invalid amount format',
      },
    };
  }

  // Check for negative
  if (parsed < 0) {
    return {
      isValid: false,
      error: {
        code: 'NEGATIVE',
        message: 'Amount cannot be negative',
      },
    };
  }

  // Check for zero
  if (parsed === 0 && !allowZero) {
    return {
      isValid: false,
      error: {
        code: 'ZERO',
        message: 'Amount must be greater than zero',
      },
    };
  }

  // Convert to lamports
  const lamports = Math.floor(parsed * LAMPORTS_PER_SOL);

  // Check minimum
  if (minAmount !== undefined && parsed < minAmount) {
    return {
      isValid: false,
      error: {
        code: 'TOO_SMALL',
        message: `Amount must be at least ${minAmount} SOL`,
      },
    };
  }

  // Check maximum
  if (maxAmount !== undefined && parsed > maxAmount) {
    return {
      isValid: false,
      error: {
        code: 'TOO_LARGE',
        message: `Amount cannot exceed ${maxAmount} SOL`,
      },
    };
  }

  // Check against max supply
  if (lamports > MAX_LAMPORTS) {
    return {
      isValid: false,
      error: {
        code: 'EXCEEDS_MAX',
        message: 'Amount exceeds maximum SOL supply',
      },
    };
  }

  // Check balance
  if (balance !== undefined) {
    const availableBalance = balance - reserveForFee;
    if (lamports > availableBalance) {
      return {
        isValid: false,
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: 'Insufficient balance',
        },
      };
    }
  }

  return {
    isValid: true,
    parsedAmount: parsed,
    lamports,
  };
}

/**
 * Validate token amount
 */
export function validateTokenAmount(
  amount: string,
  decimals: number,
  options: AmountValidationOptions = {}
): AmountValidationResult {
  const {
    allowZero = false,
    minAmount,
    maxAmount,
    balance,
  } = options;

  // Check for empty input
  if (!amount || typeof amount !== 'string') {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'Amount is required',
      },
    };
  }

  const trimmed = amount.trim();
  if (trimmed.length === 0) {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'Amount is required',
      },
    };
  }

  // Parse the amount
  const parsed = parseFloat(trimmed);

  // Check for valid number
  if (isNaN(parsed) || !isFinite(parsed)) {
    return {
      isValid: false,
      error: {
        code: 'INVALID_FORMAT',
        message: 'Invalid amount format',
      },
    };
  }

  // Check for negative
  if (parsed < 0) {
    return {
      isValid: false,
      error: {
        code: 'NEGATIVE',
        message: 'Amount cannot be negative',
      },
    };
  }

  // Check for zero
  if (parsed === 0 && !allowZero) {
    return {
      isValid: false,
      error: {
        code: 'ZERO',
        message: 'Amount must be greater than zero',
      },
    };
  }

  // Convert to smallest unit
  const rawAmount = Math.floor(parsed * Math.pow(10, decimals));

  // Check minimum
  if (minAmount !== undefined && parsed < minAmount) {
    return {
      isValid: false,
      error: {
        code: 'TOO_SMALL',
        message: `Amount must be at least ${minAmount}`,
      },
    };
  }

  // Check maximum
  if (maxAmount !== undefined && parsed > maxAmount) {
    return {
      isValid: false,
      error: {
        code: 'TOO_LARGE',
        message: `Amount cannot exceed ${maxAmount}`,
      },
    };
  }

  // Check balance
  if (balance !== undefined && rawAmount > balance) {
    return {
      isValid: false,
      error: {
        code: 'INSUFFICIENT_BALANCE',
        message: 'Insufficient balance',
      },
    };
  }

  return {
    isValid: true,
    parsedAmount: parsed,
    lamports: rawAmount,
  };
}

/**
 * Quick check if amount is valid
 */
export function isValidAmount(amount: string): boolean {
  if (!amount || typeof amount !== 'string') {
    return false;
  }

  const parsed = parseFloat(amount.trim());
  return !isNaN(parsed) && isFinite(parsed) && parsed > 0;
}

/**
 * Check if amount is valid number format
 */
export function isValidNumberFormat(amount: string): boolean {
  if (!amount || typeof amount !== 'string') {
    return false;
  }

  // Allow numbers with optional decimal point
  const numberRegex = /^\d*\.?\d*$/;
  return numberRegex.test(amount.trim()) && amount.trim().length > 0;
}

/**
 * Parse amount string to number safely
 */
export function parseAmount(amount: string): number {
  if (!amount || typeof amount !== 'string') {
    return 0;
  }

  const parsed = parseFloat(amount.trim());
  return isNaN(parsed) || !isFinite(parsed) ? 0 : parsed;
}

/**
 * Format input amount (remove invalid characters)
 */
export function sanitizeAmountInput(input: string): string {
  if (!input) return '';

  // Allow only digits and single decimal point
  let sanitized = input.replace(/[^\d.]/g, '');

  // Ensure only one decimal point
  const parts = sanitized.split('.');
  if (parts.length > 2) {
    sanitized = parts[0] + '.' + parts.slice(1).join('');
  }

  return sanitized;
}

/**
 * Limit decimal places for input
 */
export function limitDecimals(input: string, maxDecimals: number = 9): string {
  if (!input.includes('.')) {
    return input;
  }

  const [whole, decimal] = input.split('.');
  return decimal.length > maxDecimals
    ? `${whole}.${decimal.slice(0, maxDecimals)}`
    : input;
}

/**
 * Calculate max sendable amount (balance - fee reserve)
 */
export function calculateMaxSendable(
  balance: number,
  feeReserve: number = 5000 // 0.000005 SOL minimum
): number {
  const maxLamports = Math.max(0, balance - feeReserve);
  return maxLamports / LAMPORTS_PER_SOL;
}

/**
 * Check if user has minimum balance for transaction
 */
export function hasMinimumBalance(
  balance: number,
  amount: number,
  feeEstimate: number = 5000
): boolean {
  return balance >= amount + feeEstimate;
}
