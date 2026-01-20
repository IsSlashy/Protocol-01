/**
 * Protocol 01 Security Module
 *
 * This module provides high-level security features for the SDK:
 * - Zero-Knowledge Proofs via Light Protocol
 * - Stealth Addresses (DKSAP)
 * - End-to-End Encryption
 * - Confidential Transactions
 *
 * All features are designed to be non-invasive - users can opt-in
 * to privacy features without changing their workflow.
 */

// Core security primitives
export * from './crypto';
export * from './stealth';
export * from './confidential';
export * from './encryption';

// Security manager (orchestrates all features)
export { SecurityManager, type SecurityConfig } from './manager';

// Types
export type {
  StealthKeyPair,
  StealthAddress,
  EncryptedPayload,
  ConfidentialAmount,
  ZKProof,
  SecurityLevel,
} from './types';
