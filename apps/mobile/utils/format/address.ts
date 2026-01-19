/**
 * Address formatting utilities for Protocol 01
 */

// Base58 character set (excludes 0, O, I, l)
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Truncate a Solana address for display
 */
export function truncateAddress(address: string, chars: number = 4): string {
  if (!address || typeof address !== 'string') {
    return '';
  }

  if (address.length <= chars * 2 + 3) {
    return address;
  }

  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Truncate address with custom separator
 */
export function truncateAddressCustom(
  address: string,
  startChars: number = 4,
  endChars: number = 4,
  separator: string = '...'
): string {
  if (!address || typeof address !== 'string') {
    return '';
  }

  if (address.length <= startChars + endChars + separator.length) {
    return address;
  }

  return `${address.slice(0, startChars)}${separator}${address.slice(-endChars)}`;
}

/**
 * Check if string is a valid Solana address format
 */
export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  return BASE58_REGEX.test(address);
}

/**
 * Check if address is a valid public key (32 bytes in base58)
 */
export function isValidPublicKey(address: string): boolean {
  if (!isValidSolanaAddress(address)) {
    return false;
  }
  // Valid Solana public keys are 32-44 characters in base58
  return address.length >= 32 && address.length <= 44;
}

/**
 * Format address for display with optional label
 */
export function formatAddressWithLabel(
  address: string,
  label?: string,
  truncateChars: number = 4
): string {
  if (!address) {
    return '';
  }

  const truncated = truncateAddress(address, truncateChars);

  if (label) {
    return `${label} (${truncated})`;
  }

  return truncated;
}

/**
 * Compare two addresses (case-sensitive for Solana)
 */
export function addressesMatch(address1: string, address2: string): boolean {
  if (!address1 || !address2) {
    return false;
  }
  return address1 === address2;
}

/**
 * Get address checksum (first and last 4 chars for verification)
 */
export function getAddressChecksum(address: string): string {
  if (!address || address.length < 8) {
    return '';
  }
  return `${address.slice(0, 4)}${address.slice(-4)}`;
}

/**
 * Mask address for sensitive display (shows only first/last chars)
 */
export function maskAddress(
  address: string,
  visibleStart: number = 2,
  visibleEnd: number = 2
): string {
  if (!address || typeof address !== 'string') {
    return '';
  }

  if (address.length <= visibleStart + visibleEnd) {
    return address;
  }

  const maskedLength = address.length - visibleStart - visibleEnd;
  const masked = '*'.repeat(Math.min(maskedLength, 8));

  return `${address.slice(0, visibleStart)}${masked}${address.slice(-visibleEnd)}`;
}

/**
 * Format address for QR code display (full address with line breaks)
 */
export function formatAddressForQR(address: string, chunkSize: number = 11): string {
  if (!address) {
    return '';
  }

  const chunks: string[] = [];
  for (let i = 0; i < address.length; i += chunkSize) {
    chunks.push(address.slice(i, i + chunkSize));
  }

  return chunks.join('\n');
}
