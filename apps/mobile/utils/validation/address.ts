/**
 * Address validation utilities for Protocol 01
 */

import { PublicKey } from '@solana/web3.js';

// Base58 character set (excludes 0, O, I, l)
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface AddressValidationResult {
  isValid: boolean;
  error?: AddressValidationError;
  normalizedAddress?: string;
}

export interface AddressValidationError {
  code: 'EMPTY' | 'INVALID_FORMAT' | 'INVALID_LENGTH' | 'INVALID_CHARACTERS' | 'INVALID_PUBKEY';
  message: string;
}

/**
 * Validate a Solana address
 */
export function validateSolanaAddress(address: string): AddressValidationResult {
  // Check for empty input
  if (!address || typeof address !== 'string') {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'Address is required',
      },
    };
  }

  const trimmed = address.trim();

  // Check for empty after trim
  if (trimmed.length === 0) {
    return {
      isValid: false,
      error: {
        code: 'EMPTY',
        message: 'Address is required',
      },
    };
  }

  // Check length
  if (trimmed.length < 32 || trimmed.length > 44) {
    return {
      isValid: false,
      error: {
        code: 'INVALID_LENGTH',
        message: `Address must be 32-44 characters, got ${trimmed.length}`,
      },
    };
  }

  // Check Base58 format
  if (!BASE58_REGEX.test(trimmed)) {
    const invalidChars = findInvalidChars(trimmed);
    return {
      isValid: false,
      error: {
        code: 'INVALID_CHARACTERS',
        message: `Address contains invalid characters: ${invalidChars.join(', ')}`,
      },
    };
  }

  // Validate as PublicKey
  try {
    new PublicKey(trimmed);
    return {
      isValid: true,
      normalizedAddress: trimmed,
    };
  } catch {
    return {
      isValid: false,
      error: {
        code: 'INVALID_PUBKEY',
        message: 'Address is not a valid Solana public key',
      },
    };
  }
}

/**
 * Quick check if address format is valid
 */
export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  const trimmed = address.trim();
  if (!BASE58_REGEX.test(trimmed)) {
    return false;
  }

  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if address is a valid public key format (without full validation)
 */
export function isValidPublicKeyFormat(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  return BASE58_REGEX.test(address.trim());
}

/**
 * Validate program ID
 */
export function isValidProgramId(programId: string): boolean {
  return isValidSolanaAddress(programId);
}

/**
 * Validate mint address
 */
export function isValidMintAddress(mintAddress: string): boolean {
  return isValidSolanaAddress(mintAddress);
}

/**
 * Check if address is a system program address
 */
export function isSystemProgramAddress(address: string): boolean {
  const systemPrograms = [
    '11111111111111111111111111111111', // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022 Program
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', // Metaplex Token Metadata
  ];

  return systemPrograms.includes(address);
}

/**
 * Check if address could be a token account
 */
export function isPossibleTokenAccount(address: string): boolean {
  // Token accounts are PDAs, which have specific characteristics
  // but for basic validation, we just check if it's a valid address
  return isValidSolanaAddress(address);
}

/**
 * Normalize address (trim whitespace)
 */
export function normalizeAddress(address: string): string {
  if (!address || typeof address !== 'string') {
    return '';
  }
  return address.trim();
}

/**
 * Compare two addresses
 */
export function addressesEqual(address1: string, address2: string): boolean {
  if (!address1 || !address2) {
    return false;
  }
  return normalizeAddress(address1) === normalizeAddress(address2);
}

/**
 * Get address type hint
 */
export function getAddressTypeHint(address: string): string {
  if (!isValidSolanaAddress(address)) {
    return 'invalid';
  }

  if (isSystemProgramAddress(address)) {
    return 'system_program';
  }

  // Check for common patterns
  if (address.startsWith('So11111111')) {
    return 'wrapped_sol';
  }

  return 'unknown';
}

/**
 * Find invalid characters in string
 */
function findInvalidChars(str: string): string[] {
  const invalid: string[] = [];
  for (const char of str) {
    if (!BASE58_CHARS.includes(char) && !invalid.includes(char)) {
      invalid.push(char);
    }
  }
  return invalid;
}

/**
 * Convert PublicKey to base58 string safely
 */
export function publicKeyToBase58(pubkey: PublicKey | string): string {
  if (typeof pubkey === 'string') {
    return pubkey;
  }
  return pubkey.toBase58();
}

/**
 * Parse address string to PublicKey
 */
export function parsePublicKey(address: string): PublicKey | null {
  try {
    return new PublicKey(address);
  } catch {
    return null;
  }
}
