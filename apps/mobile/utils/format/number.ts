/**
 * Number formatting utilities for Protocol 01
 */

/**
 * Format number with thousand separators
 */
export function formatNumber(
  value: number,
  locale: string = 'en-US',
  options?: Intl.NumberFormatOptions
): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Format number with specified decimal places
 */
export function formatDecimal(value: number, decimals: number = 2): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return value.toFixed(decimals);
}

/**
 * Format large numbers in compact notation (e.g., 1.2K, 3.4M, 5.6B)
 */
export function formatCompact(
  value: number,
  locale: string = 'en-US'
): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Format number with custom suffix (K, M, B, T)
 */
export function formatWithSuffix(value: number, decimals: number = 1): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absValue >= 1e12) {
    return `${sign}${(absValue / 1e12).toFixed(decimals)}T`;
  }
  if (absValue >= 1e9) {
    return `${sign}${(absValue / 1e9).toFixed(decimals)}B`;
  }
  if (absValue >= 1e6) {
    return `${sign}${(absValue / 1e6).toFixed(decimals)}M`;
  }
  if (absValue >= 1e3) {
    return `${sign}${(absValue / 1e3).toFixed(decimals)}K`;
  }

  return `${sign}${absValue.toFixed(decimals)}`;
}

/**
 * Format as ordinal (1st, 2nd, 3rd, etc.)
 */
export function formatOrdinal(value: number): string {
  if (!Number.isInteger(value)) {
    return String(value);
  }

  const absValue = Math.abs(value);
  const lastTwo = absValue % 100;
  const lastOne = absValue % 10;

  let suffix: string;

  if (lastTwo >= 11 && lastTwo <= 13) {
    suffix = 'th';
  } else if (lastOne === 1) {
    suffix = 'st';
  } else if (lastOne === 2) {
    suffix = 'nd';
  } else if (lastOne === 3) {
    suffix = 'rd';
  } else {
    suffix = 'th';
  }

  return `${value}${suffix}`;
}

/**
 * Format bytes to human readable size
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (!Number.isFinite(bytes) || bytes === 0) {
    return '0 B';
  }

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(decimals)} ${sizes[i]}`;
}

/**
 * Clamp a number between min and max values
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Round to specified precision
 */
export function roundToPrecision(value: number, precision: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const multiplier = Math.pow(10, precision);
  return Math.round(value * multiplier) / multiplier;
}

/**
 * Format number as percentage
 */
export function toPercentage(
  value: number,
  total: number,
  decimals: number = 1
): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total === 0) {
    return '0%';
  }

  return `${((value / total) * 100).toFixed(decimals)}%`;
}

/**
 * Parse formatted number string back to number
 */
export function parseFormattedNumber(str: string): number {
  if (!str || typeof str !== 'string') {
    return 0;
  }

  // Remove currency symbols, spaces, and thousand separators
  const cleaned = str.replace(/[$,\s]/g, '');
  const parsed = parseFloat(cleaned);

  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Format number with plus/minus sign
 */
export function formatWithSign(value: number, decimals: number = 2): string {
  if (!Number.isFinite(value)) {
    return '+0';
  }

  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}`;
}

/**
 * Pad number with leading zeros
 */
export function padNumber(value: number, length: number): string {
  if (!Number.isFinite(value)) {
    return '0'.repeat(length);
  }

  return Math.abs(Math.floor(value)).toString().padStart(length, '0');
}

/**
 * Format number range
 */
export function formatRange(min: number, max: number, decimals: number = 0): string {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return '-';
  }

  return `${min.toFixed(decimals)} - ${max.toFixed(decimals)}`;
}

/**
 * Check if value is within range
 */
export function isInRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Calculate percentage change
 */
export function percentageChange(oldValue: number, newValue: number): number {
  if (!Number.isFinite(oldValue) || !Number.isFinite(newValue) || oldValue === 0) {
    return 0;
  }

  return ((newValue - oldValue) / Math.abs(oldValue)) * 100;
}
