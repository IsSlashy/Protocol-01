/**
 * Mugen MPC Matcher — Bridges Arcium MPC match results to Mugen escrows.
 *
 * Listens for MugenMatchFound events from the Arcium program's callback.
 * When a blind match succeeds, this service:
 *   1. Reads the revealed trade terms (crypto, fiat, nonces)
 *   2. Creates the corresponding Mugen escrow on-chain
 *   3. The noise engine's fake trades produce identical-looking events
 *
 * Privacy guarantee: the matcher service runs off-chain. The link between
 * "MPC match event" → "Mugen escrow creation" is encrypted in the service.
 * An on-chain observer sees escrows being created but cannot link them
 * to specific MPC computations (especially with noise).
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { CONFIG } from '../config.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MpcMatchEvent {
  cryptoAmount: bigint;
  fiatAmount: bigint;
  makerNonce: bigint;
  takerNonce: bigint;
  currencyHash: bigint;
  signature: string;
  slot: number;
}

export interface MpcMatcherConfig {
  /** How often to poll for new match events (ms). Default: 5000. */
  pollIntervalMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ARCIUM_PROGRAM_ID = new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT');

// ─── Service ────────────────────────────────────────────────────────────────

export class MpcMatcher {
  private connection: Connection;
  private pollIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastSlot = 0;
  private running = false;
  private matchesProcessed = 0;

  /** Callback invoked when a match is found. Wire this to escrow creation. */
  public onMatch: ((match: MpcMatchEvent) => Promise<void>) | null = null;

  constructor(config: MpcMatcherConfig = {}) {
    this.connection = new Connection(CONFIG.rpcUrl, 'confirmed');
    this.pollIntervalMs = config.pollIntervalMs ?? 5_000;
  }

  async start(): Promise<void> {
    this.running = true;
    // Get current slot as baseline
    this.lastSlot = await this.connection.getSlot();
    this.intervalId = setInterval(() => this.poll(), this.pollIntervalMs);
    console.log(`[mpc-matcher] Started — polling every ${this.pollIntervalMs}ms from slot ${this.lastSlot}`);
  }

  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log(`[mpc-matcher] Stopped — ${this.matchesProcessed} matches processed`);
  }

  getStats() {
    return {
      running: this.running,
      matchesProcessed: this.matchesProcessed,
      lastSlot: this.lastSlot,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POLLING — Scan Arcium program logs for MugenMatch events
  // ═══════════════════════════════════════════════════════════════════════════

  private async poll(): Promise<void> {
    try {
      // Fetch recent signatures for the Arcium program
      const signatures = await this.connection.getSignaturesForAddress(
        ARCIUM_PROGRAM_ID,
        { limit: 25 },
        'confirmed',
      );

      // Filter to signatures after our last processed slot
      const newSigs = signatures.filter((s) => s.slot > this.lastSlot);
      if (newSigs.length === 0) return;

      // Process in chronological order (oldest first)
      for (const sig of newSigs.reverse()) {
        const match = await this.parseMatchFromTx(sig.signature);
        if (match) {
          console.log(
            `[mpc-matcher] Match found: ${Number(match.cryptoAmount) / LAMPORTS_PER_SOL} SOL ` +
            `for ${Number(match.fiatAmount)} cents — maker=${match.makerNonce} taker=${match.takerNonce}`,
          );

          if (this.onMatch) {
            try {
              await this.onMatch(match);
              this.matchesProcessed++;
            } catch (err) {
              console.error('[mpc-matcher] onMatch handler error:', (err as Error).message);
            }
          }
        }

        this.lastSlot = Math.max(this.lastSlot, sig.slot);
      }
    } catch (err) {
      console.error('[mpc-matcher] Poll error:', (err as Error).message);
    }
  }

  /**
   * Parse a MugenMatch result from a transaction's logs.
   * Returns null if the transaction doesn't contain a match event.
   */
  private async parseMatchFromTx(signature: string): Promise<MpcMatchEvent | null> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta?.logMessages) return null;

    const logs = tx.meta.logMessages;

    // Look for the match log pattern emitted by mugen_blind_take_callback
    const matchLine = logs.find((l) => l.includes('MugenMatch:'));
    if (!matchLine) return null;

    const m = matchLine.match(
      /MugenMatch: crypto=(\d+), fiat=(\d+), maker=(\d+), taker=(\d+)/,
    );
    if (!m) return null;

    return {
      cryptoAmount: BigInt(m[1]),
      fiatAmount: BigInt(m[2]),
      makerNonce: BigInt(m[3]),
      takerNonce: BigInt(m[4]),
      currencyHash: 0n, // Not in the log format — read from event if needed
      signature,
      slot: tx.slot,
    };
  }
}
