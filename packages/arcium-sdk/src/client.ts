import { Connection, PublicKey, Keypair, TransactionInstruction } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  RescueCipher,
  x25519,
  deserializeLE,
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
/**
 * Cross-platform CSPRNG -- works in browsers, React Native, and Node.js.
 * Replaces Node-only `crypto.randomBytes`.
 */
function getRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error('CSPRNG not available — globalThis.crypto.getRandomValues is required');
  }
  return bytes;
}

/** Protocol 01 Arcium program ID (deployed on devnet, 2026-04-13 with mugen circuits). */
export const P01_ARCIUM_PROGRAM_ID = new PublicKey(
  '9kMjmVMYxBa8V9D1aoEjZtUNXTe2gjfzYdKLycn7JvgQ'
);

/** Arcium devnet cluster offset used for PDA derivation and account addressing. */
export const ARCIUM_CLUSTER_OFFSET = 456;

/**
 * MPC circuit names -- must match the encrypted-ixs function names
 * defined in the `p01_arcium` on-chain program.
 *
 * Each name maps to an Arcis circuit compiled and deployed to the
 * Arcium MPC network. The circuit name is used to derive the
 * `CompDefAccount` PDA that the Arcium runtime reads.
 */
export const CIRCUITS = {
  /** Confidential balance audit -- aggregate sum without individual exposure. */
  BALANCE_AUDIT: 'balance_audit',
  /** Multi-option private voting -- encrypted ballot accumulation. */
  PRIVATE_VOTE: 'private_vote',
  /** Optimized binary (yes/no) voting -- fewer MPC comparisons. */
  PRIVATE_VOTE_BINARY: 'private_vote_binary',
  /** Hidden nullifier commitment -- SHA3 hash without revealing the nullifier. */
  NULLIFIER_COMMIT: 'nullifier_commit',
  /** Anonymous registry lookup -- query meta-address without revealing the target. */
  PRIVATE_LOOKUP: 'private_lookup',
  /** Threshold stealth scanning -- protected viewing key scan for payments. */
  STEALTH_SCAN: 'stealth_scan',
  /** Confidential relay -- threshold TX decryption and submission. */
  THRESHOLD_DECRYPT: 'threshold_decrypt',
  /** Phase D Alt 1 -- recipient-only threshold decrypt for confidential relay. */
  DECRYPT_RECIPIENT: 'decrypt_recipient',
  /** Sealed-bid auction -- encrypted bid comparison (submit phase). */
  SEALED_BID_AUCTION: 'sealed_bid_auction',
  /** Sealed-bid auction -- finalization and winner reveal. */
  FINALIZE_AUCTION: 'finalize_auction',
  /** Mugen P2P -- encrypted sell offer submission. */
  MUGEN_SUBMIT_OFFER: 'mugen_submit_offer',
  /** Mugen P2P -- blind take (buyer match attempt). */
  MUGEN_BLIND_TAKE: 'mugen_blind_take',
  /** Mugen P2P -- cancel an encrypted offer. */
  MUGEN_CANCEL_OFFER: 'mugen_cancel_offer',
} as const;

/** Union type of all MPC circuit names. */
export type CircuitName = (typeof CIRCUITS)[keyof typeof CIRCUITS];

/**
 * Configuration for creating an {@link ArciumClient}.
 */
export interface ArciumClientConfig {
  /** Active Solana connection (devnet or mainnet). */
  connection: Connection;
  /** Anchor-compatible wallet for signing transactions. */
  wallet: anchor.Wallet;
  /** Protocol 01 Arcium program ID (defaults to {@link P01_ARCIUM_PROGRAM_ID}). */
  programId?: PublicKey;
  /** Arcium cluster offset for PDA derivation (defaults to {@link ARCIUM_CLUSTER_OFFSET}). */
  clusterOffset?: number;
}

/**
 * Encrypted payload produced by {@link ArciumClient.encrypt}.
 *
 * Contains the Rescue CTR-mode ciphertext blocks, the ephemeral public key
 * needed for the MPC nodes to derive the shared secret, and the nonce.
 */
export interface EncryptedPayload {
  /** Ciphertext blocks -- each inner array is one Rescue CTR-mode block. */
  ciphertexts: number[][];
  /** Ephemeral x25519 public key for this encryption session. */
  publicKey: Uint8Array;
  /** Random 16-byte nonce used for this encryption. */
  nonce: Uint8Array;
}

/**
 * Result of waiting for an MPC computation to finalize.
 */
export interface ComputationResult {
  /** Transaction signature of the Arcium callback that delivered the result. */
  finalizationSignature: string;
  /** Computation offset that identifies this specific MPC job. */
  computationOffset: anchor.BN;
}

/**
 * ArciumClient -- manages encryption, submission, and finalization
 * of MPC computations across Arcium's decentralized node cluster.
 *
 * Each computation follows the lifecycle:
 * 1. Client encrypts inputs via x25519 shared secret + RescueCipher
 * 2. Client submits encrypted data to the P01 Arcium on-chain program
 * 3. Program CPIs into Arcium to queue the MPC computation
 * 4. ARX nodes execute the Arcis circuit on secret shares
 * 5. Arcium invokes the callback with the signed result
 * 6. Client decrypts result using the same shared secret
 *
 * @example
 * ```ts
 * const client = new ArciumClient({ connection, wallet });
 * await client.initialize();
 * const payload = client.encrypt([100n, 200n]);
 * // ... submit payload to on-chain program ...
 * const sig = await client.awaitFinalization(computationOffset);
 * ```
 */
export class ArciumClient {
  /** The Solana connection this client uses. */
  readonly connection: Connection;
  /** The Anchor wallet used for signing. */
  readonly wallet: anchor.Wallet;
  /** The Protocol 01 Arcium program ID. */
  readonly programId: PublicKey;
  /** The Arcium cluster offset for PDA derivation. */
  readonly clusterOffset: number;
  private provider: anchor.AnchorProvider;
  private ephemeralPrivateKey: Uint8Array;
  private ephemeralPublicKey: Uint8Array;
  private sharedSecret: Uint8Array | null = null;
  private cipher: RescueCipher | null = null;
  private operationCount: number = 0;

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

  /**
   * Initialize the shared secret with the MXE's x25519 public key.
   *
   * Must be called once before any `encrypt()` / `decrypt()` operations.
   * Bypasses the Anchor borsh coder (which chokes on `SetUnset<T>` generics
   * in RN/Hermes) by manually parsing the raw MXE account data.
   *
   * @throws {Error} "Failed to connect to Arcium network. Ensure @arcium-hq/client
   *   is installed and the cluster is reachable." -- when the MXE account cannot be read.
   * @throws {Error} "Cipher initialization failed. Check that the Arcium program ID
   *   is correct for your cluster." -- when the MXE public key is missing or zeroed.
   */
  async initialize(): Promise<void> {
    let mxePublicKey: Uint8Array | null;
    try {
      mxePublicKey = await this.fetchMxeX25519Key();
    } catch (err) {
      throw new Error(
        'Failed to connect to Arcium network. Ensure @arcium-hq/client is installed and the cluster is reachable.' +
        (err instanceof Error ? ` (${err.message})` : '')
      );
    }
    if (!mxePublicKey) {
      throw new Error(
        'Cipher initialization failed. Check that the Arcium program ID is correct for your cluster.'
      );
    }
    this.sharedSecret = x25519.getSharedSecret(this.ephemeralPrivateKey, mxePublicKey);
    this.cipher = new RescueCipher(this.sharedSecret);
  }

  /**
   * Fetch x25519 public key from MXE account by parsing raw bytes.
   * Layout: 8 disc + Option<u32> cluster + u64 keygen + u64 recovery +
   *         32 programId + Option<Pubkey> authority + SetUnset<UtilityPubkeys> + ...
   * UtilityPubkeys starts with x25519_pubkey (32 bytes).
   */
  private async fetchMxeX25519Key(): Promise<Uint8Array | null> {
    const mxeAccAddress = getMXEAccAddress(this.programId);
    const accInfo = await this.connection.getAccountInfo(mxeAccAddress);
    if (!accInfo || !accInfo.data) return null;

    const data = accInfo.data;
    let offset = 8; // skip discriminator

    // cluster: Option<u32>
    const clusterTag = data[offset]; offset++;
    if (clusterTag === 1) offset += 4; // skip u32 value

    // keygen_offset: u64
    offset += 8;
    // key_recovery_init_offset: u64
    offset += 8;
    // mxe_program_id: Pubkey (32 bytes)
    offset += 32;

    // authority: Option<Pubkey>
    const authTag = data[offset]; offset++;
    if (authTag === 1) offset += 32; // skip Pubkey

    // utility_pubkeys: SetUnset<UtilityPubkeys>
    const setUnsetTag = data[offset]; offset++;
    // 0 = Set(T), 1 = Unset(T, Vec<bool>)
    // Either way, T = UtilityPubkeys starts immediately, with x25519_pubkey first (32 bytes)
    if (offset + 32 > data.length) return null;

    const x25519Key = new Uint8Array(data.slice(offset, offset + 32));
    // Verify it's not all zeros
    if (x25519Key.every((b) => b === 0)) return null;

    return x25519Key;
  }

  /**
   * Rotate ephemeral keys after every 10 encrypt operations.
   * Limits the exposure window if an ephemeral key is compromised.
   */
  private async maybeRotateKeys(): Promise<void> {
    this.operationCount++;
    if (this.operationCount % 10 === 0) {
      await this.rotateKeys();
    }
  }

  /**
   * Encrypt values for MPC computation using Rescue CTR-mode.
   *
   * Each `bigint` in the input array becomes one encrypted field element.
   * Values must fit within the Rescue prime field (~254 bits). For larger
   * data (e.g. 32-byte keys), split into 4 x u64 chunks first.
   *
   * @param values - Array of field elements to encrypt.
   * @returns Encrypted payload containing ciphertext blocks, ephemeral public key, and nonce.
   * @throws {Error} "Client not initialized" -- call {@link initialize} first.
   */
  encrypt(values: bigint[]): EncryptedPayload {
    if (!this.cipher) throw new Error('Client not initialized — call initialize() first');
    // Fire-and-forget key rotation check — rotateKeys() is async but we don't
    // block encryption on the network round-trip.  The new keys take effect on
    // the *next* encrypt() call after the rotation completes.
    void this.maybeRotateKeys();
    const nonce = getRandomBytes(16);
    const ciphertexts: number[][] = this.cipher.encrypt(values, nonce);
    return {
      ciphertexts,
      publicKey: this.ephemeralPublicKey,
      nonce,
    };
  }

  /**
   * Decrypt an MPC computation result using the same shared secret.
   *
   * @param ciphertexts - Rescue CTR-mode ciphertext blocks from the Arcium callback.
   * @param nonce - The 16-byte nonce that was used during encryption.
   * @returns Decrypted field elements as `bigint[]`.
   * @throws {Error} "Client not initialized" -- call {@link initialize} first.
   */
  decrypt(ciphertexts: number[][], nonce: Uint8Array): bigint[] {
    if (!this.cipher) throw new Error('Client not initialized — call initialize() first');
    return this.cipher.decrypt(ciphertexts, nonce);
  }

  /**
   * Generate a random 8-byte computation offset (unique per MPC invocation).
   *
   * This offset is used as a nonce to derive the computation account PDA
   * and uniquely identify each MPC job on the Arcium network.
   */
  newComputationOffset(): anchor.BN {
    return new anchor.BN(Buffer.from(getRandomBytes(8)).toString('hex'), 'hex');
  }

  /**
   * Convert a 16-byte nonce to an Anchor BN representing a u128.
   *
   * @param nonce - Raw 16-byte nonce (from {@link EncryptedPayload.nonce}).
   * @returns The nonce as an Anchor BN for on-chain instruction arguments.
   */
  nonceToU128(nonce: Uint8Array): anchor.BN {
    return new anchor.BN(deserializeLE(nonce).toString());
  }

  /**
   * Derive all required Arcium account addresses for an MPC computation.
   *
   * Uses a hardcoded cluster offset instead of `getArciumEnv()` which
   * crashes in React Native (checks `isBrowser()` and throws).
   *
   * @param circuitName - The MPC circuit to invoke (from {@link CIRCUITS}).
   * @param computationOffset - Unique offset from {@link newComputationOffset}.
   * @returns Object with all PDA addresses needed for the computation instruction.
   */
  getComputationAccounts(circuitName: CircuitName, computationOffset: anchor.BN) {
    // Hardcoded cluster offset — matches our deployed MXE account (3EzPEVpU...)
    // This avoids calling getArciumEnv() which requires Node.js env vars
    const clusterOffset = ARCIUM_CLUSTER_OFFSET;
    return {
      computationAccount: getComputationAccAddress(
        clusterOffset,
        computationOffset
      ),
      clusterAccount: getClusterAccAddress(clusterOffset),
      mxeAccount: getMXEAccAddress(this.programId),
      mempoolAccount: getMempoolAccAddress(clusterOffset),
      executingPool: getExecutingPoolAccAddress(clusterOffset),
      compDefAccount: getCompDefAccAddress(
        this.programId,
        Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE()
      ),
    };
  }

  /**
   * Wait for an MPC computation to finalize.
   *
   * Blocks until the Arcium ARX nodes complete the computation and invoke
   * the on-chain callback. Returns the finalization transaction signature.
   *
   * @param computationOffset - The offset from {@link newComputationOffset}.
   * @returns The transaction signature of the Arcium callback.
   */
  async awaitFinalization(computationOffset: anchor.BN): Promise<string> {
    return awaitComputationFinalization(
      this.provider,
      computationOffset,
      this.programId,
      'confirmed'
    );
  }

  /**
   * Rotate the ephemeral x25519 keypair and re-initialize the cipher.
   *
   * Called automatically every 10 encrypt operations, or manually for
   * long-lived sessions. After rotation, all future encryptions use
   * the new key; previously encrypted payloads remain valid.
   */
  async rotateKeys(): Promise<void> {
    this.ephemeralPrivateKey = x25519.utils.randomSecretKey();
    this.ephemeralPublicKey = x25519.getPublicKey(this.ephemeralPrivateKey);
    this.sharedSecret = null;
    this.cipher = null;
    await this.initialize();
  }

  /**
   * Derive a deterministic proxy PDA from the current ephemeral session key.
   *
   * This PDA is unlinkable to the user's real wallet because it is seeded
   * from the x25519 ephemeral key (which rotates every 10 operations and
   * on every new session).  It can be used as a pseudonymous identifier in
   * non-signing account fields (e.g. computation metadata, audit tags) so
   * that the on-chain footprint does not reveal the user's wallet pubkey.
   *
   * NOTE: The PDA itself cannot *pay* for transactions — Solana requires
   * the fee payer to be a real signer.  Full payer obfuscation requires a
   * relayer service that submits transactions on behalf of users.
   *
   * @returns [proxyPDA, bump]
   *
   * TODO: Implement a relayer-based submission path where the relayer is
   * the fee payer and this proxy PDA is the only identity visible on-chain.
   */
  deriveProxyPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('arcium_proxy'), Buffer.from(this.ephemeralPublicKey)],
      this.programId
    );
  }

  /**
   * Return a 32-byte SHA-256 identifier derived from the ephemeral session
   * key.  Unlike `deriveProxyPDA()` this is a raw hash, not a Solana PDA,
   * and can be used in off-chain indexing, log correlation, or as a
   * pseudonymous tag inside encrypted payloads without leaking the wallet
   * pubkey.
   *
   * The identifier changes whenever ephemeral keys rotate (every 10
   * operations or on `rotateKeys()`).
   */
  getProxyIdentifier(): Uint8Array {
    return sha256(
      Buffer.concat([
        Buffer.from('p01_proxy_id'),
        Buffer.from(this.ephemeralPublicKey),
      ])
    );
  }

  /**
   * Get the current ephemeral x25519 public key.
   *
   * This key is included in every encrypted payload so the MPC nodes can
   * derive the shared secret. It rotates every 10 operations.
   */
  getEphemeralPublicKey(): Uint8Array {
    return this.ephemeralPublicKey;
  }

  /**
   * Get the underlying Anchor provider for direct program access.
   *
   * Useful when you need to interact with the Arcium program outside
   * the high-level module functions.
   */
  getProvider(): anchor.AnchorProvider {
    return this.provider;
  }

  /**
   * Get the Arcium framework program ID (not the P01 program).
   *
   * Used for deriving Arcium-internal account addresses.
   */
  getArciumProgramId(): PublicKey {
    return getArciumProgramId();
  }
}
