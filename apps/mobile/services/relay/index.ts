/**
 * Decentralized Relay Service for Mobile
 *
 * Submits privacy transactions through the p01_relayer on-chain program.
 * An ephemeral keypair posts the job; the assigned relayer executes it.
 * No on-chain link between the user's wallet and the privacy transaction.
 *
 * Flow:
 *   1. Build the privacy tx with an ephemeral keypair as payer
 *   2. Fund the ephemeral keypair (small fee tx from user wallet)
 *   3. Encrypt the signed tx for the selected relayer
 *   4. Submit the relay job on-chain from the ephemeral keypair
 *   5. Monitor for completion (relayer decrypts + executes)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { getConnection } from '../solana/connection';

// ── Program Constants ──────────────────────────────────────────────────

export const RELAYER_PROGRAM_ID = new PublicKey(
  '2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW',
);

const SEEDS = {
  CONFIG: Buffer.from('relayer_config'),
  NODE: Buffer.from('relayer_node'),
  JOB: Buffer.from('relay_job'),
} as const;

// v1 overhead: version(1) + ephemeral_pubkey(32) + nonce(24) + Poly1305 tag(16) = 73
// v2 overhead: version(1) + ephemeral_pubkey(32) + kem_ct(1088) + nonce(24) + tag(16) = 1161
const ENCRYPTED_PAYLOAD_OVERHEAD_V1 = 73;
const ENCRYPTED_PAYLOAD_OVERHEAD_V2 = 1161;

// ── Types ──────────────────────────────────────────────────────────────

export interface RelayerNode {
  address: PublicKey; // PDA address
  operator: PublicKey;
  encryptionKey: Uint8Array; // 32-byte X25519 public key
  kemEncryptionKey?: Uint8Array; // 1184-byte ML-KEM-768 public key (v2 relayers)
  stake: number;
  isActive: boolean;
  reputationScore: number;
}

export interface RelayerConfig {
  authority: PublicKey;
  minStake: bigint;
  jobFeeLamports: bigint;
  protocolFeeBps: number;
  jobTimeoutSlots: bigint;
  activeRelayerCount: number;
  isActive: boolean;
}

export interface RelayJobResult {
  jobAddress: PublicKey;
  jobId: Uint8Array;
  ephemeralKeypair: Keypair;
  signature: string;
}

export enum JobStatus {
  Pending = 0,
  Completed = 1,
  Expired = 2,
  Cancelled = 3,
}

// ── Encryption ─────────────────────────────────────────────────────────

/** HKDF info for hybrid relay encryption (must match relayer-side decryption) */
const HYBRID_RELAY_HKDF_INFO = 'p01_relay_job_hybrid_v2';

/** ML-KEM-768 sizes */
const KEM_PUBLIC_KEY_SIZE = 1184;
const KEM_CIPHERTEXT_SIZE = 1088;

/**
 * Encrypt a transaction payload for a relayer.
 *
 * v1 (classic): X25519 ECDH + HKDF + XSalsa20-Poly1305
 *   Wire: 0x01 || ephemeral_pubkey (32) || nonce (24) || ciphertext (N + 16)
 *
 * v2 (hybrid): X25519 ECDH + ML-KEM-768 + HKDF + XSalsa20-Poly1305
 *   Wire: 0x02 || ephemeral_pubkey (32) || kem_ciphertext (1088) || nonce (24) || ciphertext (N + 16)
 *
 * Automatically uses v2 if relayerKemKey is provided.
 */
export function encryptForRelayer(
  payload: Uint8Array,
  relayerEncryptionKey: Uint8Array,
  relayerKemKey?: Uint8Array,
): Uint8Array {
  const ephemeral = nacl.box.keyPair();

  // X25519 ECDH → raw shared secret
  const classicSecret = nacl.scalarMult(ephemeral.secretKey, relayerEncryptionKey);

  let symmetricKey: Uint8Array;
  let kemCiphertext: Uint8Array | undefined;

  if (relayerKemKey && relayerKemKey.length === KEM_PUBLIC_KEY_SIZE) {
    // Hybrid v2: combine X25519 + ML-KEM-768
    const kem = ml_kem768.encapsulate(relayerKemKey);
    kemCiphertext = kem.cipherText;

    const combined = new Uint8Array(classicSecret.length + kem.sharedSecret.length);
    combined.set(classicSecret);
    combined.set(kem.sharedSecret, classicSecret.length);
    symmetricKey = hkdf(sha256, combined, undefined, HYBRID_RELAY_HKDF_INFO, 32);
  } else {
    // Classic v1: X25519 only
    symmetricKey = hkdf(sha256, classicSecret, undefined, 'p01_relay_job_v1', 32);
  }

  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(payload, nonce, symmetricKey);

  if (kemCiphertext) {
    // v2 wire: version(1) + ephemeral(32) + kem_ct(1088) + nonce(24) + ciphertext
    const result = new Uint8Array(1 + 32 + KEM_CIPHERTEXT_SIZE + nonce.length + ciphertext.length);
    result[0] = 0x02;
    result.set(ephemeral.publicKey, 1);
    result.set(kemCiphertext, 33);
    result.set(nonce, 33 + KEM_CIPHERTEXT_SIZE);
    result.set(ciphertext, 33 + KEM_CIPHERTEXT_SIZE + nonce.length);
    return result;
  }

  // v1 wire: version(1) + ephemeral(32) + nonce(24) + ciphertext
  const result = new Uint8Array(1 + 32 + nonce.length + ciphertext.length);
  result[0] = 0x01;
  result.set(ephemeral.publicKey, 1);
  result.set(nonce, 33);
  result.set(ciphertext, 33 + nonce.length);
  return result;
}

// ── Relayer Selection ──────────────────────────────────────────────────

/**
 * Fetch the singleton RelayerConfig PDA.
 */
export async function fetchRelayerConfig(
  connection: Connection,
): Promise<RelayerConfig> {
  const [configPDA] = PublicKey.findProgramAddressSync(
    [SEEDS.CONFIG],
    RELAYER_PROGRAM_ID,
  );

  const info = await connection.getAccountInfo(configPDA);
  if (!info) throw new Error('Relayer config not initialized');

  const data = info.data;
  // Skip 8-byte Anchor discriminator
  let offset = 8;

  const authority = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const minStake = data.readBigUInt64LE(offset); offset += 8;
  const maxRelayers = data.readUInt16LE(offset); offset += 2;
  const jobFeeLamports = data.readBigUInt64LE(offset); offset += 8;
  const protocolFeeBps = data.readUInt16LE(offset); offset += 2;
  const protocolFeeWallet = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const jobTimeoutSlots = data.readBigUInt64LE(offset); offset += 8;
  const slashAmount = data.readBigUInt64LE(offset); offset += 8;
  const cooldownSlots = data.readBigUInt64LE(offset); offset += 8;
  const activeRelayerCount = data.readUInt16LE(offset); offset += 2;
  const totalJobsCompleted = data.readBigUInt64LE(offset); offset += 8;
  const isActive = data[offset] === 1;

  return {
    authority,
    minStake,
    jobFeeLamports,
    protocolFeeBps,
    jobTimeoutSlots,
    activeRelayerCount,
    isActive,
  };
}

/**
 * Fetch all active relayer nodes via getProgramAccounts.
 */
export async function fetchActiveRelayers(
  connection: Connection,
): Promise<RelayerNode[]> {
  // RelayerNode discriminator: sha256("account:RelayerNode")[0..8]
  const discriminator = sha256(Buffer.from('account:RelayerNode')).slice(0, 8);

  // RelayerNode layout: disc(8) + operator(32) + encryption_key(32) + stake(8) + ...
  // is_active is at offset: 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 = byte 121
  // Actually let's compute: disc(8) + operator(32) + enc_key(32) + stake(8) + jobs_completed(8) +
  //   jobs_failed(8) + last_active_slot(8) + registered_at(8) + deactivated_at(8) + is_active(1)
  // = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 = offset 121 for is_active
  const IS_ACTIVE_OFFSET = 121;

  const accounts = await connection.getProgramAccounts(RELAYER_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(discriminator).toString('base64') } },
      { memcmp: { offset: IS_ACTIVE_OFFSET, bytes: Buffer.from([1]).toString('base64') } },
    ],
  });

  return accounts.map(({ pubkey, account }) => {
    const data = account.data;
    let offset = 8; // skip discriminator

    const operator = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const encryptionKey = new Uint8Array(data.slice(offset, offset + 32)); offset += 32;
    const stake = Number(data.readBigUInt64LE(offset)); offset += 8;
    const jobsCompleted = Number(data.readBigUInt64LE(offset)); offset += 8;
    const jobsFailed = Number(data.readBigUInt64LE(offset)); offset += 8;
    offset += 8; // last_active_slot
    offset += 8; // registered_at
    offset += 8; // deactivated_at_slot
    const isActive = data[offset] === 1; offset += 1;
    const reputationScore = data.readUInt32LE(offset); offset += 4;
    offset += 32; // endpoint_hash

    // v2 fields: has_kem_key (1) + kem_encryption_key (1184) + bump (1)
    let kemEncryptionKey: Uint8Array | undefined;
    if (offset + 1 + KEM_PUBLIC_KEY_SIZE <= data.length) {
      const hasKemKey = data[offset] === 1; offset += 1;
      if (hasKemKey) {
        kemEncryptionKey = new Uint8Array(data.slice(offset, offset + KEM_PUBLIC_KEY_SIZE));
      }
    }

    return {
      address: pubkey,
      operator,
      encryptionKey,
      kemEncryptionKey,
      stake,
      isActive,
      reputationScore,
    };
  });
}

/**
 * Deterministic relayer selection: SHA-256(blockhash || jobId) mod count.
 */
export function selectRelayer(
  relayers: RelayerNode[],
  blockhash: string,
  jobId: Uint8Array,
): { index: number; relayer: RelayerNode } {
  if (relayers.length === 0) throw new Error('No active relayers');
  if (relayers.length === 1) return { index: 0, relayer: relayers[0] };

  const input = new Uint8Array(blockhash.length + jobId.length);
  input.set(Buffer.from(blockhash), 0);
  input.set(jobId, blockhash.length);

  const hash = sha256(input);
  const seed = (hash[0] | (hash[1] << 8) | (hash[2] << 16) | ((hash[3] & 0x7f) << 24)) >>> 0;
  const index = seed % relayers.length;
  return { index, relayer: relayers[index] };
}

// ── Job Submission ─────────────────────────────────────────────────────

/**
 * Generate a unique 32-byte job ID.
 */
export function generateJobId(): Uint8Array {
  return sha256(Keypair.generate().publicKey.toBytes());
}

/**
 * Submit a relay job on-chain.
 *
 * @param serializedTx - The fully signed transaction to relay (serialized bytes)
 * @param walletPublicKey - User's wallet (funds the ephemeral keypair)
 * @param signTransaction - Wallet adapter sign function
 * @returns Job result with monitoring info
 */
export async function submitRelayJob(
  serializedTx: Uint8Array,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
): Promise<RelayJobResult> {
  const connection = getConnection();

  // 1. Fetch config and active relayers
  const [config, relayers] = await Promise.all([
    fetchRelayerConfig(connection),
    fetchActiveRelayers(connection),
  ]);

  if (!config.isActive) throw new Error('Relay protocol is paused');
  if (relayers.length === 0) throw new Error('No active relayers available');

  // 2. Generate job ID and select relayer
  const jobId = generateJobId();
  const { blockhash: currentBlockhash } = await connection.getLatestBlockhash('confirmed');
  const { relayer: selectedRelayer } = selectRelayer(relayers, currentBlockhash, jobId);

  // 3. Encrypt the transaction for the selected relayer (hybrid if KEM key available)
  const encrypted = encryptForRelayer(serializedTx, selectedRelayer.encryptionKey, selectedRelayer.kemEncryptionKey);

  // 4. Generate ephemeral keypair
  const ephemeral = Keypair.generate();

  // 5. Fund ephemeral keypair (job fee + rent + tx fees)
  // Relay job rent ~0.01 SOL, fee from config, extra for tx fees
  const jobRent = 10_000_000; // ~0.01 SOL conservative estimate
  const txFees = 10_000; // 10k lamports for submit_job tx fee
  const fundAmount = Number(config.jobFeeLamports) + jobRent + txFees;

  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: walletPublicKey,
      toPubkey: ephemeral.publicKey,
      lamports: fundAmount,
    }),
  );
  fundTx.feePayer = walletPublicKey;
  const { blockhash: fundBlockhash, lastValidBlockHeight: fundHeight } =
    await connection.getLatestBlockhash('confirmed');
  fundTx.recentBlockhash = fundBlockhash;

  const signedFundTx = await signTransaction(fundTx);
  const fundSig = await connection.sendRawTransaction(signedFundTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    { signature: fundSig, blockhash: fundBlockhash, lastValidBlockHeight: fundHeight },
    'confirmed',
  );

  console.log('[Relay] Ephemeral funded:', ephemeral.publicKey.toBase58().slice(0, 12) + '...');

  // 6. Build submit_job instruction
  const [configPDA] = PublicKey.findProgramAddressSync([SEEDS.CONFIG], RELAYER_PROGRAM_ID);
  const [relayerNodePDA] = PublicKey.findProgramAddressSync(
    [SEEDS.NODE, selectedRelayer.operator.toBytes()],
    RELAYER_PROGRAM_ID,
  );
  const [jobPDA] = PublicKey.findProgramAddressSync(
    [SEEDS.JOB, jobId],
    RELAYER_PROGRAM_ID,
  );

  // Anchor discriminator for submit_job: sha256("global:submit_job")[0..8]
  const submitDiscriminator = sha256(Buffer.from('global:submit_job')).slice(0, 8);

  // Borsh serialize: job_id (32 bytes) + encrypted_tx (4-byte len prefix + data)
  const jobIdBuf = Buffer.from(jobId);
  const encLenBuf = Buffer.alloc(4);
  encLenBuf.writeUInt32LE(encrypted.length, 0);

  const data = Buffer.concat([
    Buffer.from(submitDiscriminator),
    jobIdBuf,
    encLenBuf,
    Buffer.from(encrypted),
  ]);

  const submitIx = new TransactionInstruction({
    programId: RELAYER_PROGRAM_ID,
    keys: [
      { pubkey: ephemeral.publicKey, isSigner: true, isWritable: true }, // submitter
      { pubkey: configPDA, isSigner: false, isWritable: true },          // config
      { pubkey: relayerNodePDA, isSigner: false, isWritable: false },    // relayer_node
      { pubkey: jobPDA, isSigner: false, isWritable: true },             // relay_job (init)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const submitTx = new Transaction().add(submitIx);
  submitTx.feePayer = ephemeral.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  submitTx.recentBlockhash = blockhash;
  submitTx.sign(ephemeral); // Ephemeral signs — no wallet signature needed

  const signature = await connection.sendRawTransaction(submitTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  console.log('[Relay] Job submitted:', signature.slice(0, 20) + '...');

  return {
    jobAddress: jobPDA,
    jobId,
    ephemeralKeypair: ephemeral,
    signature,
  };
}

// ── Job Monitoring ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Monitor a relay job until completion or timeout.
 * The relayer closes the job PDA on completion, so account disappearing = done.
 */
export async function monitorJob(
  jobAddress: PublicKey,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ success: boolean; status: JobStatus }> {
  const connection = getConnection();
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const accountInfo = await connection.getAccountInfo(jobAddress);

    if (!accountInfo) {
      // Account closed — job completed, expired, or cancelled
      return { success: true, status: JobStatus.Completed };
    }

    // Check status byte (at data.length - 2: status + bump)
    const statusByte = accountInfo.data[accountInfo.data.length - 2];
    if (statusByte !== JobStatus.Pending) {
      return {
        success: statusByte === JobStatus.Completed,
        status: statusByte as JobStatus,
      };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return { success: false, status: JobStatus.Pending };
}

// ── High-Level API ─────────────────────────────────────────────────────

/**
 * Submit a transaction via the decentralized relay and wait for completion.
 *
 * This is the main entry point for privacy transactions:
 *   1. Encrypts the signed tx for a randomly selected relayer
 *   2. Posts the relay job on-chain from an ephemeral keypair
 *   3. Waits for the relayer to execute it
 *
 * @param serializedTx - Fully signed transaction bytes
 * @param walletPublicKey - User's wallet (only used to fund ephemeral)
 * @param signTransaction - Wallet adapter sign function
 * @param timeoutMs - Max wait time (default 120s)
 * @returns Relay job signature
 */
export async function relayTransaction(
  serializedTx: Uint8Array,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const job = await submitRelayJob(serializedTx, walletPublicKey, signTransaction);

  console.log('[Relay] Monitoring job:', job.jobAddress.toBase58().slice(0, 12) + '...');

  const result = await monitorJob(job.jobAddress, timeoutMs);

  if (!result.success) {
    const statusNames = ['Pending', 'Completed', 'Expired', 'Cancelled'];
    throw new Error(
      `Relay job failed with status: ${statusNames[result.status] || result.status}`,
    );
  }

  console.log('[Relay] Job completed successfully');
  return job.signature;
}
