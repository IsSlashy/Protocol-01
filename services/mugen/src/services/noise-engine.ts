/**
 * Mugen Noise Engine — Privacy through indistinguishable denominated trades.
 *
 * Creates a pool of N ephemeral wallets derived from a master seed, then
 * continuously executes self-trades between them using denominated amounts.
 * On-chain, these trades are identical to real user trades:
 *   - Same instructions (create_order → take_order → confirm_payment → release_escrow)
 *   - Same fee split, same reputation updates
 *   - Each wallet has a unique Poseidon reputation commitment
 *   - Randomized timing (Poisson process), currencies, payment methods
 *
 * An observer sees e.g. 100 trades/day at $100 tier. They cannot determine
 * which are noise vs real — especially since the bot is off-chain and its
 * wallet pool is encrypted on the backend.
 *
 * Self-funded: a share of every real trade's protocol fee goes to the
 * noise_fund_wallet on-chain. The engine periodically drains that wallet
 * and distributes SOL across its ephemeral pool. Zero manual funding.
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
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { createHash, randomBytes } from 'crypto';
import { CONFIG } from '../config.js';
import {
  pickRandomSolTier,
  pickRandomCurrency,
  pickRandomPaymentMethods,
  lamportsToFiatCents,
} from './denominations.js';
import type { PriceFeed } from './price-feed.js';

// ─── On-chain seeds (must match programs/p01_mugen/src/state) ───────────────

const CONFIG_SEED = Buffer.from('mugen_config');
const ORDER_SEED = Buffer.from('mugen_order');
const ESCROW_SEED = Buffer.from('mugen_escrow');
const VAULT_SEED = Buffer.from('mugen_vault');
const REPUTATION_SEED = Buffer.from('mugen_rep');

const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ─── Anchor discriminators ──────────────────────────────────────────────────

function anchorDisc(name: string): Buffer {
  const hash = createHash('sha256').update(`global:${name}`).digest();
  return Buffer.from(hash.subarray(0, 8));
}

const IX_CREATE_ORDER = anchorDisc('create_order');
const IX_TAKE_ORDER = anchorDisc('take_order');
const IX_CONFIRM_PAYMENT = anchorDisc('confirm_payment');
const IX_RELEASE_ESCROW = anchorDisc('release_escrow');
const IX_INIT_REPUTATION = anchorDisc('init_reputation');

const ORDER_TYPE_SELL_CRYPTO = 1;

// ─── Types ──────────────────────────────────────────────────────────────────

interface NoiseWallet {
  keypair: Keypair;
  repCommitment: Buffer;
  repInitialized: boolean;
}

export interface NoiseEngineConfig {
  masterSeed: Buffer;
  priceFeed: PriceFeed;
  walletCount?: number;
  meanIntervalMs?: number;
  minStepDelayMs?: number;
  maxStepDelayMs?: number;
  /** Interval between auto-fund checks in ms (default: 60000). */
  fundCheckIntervalMs?: number;
  /** Min SOL per ephemeral wallet before it gets topped up (default: 0.12 SOL). */
  minWalletBalanceLamports?: bigint;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class NoiseEngine {
  private connection: Connection;
  private wallets: NoiseWallet[];
  private priceFeed: PriceFeed;
  private meanIntervalMs: number;
  private minStepDelayMs: number;
  private maxStepDelayMs: number;
  private running = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private fundIntervalId: ReturnType<typeof setInterval> | null = null;
  private tokenMint: PublicKey;
  private tradesExecuted = 0;
  private tradesFailed = 0;
  /** The noise fund wallet — derived from master seed, same key set in config on-chain. */
  private fundWallet: Keypair;
  private fundCheckIntervalMs: number;
  private minWalletBalance: bigint;

  constructor(config: NoiseEngineConfig) {
    this.connection = new Connection(CONFIG.rpcUrl, 'confirmed');
    this.priceFeed = config.priceFeed;
    this.meanIntervalMs = config.meanIntervalMs ?? 120_000;
    this.minStepDelayMs = config.minStepDelayMs ?? 5_000;
    this.maxStepDelayMs = config.maxStepDelayMs ?? 45_000;
    this.tokenMint = new PublicKey(CONFIG.botTokenMint);
    this.fundCheckIntervalMs = config.fundCheckIntervalMs ?? 60_000;
    this.minWalletBalance = config.minWalletBalanceLamports ?? 120_000_000n; // 0.12 SOL

    // Derive the noise fund wallet (index -1, separate from ephemeral pool).
    // This is the wallet that receives fees on-chain via release_escrow.
    // Set this pubkey as noise_fund_wallet in MugenConfig.
    const fundSeed = createHash('sha256')
      .update(config.masterSeed)
      .update('mugen_noise_fund_master')
      .digest();
    this.fundWallet = Keypair.fromSeed(fundSeed);

    const count = config.walletCount ?? 6;
    this.wallets = [];
    for (let i = 0; i < count; i++) {
      const seed = createHash('sha256')
        .update(config.masterSeed)
        .update(`mugen_noise_wallet_${i}`)
        .digest();
      const keypair = Keypair.fromSeed(seed);

      const repSalt = createHash('sha256')
        .update(keypair.publicKey.toBytes())
        .update('mugen_noise_rep_salt')
        .digest();
      const repCommitment = createHash('sha256')
        .update(keypair.publicKey.toBytes())
        .update(repSalt)
        .digest();

      this.wallets.push({
        keypair,
        repCommitment: Buffer.from(repCommitment),
        repInitialized: false,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═���═════════════════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    const fundBal = await this.connection.getBalance(this.fundWallet.publicKey).catch(() => 0);
    console.log(`[noise] Engine started — ${this.wallets.length} wallets, mean interval ${this.meanIntervalMs}ms`);
    console.log(`[noise] Fund wallet: ${this.fundWallet.publicKey.toBase58()} (${(fundBal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
    console.log(`[noise] ↑ Set this as noise_fund_wallet in MugenConfig on-chain`);
    for (const w of this.wallets) {
      const bal = await this.connection.getBalance(w.keypair.publicKey).catch(() => 0);
      console.log(`[noise]   ${w.keypair.publicKey.toBase58().slice(0, 16)}... ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }

    this.running = true;

    // Auto-fund: periodically distribute from noise fund wallet to pool
    await this.autoFund();
    this.fundIntervalId = setInterval(() => this.autoFund(), this.fundCheckIntervalMs);

    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.fundIntervalId) {
      clearInterval(this.fundIntervalId);
      this.fundIntervalId = null;
    }
    console.log(`[noise] Engine stopped — ${this.tradesExecuted} trades OK, ${this.tradesFailed} failed`);
  }

  getStats() {
    return {
      wallets: this.wallets.length,
      fundWallet: this.fundWallet.publicKey.toBase58(),
      tradesExecuted: this.tradesExecuted,
      tradesFailed: this.tradesFailed,
      running: this.running,
    };
  }

  /** Public key of the noise fund wallet — use as noise_fund_wallet in MugenConfig. */
  getFundWalletPubkey(): PublicKey {
    return this.fundWallet.publicKey;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-FUND — Drain on-chain fee revenue into ephemeral wallet pool
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check noise fund wallet balance and distribute to any ephemeral wallet
   * that has fallen below the minimum threshold.
   *
   * Flow: real trades → release_escrow → noise_fee → fund wallet (on-chain)
   *       fund wallet → SOL transfers → ephemeral wallets (this method)
   */
  private async autoFund(): Promise<void> {
    try {
      // First, unwrap any wSOL the fund wallet received from fees
      const fundAta = getAssociatedTokenAddressSync(NATIVE_SOL_MINT, this.fundWallet.publicKey);
      try {
        const ataInfo = await this.connection.getAccountInfo(fundAta);
        if (ataInfo && ataInfo.data.length >= 72) {
          const wsolBalance = ataInfo.data.readBigUInt64LE(64);
          if (wsolBalance > 0n) {
            const closeTx = new Transaction().add(
              createCloseAccountInstruction(fundAta, this.fundWallet.publicKey, this.fundWallet.publicKey),
            );
            await sendAndConfirmTransaction(this.connection, closeTx, [this.fundWallet], { commitment: 'confirmed' });
            console.log(`[noise] Unwrapped ${Number(wsolBalance) / LAMPORTS_PER_SOL} wSOL from fund wallet`);
          }
        }
      } catch { /* no wSOL ATA, that's fine */ }

      // Check fund wallet native SOL balance
      const fundBalance = BigInt(await this.connection.getBalance(this.fundWallet.publicKey));
      const reserveForRent = 10_000_000n; // 0.01 SOL reserve for the fund wallet itself

      if (fundBalance <= reserveForRent) {
        return; // Nothing to distribute
      }

      const distributable = fundBalance - reserveForRent;

      // Find wallets that need topping up
      const needsFunding: { wallet: NoiseWallet; deficit: bigint }[] = [];
      for (const w of this.wallets) {
        const bal = BigInt(await this.connection.getBalance(w.keypair.publicKey));
        if (bal < this.minWalletBalance) {
          needsFunding.push({ wallet: w, deficit: this.minWalletBalance - bal });
        }
      }

      if (needsFunding.length === 0) return;

      // Distribute evenly, capped by what we have
      const totalNeeded = needsFunding.reduce((sum, n) => sum + n.deficit, 0n);
      const ratio = distributable >= totalNeeded ? 1n : distributable * 1000n / totalNeeded;

      const tx = new Transaction();
      let totalSent = 0n;

      for (const { wallet, deficit } of needsFunding) {
        const amount = ratio === 1n ? deficit : (deficit * ratio) / 1000n;
        if (amount < 5_000n) continue; // skip dust

        tx.add(
          SystemProgram.transfer({
            fromPubkey: this.fundWallet.publicKey,
            toPubkey: wallet.keypair.publicKey,
            lamports: amount,
          }),
        );
        totalSent += amount;
      }

      if (totalSent === 0n) return;

      await sendAndConfirmTransaction(this.connection, tx, [this.fundWallet], { commitment: 'confirmed' });
      console.log(
        `[noise] Auto-funded ${needsFunding.length} wallets — ` +
        `${(Number(totalSent) / LAMPORTS_PER_SOL).toFixed(6)} SOL distributed ` +
        `(${(Number(fundBalance) / LAMPORTS_PER_SOL).toFixed(6)} SOL in fund)`
      );
    } catch (err) {
      console.error('[noise] Auto-fund error:', (err as Error).message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULING — Poisson process for natural-looking timing
  // ═══════════════════════════════════════════════════════════════════════════

  private scheduleNext(): void {
    if (!this.running) return;

    // Exponential distribution: P(delay > t) = e^(-t/mean)
    const delay = Math.round(-Math.log(Math.random()) * this.meanIntervalMs);
    // Clamp to [10s, 10× mean] to avoid extreme outliers
    const clamped = Math.max(10_000, Math.min(delay, this.meanIntervalMs * 10));

    this.timeoutId = setTimeout(() => this.tick(), clamped);
  }

  private async tick(): Promise<void> {
    try {
      await this.executeNoiseTrade();
      this.tradesExecuted++;
    } catch (err) {
      this.tradesFailed++;
      console.error('[noise] Trade failed:', (err as Error).message);
    }
    this.scheduleNext();
  }

  /** Random delay between trade steps (simulates human behavior) */
  private stepDelay(): Promise<void> {
    const ms = this.minStepDelayMs + Math.random() * (this.maxStepDelayMs - this.minStepDelayMs);
    return new Promise((resolve) => setTimeout(resolve, Math.round(ms)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NOISE TRADE — Full on-chain lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  private async executeNoiseTrade(): Promise<void> {
    // 1. Pick two different wallets: seller and buyer
    const [seller, buyer] = this.pickWalletPair();
    const sellerPub = seller.keypair.publicKey;
    const buyerPub = buyer.keypair.publicKey;

    // 2. Pick denomination
    const solAmount = pickRandomSolTier();
    const currency = pickRandomCurrency();
    const paymentMethods = pickRandomPaymentMethods();

    // Get price for fiat conversion
    const priceData = this.priceFeed.getPrice('SOL');
    const currencyKey = currency.toLowerCase() as 'usd' | 'eur' | 'gbp';
    const pricePerSol = priceData?.[currencyKey] ?? 150;
    const fiatCents = lamportsToFiatCents(solAmount, pricePerSol, CONFIG.botSpreadBps);

    const label = `${Number(solAmount) / 1e9} SOL (${fiatCents / 100} ${currency})`;
    console.log(`[noise] Starting trade: ${sellerPub.toBase58().slice(0, 8)}→${buyerPub.toBase58().slice(0, 8)} ${label}`);

    // 3. Ensure reputations exist
    await this.ensureReputation(seller);
    await this.ensureReputation(buyer);

    // 4. Ensure seller has wSOL in ATA
    await this.ensureWSOL(seller.keypair, solAmount);

    // 5. Create sell order
    const { orderPda, nonce } = await this.createOrder(
      seller, solAmount, fiatCents, currency, paymentMethods,
    );
    console.log(`[noise]   ✓ Order created: ${orderPda.toBase58().slice(0, 16)}...`);

    // 6. Wait (simulate order discovery)
    await this.stepDelay();

    // 7. Take order (buyer takes, seller signs for token transfer)
    const escrowPda = await this.takeOrder(seller, buyer, orderPda);
    console.log(`[noise]   ✓ Escrow locked: ${escrowPda.toBase58().slice(0, 16)}...`);

    // 8. Wait (simulate fiat payment time — longer delay)
    const fiatDelay = this.minStepDelayMs * 2 + Math.random() * (this.maxStepDelayMs * 2);
    await new Promise((resolve) => setTimeout(resolve, Math.round(fiatDelay)));

    // 9. Confirm payment (buyer)
    await this.confirmPayment(buyer.keypair, escrowPda);
    console.log(`[noise]   ✓ Payment confirmed`);

    // 10. Wait (simulate seller checking bank)
    await this.stepDelay();

    // 11. Release escrow (seller)
    await this.releaseEscrow(seller, buyer, escrowPda, orderPda);
    console.log(`[noise]   ✓ Escrow released — trade complete (${label})`);

    // 12. Unwrap buyer's wSOL back to SOL for next cycle
    await this.unwrapWSOL(buyer.keypair);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WALLET MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /** Pick two different wallets with sufficient balance for a trade. */
  private pickWalletPair(): [NoiseWallet, NoiseWallet] {
    const shuffled = [...this.wallets].sort(() => Math.random() - 0.5);
    if (shuffled.length < 2) throw new Error('Need at least 2 noise wallets');
    return [shuffled[0], shuffled[1]];
  }

  /** Ensure a wallet has wSOL ATA with at least `amount` lamports. */
  private async ensureWSOL(wallet: Keypair, amount: bigint): Promise<void> {
    const ata = getAssociatedTokenAddressSync(NATIVE_SOL_MINT, wallet.publicKey);

    // Create ATA if needed + transfer SOL + sync native
    const rentExempt = 2_039_280; // token account rent
    const transferAmount = amount + BigInt(rentExempt) + 50_000n; // extra for fees

    const tx = new Transaction();
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        ata,
        wallet.publicKey,
        NATIVE_SOL_MINT,
      ),
    );
    tx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: ata,
        lamports: transferAmount,
      }),
    );
    tx.add(createSyncNativeInstruction(ata));

    await sendAndConfirmTransaction(this.connection, tx, [wallet], { commitment: 'confirmed' });
  }

  /** Close wSOL ATA to recover SOL. */
  private async unwrapWSOL(wallet: Keypair): Promise<void> {
    const ata = getAssociatedTokenAddressSync(NATIVE_SOL_MINT, wallet.publicKey);
    try {
      const tx = new Transaction().add(
        createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey),
      );
      await sendAndConfirmTransaction(this.connection, tx, [wallet], { commitment: 'confirmed' });
    } catch {
      // ATA might not exist or already closed
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REPUTATION INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Ensure reputation PDA exists for a noise wallet. */
  private async ensureReputation(wallet: NoiseWallet): Promise<void> {
    if (wallet.repInitialized) return;

    const [repPda] = PublicKey.findProgramAddressSync(
      [REPUTATION_SEED, wallet.repCommitment],
      CONFIG.programId,
    );

    // Check if already exists
    const existing = await this.connection.getAccountInfo(repPda);
    if (existing) {
      wallet.repInitialized = true;
      return;
    }

    // init_reputation instruction: disc(8) + commitment(32)
    const data = Buffer.alloc(8 + 32);
    IX_INIT_REPUTATION.copy(data, 0);
    wallet.repCommitment.copy(data, 8);

    const ix = new TransactionInstruction({
      programId: CONFIG.programId,
      keys: [
        { pubkey: wallet.keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: repPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [wallet.keypair], { commitment: 'confirmed' });

    wallet.repInitialized = true;
    console.log(`[noise]   Reputation initialized for ${wallet.keypair.publicKey.toBase58().slice(0, 12)}...`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ON-CHAIN INSTRUCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Step 1: Create a denominated sell order. */
  private async createOrder(
    seller: NoiseWallet,
    cryptoAmount: bigint,
    fiatCents: number,
    currency: string,
    paymentMethods: number,
  ): Promise<{ orderPda: PublicKey; nonce: Buffer }> {
    const maker = seller.keypair.publicKey;
    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], CONFIG.programId);
    const nonce = randomBytes(16);
    const [orderPda] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, maker.toBytes(), nonce],
      CONFIG.programId,
    );

    // Authority bypass for devnet attestation
    const configAccount = await this.connection.getAccountInfo(configPda);
    if (!configAccount) throw new Error('Config PDA not found');
    const authority = new PublicKey(configAccount.data.subarray(8, 40));

    // Serialize CreateOrderParams (94 bytes)
    const currencyBytes = Buffer.alloc(3);
    currencyBytes.write(currency.toUpperCase().slice(0, 3), 'ascii');

    const params = Buffer.alloc(94);
    let off = 0;
    params.writeUInt8(ORDER_TYPE_SELL_CRYPTO, off); off += 1;
    params.writeBigUInt64LE(cryptoAmount, off); off += 8;
    params.writeBigUInt64LE(BigInt(fiatCents), off); off += 8;
    currencyBytes.copy(params, off); off += 3;
    params.writeUInt16LE(paymentMethods, off); off += 2;
    params.writeBigUInt64LE(0n, off); off += 8; // min_amount
    params.writeBigUInt64LE(0n, off); off += 8; // max_amount
    seller.repCommitment.copy(params, off); off += 32;
    nonce.copy(params, off); off += 16;
    params.writeBigInt64LE(BigInt(CONFIG.botOrderTtl), off);

    const data = Buffer.concat([IX_CREATE_ORDER, params]);

    const ix = new TransactionInstruction({
      programId: CONFIG.programId,
      keys: [
        { pubkey: maker, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: orderPda, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false }, // attestation bypass
        { pubkey: this.tokenMint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(ix);

    await sendAndConfirmTransaction(this.connection, tx, [seller.keypair], { commitment: 'confirmed' });
    return { orderPda, nonce };
  }

  /** Step 2: Buyer takes the seller's order → crypto locked in escrow. */
  private async takeOrder(
    seller: NoiseWallet,
    buyer: NoiseWallet,
    orderPda: PublicKey,
  ): Promise<PublicKey> {
    const takerPub = buyer.keypair.publicKey;
    const sellerPub = seller.keypair.publicKey;

    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], CONFIG.programId);
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [ESCROW_SEED, orderPda.toBytes(), takerPub.toBytes()],
      CONFIG.programId,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, escrowPda.toBytes()],
      CONFIG.programId,
    );

    const sellerAta = getAssociatedTokenAddressSync(this.tokenMint, sellerPub);

    // Authority bypass for devnet attestation
    const configAccount = await this.connection.getAccountInfo(configPda);
    if (!configAccount) throw new Error('Config PDA not found');
    const authority = new PublicKey(configAccount.data.subarray(8, 40));

    // Instruction data: disc(8) + Option<[u8;32]> None(1) + payment_method(2)
    const data = Buffer.alloc(11);
    IX_TAKE_ORDER.copy(data, 0);
    data.writeUInt8(0, 8); // None (no stealth recipient for noise)
    data.writeUInt16LE(pickRandomPaymentMethods(), 9);

    const ix = new TransactionInstruction({
      programId: CONFIG.programId,
      keys: [
        { pubkey: takerPub, isSigner: true, isWritable: true },        // taker
        { pubkey: configPda, isSigner: false, isWritable: false },      // config
        { pubkey: orderPda, isSigner: false, isWritable: true },        // order
        { pubkey: escrowPda, isSigner: false, isWritable: true },       // escrow (init)
        { pubkey: vaultPda, isSigner: false, isWritable: true },        // escrow_vault (init)
        { pubkey: sellerAta, isSigner: false, isWritable: true },       // seller_token_account
        { pubkey: sellerPub, isSigner: true, isWritable: false },       // seller (signer)
        { pubkey: this.tokenMint, isSigner: false, isWritable: false }, // token_mint
        { pubkey: authority, isSigner: false, isWritable: false },      // taker_attestation (bypass)
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ix);

    // Both seller and buyer must sign (seller authorizes token transfer)
    await sendAndConfirmTransaction(
      this.connection, tx,
      [buyer.keypair, seller.keypair],
      { commitment: 'confirmed' },
    );

    return escrowPda;
  }

  /** Step 3: Buyer confirms fiat payment. */
  private async confirmPayment(buyer: Keypair, escrowPda: PublicKey): Promise<void> {
    const ix = new TransactionInstruction({
      programId: CONFIG.programId,
      keys: [
        { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
      ],
      data: IX_CONFIRM_PAYMENT,
    });

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [buyer], { commitment: 'confirmed' });
  }

  /** Step 4: Seller releases escrow → crypto to buyer, fees split. */
  private async releaseEscrow(
    seller: NoiseWallet,
    buyer: NoiseWallet,
    escrowPda: PublicKey,
    orderPda: PublicKey,
  ): Promise<void> {
    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], CONFIG.programId);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, escrowPda.toBytes()],
      CONFIG.programId,
    );

    // Read config for fee wallets
    const configAccount = await this.connection.getAccountInfo(configPda);
    if (!configAccount) throw new Error('Config not found');
    const cfgData = configAccount.data;
    let cfgOff = 8 + 32 + 2; // discriminator + authority + fee_bps
    const p01FeeWallet = new PublicKey(cfgData.subarray(cfgOff, cfgOff + 32)); cfgOff += 32;
    const mugenFeeWallet = new PublicKey(cfgData.subarray(cfgOff, cfgOff + 32)); cfgOff += 32;
    const treasuryWallet = new PublicKey(cfgData.subarray(cfgOff, cfgOff + 32));
    cfgOff += 32;
    cfgOff += 2; // skip p01_fee_share
    cfgOff += 2; // skip mugen_fee_share
    const noiseFundWallet = new PublicKey(cfgData.subarray(cfgOff, cfgOff + 32));

    // Buyer needs a wSOL ATA to receive crypto
    const buyerAta = getAssociatedTokenAddressSync(this.tokenMint, buyer.keypair.publicKey);
    // Ensure buyer ATA exists
    const ensureAtaTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        seller.keypair.publicKey, buyerAta, buyer.keypair.publicKey, this.tokenMint,
      ),
    );
    await sendAndConfirmTransaction(this.connection, ensureAtaTx, [seller.keypair], { commitment: 'confirmed' });

    // Fee ATAs
    const p01FeeAta = getAssociatedTokenAddressSync(this.tokenMint, p01FeeWallet);
    const mugenFeeAta = getAssociatedTokenAddressSync(this.tokenMint, mugenFeeWallet);
    const treasuryFeeAta = getAssociatedTokenAddressSync(this.tokenMint, treasuryWallet);
    const noiseFundAta = getAssociatedTokenAddressSync(this.tokenMint, noiseFundWallet);

    // Reputation PDAs
    const [makerRepPda] = PublicKey.findProgramAddressSync(
      [REPUTATION_SEED, seller.repCommitment],
      CONFIG.programId,
    );
    const [takerRepPda] = PublicKey.findProgramAddressSync(
      [REPUTATION_SEED, buyer.repCommitment],
      CONFIG.programId,
    );

    const ix = new TransactionInstruction({
      programId: CONFIG.programId,
      keys: [
        { pubkey: seller.keypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: p01FeeAta, isSigner: false, isWritable: true },
        { pubkey: mugenFeeAta, isSigner: false, isWritable: true },
        { pubkey: treasuryFeeAta, isSigner: false, isWritable: true },
        { pubkey: noiseFundAta, isSigner: false, isWritable: true },
        { pubkey: makerRepPda, isSigner: false, isWritable: true },
        { pubkey: takerRepPda, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: IX_RELEASE_ESCROW,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ix);

    await sendAndConfirmTransaction(this.connection, tx, [seller.keypair], { commitment: 'confirmed' });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Derive a master seed from a secret string (for env var). */
export function deriveMasterSeed(secret: string): Buffer {
  return Buffer.from(
    createHash('sha256').update(`mugen_noise_master:${secret}`).digest(),
  );
}
