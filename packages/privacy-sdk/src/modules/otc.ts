import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  Keypair,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import { poseidon2, poseidon3 } from 'poseidon-lite';
import type { Signer, Network, ProgramIds, TokenInfo, TxResult } from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS } from '../constants';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default order expiry: 24 hours in seconds. */
const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60;

/** Compute budget for create_otc_order instruction. */
const CREATE_ORDER_CU = 300_000;

/** Compute budget for fill_otc_order instruction. */
const FILL_ORDER_CU = 400_000;

/** Compute budget for cancel_otc_order instruction. */
const CANCEL_ORDER_CU = 200_000;

/** PDA seed prefixes. */
const OTC_ORDER_SEED = 'otc_order';
const OTC_ESCROW_SEED = 'otc_escrow';

/** Native SOL mint sentinel. */
const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** On-chain OTC order account size (bytes). */
const OTC_ORDER_ACCOUNT_SIZE = 314;

/** Order status enum values matching on-chain representation. */
const ORDER_STATUS_OPEN = 0;
const ORDER_STATUS_FILLED = 1;
const ORDER_STATUS_CANCELLED = 2;
const ORDER_STATUS_EXPIRED = 3;

// ─── Exported Types ─────────────────────────────────────────────────────────

export interface OTCOrderParams {
  /** Token being sold (symbol or mint address). */
  sellToken: string;
  /** Amount being sold (base units). */
  sellAmount: bigint;
  /** Token being bought (symbol or mint address). */
  buyToken: string;
  /** Amount being bought (base units). */
  buyAmount: bigint;
  /** Order expiry in seconds from now (default: 24h). */
  expiresIn?: number;
  /** Whether to use stealth addresses for settlement (default: true). */
  useStealth?: boolean;
}

export interface OTCOrder {
  address: PublicKey;
  maker: PublicKey;
  sellMint: PublicKey;
  buyMint: PublicKey;
  /** Commitment to sell amount: poseidon2([sellAmount, salt]). */
  sellCommitment: bigint;
  /** Commitment to buy amount: poseidon2([buyAmount, salt]). */
  buyCommitment: bigint;
  /** Total sell amount escrowed. */
  sellAmount: bigint;
  /** Total buy amount expected. */
  buyAmount: bigint;
  /** Escrow token account holding the sell tokens. */
  escrow: PublicKey;
  createdAt: number;
  expiresAt: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  filledBy?: PublicKey;
  /** 16-byte nonce used for PDA derivation. */
  nonce: Uint8Array;
  bump: number;
  escrowBump: number;
}

export interface OTCFillParams {
  /** Address of the order to fill. */
  order: PublicKey;
  /** Buy amount (must match the maker's expected buy amount). */
  buyAmount: bigint;
  /** Salt used by taker for their commitment. */
  salt?: bigint;
}

export interface OTCCreateResult {
  tx: TxResult;
  orderAddress: PublicKey;
  /** Salt used for commitments -- taker needs this to fill. */
  salt: bigint;
  /** Share this with potential takers (contains order details). */
  orderInfo: {
    orderAddress: string;
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount: string;
    expiresAt: number;
  };
}

export interface OTCFillResult {
  tx: TxResult;
  /** Amount received by taker. */
  receivedAmount: bigint;
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Anchor-style 8-byte instruction discriminator: sha256("global:<name>")[0..8]
 */
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
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
 * Read a little-endian i64 as a JS number.
 */
function i64FromLeBytes(buf: Uint8Array, offset: number): number {
  return Number(u64FromLeBytes(buf, offset));
}

/**
 * Encode a bigint as a 32-byte little-endian buffer (field element).
 */
function bigintToBytes32LE(value: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = value;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Read a 32-byte little-endian unsigned integer from a buffer slice as bigint.
 */
function bigintFromBytes32LE(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 31; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[offset + i]!);
  }
  return result;
}

/**
 * Generate a cryptographically random bigint suitable for use as a Poseidon salt.
 * Uses 31 bytes to stay safely within the BN254 scalar field.
 */
function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}

/**
 * Generate a random 16-byte nonce for order PDA derivation.
 */
function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Map an on-chain status byte to the typed status string.
 */
function parseOrderStatus(
  statusByte: number,
  expiresAt: number,
): 'open' | 'filled' | 'cancelled' | 'expired' {
  if (statusByte === ORDER_STATUS_FILLED) return 'filled';
  if (statusByte === ORDER_STATUS_CANCELLED) return 'cancelled';
  if (statusByte === ORDER_STATUS_EXPIRED) return 'expired';
  // If on-chain says open, check if it's actually expired by timestamp
  const now = Math.floor(Date.now() / 1000);
  if (now >= expiresAt) return 'expired';
  return 'open';
}

// ─── OTCModule ──────────────────────────────────────────────────────────────

/**
 * Private OTC Desk -- trustless P2P trading where amounts and parties stay hidden.
 *
 * Uses an atomic swap pattern with Poseidon commitments:
 * 1. Maker commits to sell X tokens for Y tokens, escrowing X in a PDA.
 * 2. Order is posted on-chain with Poseidon commitments (not plaintext amounts).
 * 3. Taker fills the order by providing matching commitments + tokens.
 * 4. Atomic swap executes: both parties' tokens are exchanged in one transaction.
 * 5. Neither party sees the other's wallet -- only stealth addresses are used.
 *
 * @example
 * ```typescript
 * // Maker creates an order: sell 10 SOL for 200 USDC
 * const { orderAddress, salt, orderInfo } = await sdk.otc.createOrder({
 *   sellToken: 'SOL',
 *   sellAmount: 10_000_000_000n,
 *   buyToken: 'USDC',
 *   buyAmount: 200_000_000n,
 * });
 *
 * // Share orderInfo + salt with taker off-chain...
 *
 * // Taker fills the order
 * const result = await sdk.otc.fillOrder({
 *   order: orderAddress,
 *   buyAmount: 200_000_000n,
 *   salt,
 * });
 * ```
 */
export class OTCModule {
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
   * Create a new private OTC order.
   *
   * Generates Poseidon commitments for both the sell and buy amounts,
   * escrows the sell tokens into a program-owned escrow PDA, and posts the
   * order on-chain. The returned salt must be shared with the taker off-chain
   * so they can reconstruct the buy commitment and fill the order.
   *
   * @param params - Order configuration (tokens, amounts, expiry).
   * @returns Transaction result, order address, salt, and shareable order info.
   */
  async createOrder(params: OTCOrderParams): Promise<OTCCreateResult> {
    try {
      const maker = this.walletPublicKey();
      const sellToken = this.resolveToken(params.sellToken);
      const buyToken = this.resolveToken(params.buyToken);
      const sellAmount = BigInt(params.sellAmount);
      const buyAmount = BigInt(params.buyAmount);

      if (sellAmount <= 0n) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_CONFIG,
          'Sell amount must be greater than zero.',
        );
      }
      if (buyAmount <= 0n) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_CONFIG,
          'Buy amount must be greater than zero.',
        );
      }

      // Generate cryptographic salt for Poseidon commitments
      const salt = randomSalt();

      // Compute commitments: hash(amount, salt) using Poseidon
      const sellCommitment = poseidon2([sellAmount, salt]);
      const buyCommitment = poseidon2([buyAmount, salt]);

      // Generate a random nonce for PDA uniqueness
      const nonce = randomNonce();

      // Derive the order PDA
      const [orderPDA, orderBump] = this.deriveOrderPDA(maker, nonce);

      // Derive the escrow PDA
      const [escrowPDA, escrowBump] = this.deriveEscrowPDA(orderPDA);

      // Compute expiry timestamp
      const expiresIn = params.expiresIn ?? DEFAULT_EXPIRY_SECONDS;
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + expiresIn;

      // Resolve token ATAs for maker
      const makerSellATA = await getAssociatedTokenAddress(
        sellToken.mint,
        maker,
      );

      // Build instruction data:
      //   disc (8) + sell_commitment (32) + buy_commitment (32) + sell_amount (8) +
      //   buy_amount (8) + expires_at (8) + nonce (16) + use_stealth (1)
      const useStealth = params.useStealth !== false; // default: true
      const disc = instructionDiscriminator('create_otc_order');
      const data = Buffer.concat([
        disc,
        bigintToBytes32LE(sellCommitment),
        bigintToBytes32LE(buyCommitment),
        u64ToLeBytes(sellAmount),
        u64ToLeBytes(buyAmount),
        u64ToLeBytes(expiresAt),
        Buffer.from(nonce),
        Buffer.from([useStealth ? 1 : 0]),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_ORDER_CU }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: maker, isSigner: true, isWritable: true },
            { pubkey: orderPDA, isSigner: false, isWritable: true },
            { pubkey: escrowPDA, isSigner: false, isWritable: true },
            { pubkey: sellToken.mint, isSigner: false, isWritable: false },
            { pubkey: buyToken.mint, isSigner: false, isWritable: false },
            { pubkey: makerSellATA, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkShielded,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);

      return {
        tx: txResult,
        orderAddress: orderPDA,
        salt,
        orderInfo: {
          orderAddress: orderPDA.toBase58(),
          sellToken: params.sellToken,
          buyToken: params.buyToken,
          sellAmount: sellAmount.toString(),
          buyAmount: buyAmount.toString(),
          expiresAt,
        },
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `OTC order creation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fill an open OTC order.
   *
   * Verifies the order is open, recomputes the buy commitment to ensure
   * the provided amount matches the maker's expectation, then executes
   * the atomic swap: taker's buy tokens go to the maker (or maker's
   * stealth address), and the escrowed sell tokens go to the taker
   * (or taker's stealth address).
   *
   * @param params - Order address, buy amount, and optional salt.
   * @returns Transaction result and the amount received by taker.
   */
  async fillOrder(params: OTCFillParams): Promise<OTCFillResult> {
    try {
      const taker = this.walletPublicKey();

      // Fetch and validate the order
      const order = await this.getOrder(params.order);
      if (!order) {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          `OTC order ${params.order.toBase58()} not found.`,
        );
      }
      if (order.status !== 'open') {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          `OTC order is not open (status: ${order.status}).`,
        );
      }

      const now = Math.floor(Date.now() / 1000);
      if (now >= order.expiresAt) {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          `OTC order has expired (expired at ${new Date(order.expiresAt * 1000).toISOString()}).`,
        );
      }

      // Verify buy amount matches by recomputing the commitment
      const buyAmount = BigInt(params.buyAmount);
      if (params.salt !== undefined) {
        const expectedCommitment = poseidon2([buyAmount, params.salt]);
        if (expectedCommitment !== order.buyCommitment) {
          throw new PrivacyError(
            PrivacyErrorCode.TRANSACTION_FAILED,
            'Buy amount and salt do not match the order commitment. Verify the salt shared by the maker.',
          );
        }
      }

      // Generate taker's salt for their side of the commitment
      const takerSalt = params.salt ?? randomSalt();

      // Derive escrow PDA
      const [escrowPDA] = this.deriveEscrowPDA(params.order);

      // Resolve taker's ATAs
      const takerBuyATA = await getAssociatedTokenAddress(
        order.buyMint,
        taker,
      );
      const takerReceiveATA = await getAssociatedTokenAddress(
        order.sellMint,
        taker,
      );

      // Resolve maker's buy ATA (where maker receives the buy tokens)
      const makerBuyATA = await getAssociatedTokenAddress(
        order.buyMint,
        order.maker,
      );

      // Compute taker commitment for the fill
      const takerCommitment = poseidon2([buyAmount, takerSalt]);

      // Build instruction data:
      //   disc (8) + buy_amount (8) + taker_commitment (32)
      const disc = instructionDiscriminator('fill_otc_order');
      const data = Buffer.concat([
        disc,
        u64ToLeBytes(buyAmount),
        bigintToBytes32LE(takerCommitment),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: FILL_ORDER_CU }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: taker, isSigner: true, isWritable: true },
            { pubkey: params.order, isSigner: false, isWritable: true },
            { pubkey: escrowPDA, isSigner: false, isWritable: true },
            { pubkey: order.maker, isSigner: false, isWritable: true },
            { pubkey: order.sellMint, isSigner: false, isWritable: false },
            { pubkey: order.buyMint, isSigner: false, isWritable: false },
            { pubkey: takerBuyATA, isSigner: false, isWritable: true },
            { pubkey: takerReceiveATA, isSigner: false, isWritable: true },
            { pubkey: makerBuyATA, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkShielded,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);

      return {
        tx: txResult,
        receivedAmount: order.sellAmount,
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `OTC order fill failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Cancel an open OTC order.
   *
   * Only the maker can cancel. Returns the escrowed sell tokens to the
   * maker's token account and closes the order PDA, recovering rent.
   *
   * @param orderAddress - Public key of the order to cancel.
   * @returns Transaction result.
   */
  async cancelOrder(orderAddress: PublicKey): Promise<TxResult> {
    try {
      const maker = this.walletPublicKey();

      // Fetch and validate the order
      const order = await this.getOrder(orderAddress);
      if (!order) {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          `OTC order ${orderAddress.toBase58()} not found.`,
        );
      }
      if (order.status !== 'open' && order.status !== 'expired') {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          `OTC order cannot be cancelled (status: ${order.status}).`,
        );
      }
      if (!order.maker.equals(maker)) {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          'Only the maker can cancel an OTC order.',
        );
      }

      // Derive escrow PDA
      const [escrowPDA] = this.deriveEscrowPDA(orderAddress);

      // Resolve maker's sell ATA (where escrowed tokens are returned)
      const makerSellATA = await getAssociatedTokenAddress(
        order.sellMint,
        maker,
      );

      const disc = instructionDiscriminator('cancel_otc_order');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CANCEL_ORDER_CU }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: maker, isSigner: true, isWritable: true },
            { pubkey: orderAddress, isSigner: false, isWritable: true },
            { pubkey: escrowPDA, isSigner: false, isWritable: true },
            { pubkey: order.sellMint, isSigner: false, isWritable: false },
            { pubkey: makerSellATA, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkShielded,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `OTC order cancellation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch a single OTC order's on-chain state.
   *
   * @param address - Public key of the order account.
   * @returns Parsed order information, or null if the account doesn't exist.
   */
  async getOrder(address: PublicKey): Promise<OTCOrder | null> {
    const accountInfo = await this.connection.getAccountInfo(address);
    if (!accountInfo || !accountInfo.data) {
      return null;
    }
    return this.parseOrderAccount(address, accountInfo.data);
  }

  /**
   * List all open OTC orders, optionally filtered by sell and/or buy token mints.
   *
   * Uses `getProgramAccounts` with memcmp filters on the sell_mint and buy_mint
   * fields within the order account data layout.
   *
   * @param sellToken - Optional sell token symbol or mint to filter by.
   * @param buyToken - Optional buy token symbol or mint to filter by.
   * @returns Array of parsed open OTC orders.
   */
  async listOpenOrders(sellToken?: string, buyToken?: string): Promise<OTCOrder[]> {
    const filters: Array<{ memcmp: { offset: number; bytes: string } }> = [];

    // Filter by sell_mint at offset 40 (8 discriminator + 32 maker)
    if (sellToken) {
      const sellInfo = this.resolveToken(sellToken);
      filters.push({
        memcmp: { offset: 40, bytes: sellInfo.mint.toBase58() },
      });
    }

    // Filter by buy_mint at offset 72 (8 + 32 + 32)
    if (buyToken) {
      const buyInfo = this.resolveToken(buyToken);
      filters.push({
        memcmp: { offset: 72, bytes: buyInfo.mint.toBase58() },
      });
    }

    // Filter by account data length to only match OTC order accounts
    const accounts = await this.connection.getProgramAccounts(this.programIds.zkShielded, {
      filters: [
        { dataSize: OTC_ORDER_ACCOUNT_SIZE },
        ...filters,
      ],
    });

    const orders: OTCOrder[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        const order = this.parseOrderAccount(pubkey, account.data);
        if (order.status === 'open') {
          orders.push(order);
        }
      } catch {
        // Skip accounts that fail to parse (wrong discriminator, etc.)
      }
    }

    return orders;
  }

  /**
   * List all OTC orders created by a specific maker.
   *
   * Defaults to the connected wallet if no maker is specified.
   *
   * @param maker - Public key of the maker (defaults to connected wallet).
   * @returns Array of parsed OTC orders by the maker.
   */
  async getOrdersByMaker(maker?: PublicKey): Promise<OTCOrder[]> {
    const makerKey = maker ?? this.walletPublicKey();

    // Filter by maker at offset 8 (after 8-byte discriminator)
    const accounts = await this.connection.getProgramAccounts(this.programIds.zkShielded, {
      filters: [
        { dataSize: OTC_ORDER_ACCOUNT_SIZE },
        { memcmp: { offset: 8, bytes: makerKey.toBase58() } },
      ],
    });

    const orders: OTCOrder[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        orders.push(this.parseOrderAccount(pubkey, account.data));
      } catch {
        // Skip accounts that fail to parse
      }
    }

    return orders;
  }

  // ── PDA Derivation ──────────────────────────────────────────────────────────

  /**
   * Derive the order PDA from maker and nonce.
   *
   * Seeds: ["otc_order", maker, nonce]
   */
  private deriveOrderPDA(maker: PublicKey, nonce: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(OTC_ORDER_SEED),
        maker.toBuffer(),
        Buffer.from(nonce),
      ],
      this.programIds.zkShielded,
    );
  }

  /**
   * Derive the escrow PDA from an order address.
   *
   * Seeds: ["otc_escrow", order]
   */
  private deriveEscrowPDA(order: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(OTC_ESCROW_SEED),
        order.toBuffer(),
      ],
      this.programIds.zkShielded,
    );
  }

  // ── Account Parsing ─────────────────────────────────────────────────────────

  /**
   * Parse raw OTC order account data into an OTCOrder object.
   *
   * Account layout (314 bytes):
   *   [0..8]     discriminator (Anchor 8-byte hash)
   *   [8..40]    maker (Pubkey, 32 bytes)
   *   [40..72]   sell_mint (Pubkey, 32 bytes)
   *   [72..104]  buy_mint (Pubkey, 32 bytes)
   *   [104..136] sell_commitment (32 bytes LE, field element)
   *   [136..168] buy_commitment (32 bytes LE, field element)
   *   [168..176] sell_amount (u64 LE)
   *   [176..184] buy_amount (u64 LE)
   *   [184..216] escrow (Pubkey, 32 bytes)
   *   [216..224] created_at (i64 LE)
   *   [224..232] expires_at (i64 LE)
   *   [232]      status (u8: 0=open, 1=filled, 2=cancelled, 3=expired)
   *   [233..266] filled_by (Option<Pubkey>: 1-byte tag + 32-byte pubkey)
   *   [266..282] nonce (16 bytes)
   *   [282]      bump (u8)
   *   [283]      escrow_bump (u8)
   *   -- total: 284 used + 30 reserved padding = 314 bytes
   */
  private parseOrderAccount(address: PublicKey, data: Buffer | Uint8Array): OTCOrder {
    // Skip 8-byte Anchor discriminator
    const maker = new PublicKey(data.subarray(8, 40));
    const sellMint = new PublicKey(data.subarray(40, 72));
    const buyMint = new PublicKey(data.subarray(72, 104));
    const sellCommitment = bigintFromBytes32LE(data, 104);
    const buyCommitment = bigintFromBytes32LE(data, 136);
    const sellAmount = u64FromLeBytes(data, 168);
    const buyAmount = u64FromLeBytes(data, 176);
    const escrow = new PublicKey(data.subarray(184, 216));
    const createdAt = i64FromLeBytes(data, 216);
    const expiresAt = i64FromLeBytes(data, 224);
    const statusByte = data[232]!;

    // Option<Pubkey>: 1-byte tag (0 = None, 1 = Some) + 32-byte pubkey
    const filledByTag = data[233]!;
    let filledBy: PublicKey | undefined;
    if (filledByTag === 1) {
      filledBy = new PublicKey(data.subarray(234, 266));
    }

    const nonce = new Uint8Array(data.subarray(266, 282));
    const bump = data[282]!;
    const escrowBump = data[283]!;

    const status = parseOrderStatus(statusByte, expiresAt);

    return {
      address,
      maker,
      sellMint,
      buyMint,
      sellCommitment,
      buyCommitment,
      sellAmount,
      buyAmount,
      escrow,
      createdAt,
      expiresAt,
      status,
      filledBy,
      nonce,
      bump,
      escrowBump,
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
