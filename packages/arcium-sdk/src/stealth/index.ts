import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC5: Threshold Stealth Scanning -- Protected Viewing Key Scanning
 *
 * Scans for incoming stealth payments using MPC-protected viewing keys.
 * The viewing private key is sharded across Arcium MPC nodes via Shamir
 * secret sharing -- no single node ever holds the full key.
 *
 * MPC nodes jointly compute X25519 shared secrets and view-tags for
 * each announcement, returning only the indices of matching payments.
 *
 * **Inputs**: Encrypted viewing key (one-time setup), batched ephemeral
 * public keys + view tags from on-chain announcements.
 * **Output**: Indices of announcements that belong to this user.
 *
 * @module stealth
 */

/** Batch of on-chain announcements to scan for matching payments. */
export interface StealthScanRequest {
  /** Ephemeral public keys from stealth announcements (32 bytes each). */
  ephemeralPubKeys: Uint8Array[];
  /** View tags from stealth announcements (1 byte each). Must match `ephemeralPubKeys` length. */
  viewTags: number[];
}

/** Result of a stealth scan batch. */
export interface StealthScanResult {
  /** Indices of announcements that match (belong to this user). */
  matchingIndices: number[];
  /** Finalization callback transaction signature (of the last batch). */
  signature: string;
}

/** Result of registering a viewing key with the MPC network. */
export interface ViewingKeySetup {
  /** First ciphertext block of the MXE-encrypted viewing key. */
  encryptedViewingKey: number[];
  /** Registration transaction signature. */
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
 * Register a viewing key with the Arcium MXE (one-time setup).
 *
 * The viewing private key is encrypted and stored in MXE state.
 * Only MPC nodes can access it via threshold decryption.
 * Even if one node is compromised, the key remains safe.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param viewingPrivateKey - 32-byte viewing private key (X25519).
 * @returns The encrypted key ciphertext and registration signature.
 * @throws {Error} "Stealth MPC computation failed: ..." if registration fails.
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

  let sig: string;
  try {
    sig = await program.methods
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
  } catch (err) {
    throw new Error(
      `Stealth MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  return {
    encryptedViewingKey: payload.ciphertexts[0],
    signature: sig,
  };
}

/**
 * Scan stealth announcements using the MPC-protected viewing key.
 *
 * Processes in batches of 32 announcements per MPC computation.
 * Returns indices of announcements that belong to this user.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param request - Batch of ephemeral public keys and view tags to scan.
 * @returns Matching announcement indices and the last finalization signature.
 * @throws {Error} "Stealth MPC computation failed: ..." if any batch fails.
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
