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
import { getConnection } from '../solana/connection';
import { getMpcClient, getArciumProgram, isMpcClientReady } from './mpcClient';
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
  const sig = await relayTransaction(serializedTx, walletPublicKey, signTransaction, timeoutMs);
  return { signature: sig, feePaid: 0n, wasMpcProtected: false };
}

/**
 * MPC threshold relay — N nodes jointly decrypt the TX.
 */
async function mpcRelay(
  serializedTx: Uint8Array,
  feeLamports?: bigint
): Promise<RelayJobResult> {
  const client = await getMpcClient();
  const program = await getArciumProgram();
  if (!client || !program) throw new Error('MPC client not ready');

  const { relayTransaction: sdkRelay } = await import('@protocol-01/arcium-sdk');

  // Get a deadline ~100 slots from now (~40 seconds)
  const connection = getConnection();
  const slot = await connection.getSlot('confirmed');
  const deadlineSlot = BigInt(slot) + 100n;
  const fee = feeLamports ?? 10_000_000n; // Default 0.01 SOL

  const result = await sdkRelay(client, program, serializedTx, fee, deadlineSlot);

  return {
    signature: result.relayedTxSignature || result.signature,
    feePaid: result.feePaid,
    wasMpcProtected: true,
  };
}
