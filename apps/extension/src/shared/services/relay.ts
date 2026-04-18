/**
 * Decentralized Relay Service for Extension
 *
 * Submits privacy transactions through the p01_relayer on-chain program.
 * An ephemeral keypair posts the job; the assigned relayer executes it.
 * No on-chain link between the user's wallet and the privacy transaction.
 *
 * Replaces the centralized Railway HTTP relayer.
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
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

// ── Program Constants ──────────────────────────────────────────────────

export const RELAYER_PROGRAM_ID = new PublicKey(
  '2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW',
);

const SEEDS = {
  CONFIG: Buffer.from('relayer_config'),
  NODE: Buffer.from('relayer_node'),
  JOB: Buffer.from('relay_job'),
} as const;

const KEM_PUBLIC_KEY_SIZE = 1184;
const KEM_CIPHERTEXT_SIZE = 1088;

// ── Types ──────────────────────────────────────────────────────────────

export interface RelayerNode {
  address: PublicKey;
  operator: PublicKey;
  encryptionKey: Uint8Array;
  kemEncryptionKey?: Uint8Array;
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

/**
 * Encrypt a transaction payload for a relayer.
 * v1: X25519 ECDH + HKDF + XSalsa20-Poly1305
 * v2: X25519 + ML-KEM-768 + HKDF + XSalsa20-Poly1305
 */
export function encryptForRelayer(
  payload: Uint8Array,
  relayerEncryptionKey: Uint8Array,
  relayerKemKey?: Uint8Array,
): Uint8Array {
  const ephemeral = nacl.box.keyPair();
  const classicSecret = nacl.scalarMult(ephemeral.secretKey, relayerEncryptionKey);

  let symmetricKey: Uint8Array;
  let kemCiphertext: Uint8Array | undefined;

  if (relayerKemKey && relayerKemKey.length === KEM_PUBLIC_KEY_SIZE) {
    const kem = ml_kem768.encapsulate(relayerKemKey);
    kemCiphertext = kem.cipherText;
    const combined = new Uint8Array(classicSecret.length + kem.sharedSecret.length);
    combined.set(classicSecret);
    combined.set(kem.sharedSecret, classicSecret.length);
    symmetricKey = hkdf(sha256, combined, undefined, utf8ToBytes('p01_relay_job_hybrid_v2'), 32);
  } else {
    symmetricKey = hkdf(sha256, classicSecret, undefined, utf8ToBytes('p01_relay_job_v1'), 32);
  }

  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(payload, nonce, symmetricKey);

  if (kemCiphertext) {
    const result = new Uint8Array(1 + 32 + KEM_CIPHERTEXT_SIZE + nonce.length + ciphertext.length);
    result[0] = 0x02;
    result.set(ephemeral.publicKey, 1);
    result.set(kemCiphertext, 33);
    result.set(nonce, 33 + KEM_CIPHERTEXT_SIZE);
    result.set(ciphertext, 33 + KEM_CIPHERTEXT_SIZE + nonce.length);
    return result;
  }

  const result = new Uint8Array(1 + 32 + nonce.length + ciphertext.length);
  result[0] = 0x01;
  result.set(ephemeral.publicKey, 1);
  result.set(nonce, 33);
  result.set(ciphertext, 33 + nonce.length);
  return result;
}

// ── On-chain Reads ─────────────────────────────────────────────────────

export async function fetchRelayerConfig(connection: Connection): Promise<RelayerConfig> {
  const [configPDA] = PublicKey.findProgramAddressSync([SEEDS.CONFIG], RELAYER_PROGRAM_ID);
  const info = await connection.getAccountInfo(configPDA);
  if (!info) throw new Error('Relayer config not initialized');

  const data = info.data;
  let offset = 8;
  const authority = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const minStake = data.readBigUInt64LE(offset); offset += 8;
  offset += 2; // max_relayers
  const jobFeeLamports = data.readBigUInt64LE(offset); offset += 8;
  const protocolFeeBps = data.readUInt16LE(offset); offset += 2;
  offset += 32; // protocol_fee_wallet
  const jobTimeoutSlots = data.readBigUInt64LE(offset); offset += 8;
  offset += 8; // slash_amount
  offset += 8; // cooldown_slots
  const activeRelayerCount = data.readUInt16LE(offset); offset += 2;
  offset += 8; // total_jobs_completed
  const isActive = data[offset] === 1;

  return { authority, minStake, jobFeeLamports, protocolFeeBps, jobTimeoutSlots, activeRelayerCount, isActive };
}

export async function fetchActiveRelayers(connection: Connection): Promise<RelayerNode[]> {
  const discriminator = sha256(Buffer.from('account:RelayerNode')).slice(0, 8);
  const IS_ACTIVE_OFFSET = 121;

  const accounts = await connection.getProgramAccounts(RELAYER_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(discriminator).toString('base64') } },
      { memcmp: { offset: IS_ACTIVE_OFFSET, bytes: Buffer.from([1]).toString('base64') } },
    ],
  });

  return accounts.map(({ pubkey, account }) => {
    const data = account.data;
    let offset = 8;
    const operator = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const encryptionKey = new Uint8Array(data.slice(offset, offset + 32)); offset += 32;
    const stake = Number(data.readBigUInt64LE(offset)); offset += 8;
    offset += 8; // jobs_completed
    offset += 8; // jobs_failed
    offset += 8; // last_active_slot
    offset += 8; // registered_at
    offset += 8; // deactivated_at_slot
    const isActive = data[offset] === 1; offset += 1;
    const reputationScore = data.readUInt32LE(offset); offset += 4;
    offset += 32; // endpoint_hash

    let kemEncryptionKey: Uint8Array | undefined;
    if (offset + 1 + KEM_PUBLIC_KEY_SIZE <= data.length) {
      const hasKemKey = data[offset] === 1; offset += 1;
      if (hasKemKey) {
        kemEncryptionKey = new Uint8Array(data.slice(offset, offset + KEM_PUBLIC_KEY_SIZE));
      }
    }

    return { address: pubkey, operator, encryptionKey, kemEncryptionKey, stake, isActive, reputationScore };
  });
}

// ── Relayer Selection ──────────────────────────────────────────────────

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
  return { index: seed % relayers.length, relayer: relayers[seed % relayers.length] };
}

export function generateJobId(): Uint8Array {
  return sha256(Keypair.generate().publicKey.toBytes());
}

// ── Job Submission ─────────────────────────────────────────────────────

export async function submitRelayJob(
  serializedTx: Uint8Array,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  connection: Connection,
): Promise<RelayJobResult> {
  const [config, relayers] = await Promise.all([
    fetchRelayerConfig(connection),
    fetchActiveRelayers(connection),
  ]);

  if (!config.isActive) throw new Error('Relay protocol is paused');
  if (relayers.length === 0) throw new Error('No active relayers available');

  const jobId = generateJobId();
  const { blockhash: currentBlockhash } = await connection.getLatestBlockhash('confirmed');
  const { relayer: selectedRelayer } = selectRelayer(relayers, currentBlockhash, jobId);

  const encrypted = encryptForRelayer(serializedTx, selectedRelayer.encryptionKey, selectedRelayer.kemEncryptionKey);
  const ephemeral = Keypair.generate();

  // Fund ephemeral
  const jobRent = 10_000_000;
  const txFees = 10_000;
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

  // Build submit_job instruction
  const [configPDA] = PublicKey.findProgramAddressSync([SEEDS.CONFIG], RELAYER_PROGRAM_ID);
  const [relayerNodePDA] = PublicKey.findProgramAddressSync(
    [SEEDS.NODE, selectedRelayer.operator.toBytes()],
    RELAYER_PROGRAM_ID,
  );
  const [jobPDA] = PublicKey.findProgramAddressSync([SEEDS.JOB, jobId], RELAYER_PROGRAM_ID);

  const submitDiscriminator = sha256(Buffer.from('global:submit_job')).slice(0, 8);
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
      { pubkey: ephemeral.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: relayerNodePDA, isSigner: false, isWritable: false },
      { pubkey: jobPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const submitTx = new Transaction().add(submitIx);
  submitTx.feePayer = ephemeral.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  submitTx.recentBlockhash = blockhash;
  submitTx.sign(ephemeral);

  const signature = await connection.sendRawTransaction(submitTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  console.log('[Relay] Job submitted:', signature.slice(0, 20) + '...');
  return { jobAddress: jobPDA, jobId, ephemeralKeypair: ephemeral, signature };
}

// ── Job Monitoring ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export async function monitorJob(
  jobAddress: PublicKey,
  connection: Connection,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ success: boolean; status: JobStatus }> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const accountInfo = await connection.getAccountInfo(jobAddress);
    if (!accountInfo) {
      return { success: true, status: JobStatus.Completed };
    }

    const statusByte = accountInfo.data[accountInfo.data.length - 2];
    if (statusByte !== JobStatus.Pending) {
      return { success: statusByte === JobStatus.Completed, status: statusByte as JobStatus };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return { success: false, status: JobStatus.Pending };
}

// ── High-Level API ─────────────────────────────────────────────────────

export async function relayTransaction(
  serializedTx: Uint8Array,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  connection: Connection,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const job = await submitRelayJob(serializedTx, walletPublicKey, signTransaction, connection);

  const result = await monitorJob(job.jobAddress, connection, timeoutMs);
  if (!result.success) {
    const statusNames = ['Pending', 'Completed', 'Expired', 'Cancelled'];
    throw new Error(`Relay job failed: ${statusNames[result.status] || result.status}`);
  }

  console.log('[Relay] Job completed successfully');
  return job.signature;
}
