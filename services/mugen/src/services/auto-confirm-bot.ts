/**
 * Mugen Auto-Confirm Bot — Market Maker
 *
 * Acts as an automated seller (liquidity provider):
 * 1. Monitors token balance and creates sell orders automatically
 * 2. Monitors escrows where bot is the maker (seller)
 * 3. Polls Revolut API for matching fiat payments
 * 4. Auto-releases escrow when payment is confirmed
 *
 * The bot bridges off-chain fiat detection → on-chain escrow release.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { CONFIG } from '../config.js';
import { RevolutClient, type PaymentMatch } from './revolut-client.js';
import type { OrderIndexer, IndexedEscrow } from './order-indexer.js';
import type { PriceFeed } from './price-feed.js';
import { randomBytes, createHash } from 'crypto';

// ─── On-chain constants (must match programs/p01_mugen/src/state) ──────────

const CONFIG_SEED = Buffer.from('mugen_config');
const ORDER_SEED = Buffer.from('mugen_order');
const ESCROW_SEED = Buffer.from('mugen_escrow');
const VAULT_SEED = Buffer.from('mugen_vault');
const REPUTATION_SEED = Buffer.from('mugen_rep');

// Native SOL mint (wrapped SOL)
const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Anchor instruction discriminators: SHA256("global:<instruction_name>")[0..8]
const IX_CREATE_ORDER = Buffer.from([141, 54, 37, 207, 237, 210, 250, 215]);
const IX_RELEASE_ESCROW = Buffer.from([146, 253, 129, 233, 20, 145, 181, 206]);

// Order type
const ORDER_TYPE_SELL_CRYPTO = 1;

// ─── Types ──────────────────────────────────────────────────────────────────

interface BotConfig {
  wallet: Keypair;
  revolut: RevolutClient;
  indexer: OrderIndexer;
  priceFeed: PriceFeed;
  pollIntervalMs?: number;
}

interface PendingEscrow {
  escrow: IndexedEscrow;
  reference: string;
  expectedAmount: number;
  expectedCurrency: string;
}

// ─── Bot ────────────────────────────────────────────────────────────────────

export class AutoConfirmBot {
  private connection: Connection;
  private wallet: Keypair;
  private revolut: RevolutClient;
  private indexer: OrderIndexer;
  private priceFeed: PriceFeed;
  private pollIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private processing: Set<string> = new Set();
  private tokenMint: PublicKey;

  // Stable reputation commitment for the bot (derived from wallet + fixed salt)
  private reputationCommitment: Uint8Array;
  private reputationSalt: Uint8Array;

  constructor(config: BotConfig) {
    this.connection = new Connection(CONFIG.rpcUrl, 'confirmed');
    this.wallet = config.wallet;
    this.revolut = config.revolut;
    this.indexer = config.indexer;
    this.priceFeed = config.priceFeed;
    this.pollIntervalMs = config.pollIntervalMs ?? 15_000;
    this.tokenMint = new PublicKey(CONFIG.botTokenMint);

    // Derive a stable reputation commitment: SHA256(wallet_pubkey + "mugen_bot_rep")
    // This stays the same across restarts so reputation accumulates
    this.reputationSalt = Buffer.from(
      createHash('sha256')
        .update(this.wallet.publicKey.toBytes())
        .update('mugen_bot_rep_salt')
        .digest(),
    );
    this.reputationCommitment = Buffer.from(
      createHash('sha256')
        .update(this.wallet.publicKey.toBytes())
        .update(this.reputationSalt)
        .digest(),
    );
  }

  async start(): Promise<void> {
    const walletPub = this.wallet.publicKey.toBase58();
    console.log(`[bot] Auto-confirm bot started`);
    console.log(`[bot] Wallet: ${walletPub}`);
    console.log(`[bot] Token: ${this.tokenMint.toBase58()}`);
    console.log(`[bot] Spread: ${CONFIG.botSpreadBps} bps`);
    console.log(`[bot] Order size: ${CONFIG.botOrderSize} base units`);
    console.log(`[bot] Max orders/currency: ${CONFIG.botMaxOrders}`);
    console.log(`[bot] Currencies: ${CONFIG.botFiatCurrencies.join(', ')}`);
    console.log(`[bot] Poll interval: ${this.pollIntervalMs}ms`);

    await this.tick();
    this.intervalId = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[bot] Auto-confirm bot stopped');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  private async tick(): Promise<void> {
    try {
      // Phase 1: Ensure we have enough open sell orders
      await this.ensureOrders();

      // Phase 2: Check for fiat payments and auto-release escrows
      await this.checkAndRelease();
    } catch (err) {
      console.error('[bot] Tick error:', (err as Error).message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: AUTO-CREATE SELL ORDERS
  // ═══════════════════════════════════════════════════════════════════════════

  private async ensureOrders(): Promise<void> {
    const availableBalance = await this.getAvailableBalance();
    if (availableBalance <= 0n) {
      return; // No liquidity, skip
    }

    for (const currency of CONFIG.botFiatCurrencies) {
      const openCount = this.countOpenOrders(currency);
      const needed = CONFIG.botMaxOrders - openCount;
      if (needed <= 0) continue;

      // Check if we have enough balance for new orders
      const orderSize = CONFIG.botOrderSize;
      const balanceForOrders = availableBalance - CONFIG.botReserveLamports;
      if (balanceForOrders < orderSize) {
        console.log(`[bot] Insufficient balance for new ${currency} order (have ${balanceForOrders}, need ${orderSize})`);
        continue;
      }

      // Get current price
      const fiatAmount = this.computeFiatAmount(orderSize, currency);
      if (fiatAmount === null) {
        console.warn(`[bot] No price data for ${currency}, skipping order creation`);
        continue;
      }

      // Create orders (one at a time to avoid balance issues)
      try {
        const sig = await this.createSellOrder(orderSize, fiatAmount, currency);
        console.log(`[bot] ✓ Created sell order: ${orderSize} for ${fiatAmount} ${currency} cents — tx: ${sig}`);
      } catch (err) {
        console.error(`[bot] ✗ Failed to create ${currency} order:`, (err as Error).message);
      }
    }
  }

  /**
   * Get available token balance for new orders.
   * For native SOL: balance minus rent reserve.
   * For SPL tokens: token account balance.
   */
  private async getAvailableBalance(): Promise<bigint> {
    const isNativeSol = this.tokenMint.equals(NATIVE_SOL_MINT);

    if (isNativeSol) {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return BigInt(balance);
    }

    // SPL token
    try {
      const ata = getAssociatedTokenAddressSync(this.tokenMint, this.wallet.publicKey);
      const account = await getAccount(this.connection, ata);
      return account.amount;
    } catch {
      return 0n; // Token account doesn't exist
    }
  }

  /**
   * Count bot's currently open (unfilled) orders for a given currency.
   */
  private countOpenOrders(currency: string): number {
    const botWallet = this.wallet.publicKey.toBase58();
    return this.indexer
      .getOrders({ status: 'open' })
      .filter((o) => o.maker === botWallet && o.fiatCurrency === currency)
      .length;
  }

  /**
   * Compute fiat amount in cents from crypto amount, using live price + spread.
   */
  private computeFiatAmount(cryptoAmount: bigint, currency: string): number | null {
    // Determine which token symbol to price
    const tokenSymbol = this.tokenMint.equals(NATIVE_SOL_MINT) ? 'SOL' : 'USDC';
    const priceData = this.priceFeed.getPrice(tokenSymbol);
    if (!priceData) return null;

    // Get the price in the target currency
    const currencyKey = currency.toLowerCase() as 'usd' | 'eur' | 'gbp';
    const pricePerUnit = priceData[currencyKey];
    if (!pricePerUnit || pricePerUnit <= 0) return null;

    // Convert crypto base units to whole units
    const decimals = this.tokenMint.equals(NATIVE_SOL_MINT) ? 9 : 6;
    const wholeUnits = Number(cryptoAmount) / 10 ** decimals;

    // Apply spread: price * (1 + spread_bps / 10000)
    const priceWithSpread = pricePerUnit * (1 + CONFIG.botSpreadBps / 10_000);

    // Fiat amount in cents
    const fiatCents = Math.round(wholeUnits * priceWithSpread * 100);
    return fiatCents;
  }

  /**
   * Build and send a create_order transaction on-chain.
   */
  private async createSellOrder(
    cryptoAmount: bigint,
    fiatAmountCents: number,
    fiatCurrency: string,
  ): Promise<string> {
    const maker = this.wallet.publicKey;

    // Derive config PDA
    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], CONFIG.programId);

    // Generate random 16-byte nonce for order PDA
    const nonce = randomBytes(16);

    // Derive order PDA
    const [orderPda] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, maker.toBytes(), nonce],
      CONFIG.programId,
    );

    // On devnet, use authority (config.authority) as compliance attestation (bypass)
    // Read config to get authority
    const configAccount = await this.connection.getAccountInfo(configPda);
    if (!configAccount) throw new Error('Config PDA not found');
    const authority = new PublicKey(configAccount.data.subarray(8, 40));

    // Encode fiat currency as [u8; 3]
    const currencyBytes = Buffer.alloc(3);
    currencyBytes.write(fiatCurrency.toUpperCase().slice(0, 3), 'ascii');

    // Serialize CreateOrderParams
    // Layout: order_type(1) + crypto_amount(8) + fiat_amount(8) + fiat_currency(3) +
    //         payment_methods(2) + min_amount(8) + max_amount(8) +
    //         reputation_commitment(32) + nonce(16) + expires_in(8)
    const params = Buffer.alloc(94);
    let offset = 0;

    // order_type: sell_crypto = 1
    params.writeUInt8(ORDER_TYPE_SELL_CRYPTO, offset);
    offset += 1;

    // crypto_amount
    params.writeBigUInt64LE(cryptoAmount, offset);
    offset += 8;

    // fiat_amount (in cents)
    params.writeBigUInt64LE(BigInt(fiatAmountCents), offset);
    offset += 8;

    // fiat_currency
    currencyBytes.copy(params, offset);
    offset += 3;

    // payment_methods
    params.writeUInt16LE(CONFIG.botPaymentMethods, offset);
    offset += 2;

    // min_amount (0 = no partial fills)
    params.writeBigUInt64LE(0n, offset);
    offset += 8;

    // max_amount (0 = full amount)
    params.writeBigUInt64LE(0n, offset);
    offset += 8;

    // reputation_commitment
    Buffer.from(this.reputationCommitment).copy(params, offset);
    offset += 32;

    // nonce
    nonce.copy(params, offset);
    offset += 16;

    // expires_in (seconds)
    params.writeBigInt64LE(BigInt(CONFIG.botOrderTtl), offset);

    // Full instruction data: discriminator + params
    const data = Buffer.concat([IX_CREATE_ORDER, params]);

    const keys = [
      { pubkey: maker, isSigner: true, isWritable: true },            // maker
      { pubkey: configPda, isSigner: false, isWritable: false },       // config
      { pubkey: orderPda, isSigner: false, isWritable: true },         // order (init)
      { pubkey: authority, isSigner: false, isWritable: false },       // compliance_attestation (devnet bypass)
      { pubkey: this.tokenMint, isSigner: false, isWritable: false },  // token_mint
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    const ix = new TransactionInstruction({
      programId: CONFIG.programId,
      keys,
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(ix);

    return sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
      commitment: 'confirmed',
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: AUTO-RELEASE ESCROWS (fiat payment detection)
  // ═══════════════════════════════════════════════════════════════════════════

  private async checkAndRelease(): Promise<void> {
    const pendingEscrows = this.findPendingEscrows();
    if (pendingEscrows.length === 0) return;

    console.log(`[bot] Found ${pendingEscrows.length} escrow(s) awaiting fiat confirmation`);

    const payments = await this.revolut.fetchMatchingPayments();
    if (payments.length === 0) {
      console.log('[bot] No new matching Revolut payments found');
      return;
    }

    console.log(`[bot] Found ${payments.length} Revolut payment(s) with MG- reference`);

    for (const pending of pendingEscrows) {
      if (this.processing.has(pending.escrow.address)) continue;

      const match = this.matchPayment(pending, payments);
      if (!match) continue;

      this.processing.add(pending.escrow.address);
      try {
        const sig = await this.releaseEscrow(pending);
        this.revolut.markProcessed(match.transactionId);
        console.log(
          `[bot] ✓ Released escrow ${pending.escrow.address} — ` +
            `Revolut tx ${match.transactionId} (${match.amount / 100} ${match.currency}) — sig: ${sig}`,
        );
      } catch (err) {
        console.error(`[bot] ✗ Failed to release ${pending.escrow.address}:`, (err as Error).message);
      } finally {
        this.processing.delete(pending.escrow.address);
      }
    }
  }

  private findPendingEscrows(): PendingEscrow[] {
    const botWallet = this.wallet.publicKey.toBase58();
    const allOrders = this.indexer.getOrders();
    const pending: PendingEscrow[] = [];

    for (const order of allOrders) {
      if (order.maker !== botWallet) continue;
      if (order.status !== 'in_escrow') continue;

      const escrows = this.indexer.getEscrowsForOrder(order.address);
      for (const escrow of escrows) {
        if (escrow.status !== 'payment_confirmed') continue;

        pending.push({
          escrow,
          reference: RevolutClient.escrowToReference(escrow.address),
          expectedAmount: parseInt(order.fiatAmount, 10),
          expectedCurrency: order.fiatCurrency,
        });
      }
    }

    return pending;
  }

  private matchPayment(pending: PendingEscrow, payments: PaymentMatch[]): PaymentMatch | null {
    for (const payment of payments) {
      if (payment.reference !== pending.reference) continue;
      if (payment.currency !== pending.expectedCurrency) continue;

      // Allow 1% tolerance for FX fees
      const tolerance = Math.max(pending.expectedAmount * 0.01, 50);
      if (Math.abs(payment.amount - pending.expectedAmount) > tolerance) {
        console.warn(
          `[bot] Amount mismatch for ${pending.reference}: ` +
            `expected ${pending.expectedAmount} got ${payment.amount} ${payment.currency}`,
        );
        continue;
      }

      return payment;
    }

    return null;
  }

  private async releaseEscrow(pending: PendingEscrow): Promise<string> {
    const escrowPubkey = new PublicKey(pending.escrow.address);
    const orderPubkey = new PublicKey(pending.escrow.order);
    const takerPubkey = new PublicKey(pending.escrow.taker);
    const tokenMint = new PublicKey(pending.escrow.tokenMint);

    // Derive PDAs
    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], CONFIG.programId);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, escrowPubkey.toBytes()],
      CONFIG.programId,
    );

    // Read config for fee wallets
    const configAccount = await this.connection.getAccountInfo(configPda);
    if (!configAccount) throw new Error('Config account not found');
    const configData = configAccount.data;

    let cfgOffset = 8 + 32 + 2; // skip discriminator + authority + fee_bps
    const p01FeeWallet = new PublicKey(configData.subarray(cfgOffset, cfgOffset + 32));
    cfgOffset += 32;
    const mugenFeeWallet = new PublicKey(configData.subarray(cfgOffset, cfgOffset + 32));
    cfgOffset += 32;
    const treasuryWallet = new PublicKey(configData.subarray(cfgOffset, cfgOffset + 32));
    cfgOffset += 32;
    cfgOffset += 2; // skip p01_fee_share
    cfgOffset += 2; // skip mugen_fee_share
    const noiseFundWallet = new PublicKey(configData.subarray(cfgOffset, cfgOffset + 32));

    // Derive fee ATAs
    const buyerTokenAccount = getAssociatedTokenAddressSync(tokenMint, takerPubkey);
    const p01FeeAccount = getAssociatedTokenAddressSync(tokenMint, p01FeeWallet);
    const mugenFeeAccount = getAssociatedTokenAddressSync(tokenMint, mugenFeeWallet);
    const treasuryFeeAccount = getAssociatedTokenAddressSync(tokenMint, treasuryWallet);
    const noiseFundAccount = getAssociatedTokenAddressSync(tokenMint, noiseFundWallet);

    // Parse maker reputation commitment from order
    const orderAccount = await this.connection.getAccountInfo(orderPubkey);
    if (!orderAccount) throw new Error('Order account not found');
    // offset: 8(disc) + 32(maker) + 1(type) + 32(mint) + 8(crypto) + 8(fiat) + 3(currency) + 2(methods) + 8(min) + 8(max) + 32(attestation) = 142
    const makerRepCommitment = orderAccount.data.subarray(142, 174);
    const [makerRepPda] = PublicKey.findProgramAddressSync(
      [REPUTATION_SEED, makerRepCommitment],
      CONFIG.programId,
    );

    // Find taker reputation PDA
    const takerRepPda = await this.findTakerReputation();

    const keys = [
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: escrowPubkey, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: p01FeeAccount, isSigner: false, isWritable: true },
      { pubkey: mugenFeeAccount, isSigner: false, isWritable: true },
      { pubkey: treasuryFeeAccount, isSigner: false, isWritable: true },
      { pubkey: noiseFundAccount, isSigner: false, isWritable: true },
      { pubkey: makerRepPda, isSigner: false, isWritable: true },
      { pubkey: takerRepPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({
      programId: CONFIG.programId,
      keys,
      data: IX_RELEASE_ESCROW,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ix);

    return sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
      commitment: 'confirmed',
    });
  }

  private async findTakerReputation(): Promise<PublicKey> {
    const repAccounts = await this.connection.getProgramAccounts(CONFIG.programId, {
      filters: [{ dataSize: 85 }],
    });

    for (const { pubkey, account } of repAccounts) {
      const commitment = account.data.subarray(8, 40);
      const [expectedPda] = PublicKey.findProgramAddressSync(
        [REPUTATION_SEED, commitment],
        CONFIG.programId,
      );
      if (expectedPda.equals(pubkey)) {
        return pubkey;
      }
    }

    throw new Error('No reputation PDA found for taker');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function loadBotWallet(keyOrPath: string): Keypair {
  try {
    const parsed = JSON.parse(keyOrPath);
    if (Array.isArray(parsed)) {
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
  } catch {
    // Not JSON
  }

  const bs58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (keyOrPath.split('').every((c) => bs58Chars.includes(c)) && keyOrPath.length > 40) {
    return Keypair.fromSecretKey(base58Decode(keyOrPath));
  }

  // File path
  const fs = require('fs');
  const content = fs.readFileSync(keyOrPath, 'utf-8');
  return loadBotWallet(content.trim());
}

function base58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [0];
  for (const char of str) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 char: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}
