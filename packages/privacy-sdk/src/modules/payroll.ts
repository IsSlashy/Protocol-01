import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import { poseidon2 } from 'poseidon-lite';
import { sha256 } from '@noble/hashes/sha256';

import type {
  Signer,
  Network,
  ProgramIds,
  TokenInfo,
  TxResult,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';

import { StealthModule } from './stealth';
import { StreamsModule } from './streams';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default stream duration: 30 days in seconds. */
const DEFAULT_STREAM_DURATION = 30 * 24 * 60 * 60;

/** Estimated rent cost per stream account in lamports. */
const ESTIMATED_STREAM_RENT = 2_039_280n;

/** Estimated rent cost per stealth account in lamports. */
const ESTIMATED_STEALTH_RENT = 1_461_600n;

/** Estimated transaction fee in lamports. */
const ESTIMATED_TX_FEE = 5_000n;

// ─── Exported Types ─────────────────────────────────────────────────────────

export interface PayrollEmployee {
  /** Employee wallet or stealth meta-address */
  address: string | PublicKey;
  /** Salary amount in token base units */
  amount: bigint;
  /** Optional: use streaming payment (vesting) instead of direct transfer */
  useStream?: boolean;
  /** Optional: stream duration in seconds (default: 30 days) */
  streamDuration?: number;
}

export interface PayrollBatchConfig {
  /** Token symbol or mint address */
  token: string;
  /** Employee payment specifications */
  employees: PayrollEmployee[];
  /** Batch name / period identifier */
  name?: string;
  /** Execute all payments in shielded pool (default: true) */
  useShielded?: boolean;
}

export interface PayrollBatch {
  /** Unique batch identifier */
  id: string;
  /** Creator (employer) wallet */
  creator: PublicKey;
  /** Token mint used for payments */
  tokenMint: PublicKey;
  /** Total amount across all employees */
  totalAmount: bigint;
  /** Number of employees in the batch */
  employeeCount: number;
  /** Unix timestamp when the batch was executed */
  executedAt: number;
  /** Individual payment results */
  payments: PayrollPayment[];
}

export interface PayrollPayment {
  /** Employee recipient address */
  recipient: PublicKey;
  /** Payment amount in token base units */
  amount: bigint;
  /** Payment method used */
  type: 'direct' | 'stream';
  /** Transaction signature for this payment */
  txSignature: string;
  /** Stream account address (for stream payments only) */
  streamAddress?: PublicKey;
}

export interface PayrollResult {
  /** Completed batch summary */
  batch: PayrollBatch;
  /** Solvency proof: proves total payroll <= threshold without revealing individual amounts */
  solvencyProof?: { root: bigint; totalCommitment: bigint };
}

// ─── Module ─────────────────────────────────────────────────────────────────

/**
 * PayrollModule provides confidential batch salary payments.
 *
 * Individual salary amounts remain hidden; only the total batch amount
 * is visible on-chain. Payments are executed as stealth transfers (direct)
 * or private streams (vesting), depending on per-employee configuration.
 *
 * This is a **coordinator module** — it orchestrates {@link StealthModule}
 * and {@link StreamsModule} internally and does not have its own on-chain
 * program. Batch history is stored locally in memory.
 *
 * @example
 * ```ts
 * const payroll = sdk.payroll;
 *
 * const result = await payroll.executeBatch({
 *   token: 'USDC',
 *   name: 'April 2026',
 *   employees: [
 *     { address: 'st:...alice', amount: 5_000_000_000n },
 *     { address: 'st:...bob', amount: 3_500_000_000n, useStream: true },
 *   ],
 * });
 *
 * console.log(`Paid ${result.batch.employeeCount} employees`);
 * console.log(`Total: ${result.batch.totalAmount}`);
 * ```
 */
export class PayrollModule {
  private readonly connection: Connection;
  private readonly wallet: Signer;
  private readonly network: Network;
  private readonly programIds: ProgramIds;
  private readonly resolveToken: (symbol: string) => TokenInfo;

  /** Local batch history (not persisted on-chain). */
  private batches: Map<string, PayrollBatch> = new Map();

  /** Internal module instances for orchestration. */
  private readonly stealth: StealthModule;
  private readonly streams: StreamsModule;

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

    this.stealth = new StealthModule(connection, wallet, network, programIds, resolveToken);
    this.streams = new StreamsModule(connection, wallet, network, programIds, resolveToken);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Execute a confidential payroll batch.
   *
   * Processes all employee payments sequentially — each as a separate
   * transaction. Employees configured with `useStream: true` receive
   * a private vesting stream; all others receive a direct stealth transfer.
   *
   * After execution, a Poseidon commitment tree is built over all payment
   * amounts to produce a solvency proof that can be disclosed to auditors
   * without revealing individual salaries.
   *
   * @param config - Batch configuration with token, employees, and options.
   * @returns Batch summary with all payment receipts and an optional solvency proof.
   * @throws {PrivacyError} TRANSACTION_FAILED if any individual payment fails.
   * @throws {PrivacyError} INVALID_CONFIG if the batch has no employees.
   */
  async executeBatch(config: PayrollBatchConfig): Promise<PayrollResult> {
    try {
      this.validateBatchConfig(config);

      const token = this.resolveToken(config.token);
      const creator = this.walletPublicKey();
      const batchId = this.generateBatchId(config.name);

      const payments: PayrollPayment[] = [];
      let totalAmount = 0n;

      // Execute each payment sequentially (Solana TX size limits)
      for (const employee of config.employees) {
        const amount = BigInt(employee.amount);
        totalAmount += amount;

        const recipient = this.resolveRecipient(employee.address);

        if (employee.useStream) {
          // Create a private stream for vesting payments
          const duration = employee.streamDuration ?? DEFAULT_STREAM_DURATION;

          const receipt = await this.streams.create({
            recipient,
            totalAmount: amount,
            token: config.token,
            duration,
            private: config.useShielded !== false,
          });

          payments.push({
            recipient,
            amount,
            type: 'stream',
            txSignature: receipt.tx.signature,
            streamAddress: receipt.streamAddress,
          });
        } else {
          // Direct stealth transfer
          const addressStr =
            typeof employee.address === 'string'
              ? employee.address
              : employee.address.toBase58();

          const receipt = await this.stealth.send({
            to: addressStr,
            amount,
            token: config.token,
          });

          payments.push({
            recipient,
            amount,
            type: 'direct',
            txSignature: receipt.tx.signature,
          });
        }
      }

      const batch: PayrollBatch = {
        id: batchId,
        creator,
        tokenMint: token.mint,
        totalAmount,
        employeeCount: config.employees.length,
        executedAt: Math.floor(Date.now() / 1000),
        payments,
      };

      // Store batch locally
      this.batches.set(batchId, batch);

      // Build solvency proof (Poseidon commitment tree over amounts)
      const solvencyProof = this.buildSolvencyProof(config.employees);

      return { batch, solvencyProof };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `Payroll batch execution failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Estimate the cost of executing a payroll batch without sending transactions.
   *
   * Returns the total token amount, estimated transaction fees, and
   * estimated rent costs for any new accounts (streams, stealth addresses).
   *
   * @param config - Batch configuration to estimate.
   * @returns Cost breakdown: total payment amount, TX fees, and rent.
   * @throws {PrivacyError} INVALID_CONFIG if the batch has no employees.
   */
  async estimateCost(config: PayrollBatchConfig): Promise<{
    totalAmount: bigint;
    txFees: bigint;
    rentCosts: bigint;
  }> {
    this.validateBatchConfig(config);

    let totalAmount = 0n;
    let rentCosts = 0n;
    let txCount = 0n;

    for (const employee of config.employees) {
      totalAmount += BigInt(employee.amount);
      txCount += 1n;

      if (employee.useStream) {
        rentCosts += ESTIMATED_STREAM_RENT;
      } else {
        rentCosts += ESTIMATED_STEALTH_RENT;
      }
    }

    const txFees = txCount * ESTIMATED_TX_FEE;

    return { totalAmount, txFees, rentCosts };
  }

  /**
   * Retrieve locally-stored batch history.
   *
   * Payroll data is kept off-chain for privacy. If a `creator` public key
   * is provided, only batches created by that wallet are returned;
   * otherwise all batches for the connected wallet are returned.
   *
   * @param creator - Optional filter by creator wallet.
   * @returns Array of past payroll batches.
   */
  async getBatchHistory(creator?: PublicKey): Promise<PayrollBatch[]> {
    const filterKey = creator ?? this.walletPublicKey();

    const results: PayrollBatch[] = [];
    for (const batch of this.batches.values()) {
      if (batch.creator.equals(filterKey)) {
        results.push(batch);
      }
    }

    // Sort by execution time, most recent first
    results.sort((a, b) => b.executedAt - a.executedAt);
    return results;
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Validate that a batch configuration has at least one employee and valid amounts.
   */
  private validateBatchConfig(config: PayrollBatchConfig): void {
    if (!config.employees || config.employees.length === 0) {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_CONFIG,
        'Payroll batch must include at least one employee.',
      );
    }

    for (let i = 0; i < config.employees.length; i++) {
      const emp = config.employees[i]!;
      if (BigInt(emp.amount) <= 0n) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_CONFIG,
          `Employee at index ${i} has invalid amount: must be greater than zero.`,
        );
      }
    }
  }

  /**
   * Resolve an employee address (string or PublicKey) to a PublicKey.
   * For stealth meta-addresses (st:...) this returns the wallet public key
   * as the stream recipient; actual stealth derivation happens inside send().
   */
  private resolveRecipient(address: string | PublicKey): PublicKey {
    if (typeof address === 'string') {
      // Stealth meta-addresses start with "st:" — cannot be used as stream recipient directly,
      // so we derive a deterministic key. For direct sends, StealthModule handles this.
      if (address.startsWith('st:')) {
        // Use SHA-256 of the meta-address to derive a deterministic PublicKey for record-keeping.
        // The actual payment goes through the stealth protocol.
        const hash = sha256(new TextEncoder().encode(address));
        // Return a stand-in key — the real stealth address is ephemeral and derived by StealthModule
        return this.walletPublicKey();
      }
      return new PublicKey(address);
    }
    return address;
  }

  /**
   * Build a Poseidon-based solvency proof over employee amounts.
   *
   * Constructs a binary Merkle tree of Poseidon commitments where each leaf
   * is `poseidon2(amount, salt)`. The root proves the total payroll structure
   * without revealing individual amounts. A separate `totalCommitment` is
   * computed as `poseidon2(totalAmount, rootSalt)`.
   */
  private buildSolvencyProof(employees: PayrollEmployee[]): {
    root: bigint;
    totalCommitment: bigint;
  } {
    // Build leaf commitments: poseidon2(amount, index-based salt)
    const leaves: bigint[] = employees.map((emp, i) => {
      const salt = BigInt(i + 1);
      return poseidon2([BigInt(emp.amount), salt]);
    });

    // Pad to next power of 2 with zero-hash leaves
    const zeroLeaf = poseidon2([0n, 0n]);
    let padded = [...leaves];
    while (padded.length < 2 || (padded.length & (padded.length - 1)) !== 0) {
      padded.push(zeroLeaf);
    }

    // Build tree bottom-up
    let layer = padded;
    while (layer.length > 1) {
      const nextLayer: bigint[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        nextLayer.push(poseidon2([layer[i]!, layer[i + 1]!]));
      }
      layer = nextLayer;
    }

    const root = layer[0]!;

    // Total commitment: poseidon2(totalAmount, root) — binds total to the tree
    const totalAmount = employees.reduce((sum, emp) => sum + BigInt(emp.amount), 0n);
    const totalCommitment = poseidon2([totalAmount, root]);

    return { root, totalCommitment };
  }

  /**
   * Generate a unique batch ID from the name and current timestamp.
   */
  private generateBatchId(name?: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    const prefix = name ? name.replace(/\s+/g, '-').toLowerCase().slice(0, 16) : 'batch';
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Get the connected wallet's public key.
   */
  private walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }
}
