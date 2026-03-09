import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC1: Confidential Relay — Threshold Decryption
 *
 * Problem: In the current p01_relayer model, a single relayer node decrypts
 * the user's encrypted transaction to submit it on-chain. During decryption,
 * the relayer sees the plaintext TX (amounts, recipients, instructions).
 *
 * Solution: Instead of one relayer decrypting, N Arcium MPC nodes jointly
 * decrypt via threshold decryption. The plaintext TX never exists on any
 * single machine. MPC nodes then jointly sign and submit the TX.
 *
 * Flow:
 * 1. User encrypts TX with Arcium MXE key (not single relayer key)
 * 2. Submits encrypted TX to P01 Arcium program
 * 3. Program queues MPC computation
 * 4. N ARX nodes jointly decrypt (Cerberus protocol — 1 honest = secure)
 * 5. MPC signs TX with threshold EdDSA
 * 6. Callback submits signed TX on-chain
 * 7. User's wallet never appears as fee payer or signer
 */

export interface ConfidentialRelayJob {
  /** Encrypted transaction payload (max ~1KB for Arcium output limit) */
  encryptedTx: number[];
  /** Fee offered to relayer network (lamports) */
  fee: bigint;
  /** Deadline slot (after which job expires) */
  deadlineSlot: bigint;
  /** Computation offset */
  computationOffset: anchor.BN;
  /** Submission signature */
  signature: string;
}

export interface RelayResult {
  /** The on-chain signature of the relayed transaction */
  relayedTxSignature: string;
  /** Fee actually paid */
  feePaid: bigint;
  /** Finalization signature */
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
 * No single relayer can decrypt it — only the MPC cluster jointly.
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

  const sig = await program.methods
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
