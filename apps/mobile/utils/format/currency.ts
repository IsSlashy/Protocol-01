/**
 * Currency formatting utilities for Protocol 01
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Format lamports to SOL with specified decimal places
 */
export function formatSOL(lamports: number, decimals: number = 4): string {
  if (!Number.isFinite(lamports) || lamports < 0) {
    return '0.0000';
  }
  return (lamports / LAMPORTS_PER_SOL).toFixed(decimals);
}

/**
 * Format amount as USD currency
 */
export function formatUSD(amount: number): string {
  if (!Number.isFinite(amount)) {
    return '$0.00';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

/**
 * Convert SOL to USD
 */
export function solToUSD(solAmount: number, solPrice: number): number {
  if (!Number.isFinite(solAmount) || !Number.isFinite(solPrice)) {
    return 0;
  }
  return solAmount * solPrice;
}

/**
 * Convert lamports to USD
 */
export function lamportsToUSD(lamports: number, solPrice: number): number {
  const sol = lamports / LAMPORTS_PER_SOL;
  return solToUSD(sol, solPrice);
}

/**
 * Format lamports directly to USD string
 */
export function formatLamportsToUSD(lamports: number, solPrice: number): string {
  return formatUSD(lamportsToUSD(lamports, solPrice));
}

/**
 * Parse SOL string to lamports
 */
export function parseSOLToLamports(solString: string): number {
  const parsed = parseFloat(solString);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed * LAMPORTS_PER_SOL);
}

/**
 * Format token amount with decimals
 */
export function formatTokenAmount(
  amount: number,
  decimals: number,
  displayDecimals: number = 4
): string {
  if (!Number.isFinite(amount) || amount < 0) {
    return '0';
  }
  const value = amount / Math.pow(10, decimals);
  return value.toFixed(displayDecimals);
}

/**
 * Format compact currency (e.g., $1.2K, $3.4M)
 */
export function formatCompactUSD(amount: number): string {
  if (!Number.isFinite(amount)) {
    return '$0';
  }

  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  });

  return formatter.format(amount);
}

/**
 * Format percentage
 */
export function formatPercentage(value: number, decimals: number = 2): string {
  if (!Number.isFinite(value)) {
    return '0%';
  }
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format price change with sign
 */
export function formatPriceChange(change: number): string {
  if (!Number.isFinite(change)) {
    return '0.00%';
  }
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}
