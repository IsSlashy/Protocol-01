/**
 * Deterministic relayer selection.
 *
 * Uses SHA-256(recent_blockhash || job_id) mod active_relayer_count
 * to select a relayer. This prevents users from choosing a colluding
 * relayer while distributing jobs fairly.
 */

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import type { RelayerNodeInfo, RelayerConfigInfo } from './types';
import { RELAY_SEEDS } from './types';

/**
 * Fetch all active relayer nodes from on-chain state.
 */
export async function fetchActiveRelayers(
  connection: Connection,
  programId: PublicKey,
): Promise<RelayerNodeInfo[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      // Anchor discriminator for RelayerNode (8 bytes)
      // Filter by is_active = true at the correct offset
      // RelayerNode layout: 8 (disc) + 32 (operator) + 32 (enc_key) + 8 (stake)
      //   + 8 (jobs_completed) + 8 (jobs_failed) + 8 (last_active_slot)
      //   + 8 (registered_at) + 8 (deactivated_at_slot) + 1 (is_active)
      // is_active offset = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 = 120
      { memcmp: { offset: 120, bytes: '2' } }, // base58 for [1] (true)
    ],
  });

  return accounts.map((acc) => {
    const data = acc.account.data;
    return {
      address: acc.pubkey,
      operator: new PublicKey(data.slice(8, 40)),
      encryptionKey: new Uint8Array(data.slice(40, 72)),
      stake: Number(data.readBigUInt64LE(72)),
      jobsCompleted: Number(data.readBigUInt64LE(80)),
      jobsFailed: Number(data.readBigUInt64LE(88)),
      reputationScore: data.readUInt32LE(120 + 1), // after is_active
      isActive: data[120] === 1,
    } as RelayerNodeInfo;
  }).filter((r) => r.isActive);
}

/**
 * Fetch the global relayer config.
 */
export async function fetchRelayerConfig(
  connection: Connection,
  programId: PublicKey,
): Promise<RelayerConfigInfo | null> {
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(RELAY_SEEDS.CONFIG)],
    programId,
  );

  const info = await connection.getAccountInfo(configPda);
  if (!info) return null;

  const data = info.data;
  return {
    authority: new PublicKey(data.slice(8, 40)),
    minStake: Number(data.readBigUInt64LE(40)),
    maxRelayers: data.readUInt16LE(48),
    jobFeeLamports: Number(data.readBigUInt64LE(50)),
    protocolFeeBps: data.readUInt16LE(58),
    protocolFeeWallet: new PublicKey(data.slice(60, 92)),
    jobTimeoutSlots: Number(data.readBigUInt64LE(92)),
    activeRelayerCount: data.readUInt16LE(116),
    isActive: data[126] === 1,
  };
}

/**
 * Deterministic relayer selection.
 *
 * @param relayers - Sorted list of active relayers
 * @param recentBlockhash - Recent blockhash for entropy
 * @param jobId - Unique job identifier (32 bytes)
 * @returns Selected relayer and its index
 */
export function selectRelayer(
  relayers: RelayerNodeInfo[],
  recentBlockhash: string,
  jobId: Uint8Array,
): { relayer: RelayerNodeInfo; index: number } {
  if (relayers.length === 0) {
    throw new Error('No active relayers available');
  }

  if (relayers.length === 1) {
    return { relayer: relayers[0]!, index: 0 };
  }

  // Sort by address for deterministic ordering
  const sorted = [...relayers].sort((a, b) =>
    a.address.toBase58().localeCompare(b.address.toBase58()),
  );

  // SHA-256(blockhash || job_id) mod count
  const entropy = new Uint8Array(64 + jobId.length);
  entropy.set(Buffer.from(recentBlockhash, 'base64'), 0);
  entropy.set(jobId, 64);

  const hash = sha256(entropy);

  // Use first 4 bytes as uint32 for modular selection
  const value = (hash[0]! | (hash[1]! << 8) | (hash[2]! << 16) | (hash[3]! << 24)) >>> 0;
  const index = value % sorted.length;

  return { relayer: sorted[index]!, index };
}
