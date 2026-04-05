/**
 * Arcium MPC Service — Confidential compute layer for Protocol 01.
 *
 * This service wraps @protocol-01/arcium-sdk for mobile use. It provides:
 * - Anonymous stealth address lookup (private_lookup)
 * - MPC-hidden nullifier commitment (nullifier_commit)
 * - Confidential relay job submission (threshold_decrypt)
 *
 * All operations are opt-in and transparent to existing flows.
 * When MPC is disabled, callers fall back to standard (non-MPC) paths.
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { getConnection } from '../solana/connection';

// Re-export the deployed program ID
export const P01_ARCIUM_PROGRAM_ID = new PublicKey(
  'FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT'
);

export const ARCIUM_CLUSTER_OFFSET = 456;

/** MPC readiness status */
export type ArciumStatus = 'idle' | 'initializing' | 'ready' | 'error' | 'disabled';

/** ArciumClient type (lazy-imported from @protocol-01/arcium-sdk) */
export type { ArciumClientConfig } from '@protocol-01/arcium-sdk';

/**
 * Lightweight check: can the current RPC reach the Arcium program?
 * Returns true if the program account exists on-chain.
 */
export async function isArciumAvailable(): Promise<boolean> {
  try {
    const connection = getConnection();
    const info = await connection.getAccountInfo(P01_ARCIUM_PROGRAM_ID);
    return info !== null;
  } catch {
    return false;
  }
}

/**
 * Privacy layer labels for UI display.
 */
export const PRIVACY_LAYERS = {
  zk: { label: 'ZK-SNARKs', icon: 'lock-closed' as const, color: '#8b5cf6' },
  stark: { label: 'STARKs', icon: 'shield-checkmark' as const, color: '#06b6d4' },
  mpc: { label: 'MPC', icon: 'git-network' as const, color: '#f59e0b' },
} as const;

// ── MPC Operations ──────────────────────────────────────────────────
// Each operation falls back to standard (non-MPC) path when disabled.

export { getMpcClient, resetMpcClient, isMpcClientReady } from './mpcClient';
export { lookupMetaAddress } from './privateLookup';
export type { StealthMetaAddress } from './privateLookup';
export { commitNullifier, checkNullifierSpent } from './nullifierCommit';
export type { NullifierResult } from './nullifierCommit';
export { confidentialRelay } from './confidentialRelay';
export type { RelayJobResult } from './confidentialRelay';
