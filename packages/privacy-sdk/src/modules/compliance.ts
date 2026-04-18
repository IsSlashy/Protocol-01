import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  Keypair,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { poseidon2, poseidon3, poseidon4 } from 'poseidon-lite';
import { groth16 } from 'snarkjs';
import { randomFieldElement as toolkitRandomFieldElement } from '@protocol-01/privacy-toolkit';
import type {
  Signer,
  Network,
  ProgramIds,
  TokenInfo,
  TxResult,
  Groth16Proof,
  WalletAdapter,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS, COMPUTE_UNITS } from '../constants';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Sorted Merkle tree depth for the sanctions non-inclusion proof. */
const SANCTIONS_TREE_DEPTH = 20;

/** Attestation type discriminator stored on-chain. */
const ATTESTATION_TYPE_RANGE = 0;
const ATTESTATION_TYPE_INNOCENCE = 1;

/** Default proof generation timeout (ms). */
const DEFAULT_PROOF_TIMEOUT_MS = 120_000;

/** Default attestation validity period: 90 days in seconds. */
const DEFAULT_ATTESTATION_TTL = 90 * 24 * 60 * 60;

/** Compute units required for compliance verification instructions. */
const COMPLIANCE_VERIFY_CU = 400_000;

/** PDA seed prefix for compliance attestation accounts. */
const COMPLIANCE_SEED = 'compliance';

// ─── Exported Types ──────────────────────────────────────────────────────────

export interface ComplianceRangeParams {
  /** On-chain balance commitment (from ConfidentialAccount). */
  balanceCommitment: bigint;
  /** Lower bound (inclusive). Set to 0n for upper-bound-only proof. */
  minBound: bigint;
  /** Upper bound (inclusive). e.g., 10_000_000_000n for $10K USDC. */
  maxBound: bigint;
  /** Token symbol (resolved via resolveToken). */
  token: string;
  /** Private: actual balance. */
  balance: bigint;
  /** Private: commitment salt. */
  salt: bigint;
  /** Private: commitment nonce. */
  nonce: bigint;
  /** Private: spending key. */
  spendingKey: bigint;
}

export interface ComplianceInnocenceParams {
  /** Merkle root of the sorted sanctions list (on-chain). */
  sanctionsRoot: bigint;
  /** Private: spending key. */
  spendingKey: bigint;
  /** Lower adjacent leaf from the sorted tree bracketing the user. */
  lowLeaf: bigint;
  /** Upper adjacent leaf from the sorted tree bracketing the user. */
  highLeaf: bigint;
  /** Merkle path index bits for the low leaf (depth 20). */
  lowPathIndices: number[];
  /** Merkle path elements for the low leaf (depth 20). */
  lowPathElements: bigint[];
  /** Merkle path index bits for the high leaf (depth 20). */
  highPathIndices: number[];
  /** Merkle path elements for the high leaf (depth 20). */
  highPathElements: bigint[];
}

export interface ComplianceAttestation {
  /** On-chain address of the attestation PDA. */
  address: PublicKey;
  /** Authority that created the attestation (typically the program). */
  authority: PublicKey;
  /** User wallet the attestation belongs to. */
  user: PublicKey;
  /** Type of compliance proof this attestation certifies. */
  attestationType: 'range' | 'innocence';
  /** Whether the on-chain verifier confirmed the proof. */
  isVerified: boolean;
  /** Unix timestamp when the attestation was issued. */
  issuedAt: number;
  /** Unix timestamp when the attestation expires. */
  expiresAt: number;
  /** Whether the attestation has been revoked by the authority. */
  revoked: boolean;
  /** Sanctions Merkle root at time of proof (innocence attestations only). */
  sanctionsRoot?: Uint8Array;
  /** Threshold or max bound used in the proof. */
  threshold: bigint;
  /** SHA-256 hash of the circuit verification key used. */
  circuitVkHash: Uint8Array;
}

export interface ComplianceRangeResult {
  /** Transaction result from the on-chain verification. */
  tx: TxResult;
  /** Address of the created ComplianceAttestation PDA. */
  attestationAddress: PublicKey;
  /** Unique nonce used for this attestation. */
  attestationNonce: bigint;
}

export interface ComplianceInnocenceResult {
  /** Transaction result from the on-chain verification. */
  tx: TxResult;
  /** Address of the created ComplianceAttestation PDA. */
  attestationAddress: PublicKey;
  /** Unique nonce used for this attestation. */
  attestationNonce: bigint;
}

/** Circuit file paths for compliance proof generation. */
export interface ComplianceCircuitPaths {
  /** compliance_range circuit WASM file path or URL. */
  rangeWasm?: string;
  /** compliance_range circuit zkey file path or URL. */
  rangeZkey?: string;
  /** compliance_innocence circuit WASM file path or URL. */
  innocenceWasm?: string;
  /** compliance_innocence circuit zkey file path or URL. */
  innocenceZkey?: string;
  /** Proof generation timeout in ms (default: 120000). */
  timeout?: number;
}

// ─── Borsh Serialization Helpers ─────────────────────────────────────────────

/** Encode a Groth16Proof to the on-chain Anchor format: pi_a[64] + pi_b[128] + pi_c[64] = 256 bytes. */
function encodeGroth16Proof(proof: Groth16Proof): Buffer {
  const buf = Buffer.alloc(256);
  writeBigUint256BE(buf, 0, BigInt(proof.pi_a[0]));
  writeBigUint256BE(buf, 32, BigInt(proof.pi_a[1]));
  writeBigUint256BE(buf, 64, BigInt(proof.pi_b[0][0]));
  writeBigUint256BE(buf, 96, BigInt(proof.pi_b[0][1]));
  writeBigUint256BE(buf, 128, BigInt(proof.pi_b[1][0]));
  writeBigUint256BE(buf, 160, BigInt(proof.pi_b[1][1]));
  writeBigUint256BE(buf, 192, BigInt(proof.pi_c[0]));
  writeBigUint256BE(buf, 224, BigInt(proof.pi_c[1]));
  return buf;
}

/** Write a BigInt as a 32-byte big-endian unsigned integer into a buffer at offset. */
function writeBigUint256BE(buf: Buffer, offset: number, value: bigint): void {
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

/** Encode a bigint as a little-endian buffer of the specified length. */
function bigintToLeBytes(value: bigint, len = 32): Buffer {
  const buf = Buffer.alloc(len);
  let v = value;
  for (let i = 0; i < len; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/** Encode a u64 as an 8-byte little-endian buffer. */
function u64ToLeBytes(value: bigint | number): Buffer {
  return bigintToLeBytes(BigInt(value), 8);
}

/** Read a little-endian byte slice as a bigint. */
function bufferToBigint(buf: Uint8Array, offset: number, len: number): bigint {
  let result = 0n;
  for (let i = len - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[offset + i]!);
  }
  return result;
}

/** Read a little-endian u64 from a buffer. */
function u64FromLeBytes(buf: Uint8Array, offset: number): bigint {
  return bufferToBigint(buf, offset, 8);
}

/** Read a little-endian i64 as a JS number (for timestamps). */
function i64FromLeBytes(buf: Uint8Array, offset: number): number {
  return Number(u64FromLeBytes(buf, offset));
}

// ─── Anchor Instruction Discriminator ────────────────────────────────────────

/**
 * Compute the 8-byte Anchor instruction discriminator for a given instruction name.
 * Anchor uses: sha256(utf8ToBytes("global:<instruction_name>"))[0..8]
 */
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`)).slice(0, 8));
}

// ─── Module ──────────────────────────────────────────────────────────────────

/**
 * ComplianceModule enables regulatory compliance without breaking privacy.
 *
 * It wraps two ZK circuits:
 * 1. **compliance_range** — prove a balance is between MIN and MAX
 *    (2,164 constraints, 5 public inputs)
 * 2. **compliance_innocence** — prove a user is NOT on a sanctions list
 *    via sorted Merkle tree non-inclusion (22,347 constraints, 3 public inputs)
 *
 * Successful proofs create on-chain ComplianceAttestation PDAs that third
 * parties (exchanges, DeFi protocols, regulators) can verify without
 * learning the underlying balance or identity.
 *
 * @example
 * ```ts
 * const compliance = sdk.compliance;
 * compliance.setCircuitPaths({
 *   rangeWasm: '/circuits/compliance_range.wasm',
 *   rangeZkey: '/circuits/compliance_range.zkey',
 *   innocenceWasm: '/circuits/compliance_innocence.wasm',
 *   innocenceZkey: '/circuits/compliance_innocence.zkey',
 * });
 *
 * const result = await compliance.proveRange({
 *   balanceCommitment: commitment,
 *   minBound: 0n,
 *   maxBound: 10_000_000_000n,
 *   token: 'USDC',
 *   balance: 5_000_000_000n,
 *   salt: mySalt,
 *   nonce: myNonce,
 *   spendingKey: myKey,
 * });
 * ```
 */
export class ComplianceModule {
  /** Circuit file paths for proof generation. */
  private circuitPaths?: ComplianceCircuitPaths;

  constructor(
    private connection: Connection,
    private wallet: Signer,
    private network: Network,
    private programIds: ProgramIds,
    private resolveToken: (symbol: string) => TokenInfo,
  ) {}

  /**
   * Configure circuit file paths for compliance proof generation.
   *
   * Must be called before `proveRange()` or `proveInnocence()`.
   *
   * @param paths - WASM and zkey file paths for both compliance circuits.
   */
  setCircuitPaths(paths: ComplianceCircuitPaths): void {
    this.circuitPaths = paths;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Prove that a shielded balance falls within a specified range.
   *
   * Generates a Groth16 proof over the `compliance_range` circuit
   * (2,164 constraints) demonstrating that the private balance committed
   * to on-chain satisfies `minBound <= balance <= maxBound`, without
   * revealing the actual balance.
   *
   * On success, creates a ComplianceAttestation PDA on-chain that third
   * parties can query to verify compliance.
   *
   * @param params - Range proof parameters including bounds and private witness.
   * @returns Transaction result and the attestation PDA address.
   * @throws {PrivacyError} PROOF_GENERATION_FAILED if proof generation fails.
   * @throws {PrivacyError} TRANSACTION_FAILED if the on-chain verification fails.
   */
  async proveRange(params: ComplianceRangeParams): Promise<ComplianceRangeResult> {
    try {
      this.assertRangeCircuitConfigured();
      this.validateRangeParams(params);

      const owner = this.getWalletPublicKey();
      const tokenInfo = this.resolveToken(params.token);
      const attestationNonce = this.randomFieldElement();
      const nonceBytes = bigintToLeBytes(attestationNonce, 32);

      // Derive attestation PDA
      const [attestationPDA] = this.deriveAttestationPDA(
        owner,
        ATTESTATION_TYPE_RANGE,
        nonceBytes,
      );

      // Convert the token mint to a field element for the circuit
      const tokenMintField = this.pubkeyToFieldElement(tokenInfo.mint);

      // Build circuit inputs
      const circuitInputs: Record<string, string> = {
        // Public signals (5)
        balance_commitment: params.balanceCommitment.toString(),
        min_bound: params.minBound.toString(),
        max_bound: params.maxBound.toString(),
        token_mint: tokenMintField.toString(),
        attestation_nonce: attestationNonce.toString(),
        // Private witness (4)
        balance: params.balance.toString(),
        salt: params.salt.toString(),
        nonce: params.nonce.toString(),
        spending_key: params.spendingKey.toString(),
      };

      // Generate Groth16 proof
      const { proof, publicSignals } = await this.generateProof(
        this.circuitPaths!.rangeWasm!,
        this.circuitPaths!.rangeZkey!,
        circuitInputs,
      );

      // Encode proof for on-chain submission
      const proofBytes = encodeGroth16Proof(proof as Groth16Proof);

      // Encode public signals as 32-byte LE field elements
      const publicSignalsBuf = Buffer.concat(
        publicSignals.map((s) => bigintToLeBytes(BigInt(s))),
      );

      // Build instruction data:
      // discriminator(8) + type(1) + proof(256) + num_signals(4) + signals(N*32) + nonce(32) + ttl(8)
      const disc = instructionDiscriminator('verify_compliance');
      const ttl = u64ToLeBytes(DEFAULT_ATTESTATION_TTL);
      const numSignals = Buffer.alloc(4);
      numSignals.writeUInt32LE(publicSignals.length, 0);

      const data = Buffer.concat([
        disc,
        Buffer.from([ATTESTATION_TYPE_RANGE]),
        proofBytes,
        numSignals,
        publicSignalsBuf,
        nonceBytes,
        ttl,
      ]);

      // Build transaction
      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPLIANCE_VERIFY_CU }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: attestationPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkShielded,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);

      return {
        tx: txResult,
        attestationAddress: attestationPDA,
        attestationNonce,
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        `Compliance range proof failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Prove that the user is NOT on a sanctions list.
   *
   * Generates a Groth16 proof over the `compliance_innocence` circuit
   * (22,347 constraints) using a sorted Merkle tree non-inclusion proof.
   * The user provides two adjacent leaves from the sanctions tree that
   * bracket their identity commitment (lowLeaf < userCommitment < highLeaf),
   * proving they are not a member of the list.
   *
   * On success, creates a ComplianceAttestation PDA on-chain recording the
   * sanctions root at the time of proof, which can be verified by third
   * parties without learning the user's identity.
   *
   * @param params - Innocence proof parameters including Merkle paths.
   * @returns Transaction result and the attestation PDA address.
   * @throws {PrivacyError} PROOF_GENERATION_FAILED if proof generation fails.
   * @throws {PrivacyError} TRANSACTION_FAILED if the on-chain verification fails.
   */
  async proveInnocence(params: ComplianceInnocenceParams): Promise<ComplianceInnocenceResult> {
    try {
      this.assertInnocenceCircuitConfigured();
      this.validateInnocenceParams(params);

      const owner = this.getWalletPublicKey();
      const attestationNonce = this.randomFieldElement();
      const nonceBytes = bigintToLeBytes(attestationNonce, 32);

      // Derive user commitment and address from spending key
      const userCommitment = poseidon2([params.spendingKey, 0n]);
      const userAddress = poseidon2([params.spendingKey, 1n]);

      // Derive attestation PDA
      const [attestationPDA] = this.deriveAttestationPDA(
        owner,
        ATTESTATION_TYPE_INNOCENCE,
        nonceBytes,
      );

      // Build circuit inputs
      const circuitInputs: Record<string, string | string[]> = {
        // Public signals (3)
        sanctions_root: params.sanctionsRoot.toString(),
        user_commitment: userCommitment.toString(),
        attestation_nonce: attestationNonce.toString(),
        // Private witness
        spending_key: params.spendingKey.toString(),
        user_address: userAddress.toString(),
        low_leaf: params.lowLeaf.toString(),
        high_leaf: params.highLeaf.toString(),
        low_path_indices: params.lowPathIndices.map((i) => i.toString()),
        low_path_elements: params.lowPathElements.map((e) => e.toString()),
        high_path_indices: params.highPathIndices.map((i) => i.toString()),
        high_path_elements: params.highPathElements.map((e) => e.toString()),
      };

      // Generate Groth16 proof
      const { proof, publicSignals } = await this.generateProof(
        this.circuitPaths!.innocenceWasm!,
        this.circuitPaths!.innocenceZkey!,
        circuitInputs,
      );

      // Encode proof for on-chain submission
      const proofBytes = encodeGroth16Proof(proof as Groth16Proof);

      // Encode public signals as 32-byte LE field elements
      const publicSignalsBuf = Buffer.concat(
        publicSignals.map((s) => bigintToLeBytes(BigInt(s))),
      );

      // Encode the sanctions root for on-chain storage (32 bytes)
      const sanctionsRootBytes = bigintToLeBytes(params.sanctionsRoot);

      // Build instruction data:
      // discriminator(8) + type(1) + proof(256) + num_signals(4) + signals(N*32)
      //   + nonce(32) + ttl(8) + sanctions_root(32)
      const disc = instructionDiscriminator('verify_compliance');
      const ttl = u64ToLeBytes(DEFAULT_ATTESTATION_TTL);
      const numSignals = Buffer.alloc(4);
      numSignals.writeUInt32LE(publicSignals.length, 0);

      const data = Buffer.concat([
        disc,
        Buffer.from([ATTESTATION_TYPE_INNOCENCE]),
        proofBytes,
        numSignals,
        publicSignalsBuf,
        nonceBytes,
        ttl,
        sanctionsRootBytes,
      ]);

      // Build transaction
      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPLIANCE_VERIFY_CU }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: attestationPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkShielded,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);

      return {
        tx: txResult,
        attestationAddress: attestationPDA,
        attestationNonce,
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        `Compliance innocence proof failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch a ComplianceAttestation account by its on-chain address.
   *
   * @param address - Public key of the attestation PDA.
   * @returns The parsed attestation, or `null` if the account does not exist.
   */
  async getAttestation(address: PublicKey): Promise<ComplianceAttestation | null> {
    const accountInfo = await this.connection.getAccountInfo(address);

    if (!accountInfo || !accountInfo.data) {
      return null;
    }

    return this.parseAttestationAccount(address, accountInfo.data);
  }

  /**
   * Check whether a user currently holds a valid (verified, unexpired,
   * unrevoked) compliance attestation of the specified type.
   *
   * @param user - Public key of the user to check.
   * @param type - Attestation type: `'range'` or `'innocence'`.
   * @returns `true` if the user has at least one valid attestation of that type.
   */
  async isCompliant(user: PublicKey, type: 'range' | 'innocence'): Promise<boolean> {
    const attestations = await this.getAttestationsForUser(user);
    const now = Math.floor(Date.now() / 1000);

    return attestations.some(
      (a) =>
        a.attestationType === type &&
        a.isVerified &&
        !a.revoked &&
        a.expiresAt > now,
    );
  }

  /**
   * Revoke a ComplianceAttestation. Only the original authority (the wallet
   * that submitted the proof) can revoke it.
   *
   * @param attestationAddress - Address of the attestation PDA to revoke.
   * @returns Transaction result.
   * @throws {PrivacyError} TRANSACTION_FAILED if the revocation fails.
   */
  async revokeAttestation(attestationAddress: PublicKey): Promise<TxResult> {
    try {
      const owner = this.getWalletPublicKey();

      const disc = instructionDiscriminator('revoke_compliance');
      const data = disc;

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: attestationAddress, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.zkShielded,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw PrivacyError.txFailed('revokeAttestation', err as Error);
    }
  }

  /**
   * Fetch all ComplianceAttestation accounts for a given user.
   *
   * Uses `getProgramAccounts` with a memcmp filter on the user pubkey
   * field to efficiently find all attestations without scanning every account.
   *
   * @param user - Public key of the user whose attestations to retrieve.
   * @returns Array of parsed attestation records (may be empty).
   */
  async getAttestationsForUser(user: PublicKey): Promise<ComplianceAttestation[]> {
    try {
      // Attestation account layout:
      // [0..8]    discriminator
      // [8..40]   authority (32 bytes)
      // [40..72]  user (32 bytes)
      // Filter on user field at offset 40
      const accounts = await this.connection.getProgramAccounts(
        this.programIds.zkShielded,
        {
          filters: [
            {
              // Anchor account discriminator for ComplianceAttestation
              memcmp: {
                offset: 0,
                bytes: this.attestationDiscriminatorBase58(),
              },
            },
            {
              memcmp: {
                offset: 40,
                bytes: user.toBase58(),
              },
            },
          ],
        },
      );

      const attestations: ComplianceAttestation[] = [];

      for (const { pubkey, account } of accounts) {
        try {
          const parsed = this.parseAttestationAccount(pubkey, account.data);
          attestations.push(parsed);
        } catch {
          // Skip accounts that fail to parse (different account type with same prefix)
        }
      }

      return attestations;
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `Failed to fetch attestations for user ${user.toBase58()}: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  // ─── PDA Derivation ──────────────────────────────────────────────────────

  /**
   * Derive the ComplianceAttestation PDA for a user, attestation type, and nonce.
   *
   * Seeds: ["compliance", user_pubkey, type_byte, nonce_bytes]
   *
   * @param user - User's public key.
   * @param type - Attestation type discriminator (0 = range, 1 = innocence).
   * @param nonce - Unique nonce bytes (16 bytes).
   * @returns The PDA public key and bump seed.
   */
  private deriveAttestationPDA(
    user: PublicKey,
    type: number,
    nonce: Buffer,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(COMPLIANCE_SEED),
        user.toBuffer(),
        Buffer.from([type]),
        nonce,
      ],
      this.programIds.zkShielded,
    );
  }

  // ─── Proof Generation ────────────────────────────────────────────────────

  /**
   * Generate a Groth16 proof using snarkjs.
   *
   * Wraps `groth16.fullProve` with a configurable timeout to prevent
   * indefinite hangs on resource-constrained devices.
   *
   * @param circuitWasm - Path or URL to the circuit WASM file.
   * @param circuitZkey - Path or URL to the circuit zkey file.
   * @param inputs - Circuit input signals (public + private witness).
   * @returns The proof object and array of public signal strings.
   * @throws {PrivacyError} PROOF_GENERATION_FAILED on timeout or circuit error.
   */
  private async generateProof(
    circuitWasm: string,
    circuitZkey: string,
    inputs: Record<string, string | string[]>,
  ): Promise<{ proof: any; publicSignals: string[] }> {
    const timeoutMs = this.circuitPaths?.timeout ?? DEFAULT_PROOF_TIMEOUT_MS;

    const proofPromise = groth16.fullProve(inputs, circuitWasm, circuitZkey);

    const result = await Promise.race([
      proofPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Proof generation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);

    const { proof, publicSignals } = result as {
      proof: any;
      publicSignals: string[];
    };

    return { proof, publicSignals };
  }

  // ─── Account Parsing ─────────────────────────────────────────────────────

  /**
   * Parse a raw ComplianceAttestation account buffer.
   *
   * Account layout (Anchor):
   * ```
   * [0..8]     discriminator
   * [8..40]    authority: Pubkey
   * [40..72]   user: Pubkey
   * [72]       attestation_type: u8  (0 = range, 1 = innocence)
   * [73]       is_verified: bool
   * [74..82]   issued_at: i64
   * [82..90]   expires_at: i64
   * [90]       revoked: bool
   * [91]       has_sanctions_root: bool (Option discriminator)
   * [92..124]  sanctions_root: [u8; 32] (if present)
   * [124..132] threshold: u64
   * [132..164] circuit_vk_hash: [u8; 32]
   * ```
   */
  private parseAttestationAccount(
    address: PublicKey,
    data: Buffer | Uint8Array,
  ): ComplianceAttestation {
    // Skip 8-byte Anchor discriminator
    const authority = new PublicKey(data.subarray(8, 40));
    const user = new PublicKey(data.subarray(40, 72));
    const typeDiscriminator = data[72]!;
    const isVerified = data[73]! === 1;
    const issuedAt = i64FromLeBytes(data, 74);
    const expiresAt = i64FromLeBytes(data, 82);
    const revoked = data[90]! === 1;

    const hasSanctionsRoot = data[91]! === 1;
    let sanctionsRoot: Uint8Array | undefined;
    let nextOffset: number;

    if (hasSanctionsRoot) {
      sanctionsRoot = new Uint8Array(data.subarray(92, 124));
      nextOffset = 124;
    } else {
      nextOffset = 92;
    }

    const threshold = u64FromLeBytes(data, nextOffset);
    const circuitVkHash = new Uint8Array(data.subarray(nextOffset + 8, nextOffset + 40));

    return {
      address,
      authority,
      user,
      attestationType: typeDiscriminator === ATTESTATION_TYPE_RANGE ? 'range' : 'innocence',
      isVerified,
      issuedAt,
      expiresAt,
      revoked,
      sanctionsRoot,
      threshold,
      circuitVkHash,
    };
  }

  /**
   * Compute the base58-encoded 8-byte Anchor account discriminator
   * for "ComplianceAttestation". Used in getProgramAccounts filters.
   */
  private attestationDiscriminatorBase58(): string {
    const hash = sha256(utf8ToBytes('account:ComplianceAttestation'));
    const disc = hash.slice(0, 8);
    // Convert to base58 via a temporary PublicKey isn't reliable for 8 bytes;
    // use bs58 encoding manually. We do it by padding to 32 bytes and using
    // PublicKey, then taking the prefix — but that's fragile. Instead, encode
    // directly. Solana's memcmp accepts base58 encoding of arbitrary bytes.
    return this.bytesToBase58(disc);
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  /** Assert that range circuit paths are configured. */
  private assertRangeCircuitConfigured(): void {
    if (!this.circuitPaths?.rangeWasm || !this.circuitPaths?.rangeZkey) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'Compliance range circuit not configured. Call setCircuitPaths() with rangeWasm and rangeZkey.',
      );
    }
  }

  /** Assert that innocence circuit paths are configured. */
  private assertInnocenceCircuitConfigured(): void {
    if (!this.circuitPaths?.innocenceWasm || !this.circuitPaths?.innocenceZkey) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'Compliance innocence circuit not configured. Call setCircuitPaths() with innocenceWasm and innocenceZkey.',
      );
    }
  }

  /** Validate range proof parameters. */
  private validateRangeParams(params: ComplianceRangeParams): void {
    if (params.minBound < 0n) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'minBound must be non-negative.',
      );
    }
    if (params.maxBound < params.minBound) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'maxBound must be >= minBound.',
      );
    }
    if (params.balance < params.minBound || params.balance > params.maxBound) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'balance must be within [minBound, maxBound] — the circuit will reject an out-of-range witness.',
      );
    }
  }

  /** Validate innocence proof parameters. */
  private validateInnocenceParams(params: ComplianceInnocenceParams): void {
    if (params.lowPathIndices.length !== SANCTIONS_TREE_DEPTH) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        `lowPathIndices must have exactly ${SANCTIONS_TREE_DEPTH} elements (got ${params.lowPathIndices.length}).`,
      );
    }
    if (params.lowPathElements.length !== SANCTIONS_TREE_DEPTH) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        `lowPathElements must have exactly ${SANCTIONS_TREE_DEPTH} elements (got ${params.lowPathElements.length}).`,
      );
    }
    if (params.highPathIndices.length !== SANCTIONS_TREE_DEPTH) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        `highPathIndices must have exactly ${SANCTIONS_TREE_DEPTH} elements (got ${params.highPathIndices.length}).`,
      );
    }
    if (params.highPathElements.length !== SANCTIONS_TREE_DEPTH) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        `highPathElements must have exactly ${SANCTIONS_TREE_DEPTH} elements (got ${params.highPathElements.length}).`,
      );
    }

    // The non-inclusion proof requires: lowLeaf < userAddress < highLeaf
    const userAddress = poseidon2([params.spendingKey, 1n]);
    if (params.lowLeaf >= userAddress) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'lowLeaf must be strictly less than the derived userAddress for non-inclusion.',
      );
    }
    if (params.highLeaf <= userAddress) {
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        'highLeaf must be strictly greater than the derived userAddress for non-inclusion.',
      );
    }
  }

  // ─── Wallet & Transaction Helpers ────────────────────────────────────────

  /**
   * Get the wallet's public key, handling both Keypair and WalletAdapter.
   */
  private getWalletPublicKey(): PublicKey {
    if ('publicKey' in this.wallet && this.wallet.publicKey instanceof PublicKey) {
      return this.wallet.publicKey;
    }
    if ('secretKey' in this.wallet) {
      return (this.wallet as Keypair).publicKey;
    }
    throw PrivacyError.walletNotConnected();
  }

  /**
   * Sign and send a transaction. Handles both Keypair and WalletAdapter
   * signing paths.
   *
   * - Keypair: uses sendAndConfirmTransaction (signs internally)
   * - WalletAdapter: calls signTransaction then sendRawTransaction
   */
  private async sendTx(tx: Transaction, signers?: Keypair[]): Promise<TxResult> {
    try {
      const walletPubkey = this.getWalletPublicKey();
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = walletPubkey;

      if ('secretKey' in this.wallet) {
        // Keypair: use sendAndConfirmTransaction
        const keypair = this.wallet as Keypair;
        const allSigners = [keypair, ...(signers ?? [])];
        const signature = await sendAndConfirmTransaction(
          this.connection,
          tx,
          allSigners,
          { commitment: 'confirmed' },
        );
        return { signature };
      } else {
        // WalletAdapter: signTransaction then sendRawTransaction
        const adapter = this.wallet as WalletAdapter;

        // Add any additional signers first
        if (signers?.length) {
          tx.partialSign(...signers);
        }

        const signed = await adapter.signTransaction(tx);
        const rawTx = signed.serialize();
        const signature = await this.connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });

        // Confirm the transaction
        await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );

        return { signature };
      }
    } catch (err) {
      throw PrivacyError.txFailed('sendTransaction', err as Error);
    }
  }

  // ─── Cryptographic Helpers ───────────────────────────────────────────────

  /**
   * Generate a random field element suitable for BN254 scalar field.
   * Delegates to @protocol-01/privacy-toolkit which uses rejection sampling
   * to avoid modular bias.
   */
  private randomFieldElement(): bigint {
    return toolkitRandomFieldElement();
  }

  /**
   * Convert a PublicKey to a BN254 field element.
   * Takes the first 31 bytes of the pubkey (big-endian) to stay within field range.
   */
  private pubkeyToFieldElement(pubkey: PublicKey): bigint {
    const bytes = pubkey.toBytes();
    let result = 0n;
    for (let i = 0; i < 31; i++) {
      result = (result << 8n) | BigInt(bytes[i]!);
    }
    return result;
  }

  /**
   * Base58 encoding for arbitrary byte arrays.
   * Uses the standard Bitcoin/Solana alphabet.
   */
  private bytesToBase58(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    // Count leading zeros
    let zeros = 0;
    for (const b of bytes) {
      if (b !== 0) break;
      zeros++;
    }

    // Convert to base58
    const size = Math.ceil(bytes.length * 138 / 100) + 1;
    const b58 = new Uint8Array(size);
    let length = 0;

    for (const byte of bytes) {
      let carry = byte;
      let i = 0;
      for (let j = size - 1; (carry !== 0 || i < length) && j >= 0; j--, i++) {
        carry += 256 * b58[j]!;
        b58[j] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      length = i;
    }

    // Skip leading zeros in the base58 result
    let it = size - length;
    while (it < size && b58[it] === 0) it++;

    let result = ALPHABET[0]!.repeat(zeros);
    for (; it < size; it++) {
      result += ALPHABET[b58[it]!];
    }

    return result;
  }
}
