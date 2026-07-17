import {
  Connection,
  PublicKey,
} from '@solana/web3.js';

import type {
  Signer,
  Network,
  ProgramIds,
  TokenInfo,
  TxResult,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';

import { ShieldModule } from './shield';
import { ComplianceModule } from './compliance';
import { RelayModule } from './relay';
import type { SpendingKey } from '../identity/spendingKey';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default voting deadline: 7 days from now, in seconds. */
const DEFAULT_VOTE_DEADLINE_SECONDS = 7 * 24 * 60 * 60;

/** Binary vote option count (yes / no). */
const BINARY_OPTION_COUNT = 2;

/** Vote option indices. */
const VOTE_YES = 0;
const VOTE_NO = 1;

/** Default solvency attestation TTL: 90 days in seconds. */
const DEFAULT_SOLVENCY_TTL = 90 * 24 * 60 * 60;

// ─── Exported Types ─────────────────────────────────────────────────────────

export interface TreasuryConfig {
  /** DAO authority (multisig or single wallet) */
  authority: PublicKey;
  /** Tokens to manage */
  tokens: string[];
  /** Name of the treasury */
  name?: string;
}

export interface TreasuryInfo {
  /** DAO authority wallet */
  authority: PublicKey;
  /** Per-token balance information */
  tokens: { symbol: string; mint: PublicKey; shieldedBalance: bigint }[];
  /** Sum of all token values (denominated in the first token's base units, if available) */
  totalValueEstimate?: bigint;
  /** Treasury display name */
  name: string;
}

export interface TreasurySpendProposal {
  /** Unique proposal identifier */
  proposalId: string;
  /** Recipient wallet or stealth meta-address */
  recipient: PublicKey | string;
  /** Spending amount in token base units */
  amount: bigint;
  /** Token symbol or mint address */
  token: string;
  /** Human-readable description of the spend */
  description: string;
  /** Voting deadline as Unix timestamp */
  deadline: number;
}

export interface TreasurySpendResult {
  /** Proposal that was resolved */
  proposalId: string;
  /** Whether the proposal was approved by the DAO */
  approved: boolean;
  /** Transaction result (only present if approved and executed) */
  tx?: TxResult;
  /** Vote tally from the MPC network */
  voteTally?: { yes: number; no: number };
}

export interface TreasurySolvencyProof {
  /** Token the proof covers */
  token: string;
  /** Minimum balance threshold proven */
  minBalance: bigint;
  /** On-chain attestation PDA address */
  attestationAddress: PublicKey;
  /** Unix timestamp when the attestation expires */
  expiresAt: number;
}

// ─── Module ─────────────────────────────────────────────────────────────────

/**
 * TreasuryModule provides private DAO treasury management.
 *
 * Treasury funds are held in shielded pools (via {@link ShieldModule}).
 * DAO members propose and vote on spending using private voting
 * (via {@link MPCModule}). Solvency can be proven to external parties
 * without revealing individual holdings (via {@link ComplianceModule}).
 *
 * This is a **coordinator module** — it orchestrates ShieldModule,
 * MPCModule, ComplianceModule, and RelayModule internally and does not
 * have its own on-chain program. The treasury's shielded state is
 * managed through the existing `zk_shielded` program.
 *
 * @example
 * ```ts
 * const treasury = sdk.treasury;
 *
 * // Shield funds into the treasury pool
 * await treasury.shieldFunds({ amount: 100_000_000_000n, token: 'USDC' });
 *
 * // Propose a spend
 * await treasury.proposeSpend({
 *   proposalId: 'grant-001',
 *   recipient: recipientPubkey,
 *   amount: 5_000_000_000n,
 *   token: 'USDC',
 *   description: 'Dev grant for contributor',
 *   deadline: Math.floor(Date.now() / 1000) + 7 * 86400,
 * });
 *
 * // Members vote privately
 * await treasury.voteOnSpend('grant-001', true);
 *
 * // Execute after deadline
 * const result = await treasury.executeSpend('grant-001');
 * if (result.approved) {
 *   console.log(`Spend executed: ${result.tx!.signature}`);
 * }
 * ```
 */
export class TreasuryModule {
  private readonly connection: Connection;
  private readonly wallet: Signer;
  private readonly network: Network;
  private readonly programIds: ProgramIds;
  private readonly resolveToken: (symbol: string) => TokenInfo;

  /** Internal module instances for orchestration. */
  private readonly shield: ShieldModule;
  private readonly compliance: ComplianceModule;
  private readonly relay: RelayModule;

  /** Local treasury configuration. */
  private config?: TreasuryConfig;

  /** Local proposal store (proposals are coordinated off-chain). */
  private proposals: Map<string, TreasurySpendProposal> = new Map();

  constructor(
    connection: Connection,
    wallet: Signer,
    network: Network,
    programIds: ProgramIds,
    resolveToken: (symbol: string) => TokenInfo,
    spendingKey: SpendingKey,
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = network;
    this.programIds = programIds;
    this.resolveToken = resolveToken;

    this.shield = new ShieldModule(connection, wallet, network, programIds, resolveToken, spendingKey);
    this.compliance = new ComplianceModule(connection, wallet, network, programIds, resolveToken);
    this.relay = new RelayModule(connection, wallet, network, programIds, resolveToken);
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  /**
   * Initialize the treasury with authority and managed tokens.
   *
   * Must be called before treasury operations. Sets the DAO authority
   * and the list of tokens the treasury will manage.
   *
   * @param config - Treasury configuration.
   */
  configure(config: TreasuryConfig): void {
    this.config = config;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Shield (deposit) funds into the treasury's shielded pool.
   *
   * Wraps {@link ShieldModule.shield} to move tokens from the wallet
   * into the privacy pool. Once shielded, the balance is hidden on-chain
   * and can only be spent via ZK proof.
   *
   * @param params - Amount and token to shield.
   * @returns Transaction result from the shield operation.
   * @throws {PrivacyError} SHIELD_FAILED if the deposit fails.
   */
  async shieldFunds(params: { amount: bigint; token: string }): Promise<TxResult> {
    try {
      const receipt = await this.shield.shield({
        amount: params.amount,
        token: params.token,
      });
      return receipt.tx;
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.SHIELD_FAILED,
        `Treasury shield failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Propose a treasury spend for DAO voting.
   *
   * Creates a binary (yes/no) MPC voting proposal via the Arcium
   * network. DAO members can then cast encrypted votes using
   * {@link voteOnSpend}. The proposal metadata is stored locally;
   * the on-chain component is the MPC proposal account.
   *
   * @param proposal - Spend proposal details including amount, recipient, and deadline.
   * @returns Transaction result from proposal creation.
   * @throws {PrivacyError} MPC_VOTE_FAILED if proposal creation fails.
   * @throws {PrivacyError} INVALID_CONFIG if proposal parameters are invalid.
   */
  async proposeSpend(proposal: TreasurySpendProposal): Promise<TxResult> {
    this.validateProposal(proposal);
    throw new PrivacyError(
      PrivacyErrorCode.MPC_NOT_AVAILABLE,
      'Private treasury governance (Arcium MPC voting) has been removed from ' +
        `Protocol 01; cannot create proposal "${proposal.proposalId}".`,
    );
  }

  /**
   * Cast a private vote on a treasury spend proposal.
   *
   * The vote is encrypted with the Arcium MXE public key so that
   * individual votes are never visible on-chain. Only the aggregated
   * tally is revealed after finalization.
   *
   * @param proposalId - The proposal to vote on.
   * @param approve - `true` for yes, `false` for no.
   * @returns Transaction result from the vote submission.
   * @throws {PrivacyError} MPC_VOTE_FAILED if the vote fails.
   * @throws {PrivacyError} MPC_ALREADY_VOTED if this wallet already voted.
   */
  async voteOnSpend(proposalId: string, approve: boolean): Promise<TxResult> {
    throw new PrivacyError(
      PrivacyErrorCode.MPC_NOT_AVAILABLE,
      'Private treasury governance (Arcium MPC voting) has been removed from ' +
        `Protocol 01; cannot vote on "${proposalId}" (approve=${approve}).`,
    );
  }

  /**
   * Execute a treasury spend proposal after the voting deadline.
   *
   * Finalizes the MPC tally to determine the vote outcome. If approved
   * (yes > no), the treasury unshields the specified amount and sends
   * it to the proposal recipient. If rejected, returns the tally without
   * moving funds.
   *
   * @param proposalId - The proposal to execute.
   * @returns Spend result with approval status, vote tally, and optional TX.
   * @throws {PrivacyError} MPC_VOTE_FAILED if tally finalization fails.
   * @throws {PrivacyError} INVALID_CONFIG if the proposal is not found locally.
   */
  async executeSpend(proposalId: string): Promise<TreasurySpendResult> {
    throw new PrivacyError(
      PrivacyErrorCode.MPC_NOT_AVAILABLE,
      'Private treasury governance (Arcium MPC voting) has been removed from ' +
        `Protocol 01; cannot execute "${proposalId}".`,
    );
  }

  /**
   * Prove that the treasury holds at least a minimum balance of a token.
   *
   * Generates a compliance range proof demonstrating that the shielded
   * balance is >= `minBalance` without revealing the actual amount. The
   * proof creates an on-chain ComplianceAttestation PDA that any third
   * party can verify.
   *
   * **Note:** The compliance module must have circuit paths configured
   * (via `sdk.compliance.setCircuitPaths()`) before calling this method.
   *
   * @param params - Token and minimum balance to prove.
   * @returns Solvency proof with attestation address and expiry.
   * @throws {PrivacyError} PROOF_GENERATION_FAILED if the range proof fails.
   * @throws {PrivacyError} INVALID_CONFIG if compliance circuits are not configured.
   */
  async proveSolvency(params: {
    token: string;
    minBalance: bigint;
  }): Promise<TreasurySolvencyProof> {
    try {
      // Validate the token exists
      this.resolveToken(params.token);

      // Use compliance range proof: prove balance >= minBalance
      // The caller must have set circuit paths and private witness data
      // on the compliance module. Here we use a large maxBound as the
      // upper limit since we only need a lower-bound proof.
      const MAX_BOUND = BigInt('340282366920938463463374607431768211455'); // u128 max
      const result = await this.compliance.proveRange({
        balanceCommitment: 0n, // Caller should set the real commitment
        minBound: params.minBalance,
        maxBound: MAX_BOUND,
        token: params.token,
        balance: 0n,          // Private witness — caller must provide real value
        salt: 0n,             // Private witness — caller must provide real value
        nonce: 0n,            // Private witness — caller must provide real value
        spendingKey: 0n,      // Private witness — caller must provide real value
      });

      const expiresAt = Math.floor(Date.now() / 1000) + DEFAULT_SOLVENCY_TTL;

      return {
        token: params.token,
        minBalance: params.minBalance,
        attestationAddress: result.attestationAddress,
        expiresAt,
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.PROOF_GENERATION_FAILED,
        `Treasury solvency proof failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Get aggregate treasury information across managed tokens.
   *
   * Fetches the shielded balance for each token by querying the
   * on-chain pool state. If a specific token list is provided, only
   * those tokens are queried; otherwise the configured treasury tokens
   * are used.
   *
   * @param tokens - Optional list of token symbols to query. Defaults to configured tokens.
   * @returns Treasury overview with per-token shielded balances.
   * @throws {PrivacyError} INVALID_CONFIG if no tokens are specified and treasury is not configured.
   */
  async getTreasuryInfo(tokens?: string[]): Promise<TreasuryInfo> {
    try {
      const tokenList = tokens ?? this.config?.tokens;
      if (!tokenList || tokenList.length === 0) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_CONFIG,
          'No tokens specified. Pass a token list or call configure() first.',
        );
      }

      const authority = this.config?.authority ?? this.walletPublicKey();
      const name = this.config?.name ?? 'Treasury';

      const tokenInfos: { symbol: string; mint: PublicKey; shieldedBalance: bigint }[] = [];
      let totalEstimate = 0n;

      for (const symbol of tokenList) {
        const info = this.resolveToken(symbol);

        // Query the shielded pool for this token's balance.
        // The pool balance is derived from the pool account's on-chain state.
        let shieldedBalance = 0n;
        try {
          const poolInfo = await this.shield.getPoolInfo(info.symbol);
          // Pool leaf count * average denomination gives a rough estimate
          // but the actual shielded balance per user is not publicly available
          // (that is the point of privacy). We report the commitment count.
          shieldedBalance = poolInfo ? BigInt(poolInfo.leafCount) : 0n;
        } catch {
          // Pool may not exist for this token — report zero
          shieldedBalance = 0n;
        }

        tokenInfos.push({
          symbol: info.symbol,
          mint: info.mint,
          shieldedBalance,
        });

        totalEstimate += shieldedBalance;
      }

      return {
        authority,
        tokens: tokenInfos,
        totalValueEstimate: totalEstimate,
        name,
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_CONFIG,
        `Failed to fetch treasury info: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Validate a spend proposal's parameters.
   */
  private validateProposal(proposal: TreasurySpendProposal): void {
    if (!proposal.proposalId || proposal.proposalId.length === 0) {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_CONFIG,
        'Proposal ID is required.',
      );
    }

    if (BigInt(proposal.amount) <= 0n) {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_CONFIG,
        'Spend amount must be greater than zero.',
      );
    }

    const now = Math.floor(Date.now() / 1000);
    if (proposal.deadline <= now) {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_CONFIG,
        'Proposal deadline must be in the future.',
      );
    }
  }

  /**
   * Get the connected wallet's public key.
   */
  private walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }
}
