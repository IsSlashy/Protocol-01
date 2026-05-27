import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC1: Confidential Relay -- Phase D Alt 1 (recipient-only MPC sidecar)
 *
 * Submits the unshield recipient pubkey, X25519-encrypted to the MXE
 * cluster, for threshold decryption. Everything else about the unshield
 * (amount, nullifier, root, STARK proof) keeps flowing through the
 * existing `p01_relayer` (Phase A, shipped). This SDK module is the
 * sidecar that delivers the recipient just-in-time to the relayer
 * worker; it does NOT replace `p01_relayer`.
 *
 * **Flow** (see docs/phase-d-orchestration-decision.md):
 *
 * 1. Client invokes `p01_relayer::submit_job` with the plaintext
 *    payload (amount, nullifier, root, proof). The returned `RelayerJob`
 *    PDA address is `relayerJobId`.
 * 2. Client calls {@link submitConfidentialRelayJob} with the recipient
 *    pubkey + `relayerJobId`. This:
 *    - encrypts the 32-byte recipient as 4 X25519-encrypted u64s
 *    - submits `p01_arcium::submit_confidential_relay`
 *    - triggers `queue_computation(decrypt_recipient)`
 * 3. Client calls {@link awaitRecipientDecryption} which polls the
 *    RelayJob PDA's status byte until it transitions to `Decrypted`.
 *    Returns the plaintext recipient.
 * 4. The off-chain relayer worker (services/relayer, D.5) subscribes to
 *    `RecipientDecrypted` events independently, joins them with the
 *    Phase A payload it already holds, and broadcasts the unshield.
 *
 * **PQ caveat**: Arcium MXE uses X25519 (classical ECC, Shor-breakable)
 * for the wrap. The 32 plaintext bytes of the recipient are protected
 * only during the in-flight MPC window — pre-quantum security only.
 * The Phase A STARK-proven payload (amount, nullifier, root, proof) is
 * unaffected and remains post-quantum via Goldilocks.
 *
 * @module relay
 */

/** A submitted confidential relay job waiting for MPC processing. */
export interface ConfidentialRelayJob {
  /** Address of the on-chain RelayJob PDA (p01_arcium). */
  relayJobAddress: PublicKey;
  /** PDA address of the matching Phase A relayer job. */
  relayerJobId: PublicKey;
  /** Fee offered to the relayer cluster (in lamports). */
  fee: bigint;
  /** Slot deadline after which the job expires and can be GC'd. */
  deadlineSlot: bigint;
  /** Unique computation offset identifying this MPC job. */
  computationOffset: anchor.BN;
  /** Transaction signature of the submission. */
  signature: string;
}

/** Result of awaiting recipient decryption. */
export interface DecryptedRecipient {
  /** The plaintext recipient pubkey, just decrypted by the MPC cluster. */
  recipient: PublicKey;
  /** The matching Phase A relayer job PDA. */
  relayerJobId: PublicKey;
  /** Address of the p01_arcium RelayJob PDA. */
  relayJobAddress: PublicKey;
}

const RELAY_JOB_SEED = 'p01_arcium_relay';

/** Derive the p01_arcium RelayJob PDA from the computation offset. */
export function getRelayJobAddress(
  programId: PublicKey,
  computationOffset: anchor.BN
): [PublicKey, number] {
  const offsetBytes = Buffer.from(computationOffset.toArray('le', 8));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RELAY_JOB_SEED), offsetBytes],
    programId
  );
}

/**
 * Split a 32-byte Solana pubkey into 4 little-endian u64 BigInts.
 * Mirrors the on-chain reconstruction in `decrypt_recipient_callback`:
 *
 *   recipient[0..8]  = chunk.field_0.to_le_bytes()
 *   recipient[8..16] = chunk.field_1.to_le_bytes()
 *   recipient[16..24]= chunk.field_2.to_le_bytes()
 *   recipient[24..32]= chunk.field_3.to_le_bytes()
 */
function pubkeyToU64Chunks(pubkey: PublicKey): bigint[] {
  const bytes = pubkey.toBytes();
  const chunks: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    const slice = bytes.slice(i * 8, (i + 1) * 8);
    // little-endian: read low byte first.
    chunks.push(
      BigInt('0x' + Buffer.from(slice).reverse().toString('hex'))
    );
  }
  return chunks;
}

/**
 * Submit the encrypted recipient pubkey for MPC threshold decryption.
 *
 * The recipient (32 bytes) is split into 4 u64s and encrypted with the
 * MXE cluster pubkey. The matching Phase A relayer job (which already
 * carries the rest of the unshield payload) is linked via
 * `relayerJobId`. After the on-chain callback fires, the recipient
 * becomes available via {@link awaitRecipientDecryption}.
 *
 * The RelayJob PDA is passed both as the typed `relay_job` account AND
 * as the first remaining_account, so it propagates to
 * `decrypt_recipient_callback` via Arcium's queue → callback path.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param recipient - Unshield recipient pubkey to hide from the relayer.
 * @param relayerJobId - PDA of the matching `p01_relayer::RelayerJob`.
 * @param feeLamports - Fee to offer the relayer cluster.
 * @param deadlineSlot - Slot after which a permissionless GC may refund.
 */
export async function submitConfidentialRelayJob(
  client: ArciumClient,
  program: anchor.Program,
  recipient: PublicKey,
  relayerJobId: PublicKey,
  feeLamports: bigint,
  deadlineSlot: bigint
): Promise<ConfidentialRelayJob> {
  const recipientChunks = pubkeyToU64Chunks(recipient);
  const payload = client.encrypt(recipientChunks);
  if (payload.ciphertexts.length < 4) {
    throw new Error(
      `ArciumClient.encrypt returned ${payload.ciphertexts.length} ciphertexts; expected at least 4 ` +
      "for a 32-byte recipient pubkey. Check the client's chunking implementation."
    );
  }

  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(
    CIRCUITS.DECRYPT_RECIPIENT,
    computationOffset
  );
  const [relayJobAddress] = getRelayJobAddress(client.programId, computationOffset);

  // The on-chain ix expects a fixed [[u8; 32]; 4] array.
  const encryptedRecipient: number[][] = payload.ciphertexts
    .slice(0, 4)
    .map((ct) => Array.from(ct));

  let sig: string;
  try {
    sig = await program.methods
      .submitConfidentialRelay(
        computationOffset,
        encryptedRecipient,
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce),
        relayerJobId,
        new anchor.BN(feeLamports.toString()),
        new anchor.BN(deadlineSlot.toString())
      )
      .accountsPartial({
        ...accounts,
        relayJob: relayJobAddress,
        payer: client.wallet.publicKey,
      })
      .remainingAccounts([
        // The callback reads this from remaining_accounts[0] to write
        // status + decrypted_recipient back into the PDA.
        { pubkey: relayJobAddress, isWritable: true, isSigner: false },
      ])
      .rpc({ commitment: 'confirmed' });
  } catch (err) {
    throw new Error(
      `Confidential relay submit failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'Common causes: (1) decrypt_recipient comp_def not initialized on this devnet ' +
      '(call init_decrypt_recipient_comp_def first), (2) Arcium cluster unavailable, ' +
      '(3) X25519 ciphertext malformed.'
    );
  }

  return {
    relayJobAddress,
    relayerJobId,
    fee: feeLamports,
    deadlineSlot,
    computationOffset,
    signature: sig,
  };
}

/**
 * Poll the RelayJob PDA until its status transitions to `Decrypted`
 * (status byte = 2), then read out the plaintext recipient.
 *
 * Layout offsets (mirrors `programs/p01_arcium/src/state/relay_job.rs`):
 *
 *   bytes  8..40  submitter
 *   byte      40  status
 *   bytes 41..73  relayer_job_id
 *   bytes 73..201 encrypted_recipient (4 × 32)
 *   bytes 201..233 decrypted_recipient
 *
 * @throws if the job enters `Expired` (4) or `Failed` (5), or if the
 *         timeout elapses (likely the MPC orchestration is not yet
 *         deployed on the target devnet).
 */
export async function awaitRecipientDecryption(
  client: ArciumClient,
  relayJobAddress: PublicKey,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<DecryptedRecipient> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const accountInfo = await client.connection.getAccountInfo(relayJobAddress);
    if (!accountInfo) {
      throw new Error(`RelayJob account ${relayJobAddress.toBase58()} not found`);
    }

    const data = accountInfo.data;
    if (data.length < 233) {
      throw new Error(
        `RelayJob data too short (${data.length} bytes, expected ≥ 233). ` +
        'Likely a layout mismatch between SDK and on-chain program.'
      );
    }

    const status = data[40];

    if (status === 2) {
      // Decrypted — extract recipient + relayer_job_id.
      const recipient = new PublicKey(data.slice(201, 233));
      const relayerJobId = new PublicKey(data.slice(41, 73));
      return { recipient, relayerJobId, relayJobAddress };
    }

    if (status === 4) {
      throw new Error('RelayJob expired before MPC decrypt completed');
    }

    if (status === 5) {
      throw new Error('RelayJob entered Failed state during MPC decrypt');
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(
    `Recipient decryption timed out after ${timeoutMs}ms. ` +
    'Verify that decrypt_recipient comp_def is initialized on this devnet ' +
    '(call init_decrypt_recipient_comp_def) and the Arcium cluster is live.'
  );
}

/**
 * Convenience: submit + await in one call.
 *
 * Returns the plaintext recipient once the MPC threshold decrypts it.
 * The caller should then have already submitted the matching Phase A
 * `p01_relayer::submit_job` separately so the relayer worker can join
 * the two and broadcast the unshield.
 */
export async function relayRecipient(
  client: ArciumClient,
  program: anchor.Program,
  recipient: PublicKey,
  relayerJobId: PublicKey,
  feeLamports: bigint,
  deadlineSlot: bigint,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<DecryptedRecipient> {
  const job = await submitConfidentialRelayJob(
    client,
    program,
    recipient,
    relayerJobId,
    feeLamports,
    deadlineSlot
  );
  return awaitRecipientDecryption(client, job.relayJobAddress, options);
}
