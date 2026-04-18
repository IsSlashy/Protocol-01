import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type {
  Network,
  ProgramIds,
  Signer,
  TokenInfo,
  TxResult,
  VaultType,
  CreateVaultParams,
  VaultDepositParams,
  VaultWithdrawParams,
  VaultInfo,
  VaultReceipt,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS } from '../constants';

// ── Constants ──────────────────────────────────────────────────────────────────

/** WOTS+ Winternitz parameter w=16, SHA-256 chains of depth 16 */
const WOTS_W = 16;
/** Number of hash chains in a WOTS+ signature (32 bytes / 4 bits per nibble) */
const WOTS_CHAINS = 64;
/** Checksum chains for WOTS+ (ceil(log2(CHAINS * (W-1)) / log2(W)) + 1) */
const WOTS_CHECKSUM_CHAINS = 3;
/** Total chain count = message chains + checksum chains */
const WOTS_TOTAL_CHAINS = WOTS_CHAINS + WOTS_CHECKSUM_CHAINS;
/** Each chain element is a 32-byte SHA-256 hash */
const HASH_SIZE = 32;

/** Vault account discriminators */
const WOTS_VAULT_DISCRIMINATOR = 0;
const HTL_VAULT_DISCRIMINATOR = 1;

// ── Utility Functions ──────────────────────────────────────────────────────────

/**
 * Anchor-style 8-byte instruction discriminator: sha256(utf8ToBytes("global:<name>"))[0..8]
 */
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`)).slice(0, 8));
}

/**
 * Encode a u64 as an 8-byte little-endian buffer.
 */
function u64ToLeBytes(value: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Read a little-endian u64 from a buffer slice.
 */
function u64FromLeBytes(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[offset + i]!);
  }
  return result;
}

/**
 * Read a little-endian u32 from a buffer slice.
 */
function u32FromLeBytes(buf: Uint8Array, offset: number): number {
  return (
    buf[offset]! |
    (buf[offset + 1]! << 8) |
    (buf[offset + 2]! << 16) |
    (buf[offset + 3]! << 24)
  );
}

/**
 * Read a little-endian i64 as a JS number.
 */
function i64FromLeBytes(buf: Uint8Array, offset: number): number {
  return Number(u64FromLeBytes(buf, offset));
}

/**
 * Iteratively hash a value n times with SHA-256.
 */
function hashChain(input: Uint8Array, iterations: number): Uint8Array {
  let current = input;
  for (let i = 0; i < iterations; i++) {
    current = sha256(current);
  }
  return current;
}

/**
 * VaultModule wraps the p01_quantum_vault program to provide
 * quantum-resistant custody of funds using two defense strategies:
 *
 * 1. **WOTS+ (Winternitz One-Time Signatures)**: Hash-chain-based signatures
 *    that are quantum-safe. Each withdrawal rotates the signing key.
 *
 * 2. **Hash-Timelock (HTL)**: SHA-256 preimage locks with optional timelocks.
 *    Used for cold storage where the secret preimage is the security boundary.
 *
 * In both cases, Ed25519 is used only for Solana transaction signing, NOT as
 * the security boundary -- the actual authorization comes from hash preimages.
 */
export class VaultModule {
  private readonly connection: Connection;
  private readonly wallet: Signer;
  private readonly network: Network;
  private readonly programIds: ProgramIds;
  private readonly resolveToken: (symbol: string) => TokenInfo;

  constructor(
    connection: Connection,
    wallet: Signer,
    network: Network,
    programIds: ProgramIds,
    resolveToken: (symbol: string) => TokenInfo,
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = network;
    this.programIds = programIds;
    this.resolveToken = resolveToken;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Create a new quantum-safe vault.
   *
   * For WOTS+ vaults: generates a deterministic WOTS+ keypair from the seed,
   * hashes the public key, and initializes the on-chain vault with the key hash.
   *
   * For HTL vaults: generates a random secret, computes the SHA-256 commitment,
   * and initializes the vault with the commitment and optional timelock.
   *
   * @param params - Vault type and configuration.
   * @returns Transaction result, vault address, and secret material.
   */
  async create(params: CreateVaultParams): Promise<VaultReceipt> {
    try {
      const owner = this.walletPublicKey();
      const tx = new Transaction();

      if (params.type === 'wots') {
        // Generate a deterministic WOTS+ keypair from a random seed
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const { publicKeyHash } = this.generateWotsKeypair(seed);

        const [vaultPDA] = this.deriveWotsVaultPDA(owner);

        const disc = instructionDiscriminator('init_winternitz_vault');
        const data = Buffer.concat([disc, Buffer.from(publicKeyHash)]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: true },
              { pubkey: vaultPDA, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId: this.programIds.quantumVault,
            data,
          }),
        );

        const txResult = await this.sendTx(tx);
        return { tx: txResult, vaultAddress: vaultPDA, secret: new Uint8Array(seed) };
      } else {
        // HTL vault: random 32-byte secret, SHA-256 commitment
        const secret = crypto.getRandomValues(new Uint8Array(32));
        const commitment = sha256(secret);

        const [vaultPDA] = this.deriveHtlVaultPDA(owner, commitment);
        const destination = params.destination ?? owner;
        const timelock = params.timelock ?? 0;

        const disc = instructionDiscriminator('init_hash_vault');
        const data = Buffer.concat([
          disc,
          Buffer.from(commitment),
          u64ToLeBytes(timelock),
          destination.toBuffer(),
        ]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: true },
              { pubkey: vaultPDA, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId: this.programIds.quantumVault,
            data,
          }),
        );

        const txResult = await this.sendTx(tx);
        return { tx: txResult, vaultAddress: vaultPDA };
      }
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.VAULT_CREATE_FAILED,
        `Vault creation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Deposit SOL into a quantum-safe vault.
   *
   * Works for both WOTS+ and HTL vault types. The deposited lamports
   * are held by the vault PDA until a valid withdrawal is executed.
   *
   * @param params - Vault address and deposit amount.
   * @returns Transaction result.
   */
  async deposit(params: VaultDepositParams): Promise<TxResult> {
    try {
      const owner = this.walletPublicKey();
      const amount = BigInt(params.amount);

      const vaultInfo = await this.getVault(params.vault);

      const discName =
        vaultInfo.type === 'wots' ? 'deposit_winternitz' : 'deposit_hash_vault';
      const disc = instructionDiscriminator(discName);
      const data = Buffer.concat([disc, u64ToLeBytes(amount)]);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: params.vault, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.quantumVault,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.VAULT_DEPOSIT_FAILED,
        `Vault deposit failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Withdraw SOL from a quantum-safe vault.
   *
   * For WOTS+ vaults: the caller must provide a WOTS+ signature over the
   * withdrawal message and the next public key hash for key rotation.
   * The private chains and seed must be managed off-chain.
   *
   * For HTL vaults: the caller must reveal the SHA-256 preimage. The
   * timelock (if set) must have expired.
   *
   * @param params - Vault address and withdrawal amount.
   * @returns Transaction result.
   */
  async withdraw(params: VaultWithdrawParams): Promise<TxResult> {
    try {
      const owner = this.walletPublicKey();
      const amount = BigInt(params.amount);

      const vaultInfo = await this.getVault(params.vault);

      if (vaultInfo.type === 'htl' && vaultInfo.unlockAfter) {
        const now = Math.floor(Date.now() / 1000);
        if (now < vaultInfo.unlockAfter) {
          throw new PrivacyError(
            PrivacyErrorCode.VAULT_LOCKED,
            `HTL vault is timelocked until ${new Date(vaultInfo.unlockAfter * 1000).toISOString()}.`,
          );
        }
      }

      const tx = new Transaction();

      if (vaultInfo.type === 'wots') {
        // WOTS+ withdrawal requires: current seed, next seed, destination,
        // and the current on-chain withdrawal_count (which is bound into the
        // signed message to prevent replay across withdrawals).
        if (!params.seed || params.seed.length !== 32) {
          throw new PrivacyError(
            PrivacyErrorCode.VAULT_WITHDRAW_FAILED,
            'WOTS+ withdrawal requires a 32-byte `seed` for the current key.',
          );
        }
        if (!params.nextSeed || params.nextSeed.length !== 32) {
          throw new PrivacyError(
            PrivacyErrorCode.VAULT_WITHDRAW_FAILED,
            'WOTS+ withdrawal requires a 32-byte `nextSeed` for key rotation.',
          );
        }
        const destination = params.destination ?? owner;
        const withdrawalCount =
          params.withdrawalCount !== undefined
            ? BigInt(params.withdrawalCount)
            : BigInt(vaultInfo.keyIndex ?? 0);

        // Rebuild the current WOTS+ keypair from the seed
        const { privateChains, publicElements } = this.deriveWotsChains(params.seed);
        const wotsPubkey = Buffer.concat(publicElements); // 67 * 32 = 2144 bytes

        // Derive the next key's pubkey hash for on-chain rotation
        const { publicKeyHash: nextPubkeyHash } = this.generateWotsKeypair(params.nextSeed);

        // Message MUST match the Rust program exactly:
        //   SHA-256(amount_le || destination_pubkey || withdrawal_count_le)
        const message = sha256(
          Buffer.concat([
            u64ToLeBytes(amount),
            destination.toBuffer(),
            u64ToLeBytes(withdrawalCount),
          ]),
        );

        // Build the 67-chain signature (Rust re-hashes `message` itself, but here
        // the message IS already the final hash the program will compute — so we
        // pass it straight into wotsSign which will NOT re-hash it).
        const signature = this.wotsSignFromHash(message, privateChains);

        // Anchor-serialize: disc || amount_u64 || vec<u8>(sig) || vec<u8>(pk) || [u8;32]
        const sigLen = Buffer.alloc(4);
        sigLen.writeUInt32LE(signature.length, 0);
        const pkLen = Buffer.alloc(4);
        pkLen.writeUInt32LE(wotsPubkey.length, 0);

        const disc = instructionDiscriminator('withdraw_winternitz');
        const data = Buffer.concat([
          disc,
          u64ToLeBytes(amount),
          sigLen,
          signature,
          pkLen,
          wotsPubkey,
          Buffer.from(nextPubkeyHash),
        ]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: true },
              { pubkey: params.vault, isSigner: false, isWritable: true },
              { pubkey: destination, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId: this.programIds.quantumVault,
            data,
          }),
        );
      } else {
        // HTL withdrawal: reveal preimage
        if (!params.preimage || params.preimage.length !== 32) {
          throw new PrivacyError(
            PrivacyErrorCode.VAULT_WITHDRAW_FAILED,
            'HTL vault withdrawal requires a 32-byte preimage.',
          );
        }
        const disc = instructionDiscriminator('withdraw_hash_vault');
        const data = Buffer.concat([
          disc,
          u64ToLeBytes(amount),
          Buffer.from(params.preimage),
        ]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: true },
              { pubkey: params.vault, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId: this.programIds.quantumVault,
            data,
          }),
        );
      }

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.VAULT_WITHDRAW_FAILED,
        `Vault withdrawal failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch a vault's on-chain state and determine its type.
   *
   * @param address - Public key of the vault account.
   * @returns Parsed vault information including type, balance, and key state.
   */
  async getVault(address: PublicKey): Promise<VaultInfo> {
    const accountInfo = await this.connection.getAccountInfo(address);

    if (!accountInfo || !accountInfo.data) {
      throw new PrivacyError(
        PrivacyErrorCode.VAULT_CREATE_FAILED,
        `Vault account ${address.toBase58()} not found.`,
      );
    }

    return this.parseVaultAccount(address, accountInfo.data);
  }

  // ── WOTS+ Crypto Helpers ────────────────────────────────────────────────────

  /**
   * Generate a WOTS+ keypair from a seed.
   *
   * Each of the 67 chains (64 message + 3 checksum) is derived by hashing
   * `sha256(seed || chain_index)` and then iterating the hash chain W-1 = 15
   * times to produce the public key element. The public key hash is the
   * SHA-256 of all concatenated public key elements.
   *
   * @param seed - 32-byte random seed.
   * @returns The public key hash and the private chain roots.
   */
  private generateWotsKeypair(seed: Uint8Array): {
    publicKeyHash: Uint8Array;
    privateChains: Uint8Array[];
    publicElements: Uint8Array[];
  } {
    const { privateChains, publicElements } = this.deriveWotsChains(seed);
    const publicKeyHash = sha256(Buffer.concat(publicElements));
    return { publicKeyHash, privateChains, publicElements };
  }

  /**
   * Deterministically derive the 67 private chain roots + 67 public endpoints
   * from a 32-byte seed. Must mirror the structure used by on-chain verification:
   *   chainRoot_i = SHA-256(seed || u32_le(i))
   *   pubEnd_i    = hash^15(chainRoot_i)
   *   pubkeyHash  = SHA-256(pubEnd_0 || ... || pubEnd_66)
   */
  private deriveWotsChains(seed: Uint8Array): {
    privateChains: Uint8Array[];
    publicElements: Uint8Array[];
  } {
    const privateChains: Uint8Array[] = [];
    const publicElements: Uint8Array[] = [];
    for (let i = 0; i < WOTS_TOTAL_CHAINS; i++) {
      const indexBuf = new Uint8Array(4);
      new DataView(indexBuf.buffer).setUint32(0, i, true);
      const chainRoot = sha256(Buffer.concat([seed, indexBuf]));
      privateChains.push(chainRoot);
      publicElements.push(hashChain(chainRoot, WOTS_W - 1));
    }
    return { privateChains, publicElements };
  }

  /**
   * Sign a PRE-HASHED 32-byte message digest with WOTS+ (67 chains).
   *
   * Extracts 64 message nibbles from the full digest (high-then-low per byte),
   * computes checksum = sum(15 - m_i), encodes checksum MSB-first as 3 nibbles,
   * then for each of 67 chains outputs `hash^(15 - nibble_i)(privateChain_i)`.
   */
  private wotsSignFromHash(
    msgHash: Uint8Array,
    privateChains: Uint8Array[],
  ): Buffer {
    if (msgHash.length !== 32) {
      throw new Error('wotsSignFromHash: expected a 32-byte digest');
    }

    const nibbles: number[] = new Array(WOTS_TOTAL_CHAINS);
    for (let i = 0; i < WOTS_CHAINS; i++) {
      const byteIdx = i >> 1;
      nibbles[i] = i % 2 === 0
        ? (msgHash[byteIdx]! >> 4) & 0x0f
        : msgHash[byteIdx]! & 0x0f;
    }

    let checksum = 0;
    for (let i = 0; i < WOTS_CHAINS; i++) {
      checksum += WOTS_W - 1 - nibbles[i]!;
    }
    nibbles[WOTS_CHAINS] = (checksum >> 8) & 0x0f;
    nibbles[WOTS_CHAINS + 1] = (checksum >> 4) & 0x0f;
    nibbles[WOTS_CHAINS + 2] = checksum & 0x0f;

    const sigParts: Uint8Array[] = [];
    for (let i = 0; i < WOTS_TOTAL_CHAINS; i++) {
      sigParts.push(hashChain(privateChains[i]!, WOTS_W - 1 - nibbles[i]!));
    }
    return Buffer.concat(sigParts);
  }

  // ── PDA Derivation ──────────────────────────────────────────────────────────

  /**
   * Derive the WOTS+ vault PDA for a given owner.
   */
  private deriveWotsVaultPDA(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.WINTERNITZ_VAULT), owner.toBuffer()],
      this.programIds.quantumVault,
    );
  }

  /**
   * Derive the HTL vault PDA for a given owner and commitment.
   */
  private deriveHtlVaultPDA(
    owner: PublicKey,
    commitment: Uint8Array,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(SEEDS.HASH_VAULT),
        owner.toBuffer(),
        Buffer.from(commitment),
      ],
      this.programIds.quantumVault,
    );
  }

  // ── Account Parsing ─────────────────────────────────────────────────────────

  /**
   * Parse raw vault account data into a VaultInfo object.
   *
   * Account layout varies by type:
   *
   * WOTS+ vault:
   *   [0..8]    discriminator (0)
   *   [8..40]   owner (Pubkey)
   *   [40..48]  balance (u64)
   *   [48..52]  key_index (u32)
   *   [52..84]  public_key_hash (32 bytes)
   *
   * HTL vault:
   *   [0..8]    discriminator (1)
   *   [8..40]   owner (Pubkey)
   *   [40..48]  balance (u64)
   *   [48..56]  unlock_after (i64)
   *   [56..88]  destination (Pubkey)
   *   [88..120] commitment (32 bytes)
   */
  private parseVaultAccount(
    address: PublicKey,
    data: Buffer | Uint8Array,
  ): VaultInfo {
    // First byte of discriminator determines vault type
    const vaultTypeByte = data[0];

    if (vaultTypeByte === WOTS_VAULT_DISCRIMINATOR) {
      const owner = new PublicKey(data.subarray(8, 40));
      const balance = u64FromLeBytes(data, 40);
      const keyIndex = u32FromLeBytes(data, 48);

      return {
        address,
        type: 'wots',
        owner,
        balance,
        keyIndex,
      };
    } else {
      const owner = new PublicKey(data.subarray(8, 40));
      const balance = u64FromLeBytes(data, 40);
      const unlockAfter = i64FromLeBytes(data, 48);
      const destination = new PublicKey(data.subarray(56, 88));

      return {
        address,
        type: 'htl',
        owner,
        balance,
        unlockAfter,
        destination,
      };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Sign and send a transaction. Handles both Keypair and WalletAdapter signers.
   */
  private async sendTx(tx: Transaction, signers?: Keypair[]): Promise<TxResult> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    let signature: string;
    if ('secretKey' in this.wallet) {
      const allSigners = [this.wallet as Keypair, ...(signers || [])];
      signature = await sendAndConfirmTransaction(this.connection, tx, allSigners);
    } else {
      if (signers?.length) signers.forEach((s) => tx.partialSign(s));
      const signed = await this.wallet.signTransaction(tx);
      signature = await this.connection.sendRawTransaction(signed.serialize());
      await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
    }
    return { signature };
  }
}
