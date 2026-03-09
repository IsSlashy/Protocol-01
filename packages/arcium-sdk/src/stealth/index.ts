import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC5: Threshold Stealth Scanning
 *
 * Problem: Stealth payment scanning requires the viewing private key.
 * If this key is on a single device and that device is compromised,
 * the attacker can enumerate ALL incoming payments (transaction graph leak).
 *
 * Solution: Viewing key is sharded across MPC nodes via Shamir secret sharing.
 * MPC nodes jointly compute the X25519 shared secret and view-tag
 * without ever reconstructing the full viewing key.
 *
 * Flow:
 * 1. User registers viewing key shares with Arcium MXE (one-time setup)
 * 2. To scan: user submits encrypted list of ephemeral pubkeys from announcements
 * 3. MPC computes: sharedSecret = X25519(viewingKey_shares, ephemeralPubKey)
 * 4. MPC computes: viewTag = SHA3(sharedSecret)[0]
 * 5. MPC compares viewTag with announcement's viewTag
 * 6. Returns encrypted list of matching announcement indices
 * 7. User decrypts → knows which announcements are for them
 */

export interface StealthScanRequest {
  /** Ephemeral public keys from on-chain announcements */
  ephemeralPubKeys: Uint8Array[];
  /** View tags from on-chain announcements (1 byte each) */
  viewTags: number[];
}

export interface StealthScanResult {
  /** Indices of matching announcements (these are for you) */
  matchingIndices: number[];
  /** Computation signature */
  signature: string;
}

export interface ViewingKeySetup {
  /** MXE-encrypted viewing key (stored on-chain, only MPC can decrypt) */
  encryptedViewingKey: number[];
  /** Setup transaction signature */
  signature: string;
}

const VIEWING_KEY_SEED = 'p01_viewing_key';
const SCAN_BATCH_SIZE = 32; // Max announcements per MPC batch

/** Derive the encrypted viewing key PDA */
export function getViewingKeyAddress(
  programId: PublicKey,
  owner: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VIEWING_KEY_SEED), owner.toBuffer()],
    programId
  );
}

/**
 * Register viewing key with Arcium MXE (one-time setup).
 *
 * The viewing key is encrypted and stored in MXE state.
 * Only MPC nodes can access it (threshold decryption).
 * Even if one node is compromised, the key remains safe.
 */
export async function registerViewingKey(
  client: ArciumClient,
  program: anchor.Program,
  viewingPrivateKey: Uint8Array
): Promise<ViewingKeySetup> {
  // Encrypt the 32-byte viewing private key as 4 u64 chunks
  const chunks: bigint[] = [];
  for (let i = 0; i < 32; i += 8) {
    chunks.push(
      BigInt(
        '0x' +
          Buffer.from(viewingPrivateKey.slice(i, i + 8))
            .reverse()
            .toString('hex')
      )
    );
  }

  const payload = client.encrypt(chunks);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.STEALTH_SCAN, computationOffset);
  const [viewingKeyAddress] = getViewingKeyAddress(client.programId, client.wallet.publicKey);

  const sig = await program.methods
    .registerViewingKey(
      computationOffset,
      Array.from(payload.ciphertexts[0]),
      Array.from(payload.ciphertexts[1]),
      Array.from(payload.ciphertexts[2]),
      Array.from(payload.ciphertexts[3]),
      Array.from(payload.publicKey),
      client.nonceToU128(payload.nonce)
    )
    .accountsPartial({
      ...accounts,
      viewingKeyAccount: viewingKeyAddress,
      owner: client.wallet.publicKey,
    })
    .rpc({ commitment: 'confirmed' });

  await client.awaitFinalization(computationOffset);

  return {
    encryptedViewingKey: payload.ciphertexts[0],
    signature: sig,
  };
}

/**
 * Scan announcements using MPC-protected viewing key.
 *
 * Processes in batches of SCAN_BATCH_SIZE announcements.
 * Returns indices of announcements that match (belong to this user).
 */
export async function scanAnnouncements(
  client: ArciumClient,
  program: anchor.Program,
  request: StealthScanRequest
): Promise<StealthScanResult> {
  if (request.ephemeralPubKeys.length !== request.viewTags.length) {
    throw new Error('ephemeralPubKeys and viewTags must have same length');
  }

  const allMatches: number[] = [];
  let lastSig = '';

  // Process in batches
  for (let i = 0; i < request.ephemeralPubKeys.length; i += SCAN_BATCH_SIZE) {
    const batchKeys = request.ephemeralPubKeys.slice(i, i + SCAN_BATCH_SIZE);
    const batchTags = request.viewTags.slice(i, i + SCAN_BATCH_SIZE);

    // Pack batch: each ephemeral key (32 bytes) + view tag (1 byte)
    const batchValues: bigint[] = [];
    for (let j = 0; j < batchKeys.length; j++) {
      // Pack 32-byte key as 4 u64 chunks
      for (let k = 0; k < 32; k += 8) {
        batchValues.push(
          BigInt(
            '0x' +
              Buffer.from(batchKeys[j].slice(k, k + 8))
                .reverse()
                .toString('hex')
          )
        );
      }
      // Pack view tag
      batchValues.push(BigInt(batchTags[j]));
    }

    // Pad to fixed batch size (MPC circuits need fixed dimensions)
    while (batchValues.length < SCAN_BATCH_SIZE * 5) {
      batchValues.push(0n); // padding
    }

    const payload = client.encrypt(batchValues);
    const computationOffset = client.newComputationOffset();
    const accounts = client.getComputationAccounts(CIRCUITS.STEALTH_SCAN, computationOffset);
    const [viewingKeyAddress] = getViewingKeyAddress(client.programId, client.wallet.publicKey);

    await program.methods
      .scanBatch(
        computationOffset,
        payload.ciphertexts.map((ct) => Array.from(ct)),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce),
        batchKeys.length
      )
      .accountsPartial({
        ...accounts,
        viewingKeyAccount: viewingKeyAddress,
        owner: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });

    const finalizeSig = await client.awaitFinalization(computationOffset);
    lastSig = finalizeSig;

    // Parse matching indices from callback
    const tx = await client.connection.getTransaction(finalizeSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    const logs = tx?.meta?.logMessages || [];
    const matchLine = logs.find((l) => l.includes('ScanMatches:'));
    if (matchLine) {
      const indices = matchLine
        .split('ScanMatches:')[1]
        .trim()
        .split(',')
        .filter((s) => s.length > 0)
        .map((s) => parseInt(s, 10) + i); // offset by batch start
      allMatches.push(...indices);
    }
  }

  return { matchingIndices: allMatches, signature: lastSig };
}
