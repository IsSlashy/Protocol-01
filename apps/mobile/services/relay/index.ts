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
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
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
  /** Slot of last successful complete_job. 0 if never completed a job. */
  lastActiveSlot: number;
  /** Slot of registration (used for new-relayer-still-warming heuristics). */
  registeredAtSlot: number;
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
  /** Operator pubkey of the relayer that was assigned (for failover tracking). */
  selectedOperator: PublicKey;
}

export enum JobStatus {
  Pending = 0,
  Completed = 1,
  Expired = 2,
  Cancelled = 3,
}

// ── Encryption ─────────────────────────────────────────────────────────

/** HKDF info for hybrid relay encryption (must match relayer-side decryption) */
const HYBRID_RELAY_HKDF_INFO = utf8ToBytes('p01_relay_job_hybrid_v2');

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
    symmetricKey = hkdf(sha256, classicSecret, undefined, utf8ToBytes('p01_relay_job_v1'), 32);
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

  // RelayerNode layout (programs/p01_relayer/src/state/relayer_node.rs):
  //   disc(8) + operator(32) + encryption_key(32) + stake(8) + jobs_completed(8) +
  //   jobs_failed(8) + last_active_slot(8) + registered_at(8) + deactivated_at_slot(8) +
  //   is_active(1) + ...
  // Cumulative: 8+32+32+8+8+8+8+8+8 = 120 → is_active starts at byte 120.
  const IS_ACTIVE_OFFSET = 120;

  // Solana JSON-RPC memcmp `bytes` defaults to base58 decoding. Passing a
  // base64 string without `encoding: 'base64'` triggers a Base58DecodeError
  // on chars '0'/'/'/'+/=' which are absent from the base58 alphabet.
  const accounts = await connection.getProgramAccounts(RELAYER_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(discriminator).toString('base64'), encoding: 'base64' } },
      { memcmp: { offset: IS_ACTIVE_OFFSET, bytes: Buffer.from([1]).toString('base64'), encoding: 'base64' } },
    ],
  });

  return accounts.map(({ pubkey, account }) => {
    const data = account.data;
    let offset = 8; // skip discriminator

    const operator = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
    const encryptionKey = new Uint8Array(data.slice(offset, offset + 32)); offset += 32;
    const stake = Number(data.readBigUInt64LE(offset)); offset += 8;
    /* jobsCompleted */ Number(data.readBigUInt64LE(offset)); offset += 8;
    /* jobsFailed */ Number(data.readBigUInt64LE(offset)); offset += 8;
    const lastActiveSlot = Number(data.readBigUInt64LE(offset)); offset += 8;
    const registeredAtSlot = Number(data.readBigUInt64LE(offset)); offset += 8;
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
      lastActiveSlot,
      registeredAtSlot,
    };
  });
}

/**
 * Deterministic relayer selection: SHA-256(blockhash || jobId) mod count.
 *
 * `excludedOperators` (base58 pubkey strings) lets the caller skip relayers
 * that have already failed in a prior attempt of the same flow. The function
 * filters the candidate set first, then applies the deterministic hash.
 * Throws if no relayer remains after exclusion.
 */
export function selectRelayer(
  relayers: RelayerNode[],
  blockhash: string,
  jobId: Uint8Array,
  excludedOperators?: Set<string>,
): { index: number; relayer: RelayerNode } {
  let candidates = relayers;
  if (excludedOperators && excludedOperators.size > 0) {
    candidates = relayers.filter(r => !excludedOperators.has(r.operator.toBase58()));
    if (candidates.length === 0) {
      throw new Error(`All ${relayers.length} active relayers excluded — no candidate remaining`);
    }
  }
  if (candidates.length === 0) throw new Error('No active relayers');
  if (candidates.length === 1) {
    const idx = relayers.indexOf(candidates[0]);
    return { index: idx, relayer: candidates[0] };
  }

  const input = new Uint8Array(blockhash.length + jobId.length);
  input.set(Buffer.from(blockhash), 0);
  input.set(jobId, blockhash.length);

  const hash = sha256(input);
  const seed = (hash[0] | (hash[1] << 8) | (hash[2] << 16) | ((hash[3] & 0x7f) << 24)) >>> 0;
  const candidateIdx = seed % candidates.length;
  const selected = candidates[candidateIdx];
  // Return the index in the ORIGINAL relayers array (consumers iterate it).
  const indexInOriginal = relayers.indexOf(selected);
  return { index: indexInOriginal, relayer: selected };
}

/**
 * Liveness threshold for filtering dormant relayers in selection.
 *
 * If a relayer's `lastActiveSlot` is older than `currentSlot - LIVENESS_THRESHOLD_SLOTS`
 * AND it has had a chance to run a job (lastActiveSlot != 0 OR
 * registered >= LIVENESS_THRESHOLD_SLOTS ago), treat it as dormant.
 *
 * Slots @ ~400ms each : 50_000 slots ≈ 5.5 hours. Generous grace for
 * registered-but-not-yet-picked relayers (lastActiveSlot=0 stays alive
 * for 5h post-registration). Trade-off: a relayer that crashed but stays
 * isActive on-chain will be considered live for ~5h. Acceptable because
 * the multi-relayer failover will route to the next one if this one
 * doesn't pickup within 90s blockhash window.
 */
const LIVENESS_THRESHOLD_SLOTS = 50_000;

/** Filter out dormant relayers based on `lastActiveSlot` vs the current slot. */
export function filterByLiveness(
  relayers: RelayerNode[],
  currentSlot: number,
): RelayerNode[] {
  return relayers.filter(r => {
    // Never-active fresh relayer: give it a chance until LIVENESS_THRESHOLD_SLOTS
    // since registration.
    if (r.lastActiveSlot === 0) {
      return currentSlot - r.registeredAtSlot < LIVENESS_THRESHOLD_SLOTS;
    }
    // Has completed jobs in the past → require recent activity.
    return currentSlot - r.lastActiveSlot < LIVENESS_THRESHOLD_SLOTS;
  });
}

// ── Job Submission ─────────────────────────────────────────────────────

/**
 * Generate a unique 32-byte job ID.
 */
export function generateJobId(): Uint8Array {
  return sha256(Keypair.generate().publicKey.toBytes());
}

/**
 * Options for submitRelayJob.
 *
 * - `ephemeralKeypair`: provide a pre-derived ephemeral signer (e.g. derived
 *   from a stealth meta-address via specter-sdk for cross-flow coherence).
 *   Defaults to a fresh `Keypair.generate()`.
 * - `forceV1Encryption`: skip ML-KEM-768 hybrid v2 even if the selected
 *   relayer publishes a KEM key. v2 overhead is 1161 bytes; the on-chain
 *   `encrypted_tx` cap (~1280 bytes) leaves only ~119 usable bytes — too
 *   small for zk_shielded V3 inner txs. Set true when wrapping V3.
 */
export interface SubmitRelayJobOptions {
  ephemeralKeypair?: Keypair;
  forceV1Encryption?: boolean;
  /** Operator pubkeys (base58) to skip in selection. Used by the multi-relayer
   * failover loop in `signAndSendViaRelayer` after a relayer fails to pick up. */
  excludedOperators?: Set<string>;
  /** When true, also filter out dormant relayers via `last_active_slot` heuristic
   * before selection. Defaults to true. */
  filterDormant?: boolean;
}

/**
 * Submit a relay job on-chain.
 *
 * @param serializedTx - The fully signed transaction to relay (serialized bytes)
 * @param walletPublicKey - User's wallet (funds the ephemeral keypair)
 * @param signTransaction - Wallet adapter sign function
 * @param opts - Optional ephemeral override + encryption-version override
 * @returns Job result with monitoring info
 */
export async function submitRelayJob(
  serializedTx: Uint8Array,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  opts: SubmitRelayJobOptions = {},
): Promise<RelayJobResult> {
  const connection = getConnection();
  const t0 = Date.now();

  // 1. Fetch config and active relayers
  console.log('[Relay] step1/7: fetching config + active relayers');
  const [config, relayers] = await Promise.all([
    fetchRelayerConfig(connection),
    fetchActiveRelayers(connection),
  ]);

  if (!config.isActive) throw new Error('Relay protocol is paused');
  if (relayers.length === 0) throw new Error('No active relayers available');
  console.log('[Relay] step1/7 done: ' + relayers.length + ' active relayers, jobFee=' + config.jobFeeLamports.toString() + ' lamports');

  // Apply liveness filter (skip dormant relayers per last_active_slot).
  const filterDormant = opts.filterDormant !== false; // default true
  let candidatePool = relayers;
  if (filterDormant) {
    const currentSlot = await connection.getSlot('confirmed');
    const live = filterByLiveness(relayers, currentSlot);
    if (live.length > 0) {
      candidatePool = live;
      if (live.length < relayers.length) {
        console.log('[Relay] liveness filter: ' + live.length + '/' + relayers.length + ' active relayers passed');
      }
    } else {
      console.warn('[Relay] liveness filter: 0/' + relayers.length + ' relayers look alive — falling back to full set');
    }
  }

  // 2. Generate job ID and select relayer (skip excluded operators).
  console.log('[Relay] step2/7: selecting relayer deterministically' + (opts.excludedOperators?.size ? ' (excluded=' + opts.excludedOperators.size + ')' : ''));
  const jobId = generateJobId();
  const { blockhash: currentBlockhash } = await connection.getLatestBlockhash('confirmed');
  const { relayer: selectedRelayer } = selectRelayer(candidatePool, currentBlockhash, jobId, opts.excludedOperators);
  console.log('[Relay] step2/7 done: relayer=' + selectedRelayer.operator.toBase58().slice(0, 8) + '... (kem=' + (selectedRelayer.kemEncryptionKey ? 'yes' : 'no') + ')');

  // 3. Encrypt the transaction for the selected relayer (hybrid if KEM key available
  //    and not explicitly forced to v1).
  const kemKey = opts.forceV1Encryption ? undefined : selectedRelayer.kemEncryptionKey;
  const encrypted = encryptForRelayer(serializedTx, selectedRelayer.encryptionKey, kemKey);
  const encVer = kemKey ? 'v2-hybrid' : 'v1-x25519';
  console.log('[Relay] step3/7: encrypted innerTx, version=' + encVer + ', ciphertext=' + encrypted.length + 'B (cap 1280)');

  // 4. Use caller-provided ephemeral if any, else derive deterministically
  // from the per-device session seed + jobId. Deterministic derivation is
  // critical for Phase A.1 stuck-funds recovery: even if the wrapper crashes
  // mid-flight, the ephemeral keypair can be re-derived from (sessionSeed,
  // jobId) and any leftover lamports swept back to the user wallet.
  const { deriveEphemeralForRelay, addPendingRelay, jobIdToHex } = await import('./ephemeralRecovery');
  const ephemeral = opts.ephemeralKeypair ?? (await deriveEphemeralForRelay(jobId));
  const ephemeralSrc = opts.ephemeralKeypair ? 'caller-provided' : 'derived';
  console.log('[Relay] step4/7: ephemeral=' + ephemeral.publicKey.toBase58().slice(0, 8) + '... (' + ephemeralSrc + ')');

  // 5. Fund ephemeral keypair (job fee + rent + tx fees)
  //
  // The submitter (= ephemeral) pays:
  //   - submit_job tx fee (~5k lamports)
  //   - rent for the new RelayJob PDA (init constraint) — computed dynamically
  //   - explicit CPI transfer of jobFeeLamports to the new PDA inside the handler
  //
  // Solana rent-exempt formula = (128 + size) × 6960 lamports.
  // RelayJob::LEN = 1414 (must mirror programs/p01_relayer/src/state/relay_job.rs).
  // Hardcoded estimates previously missed the 128-byte account header → ephemeral
  // ran out of lamports during the CPI transfer ("Transfer: insufficient lamports").
  const RELAY_JOB_LEN = 1414;
  const jobRent = await connection.getMinimumBalanceForRentExemption(RELAY_JOB_LEN);
  const txFees = 50_000; // generous: 5k base + priority fee headroom
  // After submit_job CPI, the ephemeral keeps `txFees - 5k` lamports. As a
  // system-owned account it must remain rent-exempt or be fully drained, else
  // the runtime rejects with "account (0) insufficient funds for rent". Top
  // up by the 0-byte rent-exempt minimum (~890k lamports). Residue is swept
  // back to the user wallet later by ephemeralRecovery.
  const ephemeralRentMin = await connection.getMinimumBalanceForRentExemption(0);
  const fundAmount =
    Number(config.jobFeeLamports) + jobRent + txFees + ephemeralRentMin;

  // Persist a pending entry BEFORE the fund tx so that any crash between
  // here and successful completion leaves a recovery breadcrumb.
  const jobIdHex = jobIdToHex(jobId);
  await addPendingRelay({
    jobId: jobIdHex,
    ephemeralPubkey: ephemeral.publicKey.toBase58(),
    expectedLamports: fundAmount,
    createdAt: new Date().toISOString(),
  });

  console.log('[Relay] step5/7: pre-funding ephemeral, total=' + fundAmount + ' lamports (jobFee+rent+txFees)');
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

  console.log('[Relay] step5/7 done: ephemeral funded with ' + fundAmount + ' lamports, fundTx=' + fundSig.slice(0, 12) + '...');

  // 6. Build submit_job instruction
  console.log('[Relay] step6/7: building submit_job ix');
  const [configPDA] = PublicKey.findProgramAddressSync([SEEDS.CONFIG], RELAYER_PROGRAM_ID);
  const [relayerNodePDA] = PublicKey.findProgramAddressSync(
    [SEEDS.NODE, selectedRelayer.operator.toBytes()],
    RELAYER_PROGRAM_ID,
  );
  const [jobPDA] = PublicKey.findProgramAddressSync(
    [SEEDS.JOB, jobId],
    RELAYER_PROGRAM_ID,
  );
  console.log('[Relay] step6/7: jobPDA=' + jobPDA.toBase58().slice(0, 8) + '...');

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
      { pubkey: relayerNodePDA, isSigner: false, isWritable: true },     // relayer_node (mut: apply_decay)
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

  console.log('[Relay] step7/7 done: relay-job submitted, outerSig=' + signature.slice(0, 12) + '..., total elapsed=' + (Date.now() - t0) + 'ms');

  return {
    jobAddress: jobPDA,
    jobId,
    ephemeralKeypair: ephemeral,
    signature,
    selectedOperator: selectedRelayer.operator,
  };
}

// ── Chunked Job Submission (Phase A.3) ─────────────────────────────────

/** Maximum chunk data bytes per submit_chunk tx.
 *
 * Sized so a single submit_chunk tx fits inside the 1232-byte Solana cap.
 *
 * Tx breakdown (recomputed 2026-05-07 after device error "1306 > 1232") :
 *   sigCount(1) + 64×1 sig                  = 65
 *   header                                   = 3
 *   keysCount(1) + 32×5 unique keys
 *     (ephemeral, jobPDA, chunkPDA, systemProgram, p01_relayer programId)
 *                                            = 161
 *   recentBlockhash                          = 32
 *   ixCount(1)                               = 1
 *   per-ix: progIdx(1) + acctCount(1)
 *     + 4 acct_indices(4) + dataLen(4)       = 10
 *   ix data fixed: disc(8) + jobId(32) + chunkIdx(2) + vecLen(4)
 *                                            = 46
 *   Total fixed: 65+3+161+32+1+1+10+46       = 319
 * → Available for data = 1232 - 319 = 913 bytes.
 *
 * On-chain `MAX_CHUNK_DATA_SIZE` in relay_job.rs is 990 (looser cap on the
 * program side; mobile self-imposes the tighter 900 for safe margin). */
export const MAX_CHUNK_DATA_SIZE = 900;

/** RelayChunk PDA on-chain allocated size (bytes).
 * MUST match `RelayChunk::LEN` in programs/p01_relayer/src/state/relay_job.rs,
 * which uses the on-chain `MAX_CHUNK_DATA_SIZE = 990` (the looser cap). The
 * mobile MAX_CHUNK_DATA_SIZE = 900 is a tighter self-imposed limit for the
 * tx envelope; it does NOT change the allocated account size. Pre-fund rent
 * MUST use 990 (the actual on-chain alloc) or the second chunk's `init`
 * fails with Custom(0x1) ResultWithNegativeLamports. */
const ONCHAIN_MAX_CHUNK_DATA_SIZE = 990;
const RELAY_CHUNK_LEN = 8 + 32 + 2 + 4 + ONCHAIN_MAX_CHUNK_DATA_SIZE + 1; // = 1037

/** Discriminator for `submit_job_chunked` (sha256("global:submit_job_chunked")[..8]). */
const SUBMIT_JOB_CHUNKED_DISC = Buffer.from([192, 160, 6, 61, 217, 212, 36, 196]);
/** Discriminator for `submit_chunk` (sha256("global:submit_chunk")[..8]). */
const SUBMIT_CHUNK_DISC = Buffer.from([53, 145, 90, 120, 188, 31, 143, 10]);

const SEED_RELAY_CHUNK = Buffer.from('relay_chunk');

/** Compute the per-chunk PDA address, mirroring on-chain seeds. */
function deriveChunkPDA(jobId: Uint8Array, chunkIndex: number): PublicKey {
  const idxBuf = Buffer.alloc(2);
  idxBuf.writeUInt16LE(chunkIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_RELAY_CHUNK, jobId, idxBuf],
    RELAYER_PROGRAM_ID,
  );
  return pda;
}

/**
 * Phase A.3 — submit a chunked relay job.
 *
 * Same shape as `submitRelayJob` but supports arbitrary-size encrypted_tx
 * by splitting the ciphertext across N `submit_chunk` calls. Use when
 * the encrypted bytes > legacy single-shot envelope budget (845B for v1,
 * impossible for v2 hybrid ML-KEM-768 = 1161B overhead).
 *
 * Pre-fund covers : jobFee + RelayJob rent + N × RelayChunk rent + N+1
 * tx fees + ephemeralRentMin. Worst-case overshoot is reclaimed by
 * `ephemeralRecovery` after completion.
 */
export async function submitChunkedRelayJob(
  serializedTx: Uint8Array,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  opts: SubmitRelayJobOptions = {},
): Promise<RelayJobResult> {
  const connection = getConnection();
  const t0 = Date.now();

  // 1. Fetch config + active relayers (same as legacy)
  console.log('[ChunkedRelay] step1/7: fetching config + active relayers');
  const [config, relayers] = await Promise.all([
    fetchRelayerConfig(connection),
    fetchActiveRelayers(connection),
  ]);
  if (!config.isActive) throw new Error('Relay protocol is paused');
  if (relayers.length === 0) throw new Error('No active relayers available');

  const filterDormant = opts.filterDormant !== false;
  let candidatePool = relayers;
  if (filterDormant) {
    const currentSlot = await connection.getSlot('confirmed');
    const live = filterByLiveness(relayers, currentSlot);
    if (live.length > 0) candidatePool = live;
  }

  // 2. Pick relayer + jobId
  const jobId = generateJobId();
  const { blockhash: outerBlockhash } = await connection.getLatestBlockhash('confirmed');
  const { relayer: selectedRelayer } = selectRelayer(candidatePool, outerBlockhash, jobId, opts.excludedOperators);
  console.log('[ChunkedRelay] step2/7: relayer=' + selectedRelayer.operator.toBase58().slice(0, 8) + '... (kem=' + (selectedRelayer.kemEncryptionKey ? 'yes' : 'no') + ')');

  // 3. Encrypt (chunked unlocks v2 hybrid ML-KEM-768 by default)
  const kemKey = opts.forceV1Encryption ? undefined : selectedRelayer.kemEncryptionKey;
  const encrypted = encryptForRelayer(serializedTx, selectedRelayer.encryptionKey, kemKey);
  const encVer = kemKey ? 2 : 1;
  const totalChunks = Math.ceil(encrypted.length / MAX_CHUNK_DATA_SIZE);
  if (totalChunks < 1 || totalChunks > 256) {
    throw new Error(`Chunked submission requires 1..=256 chunks, got ${totalChunks}`);
  }
  console.log('[ChunkedRelay] step3/7: encrypted=' + encrypted.length + 'B → ' + totalChunks + ' chunks (v' + encVer + ')');

  // 4. Ephemeral
  const { deriveEphemeralForRelay, addPendingRelay, jobIdToHex } = await import('./ephemeralRecovery');
  const ephemeral = opts.ephemeralKeypair ?? (await deriveEphemeralForRelay(jobId));

  // 5. Pre-fund
  const RELAY_JOB_LEN = 1414;
  const jobRent = await connection.getMinimumBalanceForRentExemption(RELAY_JOB_LEN);
  const chunkRent = await connection.getMinimumBalanceForRentExemption(RELAY_CHUNK_LEN);
  const ephemeralRentMin = await connection.getMinimumBalanceForRentExemption(0);
  // N+1 tx fees: 1 submit_job_chunked + N submit_chunk. Each ~5k base, plus
  // headroom for priority fees + retries = 30k per tx.
  const txFees = 30_000 * (totalChunks + 1);
  const fundAmount =
    Number(config.jobFeeLamports) +
    jobRent +
    totalChunks * chunkRent +
    txFees +
    ephemeralRentMin;

  const jobIdHex = jobIdToHex(jobId);
  await addPendingRelay({
    jobId: jobIdHex,
    ephemeralPubkey: ephemeral.publicKey.toBase58(),
    expectedLamports: fundAmount,
    createdAt: new Date().toISOString(),
  });

  const sourceBal = await connection.getBalance(walletPublicKey);
  console.log(
    `[ChunkedRelay] step5/7: pre-funding ephemeral=${ephemeral.publicKey.toBase58().slice(0, 8)}… ` +
    `fundAmount=${(fundAmount / 1e9).toFixed(6)} SOL ` +
    `(jobFee=${(Number(config.jobFeeLamports) / 1e9).toFixed(6)} ` +
    `jobRent=${(jobRent / 1e9).toFixed(6)} ` +
    `${totalChunks}×chunkRent=${((totalChunks * chunkRent) / 1e9).toFixed(6)} ` +
    `txFees=${(txFees / 1e9).toFixed(6)} ` +
    `ephRent=${(ephemeralRentMin / 1e9).toFixed(6)})`,
  );
  console.log(`[ChunkedRelay] step5/7 source ${walletPublicKey.toBase58().slice(0, 8)}… bal=${(sourceBal / 1e9).toFixed(6)} SOL`);
  if (sourceBal < fundAmount) {
    console.error(`[ChunkedRelay] step5/7 INSUFFICIENT SOURCE BAL — short ${((fundAmount - sourceBal) / 1e9).toFixed(6)} SOL (this will fail simulation)`);
  }
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
  console.log(`[ChunkedRelay] step5/7 fund confirmed sig=${fundSig.slice(0, 16)}…`);

  // 6. submit_job_chunked
  const [configPDA] = PublicKey.findProgramAddressSync([SEEDS.CONFIG], RELAYER_PROGRAM_ID);
  const [relayerNodePDA] = PublicKey.findProgramAddressSync(
    [SEEDS.NODE, selectedRelayer.operator.toBytes()],
    RELAYER_PROGRAM_ID,
  );
  const [jobPDA] = PublicKey.findProgramAddressSync([SEEDS.JOB, jobId], RELAYER_PROGRAM_ID);

  const initData = Buffer.alloc(8 + 32 + 2 + 1);
  SUBMIT_JOB_CHUNKED_DISC.copy(initData, 0);
  Buffer.from(jobId).copy(initData, 8);
  initData.writeUInt16LE(totalChunks, 40);
  initData.writeUInt8(encVer, 42);

  const initIx = new TransactionInstruction({
    programId: RELAYER_PROGRAM_ID,
    keys: [
      { pubkey: ephemeral.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: relayerNodePDA, isSigner: false, isWritable: true },
      { pubkey: jobPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  const initTx = new Transaction().add(initIx);
  initTx.feePayer = ephemeral.publicKey;
  const { blockhash: initBh, lastValidBlockHeight: initLvbh } =
    await connection.getLatestBlockhash('confirmed');
  initTx.recentBlockhash = initBh;
  initTx.sign(ephemeral);
  const initSig = await connection.sendRawTransaction(initTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    { signature: initSig, blockhash: initBh, lastValidBlockHeight: initLvbh },
    'confirmed',
  );
  const ephBalAfterInit = await connection.getBalance(ephemeral.publicKey);
  console.log(
    `[ChunkedRelay] step6/7: submit_job_chunked ok sig=${initSig.slice(0, 16)}… ` +
    `eph bal=${(ephBalAfterInit / 1e9).toFixed(6)} SOL`,
  );

  // 7. submit_chunk × N (parallel waves)
  console.log('[ChunkedRelay] step7/7: submitting ' + totalChunks + ' chunks');
  const { blockhash: chunkBh, lastValidBlockHeight: chunkLvbh } =
    await connection.getLatestBlockhash('confirmed');

  const chunkTxs: Transaction[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * MAX_CHUNK_DATA_SIZE;
    const end = Math.min(start + MAX_CHUNK_DATA_SIZE, encrypted.length);
    const data = encrypted.slice(start, end);

    const chunkPda = deriveChunkPDA(jobId, i);
    const ixData = Buffer.alloc(8 + 32 + 2 + 4 + data.length);
    SUBMIT_CHUNK_DISC.copy(ixData, 0);
    Buffer.from(jobId).copy(ixData, 8);
    ixData.writeUInt16LE(i, 40);
    ixData.writeUInt32LE(data.length, 42);
    Buffer.from(data).copy(ixData, 46);

    const ix = new TransactionInstruction({
      programId: RELAYER_PROGRAM_ID,
      keys: [
        { pubkey: ephemeral.publicKey, isSigner: true, isWritable: true },
        { pubkey: jobPDA, isSigner: false, isWritable: true },
        { pubkey: chunkPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ixData,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = ephemeral.publicKey;
    tx.recentBlockhash = chunkBh;
    tx.sign(ephemeral);
    chunkTxs.push(tx);
  }

  // Send all chunks in parallel waves of 8
  const WAVE_SIZE = 8;
  const chunkSigs: string[] = [];
  for (let w = 0; w < chunkTxs.length; w += WAVE_SIZE) {
    const slice = chunkTxs.slice(w, Math.min(w + WAVE_SIZE, chunkTxs.length));
    const sigs = await Promise.all(
      slice.map(tx =>
        connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        }),
      ),
    );
    chunkSigs.push(...sigs);
    console.log(`[ChunkedRelay] step7 wave ${Math.floor(w / WAVE_SIZE) + 1}: sent ${slice.length} chunks (${chunkSigs.length}/${totalChunks})`);
  }
  // Confirm all
  await Promise.all(
    chunkSigs.map(sig =>
      connection.confirmTransaction(
        { signature: sig, blockhash: chunkBh, lastValidBlockHeight: chunkLvbh },
        'confirmed',
      ),
    ),
  );

  const ephBalFinal = await connection.getBalance(ephemeral.publicKey);
  console.log(
    `[ChunkedRelay] DONE in ${Date.now() - t0}ms — ${totalChunks} chunks landed, ` +
    `jobPDA=${jobPDA.toBase58().slice(0, 8)}… eph leftover=${(ephBalFinal / 1e9).toFixed(6)} SOL`,
  );

  return {
    jobAddress: jobPDA,
    jobId,
    ephemeralKeypair: ephemeral,
    signature: initSig,
    selectedOperator: selectedRelayer.operator,
  };
}

// ── Cancel Job ─────────────────────────────────────────────────────────

/**
 * Cancel a Pending relay job. Only the original submitter (ephemeral keypair)
 * can sign. On success, the job PDA is closed and rent + fee are refunded
 * to the ephemeral. No slash to the relayer.
 *
 * Used by the V3 wrapper when the inner-tx blockhash expires while the job
 * is still Pending — cancel + retry with a fresh blockhash.
 */
export async function cancelRelayJob(
  jobAddress: PublicKey,
  ephemeral: Keypair,
): Promise<string> {
  const connection = getConnection();
  // Anchor discriminator for cancel_job: sha256("global:cancel_job")[0..8]
  const cancelDiscriminator = sha256(Buffer.from('global:cancel_job')).slice(0, 8);

  const cancelIx = new TransactionInstruction({
    programId: RELAYER_PROGRAM_ID,
    keys: [
      { pubkey: ephemeral.publicKey, isSigner: true, isWritable: true }, // submitter
      { pubkey: jobAddress, isSigner: false, isWritable: true }, // job (close=submitter)
    ],
    data: Buffer.from(cancelDiscriminator),
  });

  const tx = new Transaction().add(cancelIx);
  tx.feePayer = ephemeral.publicKey;
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(ephemeral);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  console.log('[Relay] cancel_job done, sig=' + sig.slice(0, 12) + '...');
  return sig;
}

// ── Job Monitoring ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;
// Probe blockhash freshness every BLOCKHASH_CHECK_INTERVAL_MS while job pending.
// Solana's blockhash window is ~150 slots (~60s legacy, ~120-150s new). We
// fail-fast at the lower end to leave headroom for cancel + retry.
const BLOCKHASH_CHECK_INTERVAL_MS = 10_000;
const BLOCKHASH_FAILSAFE_MS = 90_000;

/**
 * Specific error thrown by `monitorJob` when the inner-tx blockhash expires
 * while the job is still Pending. The caller should cancel the job (refund
 * ephemeral rent) and retry with a fresh blockhash.
 *
 * The optional `failedOperator` field is set by `relayTransaction` after
 * cancelling so the multi-relayer failover loop in `signAndSendViaRelayer`
 * can exclude this relayer on the next attempt.
 */
export class InnerBlockhashExpiredError extends Error {
  public failedOperator?: PublicKey;

  constructor(public readonly jobAddress: PublicKey) {
    super(
      `Inner-tx blockhash expired while job ${jobAddress.toBase58().slice(0, 8)}... still Pending — abort and retry`,
    );
    this.name = 'InnerBlockhashExpiredError';
  }
}

/**
 * Monitor a relay job until completion or timeout.
 * The relayer closes the job PDA on completion, so account disappearing = done.
 *
 * If `innerBlockhash` is provided, the function also probes the blockhash for
 * freshness while the job is Pending. When it goes stale (or after
 * `BLOCKHASH_FAILSAFE_MS` regardless of probe accuracy), `InnerBlockhashExpiredError`
 * is thrown so the caller can cancel + retry with a fresh blockhash instead
 * of blocking the user for the full timeout window.
 */
export async function monitorJob(
  jobAddress: PublicKey,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  innerBlockhash?: string,
): Promise<{ success: boolean; status: JobStatus }> {
  const connection = getConnection();
  const startTime = Date.now();
  let pollCount = 0;
  let lastBlockhashCheck = startTime;
  console.log('[Relay] monitor: starting poll, timeoutMs=' + timeoutMs + (innerBlockhash ? ', blockhash-aware' : ''));

  while (Date.now() - startTime < timeoutMs) {
    const accountInfo = await connection.getAccountInfo(jobAddress);
    pollCount++;

    if (!accountInfo) {
      // Account closed — job completed, expired, or cancelled
      console.log('[Relay] monitor: account closed → completed (polls=' + pollCount + ', elapsed=' + (Date.now() - startTime) + 'ms)');
      return { success: true, status: JobStatus.Completed };
    }

    // Check status byte (at data.length - 2: status + bump)
    const statusByte = accountInfo.data[accountInfo.data.length - 2];
    if (statusByte !== JobStatus.Pending) {
      const statusNames = ['Pending', 'Completed', 'Expired', 'Cancelled'];
      console.log('[Relay] monitor: status changed → ' + statusNames[statusByte] + ' (polls=' + pollCount + ', elapsed=' + (Date.now() - startTime) + 'ms)');
      return {
        success: statusByte === JobStatus.Completed,
        status: statusByte as JobStatus,
      };
    }

    // Fail-fast on inner-tx blockhash expiry instead of waiting for the full
    // user-facing timeout — lets the wrapper cancel + retry quickly.
    const elapsed = Date.now() - startTime;
    if (innerBlockhash && elapsed - (lastBlockhashCheck - startTime) >= BLOCKHASH_CHECK_INTERVAL_MS) {
      lastBlockhashCheck = Date.now();
      try {
        const isValid = await connection.isBlockhashValid(innerBlockhash, { commitment: 'confirmed' });
        if (!isValid) {
          console.warn('[Relay] monitor: inner blockhash expired (job still Pending after ' + elapsed + 'ms) — fail-fast');
          throw new InnerBlockhashExpiredError(jobAddress);
        }
      } catch (e) {
        if (e instanceof InnerBlockhashExpiredError) throw e;
        // RPC error — don't fail-fast on flaky RPC; rely on the fail-safe timer.
        console.warn('[Relay] monitor: blockhash probe RPC error, continuing: ' + (e as Error).message);
      }
    }
    // Hard fail-safe regardless of probe result (covers RPC outages).
    if (innerBlockhash && elapsed >= BLOCKHASH_FAILSAFE_MS) {
      console.warn('[Relay] monitor: blockhash fail-safe triggered after ' + elapsed + 'ms — assuming expired');
      throw new InnerBlockhashExpiredError(jobAddress);
    }

    if (pollCount % 5 === 0) {
      console.log('[Relay] monitor: still pending, poll=' + pollCount + ', elapsed=' + elapsed + 'ms');
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log('[Relay] monitor: TIMEOUT after ' + timeoutMs + 'ms (polls=' + pollCount + ')');
  return { success: false, status: JobStatus.Pending };
}

// ── High-Level API ─────────────────────────────────────────────────────

/**
 * Options for relayTransaction.
 */
export interface RelayTransactionOptions extends SubmitRelayJobOptions {
  timeoutMs?: number;
  /** Inner-tx recentBlockhash for fail-fast expiry detection (recommended). */
  innerBlockhash?: string;
}

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
 * @param opts - timeout, ephemeral override, encryption-version override
 * @returns Relay job signature
 */
export async function relayTransaction(
  serializedTx: Uint8Array,
  walletPublicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  opts: RelayTransactionOptions = {},
): Promise<string> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, innerBlockhash, ...submitOpts } = opts;
  const { removePendingRelay, markPendingRelayErrored, jobIdToHex } =
    await import('./ephemeralRecovery');

  const job = await submitRelayJob(serializedTx, walletPublicKey, signTransaction, submitOpts);
  const jobIdHex = jobIdToHex(job.jobId);

  console.log('[Relay] Monitoring job:', job.jobAddress.toBase58().slice(0, 12) + '...');

  let result;
  try {
    result = await monitorJob(job.jobAddress, timeoutMs, innerBlockhash);
  } catch (e) {
    if (e instanceof InnerBlockhashExpiredError) {
      // Tag with the failed operator so the wrapper's failover loop can
      // exclude this relayer on the next attempt.
      e.failedOperator = job.selectedOperator;
      // Cancel the job to refund ephemeral rent before bubbling up.
      try {
        await cancelRelayJob(job.jobAddress, job.ephemeralKeypair);
        await removePendingRelay(jobIdHex);
        console.log('[Relay] cancelled stale job after blockhash expiry (failed op=' + job.selectedOperator.toBase58().slice(0, 8) + '...)');
      } catch (cancelErr) {
        console.warn('[Relay] cancel after blockhash expiry failed: ' + (cancelErr as Error).message);
        await markPendingRelayErrored(jobIdHex, `blockhash-expired-cancel-failed: ${(cancelErr as Error)?.message ?? String(cancelErr)}`);
      }
    } else {
      await markPendingRelayErrored(jobIdHex, `monitor threw: ${(e as Error)?.message ?? String(e)}`);
    }
    throw e;
  }

  if (!result.success) {
    const statusNames = ['Pending', 'Completed', 'Expired', 'Cancelled'];
    const status = statusNames[result.status] || String(result.status);
    await markPendingRelayErrored(jobIdHex, `status=${status}`);
    throw new Error(`Relay job failed with status: ${status}`);
  }

  // Job consumed by relay protocol — ephemeral funds spent, nothing to sweep.
  await removePendingRelay(jobIdHex);
  console.log('[Relay] Job completed successfully');
  return job.signature;
}
