/**
 * MPC Confidential Relay — threshold TX decryption via Arcium.
 *
 * Standard flow: User encrypts TX for a SINGLE relayer node →
 *   relayer decrypts and sees plaintext amounts/recipients.
 *
 * MPC flow: User encrypts TX with MXE key → N Arcium MPC nodes
 *   jointly decrypt via threshold decryption (Cerberus protocol) →
 *   no single node ever sees the plaintext TX.
 *
 * Falls back to standard (single-relayer) when MPC is unavailable.
 */

import { PublicKey, Transaction } from '@solana/web3.js';
import { isMpcClientReady } from './mpcClient';
import { useArciumStore } from '../../stores/arciumStore';

export interface RelayJobResult {
  /** On-chain signature of the relayed transaction */
  signature: string;
  /** Fee paid (lamports) */
  feePaid: bigint;
  /** Whether MPC threshold decryption was used */
  wasMpcProtected: boolean;
}

/**
 * Submit a transaction through the relay network.
 *
 * When MPC is enabled: TX is encrypted with the MXE's public key.
 * N MPC nodes jointly decrypt (no single node sees plaintext).
 *
 * When MPC is disabled: standard single-relayer encryption (X25519 + XSalsa20).
 */
export async function confidentialRelay(
  serializedTx: Uint8Array,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  feeLamports?: bigint,
  timeoutMs?: number
): Promise<RelayJobResult> {
  const { mpcEnabled } = useArciumStore.getState();

  if (mpcEnabled && isMpcClientReady()) {
    try {
      return await mpcRelay(serializedTx, feeLamports);
    } catch (e: any) {
      console.warn('[MPC] Confidential relay failed, falling back to standard:', e.message);
    }
  }

  // Fallback: standard single-relayer
  const { relayTransaction } = await import('../relay');
  const sig = await relayTransaction(serializedTx, walletPublicKey, signTransaction, { timeoutMs });
  return { signature: sig, feePaid: 0n, wasMpcProtected: false };
}

/**
 * MPC threshold relay — Phase D Alt 1 (recipient-only sidecar).
 *
 * The legacy maximal-design (encrypt the full serialized TX, let MPC
 * decrypt + broadcast) was replaced on 2026-05-27 by the Alt 1 model
 * that encrypts ONLY the recipient pubkey and keeps the rest of the
 * unshield flowing through the existing Phase A `p01_relayer`. The
 * new SDK API requires the caller to coordinate two ix submissions
 * (Phase A submit_job + Phase D submit_confidential_relay) — a
 * restructuring of this mobile call-site, tracked in D.6.
 *
 * For now: surface a clear error so the standard fallback path
 * activates. mpcEnabled can stay on; this just routes through the
 * trusted single-relayer until the Alt 1 mobile wiring lands.
 *
 * @internal Migration tracked in docs/phase-d-orchestration-decision.md
 */
async function mpcRelay(
  _serializedTx: Uint8Array,
  _feeLamports?: bigint
): Promise<RelayJobResult> {
  throw new Error(
    'MPC confidential relay is being migrated to Phase D Alt 1 (recipient-only). ' +
    'Mobile wiring lands in a follow-up; falling back to standard relayer.'
  );
}
