/**
 * MPC Private Registry Lookup — stealth meta-address query without
 * revealing the target wallet to RPC nodes.
 *
 * Standard flow: getAccountInfo(registryPDA) → RPC sees target wallet
 * MPC flow: encrypt(wallet) → MPC queries registry → decrypt result
 *
 * Throws when MPC is enabled but fails (no silent fallback to public).
 * Uses standard (public) lookup only when MPC is explicitly disabled.
 */

import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import { getMpcClient, getArciumProgram, isMpcClientReady } from './mpcClient';
import { useArciumStore } from '../../stores/arciumStore';

export interface StealthMetaAddress {
  isRegistered: boolean;
  spendingPubKey: Uint8Array | null;
  viewingPubKey: Uint8Array | null;
  hasKemKey: boolean;
  kemPubKey: Uint8Array | null;
  /** Whether this lookup used MPC (true) or public RPC (false) */
  wasMpcProtected: boolean;
}

const P01_REGISTRY_PROGRAM_ID = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
const REGISTRY_SEED = 'user_registry';
const REGISTRY_DISCRIMINATOR_SIZE = 8;
const PUBKEY_SIZE = 32;

function getRegistryPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(REGISTRY_SEED), wallet.toBuffer()],
    P01_REGISTRY_PROGRAM_ID
  );
}

/**
 * Look up a stealth meta-address for a target wallet.
 *
 * When MPC is enabled: encrypts the target wallet address, MPC queries
 * the registry, and the result is decrypted client-side. The RPC node
 * never sees which wallet you're querying.
 *
 * When MPC is disabled: standard public RPC query (getAccountInfo).
 */
export async function lookupMetaAddress(
  targetWallet: PublicKey,
  forceMpc?: boolean
): Promise<StealthMetaAddress> {
  const { mpcEnabled } = useArciumStore.getState();

  // MPC path: required when enabled — no silent fallback to public
  if (mpcEnabled || forceMpc) {
    if (!isMpcClientReady()) {
      throw new Error('MPC client is not ready. Cannot perform private lookup.');
    }
    return await mpcLookup(targetWallet);
  }

  // Standard (public) lookup — only when MPC is explicitly disabled
  return publicLookup(targetWallet);
}

/**
 * MPC-protected registry lookup.
 * Uses @protocol-01/arcium-sdk privateLookup under the hood.
 */
async function mpcLookup(targetWallet: PublicKey): Promise<StealthMetaAddress> {
  const client = await getMpcClient();
  const program = await getArciumProgram();
  if (!client || !program) throw new Error('MPC client not ready');

  const { privateLookup: sdkLookup } = await import('@protocol-01/arcium-sdk');
  const result = await sdkLookup(client, program, targetWallet);

  return {
    isRegistered: result.isRegistered,
    spendingPubKey: result.spendingPubKey,
    viewingPubKey: result.viewingPubKey,
    hasKemKey: result.hasKemKey,
    kemPubKey: result.kemPubKey,
    wasMpcProtected: true,
  };
}

/**
 * Standard (public) registry lookup via RPC getAccountInfo.
 * The RPC node sees which wallet you're querying.
 */
async function publicLookup(targetWallet: PublicKey): Promise<StealthMetaAddress> {
  const connection = getConnection();
  const [pda] = getRegistryPDA(targetWallet);
  const info = await connection.getAccountInfo(pda);

  if (!info || !info.data || info.data.length < REGISTRY_DISCRIMINATOR_SIZE + PUBKEY_SIZE * 3) {
    return {
      isRegistered: false,
      spendingPubKey: null,
      viewingPubKey: null,
      hasKemKey: false,
      kemPubKey: null,
      wasMpcProtected: false,
    };
  }

  const data = info.data;
  let offset = REGISTRY_DISCRIMINATOR_SIZE;

  // Skip owner pubkey (32 bytes)
  offset += PUBKEY_SIZE;

  // spending_pub_key (32 bytes)
  const spendingPubKey = data.slice(offset, offset + PUBKEY_SIZE);
  offset += PUBKEY_SIZE;

  // viewing_pub_key (32 bytes)
  const viewingPubKey = data.slice(offset, offset + PUBKEY_SIZE);
  offset += PUBKEY_SIZE;

  // version (1 byte)
  const version = data[offset];
  offset += 1;

  // has_kem_key (1 byte)
  const hasKemKey = data[offset] === 1;
  offset += 1;

  // kem_pub_key (1184 bytes, if present)
  let kemPubKey: Uint8Array | null = null;
  if (hasKemKey && data.length >= offset + 1184) {
    kemPubKey = data.slice(offset, offset + 1184);
  }

  return {
    isRegistered: true,
    spendingPubKey: new Uint8Array(spendingPubKey),
    viewingPubKey: new Uint8Array(viewingPubKey),
    hasKemKey,
    kemPubKey: kemPubKey ? new Uint8Array(kemPubKey) : null,
    wasMpcProtected: false,
  };
}
