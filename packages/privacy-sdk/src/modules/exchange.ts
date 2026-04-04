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
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import { poseidon2 } from 'poseidon-lite';
import type { Signer, Network, ProgramIds, TokenInfo, TxResult } from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS } from '../constants';

// ─── Constants ──────────────────────────────────────────────────────────────

const CREATE_ORDER_CU = 300_000;
const TAKE_ORDER_CU = 400_000;
const RELEASE_ESCROW_CU = 400_000;
const CONFIRM_PAYMENT_CU = 200_000;
const CANCEL_ORDER_CU = 200_000;
const DISPUTE_CU = 200_000;

const MUGEN_ORDER_ACCOUNT_SIZE = 200;
const MUGEN_ESCROW_ACCOUNT_SIZE = 312;
const MUGEN_REPUTATION_ACCOUNT_SIZE = 85;

const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;

const ORDER_STATUS_OPEN = 0;
const ORDER_STATUS_IN_ESCROW = 1;
const ORDER_STATUS_COMPLETED = 2;
const ORDER_STATUS_CANCELLED = 3;
const ORDER_STATUS_DISPUTED = 4;
const ORDER_STATUS_EXPIRED = 5;

const ESCROW_AWAITING_PAYMENT = 0;
const ESCROW_PAYMENT_CONFIRMED = 1;
const ESCROW_RELEASED = 2;
const ESCROW_DISPUTED = 3;
const ESCROW_REFUNDED = 4;
const ESCROW_EXPIRED = 5;

const PAYMENT_METHOD_MAP: Record<PaymentMethod, number> = {
  bank: 1,
  revolut: 2,
  wise: 4,
  cash: 8,
  sepa: 16,
  zelle: 32,
};

const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ─── Types ──────────────────────────────────────────────────────────────────

export type PaymentMethod = 'bank' | 'revolut' | 'wise' | 'cash' | 'sepa' | 'zelle';
export type MugenOrderType = 'buy_crypto' | 'sell_crypto';

export type MugenOrderStatus =
  | 'open'
  | 'in_escrow'
  | 'completed'
  | 'cancelled'
  | 'disputed'
  | 'expired';

export type MugenEscrowStatus =
  | 'awaiting_payment'
  | 'payment_confirmed'
  | 'released'
  | 'disputed'
  | 'refunded'
  | 'expired';

export interface MugenOrderParams {
  /** Buy crypto with fiat, or sell crypto for fiat. */
  orderType: MugenOrderType;
  /** Token symbol or mint address. */
  token: string;
  /** Amount of crypto in base units. */
  cryptoAmount: bigint;
  /** Fiat price in cents (e.g. 15000 = $150.00). */
  fiatAmount: bigint;
  /** ISO 4217 currency code (USD, EUR, GBP). */
  fiatCurrency: string;
  /** Accepted payment methods. */
  paymentMethods: PaymentMethod[];
  /** Minimum trade amount (0 = no partial fills). */
  minAmount?: bigint;
  /** Maximum trade amount. */
  maxAmount?: bigint;
  /** Order expiry in seconds (default: 24h). */
  expiresIn?: number;
}

export interface MugenOrder {
  address: PublicKey;
  maker: PublicKey;
  orderType: MugenOrderType;
  tokenMint: PublicKey;
  cryptoAmount: bigint;
  fiatAmount: bigint;
  fiatCurrency: string;
  paymentMethods: PaymentMethod[];
  minAmount: bigint;
  maxAmount: bigint;
  complianceAttestation: PublicKey;
  reputationCommitment: bigint;
  status: MugenOrderStatus;
  createdAt: number;
  expiresAt: number;
}

export interface MugenEscrowInfo {
  address: PublicKey;
  order: PublicKey;
  maker: PublicKey;
  taker: PublicKey;
  tokenMint: PublicKey;
  cryptoAmount: bigint;
  fiatAmount: bigint;
  escrowVault: PublicKey;
  stealthRecipient: Uint8Array;
  paymentMethod: PaymentMethod;
  status: MugenEscrowStatus;
  createdAt: number;
  expiresAt: number;
  paymentConfirmedAt: number;
}

export interface MugenReputation {
  commitment: bigint;
  tradesCompleted: number;
  tradesDisputed: number;
  totalVolume: bigint;
  avgPaymentTime: number;
  positiveFeedback: number;
  negativeFeedback: number;
  firstTradeAt: number;
  lastTradeAt: number;
}

export interface MugenCreateOrderResult {
  tx: TxResult;
  orderAddress: PublicKey;
  reputationSalt: bigint;
}

export interface MugenTakeOrderResult {
  tx: TxResult;
  escrowAddress: PublicKey;
}

export interface MugenListOrdersFilter {
  token?: string;
  fiatCurrency?: string;
  orderType?: MugenOrderType;
  status?: MugenOrderStatus;
}

// ─── Module ─────────────────────────────────────────────────────────────────

/**
 * Mugen Exchange Module — P2P fiat-to-crypto exchange with ZK compliance.
 *
 * No KYC required. Uses existing ComplianceModule attestations (sanctions innocence proofs)
 * for regulatory compliance without identity disclosure.
 *
 * @example
 * ```typescript
 * // Create a sell order: sell 10 SOL for $150
 * const result = await sdk.exchange.createOrder({
 *   orderType: 'sell_crypto',
 *   token: 'SOL',
 *   cryptoAmount: 10_000_000_000n,
 *   fiatAmount: 150_00n,
 *   fiatCurrency: 'USD',
 *   paymentMethods: ['bank', 'revolut'],
 * });
 *
 * // Take an order (locks crypto in escrow)
 * const escrow = await sdk.exchange.takeOrder(orderAddress);
 *
 * // After fiat payment sent:
 * await sdk.exchange.confirmPayment(escrow.escrowAddress);
 *
 * // Seller releases after verifying fiat receipt:
 * await sdk.exchange.releaseEscrow(escrow.escrowAddress);
 * ```
 */
export class MugenExchangeModule {
  private connection: Connection;
  private wallet: Signer;
  private network: Network;
  private programIds: ProgramIds;
  private resolveToken: (symbol: string) => TokenInfo;

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

  // ─── Helpers ────────────────────────────────────────────────────────────

  private get programId(): PublicKey {
    return this.programIds.mugenExchange;
  }

  private get walletPubkey(): PublicKey {
    return this.wallet.publicKey;
  }

  private anchorDiscriminator(name: string): Buffer {
    const hash = sha256(`global:${name}`);
    return Buffer.from(hash.slice(0, 8));
  }

  private findConfigPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.MUGEN_CONFIG)],
      this.programId,
    );
  }

  private findOrderPDA(maker: PublicKey, nonce: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.MUGEN_ORDER), maker.toBuffer(), Buffer.from(nonce)],
      this.programId,
    );
  }

  private findEscrowPDA(order: PublicKey, taker: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.MUGEN_ESCROW), order.toBuffer(), taker.toBuffer()],
      this.programId,
    );
  }

  private findVaultPDA(escrow: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.MUGEN_VAULT), escrow.toBuffer()],
      this.programId,
    );
  }

  private findReputationPDA(commitment: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.MUGEN_REPUTATION), Buffer.from(commitment)],
      this.programId,
    );
  }

  private paymentMethodsToBitfield(methods: PaymentMethod[]): number {
    return methods.reduce((acc, m) => acc | (PAYMENT_METHOD_MAP[m] || 0), 0);
  }

  private bitfieldToPaymentMethods(bitfield: number): PaymentMethod[] {
    const methods: PaymentMethod[] = [];
    for (const [method, bit] of Object.entries(PAYMENT_METHOD_MAP)) {
      if (bitfield & bit) methods.push(method as PaymentMethod);
    }
    return methods;
  }

  private statusFromU8(val: number): MugenOrderStatus {
    const map: Record<number, MugenOrderStatus> = {
      [ORDER_STATUS_OPEN]: 'open',
      [ORDER_STATUS_IN_ESCROW]: 'in_escrow',
      [ORDER_STATUS_COMPLETED]: 'completed',
      [ORDER_STATUS_CANCELLED]: 'cancelled',
      [ORDER_STATUS_DISPUTED]: 'disputed',
      [ORDER_STATUS_EXPIRED]: 'expired',
    };
    return map[val] ?? 'expired';
  }

  private escrowStatusFromU8(val: number): MugenEscrowStatus {
    const map: Record<number, MugenEscrowStatus> = {
      [ESCROW_AWAITING_PAYMENT]: 'awaiting_payment',
      [ESCROW_PAYMENT_CONFIRMED]: 'payment_confirmed',
      [ESCROW_RELEASED]: 'released',
      [ESCROW_DISPUTED]: 'disputed',
      [ESCROW_REFUNDED]: 'refunded',
      [ESCROW_EXPIRED]: 'expired',
    };
    return map[val] ?? 'expired';
  }

  private async sendTx(tx: Transaction, signers: Keypair[] = []): Promise<TxResult> {
    tx.feePayer = this.walletPubkey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    if ('signTransaction' in this.wallet && typeof this.wallet.signTransaction === 'function') {
      if (signers.length > 0) tx.partialSign(...signers);
      const signed = await this.wallet.signTransaction(tx);
      const sig = await this.connection.sendRawTransaction(signed.serialize());
      await this.connection.confirmTransaction(sig, 'confirmed');
      return { signature: sig };
    } else {
      const sig = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [this.wallet as Keypair, ...signers],
        { commitment: 'confirmed' },
      );
      return { signature: sig };
    }
  }

  // ─── Order Lifecycle ────────────────────────────────────────────────────

  /**
   * Create a new P2P buy/sell order.
   * Requires a valid compliance attestation (ZK sanctions innocence proof).
   */
  async createOrder(
    params: MugenOrderParams,
    complianceAttestation: PublicKey,
  ): Promise<MugenCreateOrderResult> {
    const tokenInfo = this.resolveToken(params.token);
    const nonce = Keypair.generate().publicKey.toBytes().slice(0, 16);

    // Generate reputation commitment: Poseidon(walletPubkey_as_field, salt)
    const salt = BigInt('0x' + Buffer.from(Keypair.generate().publicKey.toBytes()).toString('hex'));
    const walletField = BigInt('0x' + Buffer.from(this.walletPubkey.toBytes()).toString('hex')) % (2n ** 254n);
    const commitment = poseidon2([walletField, salt]);
    const commitmentBytes = Buffer.alloc(32);
    let c = commitment;
    for (let i = 0; i < 32; i++) {
      commitmentBytes[i] = Number(c & 0xFFn);
      c >>= 8n;
    }

    const [configPDA] = this.findConfigPDA();
    const [orderPDA] = this.findOrderPDA(this.walletPubkey, nonce);

    const fiatCurrencyBytes = Buffer.alloc(3);
    fiatCurrencyBytes.write(params.fiatCurrency.toUpperCase().slice(0, 3), 'ascii');

    const orderTypeU8 = params.orderType === 'buy_crypto' ? 0 : 1;
    const paymentBitfield = this.paymentMethodsToBitfield(params.paymentMethods);
    const expiresIn = params.expiresIn ?? DEFAULT_EXPIRY_SECONDS;

    // Encode instruction data
    const disc = this.anchorDiscriminator('create_order');
    const data = Buffer.alloc(8 + 1 + 8 + 8 + 3 + 2 + 8 + 8 + 32 + 16 + 8);
    let offset = 0;
    disc.copy(data, offset); offset += 8;
    data.writeUInt8(orderTypeU8, offset); offset += 1;
    data.writeBigUInt64LE(params.cryptoAmount, offset); offset += 8;
    data.writeBigUInt64LE(params.fiatAmount, offset); offset += 8;
    fiatCurrencyBytes.copy(data, offset); offset += 3;
    data.writeUInt16LE(paymentBitfield, offset); offset += 2;
    data.writeBigUInt64LE(params.minAmount ?? 0n, offset); offset += 8;
    data.writeBigUInt64LE(params.maxAmount ?? 0n, offset); offset += 8;
    commitmentBytes.copy(data, offset); offset += 32;
    Buffer.from(nonce).copy(data, offset); offset += 16;
    data.writeBigInt64LE(BigInt(expiresIn), offset);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: this.walletPubkey, isSigner: true, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: orderPDA, isSigner: false, isWritable: true },
        { pubkey: complianceAttestation, isSigner: false, isWritable: false },
        { pubkey: tokenInfo.mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_ORDER_CU }));
    tx.add(ix);

    const result = await this.sendTx(tx);

    return {
      tx: result,
      orderAddress: orderPDA,
      reputationSalt: salt,
    };
  }

  /**
   * Cancel an open order (maker only).
   */
  async cancelOrder(orderAddress: PublicKey): Promise<TxResult> {
    const disc = this.anchorDiscriminator('cancel_order');

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: this.walletPubkey, isSigner: true, isWritable: true },
        { pubkey: orderAddress, isSigner: false, isWritable: true },
      ],
      programId: this.programId,
      data: disc,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CANCEL_ORDER_CU }));
    tx.add(ix);

    return this.sendTx(tx);
  }

  /**
   * Take an open order — locks crypto in escrow.
   * Both parties must hold valid ZK compliance attestations.
   */
  async takeOrder(
    orderAddress: PublicKey,
    takerAttestation: PublicKey,
    sellerTokenAccount: PublicKey,
    options?: {
      stealthRecipient?: Uint8Array;
      paymentMethod?: PaymentMethod;
    },
  ): Promise<MugenTakeOrderResult> {
    const order = await this.getOrder(orderAddress);
    if (!order) {
      throw new PrivacyError(PrivacyErrorCode.EXCHANGE_ORDER_NOT_FOUND, 'Order not found');
    }

    const [escrowPDA] = this.findEscrowPDA(orderAddress, this.walletPubkey);
    const [vaultPDA] = this.findVaultPDA(escrowPDA);

    const stealthBytes = options?.stealthRecipient ?? new Uint8Array(32);
    const paymentMethod = options?.paymentMethod
      ? PAYMENT_METHOD_MAP[options.paymentMethod] ?? 1
      : 1;

    // Encode: discriminator + option<[u8;32]> + u16
    const disc = this.anchorDiscriminator('take_order');
    const hasStealthRecipient = stealthBytes.some(b => b !== 0);
    const data = Buffer.alloc(8 + 1 + (hasStealthRecipient ? 32 : 0) + 2);
    let offset = 0;
    disc.copy(data, offset); offset += 8;
    if (hasStealthRecipient) {
      data.writeUInt8(1, offset); offset += 1;
      Buffer.from(stealthBytes).copy(data, offset); offset += 32;
    } else {
      data.writeUInt8(0, offset); offset += 1;
    }
    data.writeUInt16LE(paymentMethod, offset);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: this.walletPubkey, isSigner: true, isWritable: true },
        { pubkey: this.findConfigPDA()[0], isSigner: false, isWritable: false },
        { pubkey: orderAddress, isSigner: false, isWritable: true },
        { pubkey: escrowPDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: this.walletPubkey, isSigner: true, isWritable: false }, // seller signer
        { pubkey: order.tokenMint, isSigner: false, isWritable: false },
        { pubkey: takerAttestation, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: TAKE_ORDER_CU }));
    tx.add(ix);

    const result = await this.sendTx(tx);
    return { tx: result, escrowAddress: escrowPDA };
  }

  /**
   * Buyer confirms fiat payment was sent.
   */
  async confirmPayment(escrowAddress: PublicKey): Promise<TxResult> {
    const disc = this.anchorDiscriminator('confirm_payment');

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: this.walletPubkey, isSigner: true, isWritable: false },
        { pubkey: escrowAddress, isSigner: false, isWritable: true },
      ],
      programId: this.programId,
      data: disc,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CONFIRM_PAYMENT_CU }));
    tx.add(ix);

    return this.sendTx(tx);
  }

  /**
   * Seller releases escrowed crypto after confirming fiat receipt.
   * Protocol fee deducted. Both parties' reputation updated.
   */
  async releaseEscrow(
    escrowAddress: PublicKey,
    buyerTokenAccount: PublicKey,
    feeTokenAccount: PublicKey,
    makerReputationPDA: PublicKey,
    takerReputationPDA: PublicKey,
  ): Promise<TxResult> {
    const [configPDA] = this.findConfigPDA();
    const [vaultPDA] = this.findVaultPDA(escrowAddress);
    const disc = this.anchorDiscriminator('release_escrow');

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: this.walletPubkey, isSigner: true, isWritable: false },
        { pubkey: configPDA, isSigner: false, isWritable: true },
        { pubkey: escrowAddress, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: feeTokenAccount, isSigner: false, isWritable: true },
        { pubkey: makerReputationPDA, isSigner: false, isWritable: true },
        { pubkey: takerReputationPDA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: disc,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: RELEASE_ESCROW_CU }));
    tx.add(ix);

    return this.sendTx(tx);
  }

  /**
   * Either party opens a dispute on the escrow.
   */
  async disputeEscrow(escrowAddress: PublicKey, reason: number): Promise<TxResult> {
    const disc = this.anchorDiscriminator('dispute_escrow');
    const data = Buffer.alloc(8 + 1);
    disc.copy(data, 0);
    data.writeUInt8(reason, 8);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: this.walletPubkey, isSigner: true, isWritable: false },
        { pubkey: escrowAddress, isSigner: false, isWritable: true },
      ],
      programId: this.programId,
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: DISPUTE_CU }));
    tx.add(ix);

    return this.sendTx(tx);
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  /**
   * Fetch a single order by address.
   */
  async getOrder(address: PublicKey): Promise<MugenOrder | null> {
    const info = await this.connection.getAccountInfo(address);
    if (!info || info.data.length < 8) return null;
    return this.parseOrder(address, info.data);
  }

  /**
   * Fetch a single escrow by address.
   */
  async getEscrow(address: PublicKey): Promise<MugenEscrowInfo | null> {
    const info = await this.connection.getAccountInfo(address);
    if (!info || info.data.length < 8) return null;
    return this.parseEscrow(address, info.data);
  }

  /**
   * List all open orders, optionally filtered.
   */
  async listOrders(filter?: MugenListOrdersFilter): Promise<MugenOrder[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: MUGEN_ORDER_ACCOUNT_SIZE },
        // Filter by open status
        ...(filter?.status
          ? []
          : [{ memcmp: { offset: 8 + 32 + 1 + 32 + 8 + 8 + 3 + 2 + 8 + 8 + 32 + 32 + 16, bytes: 'A' /* status = 0 */ } }]),
      ],
    });

    const orders = accounts
      .map(({ pubkey, account }) => this.parseOrder(pubkey, account.data))
      .filter((o): o is MugenOrder => o !== null);

    // Apply client-side filters
    return orders.filter(o => {
      if (filter?.token) {
        const tokenInfo = this.resolveToken(filter.token);
        if (!o.tokenMint.equals(tokenInfo.mint)) return false;
      }
      if (filter?.fiatCurrency && o.fiatCurrency !== filter.fiatCurrency) return false;
      if (filter?.orderType && o.orderType !== filter.orderType) return false;
      if (filter?.status && o.status !== filter.status) return false;
      return true;
    });
  }

  /**
   * Get the caller's own orders.
   */
  async getMyOrders(): Promise<MugenOrder[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: MUGEN_ORDER_ACCOUNT_SIZE },
        { memcmp: { offset: 8, bytes: this.walletPubkey.toBase58() } },
      ],
    });

    return accounts
      .map(({ pubkey, account }) => this.parseOrder(pubkey, account.data))
      .filter((o): o is MugenOrder => o !== null);
  }

  /**
   * Get reputation data for a commitment.
   */
  async getReputation(commitment: Uint8Array): Promise<MugenReputation | null> {
    const [pda] = this.findReputationPDA(commitment);
    const info = await this.connection.getAccountInfo(pda);
    if (!info || info.data.length < 8) return null;
    return this.parseReputation(info.data);
  }

  /**
   * Generate a reputation commitment for the current wallet.
   */
  getReputationCommitment(salt: bigint): { commitment: bigint; commitmentBytes: Uint8Array } {
    const walletField = BigInt('0x' + Buffer.from(this.walletPubkey.toBytes()).toString('hex')) % (2n ** 254n);
    const commitment = poseidon2([walletField, salt]);
    const bytes = Buffer.alloc(32);
    let c = commitment;
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number(c & 0xFFn);
      c >>= 8n;
    }
    return { commitment, commitmentBytes: new Uint8Array(bytes) };
  }

  // ─── Parsers ────────────────────────────────────────────────────────────

  private parseOrder(address: PublicKey, data: Buffer): MugenOrder | null {
    try {
      let offset = 8; // skip discriminator

      const maker = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const orderTypeU8 = data.readUInt8(offset); offset += 1;
      const tokenMint = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const cryptoAmount = data.readBigUInt64LE(offset); offset += 8;
      const fiatAmount = data.readBigUInt64LE(offset); offset += 8;
      const fiatCurrency = data.subarray(offset, offset + 3).toString('ascii'); offset += 3;
      const paymentMethodsBitfield = data.readUInt16LE(offset); offset += 2;
      const minAmount = data.readBigUInt64LE(offset); offset += 8;
      const maxAmount = data.readBigUInt64LE(offset); offset += 8;
      const complianceAttestation = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const repCommitmentBytes = data.subarray(offset, offset + 32); offset += 32;
      offset += 16; // nonce
      const status = data.readUInt8(offset); offset += 1;
      const createdAt = Number(data.readBigInt64LE(offset)); offset += 8;
      const expiresAt = Number(data.readBigInt64LE(offset));

      let reputationCommitment = 0n;
      for (let i = 31; i >= 0; i--) {
        reputationCommitment = (reputationCommitment << 8n) | BigInt(repCommitmentBytes[i]);
      }

      return {
        address,
        maker,
        orderType: orderTypeU8 === 0 ? 'buy_crypto' : 'sell_crypto',
        tokenMint,
        cryptoAmount,
        fiatAmount,
        fiatCurrency: fiatCurrency.replace(/\0/g, ''),
        paymentMethods: this.bitfieldToPaymentMethods(paymentMethodsBitfield),
        minAmount,
        maxAmount,
        complianceAttestation,
        reputationCommitment,
        status: this.statusFromU8(status),
        createdAt,
        expiresAt,
      };
    } catch {
      return null;
    }
  }

  private parseEscrow(address: PublicKey, data: Buffer): MugenEscrowInfo | null {
    try {
      let offset = 8;

      const order = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const maker = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const taker = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const tokenMint = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      const cryptoAmount = data.readBigUInt64LE(offset); offset += 8;
      const fiatAmount = data.readBigUInt64LE(offset); offset += 8;
      const escrowVault = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
      offset += 32; // maker_attestation
      offset += 32; // taker_attestation
      const stealthRecipient = new Uint8Array(data.subarray(offset, offset + 32)); offset += 32;
      const paymentMethodBitfield = data.readUInt16LE(offset); offset += 2;
      const status = data.readUInt8(offset); offset += 1;
      const createdAt = Number(data.readBigInt64LE(offset)); offset += 8;
      const expiresAt = Number(data.readBigInt64LE(offset)); offset += 8;
      const paymentConfirmedAt = Number(data.readBigInt64LE(offset));

      const methods = this.bitfieldToPaymentMethods(paymentMethodBitfield);

      return {
        address,
        order,
        maker,
        taker,
        tokenMint,
        cryptoAmount,
        fiatAmount,
        escrowVault,
        stealthRecipient,
        paymentMethod: methods[0] ?? 'bank',
        status: this.escrowStatusFromU8(status),
        createdAt,
        expiresAt,
        paymentConfirmedAt,
      };
    } catch {
      return null;
    }
  }

  private parseReputation(data: Buffer): MugenReputation | null {
    try {
      let offset = 8;

      const commitmentBytes = data.subarray(offset, offset + 32); offset += 32;
      let commitment = 0n;
      for (let i = 31; i >= 0; i--) {
        commitment = (commitment << 8n) | BigInt(commitmentBytes[i]);
      }

      const tradesCompleted = data.readUInt32LE(offset); offset += 4;
      const tradesDisputed = data.readUInt32LE(offset); offset += 4;
      const totalVolume = data.readBigUInt64LE(offset); offset += 8;
      const avgPaymentTime = data.readUInt32LE(offset); offset += 4;
      const positiveFeedback = data.readUInt32LE(offset); offset += 4;
      const negativeFeedback = data.readUInt32LE(offset); offset += 4;
      const firstTradeAt = Number(data.readBigInt64LE(offset)); offset += 8;
      const lastTradeAt = Number(data.readBigInt64LE(offset));

      return {
        commitment,
        tradesCompleted,
        tradesDisputed,
        totalVolume,
        avgPaymentTime,
        positiveFeedback,
        negativeFeedback,
        firstTradeAt,
        lastTradeAt,
      };
    } catch {
      return null;
    }
  }
}
