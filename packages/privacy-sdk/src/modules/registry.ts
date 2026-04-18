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
  RegisterParams,
  RegistryEntry,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS } from '../constants';

/** ML-KEM-768 public key size in bytes */
const KEM_PUBKEY_SIZE = 1184;

// ── Utility Functions ──────────────────────────────────────────────────────────

/**
 * Anchor-style 8-byte instruction discriminator: sha256(utf8ToBytes("global:<name>"))[0..8]
 */
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`)).slice(0, 8));
}

/**
 * Encode a Borsh string with a 4-byte length prefix.
 */
function encodeBorshString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/**
 * Decode a Borsh string from a buffer at the given offset.
 * Returns the string and the number of bytes consumed.
 */
function decodeBorshString(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const len =
    buf[offset]! |
    (buf[offset + 1]! << 8) |
    (buf[offset + 2]! << 16) |
    (buf[offset + 3]! << 24);
  const value = Buffer.from(buf.subarray(offset + 4, offset + 4 + len)).toString('utf-8');
  return { value, bytesRead: 4 + len };
}

/**
 * Read a little-endian i64 as a JS number.
 */
function i64FromLeBytes(buf: Uint8Array, offset: number): number {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[offset + i]!);
  }
  return Number(result);
}

/**
 * RegistryModule wraps the p01_registry program to manage
 * stealth meta-address registration on-chain.
 *
 * Each registered user publishes their spending public key,
 * viewing public key, and optionally an ML-KEM-768 public key
 * for quantum-resistant stealth address derivation.
 *
 * The registry follows the EIP-5564 stealth address standard
 * adapted for Solana.
 */
export class RegistryModule {
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
   * Register a stealth meta-address on-chain.
   *
   * If `kemPubKey` is provided (1184-byte ML-KEM-768 public key), the v2
   * instruction is used for quantum-resistant stealth address generation.
   * Otherwise the v1 instruction registers classical ECDH keys.
   *
   * @param params - Spending/viewing public keys and optional KEM key and name.
   * @returns Transaction result.
   */
  async register(params: RegisterParams): Promise<TxResult> {
    try {
      const owner = this.walletPublicKey();
      const [registryPDA] = this.deriveRegistryPDA(owner);

      // Check if already registered
      const existing = await this.connection.getAccountInfo(registryPDA);
      if (existing) {
        throw new PrivacyError(
          PrivacyErrorCode.REGISTRY_ALREADY_EXISTS,
          'Registry entry already exists. Use update() to modify.',
        );
      }

      const tx = new Transaction();

      if (params.kemPubKey && params.kemPubKey.length === KEM_PUBKEY_SIZE) {
        // v2: quantum-resistant registration with ML-KEM-768 key
        const disc = instructionDiscriminator('register_v2');
        const nameBytes = encodeBorshString(params.name ?? '');
        const data = Buffer.concat([
          disc,
          Buffer.from(params.spendingPubKey),
          Buffer.from(params.viewingPubKey),
          Buffer.from(params.kemPubKey),
          nameBytes,
        ]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: true },
              { pubkey: registryPDA, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId: this.programIds.registry,
            data,
          }),
        );
      } else {
        // v1: classical ECDH registration
        const disc = instructionDiscriminator('register_v1');
        const nameBytes = encodeBorshString(params.name ?? '');
        const data = Buffer.concat([
          disc,
          Buffer.from(params.spendingPubKey),
          Buffer.from(params.viewingPubKey),
          nameBytes,
        ]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: true },
              { pubkey: registryPDA, isSigner: false, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            programId: this.programIds.registry,
            data,
          }),
        );
      }

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.REGISTRY_UPDATE_FAILED,
        `Registry registration failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Update an existing registry entry.
   *
   * Supports partial updates: provide only the fields you want to change.
   * If `kemPubKey` is included, the v2 update instruction is used.
   *
   * @param params - Fields to update (spending key, viewing key, KEM key, name).
   * @returns Transaction result.
   */
  async update(params: Partial<RegisterParams>): Promise<TxResult> {
    try {
      const owner = this.walletPublicKey();
      const [registryPDA] = this.deriveRegistryPDA(owner);

      // Verify entry exists
      const existing = await this.connection.getAccountInfo(registryPDA);
      if (!existing) {
        throw new PrivacyError(
          PrivacyErrorCode.REGISTRY_NOT_FOUND,
          'No registry entry found. Use register() first.',
        );
      }

      const tx = new Transaction();

      // If only updating name, use update_name
      if (params.name && !params.spendingPubKey && !params.viewingPubKey && !params.kemPubKey) {
        const disc = instructionDiscriminator('update_name');
        const nameBytes = encodeBorshString(params.name);
        const data = Buffer.concat([disc, nameBytes]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: false },
              { pubkey: registryPDA, isSigner: false, isWritable: true },
            ],
            programId: this.programIds.registry,
            data,
          }),
        );
      } else if (params.kemPubKey && params.kemPubKey.length === KEM_PUBKEY_SIZE) {
        // v2 key update: includes KEM public key
        const disc = instructionDiscriminator('update_keys_v2');
        const data = Buffer.concat([
          disc,
          Buffer.from(params.spendingPubKey ?? new Uint8Array(32)),
          Buffer.from(params.viewingPubKey ?? new Uint8Array(32)),
          Buffer.from(params.kemPubKey),
        ]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: false },
              { pubkey: registryPDA, isSigner: false, isWritable: true },
            ],
            programId: this.programIds.registry,
            data,
          }),
        );
      } else {
        // v1 key update: classical ECDH keys only
        const disc = instructionDiscriminator('update_keys_v1');
        const data = Buffer.concat([
          disc,
          Buffer.from(params.spendingPubKey ?? new Uint8Array(32)),
          Buffer.from(params.viewingPubKey ?? new Uint8Array(32)),
        ]);

        tx.add(
          new TransactionInstruction({
            keys: [
              { pubkey: owner, isSigner: true, isWritable: false },
              { pubkey: registryPDA, isSigner: false, isWritable: true },
            ],
            programId: this.programIds.registry,
            data,
          }),
        );
      }

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.REGISTRY_UPDATE_FAILED,
        `Registry update failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Deregister (close) the caller's registry entry.
   *
   * Reclaims the rent-exempt lamports back to the wallet.
   *
   * @returns Transaction result.
   */
  async deregister(): Promise<TxResult> {
    try {
      const owner = this.walletPublicKey();
      const [registryPDA] = this.deriveRegistryPDA(owner);

      const existing = await this.connection.getAccountInfo(registryPDA);
      if (!existing) {
        throw new PrivacyError(
          PrivacyErrorCode.REGISTRY_NOT_FOUND,
          'No registry entry found to deregister.',
        );
      }

      const disc = instructionDiscriminator('deregister');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: registryPDA, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.registry,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.REGISTRY_UPDATE_FAILED,
        `Deregistration failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Look up a wallet's stealth meta-address from the on-chain registry.
   *
   * @param wallet - The wallet public key to look up.
   * @returns The registry entry, or null if the wallet is not registered.
   */
  async lookup(wallet: PublicKey): Promise<RegistryEntry | null> {
    const [registryPDA] = this.deriveRegistryPDA(wallet);
    const accountInfo = await this.connection.getAccountInfo(registryPDA);

    if (!accountInfo || !accountInfo.data) {
      return null;
    }

    return this.parseRegistryAccount(accountInfo.data);
  }

  /**
   * Batch-lookup multiple wallets' registry entries in one RPC call.
   *
   * @param wallets - Array of wallet public keys to look up.
   * @returns Map from wallet base58 address to registry entry (missing wallets are omitted).
   */
  async lookupMultiple(wallets: PublicKey[]): Promise<Map<string, RegistryEntry>> {
    const pdas = wallets.map((w) => this.deriveRegistryPDA(w)[0]);

    const accountInfos = await this.connection.getMultipleAccountsInfo(pdas);

    const results = new Map<string, RegistryEntry>();
    for (let i = 0; i < wallets.length; i++) {
      const info = accountInfos[i];
      if (info && info.data) {
        results.set(wallets[i]!.toBase58(), this.parseRegistryAccount(info.data));
      }
    }

    return results;
  }

  /**
   * Check whether a wallet has a registry entry on-chain.
   *
   * @param wallet - The wallet public key to check.
   * @returns True if registered, false otherwise.
   */
  async isRegistered(wallet: PublicKey): Promise<boolean> {
    const [registryPDA] = this.deriveRegistryPDA(wallet);
    const accountInfo = await this.connection.getAccountInfo(registryPDA);
    return accountInfo !== null;
  }

  // ── PDA Derivation ──────────────────────────────────────────────────────────

  /**
   * Derive the registry PDA for a given owner.
   */
  private deriveRegistryPDA(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.REGISTRY), owner.toBuffer()],
      this.programIds.registry,
    );
  }

  // ── Account Parsing ─────────────────────────────────────────────────────────

  /**
   * Parse raw registry account data into a RegistryEntry object.
   *
   * Account layout (UserRegistry, 1343 bytes max):
   *   [0..8]      discriminator
   *   [8..40]     owner (Pubkey)
   *   [40..72]    spending_pub_key (32 bytes)
   *   [72..104]   viewing_pub_key (32 bytes)
   *   [104]       version (u8)
   *   [105]       has_kem (bool)
   *   [106..1290] kem_pub_key (1184 bytes, present if has_kem)
   *   Then:       name (Borsh string: 4-byte len + utf8)
   *   Then:       created_at (i64)
   *   Then:       updated_at (i64)
   */
  private parseRegistryAccount(data: Buffer | Uint8Array): RegistryEntry {
    const owner = new PublicKey(data.subarray(8, 40));
    const spendingPubKey = new Uint8Array(data.subarray(40, 72));
    const viewingPubKey = new Uint8Array(data.subarray(72, 104));
    const version = data[104];
    const hasKem = data[105] === 1;

    let offset = 106;
    let kemPubKey: Uint8Array | undefined;

    if (hasKem) {
      kemPubKey = new Uint8Array(data.subarray(offset, offset + KEM_PUBKEY_SIZE));
      offset += KEM_PUBKEY_SIZE;
    }

    const { value: name, bytesRead: nameBytes } = decodeBorshString(data, offset);
    offset += nameBytes;

    const createdAt = i64FromLeBytes(data, offset);
    offset += 8;
    const updatedAt = i64FromLeBytes(data, offset);

    return {
      owner,
      spendingPubKey,
      viewingPubKey,
      kemPubKey,
      version: version!,
      name,
      createdAt,
      updatedAt,
    };
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
