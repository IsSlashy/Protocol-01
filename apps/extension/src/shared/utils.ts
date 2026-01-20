import { clsx, type ClassValue } from 'clsx';

/**
 * Merge Tailwind classes with clsx
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/**
 * Format a number as currency
 */
export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format a token amount with proper decimals
 */
export function formatTokenAmount(
  amount: number,
  decimals: number,
  maxDecimals = 4
): string {
  const value = amount / Math.pow(10, decimals);
  if (value === 0) return '0';
  if (value < 0.0001) return '<0.0001';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

/**
 * Truncate an address for display
 */
export function truncateAddress(address: string, chars = 4): string {
  if (!address) return '';
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Copy text to clipboard
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format relative time
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

/**
 * Format subscription period
 */
export function formatPeriod(seconds: number): string {
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  const weeks = days / 7;
  const months = days / 30;

  if (months >= 1) return months === 1 ? 'Monthly' : `Every ${Math.round(months)} months`;
  if (weeks >= 1) return weeks === 1 ? 'Weekly' : `Every ${Math.round(weeks)} weeks`;
  if (days >= 1) return days === 1 ? 'Daily' : `Every ${Math.round(days)} days`;
  if (hours >= 1) return `Every ${Math.round(hours)} hours`;
  return `Every ${Math.round(minutes)} minutes`;
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return crypto.randomUUID();
}
