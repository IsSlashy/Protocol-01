/**
 * Mugen Mixer — Multi-hop ephemeral delivery for real P2P trades.
 *
 * After an escrow is released, instead of funds going directly to the buyer's
 * wallet, they are routed through 2-4 ephemeral intermediate wallets with
 * random delays between each hop. This breaks the on-chain link between the
 * Mugen trade and the buyer's final wallet.
 *
 * Combined with the NoiseEngine (which creates identical-looking trades
 * between its own ephemeral wallets), an observer cannot determine:
 *   1. Which trades are real vs noise
 *   2. Where funds actually end up (multi-hop breaks graph analysis)
 *   3. When funds were delivered (random delays break timing analysis)
 *
 * Flow:
 *   Escrow release → Ephemeral Wallet 1 → [delay] → EW2 → [delay] → ... → Buyer
 *
 * The mixer holds ephemeral keypairs in memory. If the service restarts,
 * pending deliveries are lost (funds remain in intermediate wallets and
 * can be recovered from the master seed).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
} from '@solana/spl-token';
import { createHash, randomBytes } from 'crypto';
import { CONFIG } from '../config.js';

// ─── Types ──────────────────────────────────────────────────────────────────

const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** Represents a single hop in the delivery chain. */
interface Hop {
  /** Ephemeral keypair for this hop (derived deterministically). */
  wallet: Keypair;
  /** When this hop should execute (unix ms). */
  scheduledAt: number;
  /** Whether this hop has been executed. */
  executed: boolean;
}

/** A pending multi-hop delivery job. */
interface DeliveryJob {
  id: string;
  /** Amount to deliver (lamports or SPL base units). */
  amount: bigint;
  /** Token mint (wSOL for native SOL trades). */
  tokenMint: PublicKey;
  /** First wallet in chain (receives from escrow release). */
  entryWallet: Keypair;
  /** Intermediate hops. */
  hops: Hop[];
  /** Final destination wallet. */
  destination: PublicKey;
  /** Job status. */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Creation timestamp. */
  createdAt: number;
}

export interface MixerConfig {
  /** Master seed for deterministic ephemeral wallet derivation. */
  masterSeed: Buffer;
  /** Number of intermediate hops (default: 3). */
  hops?: number;
  /** Min delay between hops in ms (default: 30000 = 30s). */
  minHopDelayMs?: number;
  /** Max delay between hops in ms (default: 300000 = 5min). */
  maxHopDelayMs?: number;
  /** How often to check for pending hops in ms (default: 10000). */
  pollIntervalMs?: number;
}

export interface DeliveryRequest {
  /** Amount in lamports (native SOL) or base units (SPL). */
  amount: bigint;
  /** Token mint. */
  tokenMint: PublicKey;
  /** Final recipient wallet. */
  destination: PublicKey;
}

export interface DeliveryResult {
  /** Unique delivery ID for tracking. */
  deliveryId: string;
  /** The wallet that should receive funds from the escrow release.
   *  The web app should use this as the buyer_token_account. */
  entryWallet: PublicKey;
  /** Estimated delivery time (unix ms). */
  estimatedDeliveryAt: number;
  /** Number of hops including entry. */
  totalHops: number;
}

// ─── Mixer ──────────────────────────────────────────────────────────────────

export class Mixer {
  private connection: Connection;
  private masterSeed: Buffer;
  private numHops: number;
  private minHopDelayMs: number;
  private maxHopDelayMs: number;
  private pollIntervalMs: number;
  private jobs: Map<string, DeliveryJob> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private deliveryCounter = 0;
  private completedCount = 0;
  private failedCount = 0;

  constructor(config: MixerConfig) {
    this.connection = new Connection(CONFIG.rpcUrl, 'confirmed');
    this.masterSeed = config.masterSeed;
    this.numHops = config.hops ?? 3;
    this.minHopDelayMs = config.minHopDelayMs ?? 30_000;
    this.maxHopDelayMs = config.maxHopDelayMs ?? 300_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 10_000;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  start(): void {
    this.running = true;
    this.intervalId = setInterval(() => this.processJobs(), this.pollIntervalMs);
    console.log(`[mixer] Started — ${this.numHops} hops, delay ${this.minHopDelayMs}-${this.maxHopDelayMs}ms`);
  }

  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log(`[mixer] Stopped — ${this.completedCount} delivered, ${this.failedCount} failed, ${this.jobs.size} pending`);
  }

  getStats() {
    return {
      pending: [...this.jobs.values()].filter((j) => j.status !== 'completed' && j.status !== 'failed').length,
      completed: this.completedCount,
      failed: this.failedCount,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELIVERY REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register a new multi-hop delivery.
   *
   * Returns the entry wallet — the web app should direct the escrow release
   * to this wallet's ATA instead of the buyer's real wallet. The mixer then
   * routes funds through ephemeral hops to the final destination.
   */
  requestDelivery(req: DeliveryRequest): DeliveryResult {
    const deliveryId = `MIX-${Date.now()}-${++this.deliveryCounter}`;
    const now = Date.now();

    // Derive entry wallet deterministically
    const entryWallet = this.deriveWallet(deliveryId, 'entry');

    // Derive intermediate hop wallets with scheduled times
    const hops: Hop[] = [];
    let cumulativeDelay = 0;
    for (let i = 0; i < this.numHops; i++) {
      const delay = this.randomDelay();
      cumulativeDelay += delay;
      hops.push({
        wallet: this.deriveWallet(deliveryId, `hop_${i}`),
        scheduledAt: now + cumulativeDelay,
        executed: false,
      });
    }

    // Final hop delay to destination
    cumulativeDelay += this.randomDelay();

    const job: DeliveryJob = {
      id: deliveryId,
      amount: req.amount,
      tokenMint: req.tokenMint,
      entryWallet,
      hops,
      destination: req.destination,
      status: 'pending',
      createdAt: now,
    };

    this.jobs.set(deliveryId, job);

    console.log(
      `[mixer] Delivery registered: ${deliveryId} — ` +
      `${Number(req.amount) / 1e9} SOL → ${this.numHops} hops → ` +
      `${req.destination.toBase58().slice(0, 12)}... ` +
      `(~${Math.round(cumulativeDelay / 1000)}s total)`
    );

    return {
      deliveryId,
      entryWallet: entryWallet.publicKey,
      estimatedDeliveryAt: now + cumulativeDelay,
      totalHops: this.numHops + 1, // +1 for entry→hop0
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // JOB PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════

  private async processJobs(): Promise<void> {
    const now = Date.now();

    for (const job of this.jobs.values()) {
      if (job.status === 'completed' || job.status === 'failed') continue;

      try {
        // Check if entry wallet has funds (escrow was released)
        if (job.status === 'pending') {
          const hasFunds = await this.checkFunds(job.entryWallet.publicKey, job.tokenMint, job.amount);
          if (!hasFunds) continue;
          job.status = 'in_progress';
          console.log(`[mixer] ${job.id} — Funds detected, starting hops`);
        }

        // Execute hops that are ready
        await this.executeReadyHops(job, now);

        // Check if all hops are done → final delivery
        if (job.hops.every((h) => h.executed)) {
          const lastHop = job.hops[job.hops.length - 1];
          await this.executeTransfer(lastHop.wallet, job.destination, job.amount, job.tokenMint);
          await this.cleanupWallet(lastHop.wallet, job.tokenMint);

          job.status = 'completed';
          this.completedCount++;
          console.log(
            `[mixer] ${job.id} — ✓ Delivered to ${job.destination.toBase58().slice(0, 12)}... ` +
            `(${Math.round((Date.now() - job.createdAt) / 1000)}s elapsed)`
          );
        }
      } catch (err) {
        console.error(`[mixer] ${job.id} — Error:`, (err as Error).message);
        // Don't mark as failed immediately — retry on next tick
        // Only fail after 1 hour of no progress
        if (now - job.createdAt > 3_600_000) {
          job.status = 'failed';
          this.failedCount++;
          console.error(`[mixer] ${job.id} — FAILED (timeout)`);
        }
      }
    }

    // Cleanup old completed/failed jobs (keep for 10 min)
    for (const [id, job] of this.jobs) {
      if ((job.status === 'completed' || job.status === 'failed') && now - job.createdAt > 600_000) {
        this.jobs.delete(id);
      }
    }
  }

  private async executeReadyHops(job: DeliveryJob, now: number): Promise<void> {
    for (let i = 0; i < job.hops.length; i++) {
      const hop = job.hops[i];
      if (hop.executed || now < hop.scheduledAt) continue;

      // Source: entry wallet (first hop) or previous hop wallet
      const source = i === 0 ? job.entryWallet : job.hops[i - 1].wallet;

      // Verify previous hop was executed
      if (i > 0 && !job.hops[i - 1].executed) continue;

      await this.executeTransfer(source, hop.wallet.publicKey, job.amount, job.tokenMint);
      await this.cleanupWallet(source, job.tokenMint);

      hop.executed = true;
      console.log(`[mixer] ${job.id} — Hop ${i + 1}/${job.hops.length} → ${hop.wallet.publicKey.toBase58().slice(0, 12)}...`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSFER EXECUTION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Transfer funds from one wallet to another (native SOL or wSOL). */
  private async executeTransfer(
    from: Keypair,
    to: PublicKey,
    amount: bigint,
    tokenMint: PublicKey,
  ): Promise<void> {
    const isNativeSol = tokenMint.equals(NATIVE_SOL_MINT);

    if (isNativeSol) {
      // For wSOL: close source ATA (unwrap) → SOL transfer → create+fund dest ATA
      // Step 1: Close source wSOL ATA to unwrap to native SOL
      const srcAta = getAssociatedTokenAddressSync(NATIVE_SOL_MINT, from.publicKey);
      const closeTx = new Transaction().add(
        createCloseAccountInstruction(srcAta, from.publicKey, from.publicKey),
      );
      try {
        await sendAndConfirmTransaction(this.connection, closeTx, [from], { commitment: 'confirmed' });
      } catch {
        // ATA might already be closed / holding native SOL
      }

      // Step 2: Transfer native SOL
      // Reserve some for the destination's ATA rent + tx fees
      const reserved = 2_100_000n + 10_000n; // ATA rent + fees
      const transferAmount = amount > reserved ? amount : amount;

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: from.publicKey,
          toPubkey: to,
          lamports: transferAmount,
        }),
      );
      await sendAndConfirmTransaction(this.connection, tx, [from], { commitment: 'confirmed' });
    } else {
      // SPL token transfer
      const fromAta = getAssociatedTokenAddressSync(tokenMint, from.publicKey);
      const toAta = getAssociatedTokenAddressSync(tokenMint, to);

      const tx = new Transaction();
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(from.publicKey, toAta, to, tokenMint),
      );
      tx.add(
        createTransferInstruction(fromAta, toAta, from.publicKey, amount),
      );
      await sendAndConfirmTransaction(this.connection, tx, [from], { commitment: 'confirmed' });
    }
  }

  /** Close token accounts and recover rent from an ephemeral wallet. */
  private async cleanupWallet(wallet: Keypair, tokenMint: PublicKey): Promise<void> {
    try {
      // Close token account if exists
      const ata = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);
      const info = await this.connection.getAccountInfo(ata);
      if (info) {
        const tx = new Transaction().add(
          createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey),
        );
        await sendAndConfirmTransaction(this.connection, tx, [wallet], { commitment: 'confirmed' });
      }
    } catch {
      // Best effort cleanup
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Check if a wallet has enough funds. */
  private async checkFunds(wallet: PublicKey, tokenMint: PublicKey, minAmount: bigint): Promise<boolean> {
    if (tokenMint.equals(NATIVE_SOL_MINT)) {
      // Check wSOL ATA balance OR native SOL balance
      try {
        const ata = getAssociatedTokenAddressSync(NATIVE_SOL_MINT, wallet);
        const info = await this.connection.getAccountInfo(ata);
        if (info && info.data.length >= 72) {
          // Read SPL token amount (offset 64, 8 bytes LE)
          const balance = info.data.readBigUInt64LE(64);
          if (balance >= minAmount) return true;
        }
      } catch { /* no ATA */ }

      // Fallback: check native SOL balance
      const balance = await this.connection.getBalance(wallet);
      return BigInt(balance) >= minAmount;
    }

    // SPL token
    try {
      const ata = getAssociatedTokenAddressSync(tokenMint, wallet);
      const info = await this.connection.getAccountInfo(ata);
      if (info && info.data.length >= 72) {
        const balance = info.data.readBigUInt64LE(64);
        return balance >= minAmount;
      }
    } catch { /* no ATA */ }

    return false;
  }

  /** Derive a deterministic ephemeral wallet from master seed + delivery ID + label. */
  private deriveWallet(deliveryId: string, label: string): Keypair {
    const seed = createHash('sha256')
      .update(this.masterSeed)
      .update(`mixer:${deliveryId}:${label}`)
      .digest();
    return Keypair.fromSeed(seed);
  }

  /** Random delay between hops. */
  private randomDelay(): number {
    return Math.round(
      this.minHopDelayMs + Math.random() * (this.maxHopDelayMs - this.minHopDelayMs),
    );
  }
}
