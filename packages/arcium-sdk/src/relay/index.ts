import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC1: Confidential Relay -- Threshold TX Decryption
 *
 * Submits a transaction for threshold decryption by N Arcium MPC nodes.
 * No single relayer ever sees the plaintext transaction. The MPC cluster
 * jointly decrypts (Cerberus protocol -- 1 honest node = secure), signs
 * with threshold EdDSA, and submits the TX on-chain. The user's wallet
 * never appears as fee payer or signer.
 *
 * **Inputs**: Serialized Solana transaction (encrypted), fee, deadline slot.
 * **Output**: The relayed transaction signature and fee paid.
 *
 * @module relay
 */

/** A submitted confidential relay job waiting for MPC processing. */
export interface ConfidentialRelayJob {
  /** First ciphertext block of the encrypted transaction payload. */
  encryptedTx: number[];
  /** Fee offered to the relayer network (in lamports). */
  fee: bigint;
  /** Slot deadline after which the job expires and can be reclaimed. */
  deadlineSlot: bigint;
  /** Unique computation offset identifying this MPC job. */
  computationOffset: anchor.BN;
  /** Transaction signature of the submission. */
  signature: string;
}

/** Result returned after the MPC cluster decrypts and relays the transaction. */
export interface RelayResult {
  /** The on-chain signature of the relayed (decrypted) transaction. */
  relayedTxSignature: string;
  /** Actual fee paid to the relayer network (in lamports). */
  feePaid: bigint;
  /** Finalization callback transaction signature. */
  signature: string;
}

const RELAY_JOB_SEED = 'p01_arcium_relay';
const RELAY_CONFIG_SEED = 'p01_relay_config';

/** P01 Relayer program (existing) */
const P01_RELAYER_PROGRAM_ID = new PublicKey('2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW');

/** Derive the Arcium relay job PDA */
export function getRelayJobAddress(
  programId: PublicKey,
  jobId: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(RELAY_JOB_SEED), jobId],
    programId
  );
}

/**
 * Submit an encrypted transaction for confidential relay.
 *
 * The transaction is encrypted with the MXE's public key.
 * No single relayer can decrypt it -- only the MPC cluster jointly.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param serializedTx - The raw serialized Solana transaction bytes.
 * @param feeLamports - Fee to offer the relayer network (in lamports).
 * @param deadlineSlot - Slot after which the job expires.
 * @returns The submitted relay job with computation offset for tracking.
 * @throws {Error} "Relay MPC computation failed: ..." if the on-chain submission fails.
 */
export async function submitConfidentialRelayJob(
  client: ArciumClient,
  program: anchor.Program,
  serializedTx: Uint8Array,
  feeLamports: bigint,
  deadlineSlot: bigint
): Promise<ConfidentialRelayJob> {
  // Chunk the serialized TX into field elements (8 bytes each)
  const txChunks: bigint[] = [];
  for (let i = 0; i < serializedTx.length; i += 8) {
    const chunk = serializedTx.slice(i, Math.min(i + 8, serializedTx.length));
    // Pad to 8 bytes if needed
    const padded = new Uint8Array(8);
    padded.set(chunk);
    txChunks.push(
      BigInt(
        '0x' +
          Buffer.from(padded)
            .reverse()
            .toString('hex')
      )
    );
  }

  // Add fee and deadline as plaintext (not sensitive)
  const payload = client.encrypt(txChunks);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.THRESHOLD_DECRYPT, computationOffset);

  const jobId = Buffer.from(computationOffset.toArray('le', 8));
  const [relayJobAddress] = getRelayJobAddress(client.programId, jobId);

  let sig: string;
  try {
    sig = await program.methods
      .submitConfidentialRelay(
        computationOffset,
        payload.ciphertexts.map((ct) => Array.from(ct)),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce),
        new anchor.BN(feeLamports.toString()),
        new anchor.BN(deadlineSlot.toString()),
        serializedTx.length // original TX length (for unpadding)
      )
      .accountsPartial({
        ...accounts,
        relayJob: relayJobAddress,
        payer: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });
  } catch (err) {
    throw new Error(
      `Relay MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  return {
    encryptedTx: payload.ciphertexts[0],
    fee: feeLamports,
    deadlineSlot,
    computationOffset,
    signature: sig,
  };
}

/**
 * Wait for relay job completion.
 * MPC decrypts, signs, and submits the TX.
 * Returns the relayed transaction signature.
 */
export async function awaitRelayCompletion(
  client: ArciumClient,
  computationOffset: anchor.BN
): Promise<RelayResult> {
  const finalizeSig = await client.awaitFinalization(computationOffset);

  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const relayLine = logs.find((l) => l.includes('RelayedTx:'));
  const relayedSig = relayLine ? relayLine.split('RelayedTx:')[1].trim() : '';
  const feeLine = logs.find((l) => l.includes('FeePaid:'));
  const feePaid = feeLine ? BigInt(feeLine.split('FeePaid:')[1].trim()) : 0n;

  return {
    relayedTxSignature: relayedSig,
    feePaid,
    signature: finalizeSig,
  };
}

/**
 * Convenience: submit + await in one call.
 */
export async function relayTransaction(
  client: ArciumClient,
  program: anchor.Program,
  serializedTx: Uint8Array,
  feeLamports: bigint,
  deadlineSlot: bigint
): Promise<RelayResult> {
  const job = await submitConfidentialRelayJob(
    client,
    program,
    serializedTx,
    feeLamports,
    deadlineSlot
  );
  return awaitRelayCompletion(client, job.computationOffset);
}
