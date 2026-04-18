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
  TokenSymbol,
  TxResult,
  CreateSubscriptionParams,
  SubscriptionInfo,
  SubscriptionReceipt,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS, COMPUTE_UNITS } from '../constants';

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
 * Encode a u32 as a 4-byte little-endian buffer.
 */
function u32ToLeBytes(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
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
  return buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16) | (buf[offset + 3]! << 24);
}

/**
 * Read a little-endian i64 (signed) as a JS number from a buffer slice.
 */
function i64FromLeBytes(buf: Uint8Array, offset: number): number {
  return Number(u64FromLeBytes(buf, offset));
}

/**
 * Encode a string with a 4-byte length prefix (Borsh-style).
 */
function encodeBorshString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf-8');
  const len = u32ToLeBytes(bytes.length);
  return Buffer.concat([len, bytes]);
}

/**
 * SubscriptionsModule wraps the on-chain subscription program
 * to manage recurring payments between subscribers and merchants.
 *
 * Subscriptions delegate token authority to a PDA that can be
 * triggered permissionlessly when a payment is due. Supports
 * pause/resume, cancellation, and private (shielded) subscriptions.
 */
export class SubscriptionsModule {
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
   * Create a new recurring subscription.
   *
   * Delegates token authority to the subscription PDA so that payments
   * can be processed automatically when due. Optionally routes through
   * the shielded pool for privacy.
   *
   * @param params - Subscription configuration (merchant, amount, interval, etc.).
   * @returns Transaction result and the subscription PDA address.
   */
  async create(params: CreateSubscriptionParams): Promise<SubscriptionReceipt> {
    try {
      const token = this.resolveToken(params.token ?? 'SOL');
      const amount = BigInt(params.amount);
      const subscriber = this.walletPublicKey();
      const merchant = params.merchant;
      const mint = token.mint;
      const subscriptionId = params.name ?? `sub_${Date.now()}`;
      const maxPayments = params.maxPayments ?? 0; // 0 = unlimited

      const [subscriptionPDA] = this.deriveSubscriptionPDA(
        subscriber,
        merchant,
        subscriptionId,
      );

      const disc = instructionDiscriminator('create_subscription');
      const data = Buffer.concat([
        disc,
        u64ToLeBytes(amount),
        u64ToLeBytes(params.interval),
        u32ToLeBytes(maxPayments),
        encodeBorshString(subscriptionId),
        Buffer.from([params.private ? 1 : 0]),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS.SUBSCRIPTION_CREATE,
        }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: subscriber, isSigner: true, isWritable: true },
            { pubkey: merchant, isSigner: false, isWritable: false },
            { pubkey: subscriptionPDA, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.subscription,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);
      return { tx: txResult, subscriptionAddress: subscriptionPDA };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.SUBSCRIPTION_CREATE_FAILED,
        `Subscription creation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Cancel an active subscription.
   *
   * Only the subscriber can cancel. The PDA delegation is revoked
   * and no further payments will be processed.
   *
   * @param subscriptionAddress - Public key of the subscription account.
   * @returns Transaction result.
   */
  async cancel(subscriptionAddress: PublicKey): Promise<TxResult> {
    try {
      const subscriber = this.walletPublicKey();

      const disc = instructionDiscriminator('cancel_subscription');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: subscriber, isSigner: true, isWritable: true },
            { pubkey: subscriptionAddress, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.subscription,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.SUBSCRIPTION_CANCEL_FAILED,
        `Subscription cancellation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Pause an active subscription.
   *
   * The subscription remains on-chain but payments are suspended until resumed.
   * Only the subscriber can pause.
   *
   * @param subscriptionAddress - Public key of the subscription account.
   * @returns Transaction result.
   */
  async pause(subscriptionAddress: PublicKey): Promise<TxResult> {
    try {
      const subscriber = this.walletPublicKey();

      const disc = instructionDiscriminator('pause_subscription');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: subscriber, isSigner: true, isWritable: false },
            { pubkey: subscriptionAddress, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.subscription,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.SUBSCRIPTION_PAUSE_FAILED,
        `Subscription pause failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Resume a paused subscription.
   *
   * The next payment becomes due based on the current timestamp plus
   * the subscription interval.
   *
   * @param subscriptionAddress - Public key of the subscription account.
   * @returns Transaction result.
   */
  async resume(subscriptionAddress: PublicKey): Promise<TxResult> {
    try {
      const subscriber = this.walletPublicKey();

      const disc = instructionDiscriminator('resume_subscription');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: subscriber, isSigner: true, isWritable: false },
            { pubkey: subscriptionAddress, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.subscription,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.SUBSCRIPTION_PAUSE_FAILED,
        `Subscription resume failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Process a due payment on a subscription.
   *
   * This is a permissionless operation -- any wallet can trigger it
   * as long as the payment is actually due. Tokens are transferred
   * from the subscriber to the merchant via the PDA delegation.
   *
   * @param subscriptionAddress - Public key of the subscription account.
   * @returns Transaction result.
   */
  async processPayment(subscriptionAddress: PublicKey): Promise<TxResult> {
    try {
      const caller = this.walletPublicKey();

      const disc = instructionDiscriminator('process_payment');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS.SUBSCRIPTION_CREATE,
        }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: caller, isSigner: true, isWritable: true },
            { pubkey: subscriptionAddress, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.subscription,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.SUBSCRIPTION_CREATE_FAILED,
        `Subscription payment processing failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch a single subscription's on-chain state.
   *
   * @param address - Public key of the subscription account.
   * @returns Parsed subscription information.
   */
  async getSubscription(address: PublicKey): Promise<SubscriptionInfo> {
    const accountInfo = await this.connection.getAccountInfo(address);

    if (!accountInfo || !accountInfo.data) {
      throw new PrivacyError(
        PrivacyErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription account ${address.toBase58()} not found.`,
      );
    }

    return this.parseSubscriptionAccount(address, accountInfo.data);
  }

  /**
   * List all subscriptions for the connected wallet.
   *
   * @param role - Filter by 'subscriber' or 'merchant'.
   * @returns Array of parsed subscription information.
   */
  async listSubscriptions(
    role: 'subscriber' | 'merchant',
  ): Promise<SubscriptionInfo[]> {
    const wallet = this.walletPublicKey();

    // Account layout: 8-byte discriminator, then subscriber (32), then merchant (32)
    const offset = role === 'subscriber' ? 8 : 40;

    const accounts = await this.connection.getProgramAccounts(
      this.programIds.subscription,
      {
        filters: [{ memcmp: { offset, bytes: wallet.toBase58() } }],
      },
    );

    return accounts.map((a) =>
      this.parseSubscriptionAccount(a.pubkey, a.account.data),
    );
  }

  // ── PDA Derivation ──────────────────────────────────────────────────────────

  /**
   * Derive the subscription PDA for a subscriber-merchant-id tuple.
   */
  private deriveSubscriptionPDA(
    subscriber: PublicKey,
    merchant: PublicKey,
    id: string,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(SEEDS.SUBSCRIPTION),
        subscriber.toBuffer(),
        merchant.toBuffer(),
        Buffer.from(id, 'utf-8'),
      ],
      this.programIds.subscription,
    );
  }

  // ── Account Parsing ─────────────────────────────────────────────────────────

  /**
   * Parse raw subscription account data into a SubscriptionInfo object.
   *
   * Account layout (expected):
   *   [0..8]     discriminator
   *   [8..40]    subscriber (Pubkey)
   *   [40..72]   merchant (Pubkey)
   *   [72..80]   amount (u64)
   *   [80..88]   interval (u64)
   *   [88..96]   next_payment_due (i64)
   *   [96..100]  payments_completed (u32)
   *   [100..104] max_payments (u32)
   *   [104]      is_active (bool)
   *   [105]      is_private (bool)
   *   [106..138] token_mint (Pubkey)
   */
  private parseSubscriptionAccount(
    address: PublicKey,
    data: Buffer | Uint8Array,
  ): SubscriptionInfo {
    const subscriber = new PublicKey(data.subarray(8, 40));
    const merchant = new PublicKey(data.subarray(40, 72));
    const amount = u64FromLeBytes(data, 72);
    const interval = Number(u64FromLeBytes(data, 80));
    const nextPaymentDue = i64FromLeBytes(data, 88);
    const paymentsCompleted = u32FromLeBytes(data, 96);
    const maxPayments = u32FromLeBytes(data, 100);
    const isActive = data[104] === 1;
    const isPrivate = data[105] === 1;
    const tokenMint = new PublicKey(data.subarray(106, 138));

    return {
      address,
      subscriber,
      merchant,
      amount,
      interval,
      nextPaymentDue,
      paymentsCompleted,
      maxPayments,
      isActive,
      isPrivate,
      tokenMint,
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
