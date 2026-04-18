/**
 * Submit an encrypted relay job on-chain.
 *
 * Flow:
 * 1. Fetch active relayers and config
 * 2. Select relayer deterministically
 * 3. Encrypt the serialized transaction to the relayer's X25519 key
 * 4. Build and send the submit_job instruction
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encryptForRelayer } from './encrypt';
import { fetchActiveRelayers, fetchRelayerConfig, selectRelayer } from './select';
import { RELAY_SEEDS } from './types';
import type { SubmitRelayJobOptions, RelayJobResult } from './types';

/**
 * Generate a random 32-byte job ID.
 */
export function generateJobId(): Uint8Array {
  const random = Keypair.generate().publicKey.toBuffer();
  return new Uint8Array(sha256(random));
}

/**
 * Submit a relay job: encrypt the transaction and post it on-chain.
 *
 * The ephemeral keypair pays the job fee + rent. It should be funded
 * beforehand from the shielded pool to avoid linking to the user's wallet.
 *
 * @returns Job metadata including the job PDA and assigned relayer
 */
export async function submitRelayJob(
  options: SubmitRelayJobOptions,
): Promise<RelayJobResult> {
  const {
    connection,
    programId,
    transaction,
    ephemeralKeypair,
    relayerOverride,
    timeout,
  } = options;

  // 1. Fetch config and relayers
  const [config, relayers] = await Promise.all([
    fetchRelayerConfig(connection, programId),
    fetchActiveRelayers(connection, programId),
  ]);

  if (!config) throw new Error(
    'Relayer config not initialized. The relayer program may not be deployed on this network. ' +
    'Ensure ENABLE_RELAYER feature flag is enabled and you are on devnet.'
  );
  if (!config.isActive) throw new Error(
    'Relayer protocol is currently paused by the protocol authority. ' +
    'Try again later or use direct transactions instead.'
  );
  if (relayers.length === 0) throw new Error(
    'No active relayers available on this network. The relay feature requires at least one ' +
    'staked relayer node. Ensure ENABLE_RELAYER feature flag is enabled and you are on devnet.'
  );

  // 2. Generate job ID
  const jobId = generateJobId();

  // 3. Select relayer
  let selectedRelayer;
  if (relayerOverride) {
    selectedRelayer = relayers.find(
      (r) => r.address.equals(relayerOverride),
    );
    if (!selectedRelayer) throw new Error(
      `Specified relayer ${relayerOverride.toBase58()} not found or inactive. ` +
      'Use fetchActiveRelayers() to list available relayers, or omit relayerOverride for automatic selection.'
    );
  } else {
    const { blockhash } = await connection.getLatestBlockhash();
    const result = selectRelayer(relayers, blockhash, jobId);
    selectedRelayer = result.relayer;
  }

  // 4. Serialize and encrypt the transaction
  const serializedTx = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const encryptedTx = encryptForRelayer(
    serializedTx,
    selectedRelayer.encryptionKey,
  );

  // 5. Derive PDAs
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(RELAY_SEEDS.CONFIG)],
    programId,
  );
  const [jobPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(RELAY_SEEDS.RELAY_JOB), Buffer.from(jobId)],
    programId,
  );

  // 6. Build submit_job instruction
  //    Instruction data: [discriminator(8)] [job_id(32)] [vec_len(4)] [encrypted_tx(N)]
  const discriminator = Buffer.from(
    sha256(Buffer.from('global:submit_job')).slice(0, 8),
  );
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(encryptedTx.length);

  const data = Buffer.concat([
    discriminator,
    Buffer.from(jobId),
    vecLen,
    Buffer.from(encryptedTx),
  ]);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: ephemeralKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: selectedRelayer.address, isSigner: false, isWritable: false },
      { pubkey: jobPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });

  // 7. Send transaction
  const tx = new Transaction().add(ix);
  tx.feePayer = ephemeralKeypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(ephemeralKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(sig, 'confirmed');

  // 8. Read the job to get deadline
  const slot = await connection.getSlot();

  return {
    jobId,
    jobAddress: jobPda,
    assignedRelayer: selectedRelayer.address,
    submitSignature: sig,
    feePaid: config.jobFeeLamports,
    deadlineSlot: slot + config.jobTimeoutSlots,
  };
}
