import { Connection, PublicKey, Keypair, TransactionInstruction } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import {
  RescueCipher,
  x25519,
  getMXEPublicKey,
  deserializeLE,
  getArciumEnv,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  awaitComputationFinalization,
  getArciumProgramId,
} from '@arcium-hq/client';
import { randomBytes } from 'crypto';

/** Protocol 01 Arcium program ID (deployed on devnet) */
export const P01_ARCIUM_PROGRAM_ID = new PublicKey(
  'FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT'
);

/** Arcium devnet cluster offset */
export const ARCIUM_CLUSTER_OFFSET = 456;

/** Circuit names (must match encrypted-ixs function names) */
export const CIRCUITS = {
  BALANCE_AUDIT: 'balance_audit',
  PRIVATE_VOTE: 'private_vote',
  NULLIFIER_COMMIT: 'nullifier_commit',
  PRIVATE_LOOKUP: 'private_lookup',
  STEALTH_SCAN: 'stealth_scan',
  THRESHOLD_DECRYPT: 'threshold_decrypt',
} as const;

export type CircuitName = (typeof CIRCUITS)[keyof typeof CIRCUITS];

export interface ArciumClientConfig {
  connection: Connection;
  wallet: anchor.Wallet;
  programId?: PublicKey;
  clusterOffset?: number;
}

/** Encrypted payload — ciphertexts are number[][] (Rescue CTR-mode blocks) */
export interface EncryptedPayload {
  ciphertexts: number[][];
  publicKey: Uint8Array;
  nonce: Uint8Array;
}

export interface ComputationResult {
  finalizationSignature: string;
  computationOffset: anchor.BN;
}

/**
 * ArciumClient — manages encryption, submission, and finalization
 * of MPC computations across Arcium's decentralized node cluster.
 *
 * Each computation follows the lifecycle:
 * 1. Client encrypts inputs via x25519 shared secret + RescueCipher
 * 2. Client submits encrypted data to P01 Arcium program
 * 3. Program CPIs into Arcium to queue the MPC computation
 * 4. ARX nodes execute the Arcis circuit on secret shares
 * 5. Arcium invokes callback with signed result
 * 6. Client decrypts result using same shared secret
 */
export class ArciumClient {
  readonly connection: Connection;
  readonly wallet: anchor.Wallet;
  readonly programId: PublicKey;
  readonly clusterOffset: number;
  private provider: anchor.AnchorProvider;
  private ephemeralPrivateKey: Uint8Array;
  private ephemeralPublicKey: Uint8Array;
  private sharedSecret: Uint8Array | null = null;
  private cipher: RescueCipher | null = null;

  constructor(config: ArciumClientConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.programId = config.programId ?? P01_ARCIUM_PROGRAM_ID;
    this.clusterOffset = config.clusterOffset ?? ARCIUM_CLUSTER_OFFSET;
    this.provider = new anchor.AnchorProvider(this.connection, this.wallet, {
      commitment: 'confirmed',
    });

    // Generate ephemeral x25519 keypair for this session
    this.ephemeralPrivateKey = x25519.utils.randomSecretKey();
    this.ephemeralPublicKey = x25519.getPublicKey(this.ephemeralPrivateKey);
  }

  /** Initialize shared secret with MXE's x25519 public key */
  async initialize(): Promise<void> {
    const mxePublicKey = await getMXEPublicKey(this.provider, this.programId);
    if (!mxePublicKey) {
      throw new Error('MXE public key not found — is the program deployed and MXE initialized?');
    }
    this.sharedSecret = x25519.getSharedSecret(this.ephemeralPrivateKey, mxePublicKey);
    this.cipher = new RescueCipher(this.sharedSecret);
  }

  /** Encrypt values for MPC computation. Returns number[][] (Rescue CTR blocks). */
  encrypt(values: bigint[]): EncryptedPayload {
    if (!this.cipher) throw new Error('Client not initialized — call initialize() first');
    const nonce = randomBytes(16);
    const ciphertexts: number[][] = this.cipher.encrypt(values, nonce);
    return {
      ciphertexts,
      publicKey: this.ephemeralPublicKey,
      nonce,
    };
  }

  /** Decrypt MPC computation result */
  decrypt(ciphertexts: number[][], nonce: Uint8Array): bigint[] {
    if (!this.cipher) throw new Error('Client not initialized — call initialize() first');
    return this.cipher.decrypt(ciphertexts, nonce);
  }

  /** Generate a random computation offset (unique per invocation) */
  newComputationOffset(): anchor.BN {
    return new anchor.BN(randomBytes(8), 'hex');
  }

  /** Derive nonce as u128 BN from raw bytes */
  nonceToU128(nonce: Uint8Array): anchor.BN {
    return new anchor.BN(deserializeLE(nonce).toString());
  }

  /** Get all required Arcium account addresses for a computation */
  getComputationAccounts(circuitName: CircuitName, computationOffset: anchor.BN) {
    const arciumEnv = getArciumEnv();
    return {
      computationAccount: getComputationAccAddress(
        arciumEnv.arciumClusterOffset,
        computationOffset
      ),
      clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
      mxeAccount: getMXEAccAddress(this.programId),
      mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(
        this.programId,
        Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE()
      ),
    };
  }

  /** Wait for MPC computation to finalize (ARX nodes return result) */
  async awaitFinalization(computationOffset: anchor.BN): Promise<string> {
    return awaitComputationFinalization(
      this.provider,
      computationOffset,
      this.programId,
      'confirmed'
    );
  }

  /** Rotate ephemeral keys (for long-lived sessions) */
  async rotateKeys(): Promise<void> {
    this.ephemeralPrivateKey = x25519.utils.randomSecretKey();
    this.ephemeralPublicKey = x25519.getPublicKey(this.ephemeralPrivateKey);
    this.sharedSecret = null;
    this.cipher = null;
    await this.initialize();
  }

  /** Get provider for direct Anchor program access */
  getProvider(): anchor.AnchorProvider {
    return this.provider;
  }

  /** Get Arcium program ID (for account derivation) */
  getArciumProgramId(): PublicKey {
    return getArciumProgramId();
  }
}
