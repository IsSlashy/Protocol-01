// Error catalog for the on-chain `zk_shielded` program.
//
// Anchor assigns sequential codes to `#[error_code]` variants starting at 6000.
// This catalog lets the mobile client decode `simulateTransaction` failures into
// human-readable names instead of opaque numeric codes.
//
// Source: programs/zk_shielded/src/errors.rs (kept in sync manually).
// If a new variant is appended to that enum, add it here in the same order.

import type {
  RpcResponseAndContext,
  SimulatedTransactionResponse,
} from '@solana/web3.js';

/** Convenience alias matching what `connection.simulateTransaction` returns. */
export type SimResult = RpcResponseAndContext<SimulatedTransactionResponse>;

/** Map: Anchor error code -> { name, msg }. */
export const ZK_SHIELDED_ERRORS: Record<number, { name: string; msg: string }> = {
  6000: { name: 'InvalidProof', msg: 'Invalid ZK proof - verification failed' },
  6001: { name: 'NullifierAlreadySpent', msg: 'Nullifier has already been spent' },
  6002: { name: 'InvalidMerkleRoot', msg: 'Invalid Merkle root - not a known root' },
  6003: { name: 'PoolNotActive', msg: 'Pool is not active' },
  6004: { name: 'Unauthorized', msg: 'Unauthorized - not pool authority' },
  6005: { name: 'InvalidAmount', msg: 'Invalid amount - must be greater than zero' },
  6006: { name: 'MerkleTreeFull', msg: 'Merkle tree is full' },
  6007: { name: 'InsufficientBalance', msg: 'Insufficient shielded balance' },
  6008: { name: 'InvalidCommitment', msg: 'Invalid commitment format' },
  6009: { name: 'InvalidVerificationKey', msg: 'Invalid verification key' },
  6010: { name: 'BloomFilterHit', msg: 'Bloom filter indicates potential double spend' },
  6011: { name: 'TokenMintMismatch', msg: 'Token mint mismatch' },
  6012: { name: 'RelayerFeeExceedsMax', msg: 'Relayer fee exceeds maximum allowed' },
  6013: { name: 'InvalidPublicInputs', msg: 'Invalid public inputs' },
  6014: { name: 'ArithmeticOverflow', msg: 'Arithmetic overflow' },
  6015: { name: 'MissingTokenProgram', msg: 'Missing token program for SPL token operation' },
  6016: { name: 'MissingTokenAccount', msg: 'Missing user token account for SPL token operation' },
  6017: { name: 'MissingPoolVault', msg: 'Missing pool vault for SPL token operation' },
  6018: { name: 'InvalidTokenMint', msg: 'Invalid token mint' },
  6019: { name: 'InvalidTokenOwner', msg: 'Invalid token account owner' },
  6020: { name: 'InsufficientPoolBalance', msg: 'Insufficient pool balance for withdrawal' },
  6021: { name: 'InvalidDenomination', msg: 'Denomination must be greater than zero' },
  6022: { name: 'AmountMustEqualDenomination', msg: 'Deposit amount must equal pool denomination' },
  6023: { name: 'EpochDelayNotMet', msg: 'Epoch delay not met - note is too young' },
  6024: { name: 'InvalidEpochDelay', msg: 'Epoch delay must be greater than zero' },
  6025: { name: 'VaultNotActive', msg: 'Subscription vault is not active' },
  6026: { name: 'VaultAlreadyPaused', msg: 'Subscription vault is already paused' },
  6027: { name: 'VaultNotPaused', msg: 'Subscription vault is not paused' },
  6028: { name: 'UnauthorizedVaultSubscriber', msg: 'Unauthorized vault subscriber' },
  6029: { name: 'NoClaimablePeriods', msg: 'No claimable periods available' },
  6030: { name: 'InsufficientVaultBalance', msg: 'Insufficient vault balance for claim' },
  6031: { name: 'InvalidVaultMode', msg: 'Invalid vault mode for this operation' },
  6032: { name: 'InvalidRate', msg: 'Subscription rate must be greater than zero' },
  6033: { name: 'InvalidInterval', msg: 'Subscription interval must be greater than zero' },
  6034: { name: 'ExpectedNormalMode', msg: 'Expected normal (wallet) mode vault' },
  6035: { name: 'ExpectedPrivateMode', msg: 'Expected private (ZK) mode vault' },
  6036: { name: 'InvalidFeeWallet', msg: 'Invalid protocol fee wallet' },
  6037: { name: 'VkUpdateCooldown', msg: 'VK update cooldown period has not elapsed' },
  6038: { name: 'NoPendingAuthority', msg: 'No pending authority transfer' },
  6039: { name: 'PendingAuthorityMismatch', msg: 'Pending authority does not match signer' },
  6040: { name: 'InvalidSplitDenomination', msg: 'Invalid split denomination' },
  6041: { name: 'TooManyOutputs', msg: 'Too many split outputs - max 20' },
  6042: { name: 'InvalidOutputCount', msg: 'Invalid output count - must be 1..20' },
  6043: { name: 'RouteNotActive', msg: 'Privacy route is not active' },
  6044: { name: 'UnauthorizedRoute', msg: 'Unauthorized route access' },
  6045: { name: 'EscrowAlreadySettled', msg: 'Auction escrow has already been settled' },
  6046: { name: 'EscrowOutcomeNotSet', msg: 'Auction escrow outcome has not been determined yet' },
  6047: { name: 'EscrowAlreadyReleased', msg: 'Auction escrow has already been released' },
  6048: { name: 'InvalidAuctionId', msg: 'Invalid auction ID - does not match escrow' },
  6049: { name: 'AuctionNotFinalized', msg: 'Auction has not been finalized by MPC' },
};

export interface DecodedSimError {
  /** Top-level shape of the err object as returned by web3.js. */
  raw: unknown;
  /** Index of the failing instruction inside the transaction, if known. */
  ixIndex: number | null;
  /** Anchor error code if the failure was a Custom program error. */
  errorCode: number | null;
  /** Human-readable name from the catalog (or "Unknown" if not in map). */
  errorName: string;
  /** Human-readable message from the catalog (or null). */
  errorMsg: string | null;
  /** Top-level reason category for quick triage. */
  category:
    | 'merkle-root'
    | 'maturity'
    | 'nullifier'
    | 'verification'
    | 'authorization'
    | 'budget'
    | 'pool-state'
    | 'unknown';
  /** Lines from `simResult.value.logs` that mention "Program log" or errors. */
  programLogs: string[];
}

/**
 * Decode a `simulateTransaction` result. Always returns a structured object,
 * never throws. Designed to be safe to call from any error handler.
 */
export function decodeSimError(simResult: SimResult | null | undefined): DecodedSimError {
  const empty: DecodedSimError = {
    raw: null,
    ixIndex: null,
    errorCode: null,
    errorName: 'Unknown',
    errorMsg: null,
    category: 'unknown',
    programLogs: [],
  };
  if (!simResult || !simResult.value) return empty;

  const err = simResult.value.err;
  const logs = (simResult.value.logs || []).filter(
    (l) => l.startsWith('Program log:') || l.includes('Error') || l.includes('failed'),
  );

  const result: DecodedSimError = { ...empty, raw: err, programLogs: logs };

  // The `err` shape that interests us is:
  //   { InstructionError: [ <ix_index>, { Custom: <code> } ] }
  // It can also be a plain string, an object with other keys (e.g. AccountNotFound),
  // or null (sim succeeded — caller should not have called us).
  if (!err) return result;
  if (typeof err === 'string') {
    result.errorName = err;
    return result;
  }
  if (typeof err === 'object' && 'InstructionError' in (err as Record<string, unknown>)) {
    const ie = (err as { InstructionError: [number, unknown] }).InstructionError;
    if (Array.isArray(ie) && ie.length === 2) {
      result.ixIndex = typeof ie[0] === 'number' ? ie[0] : null;
      const inner = ie[1];
      if (inner && typeof inner === 'object' && 'Custom' in (inner as Record<string, unknown>)) {
        const code = (inner as { Custom: number }).Custom;
        if (typeof code === 'number') {
          result.errorCode = code;
          const entry = ZK_SHIELDED_ERRORS[code];
          if (entry) {
            result.errorName = entry.name;
            result.errorMsg = entry.msg;
          } else {
            result.errorName = `Custom(${code})`;
          }
        }
      } else if (typeof inner === 'string') {
        result.errorName = inner;
      } else if (inner && typeof inner === 'object') {
        // e.g. { ProgramFailedToComplete: ... }
        const key = Object.keys(inner as object)[0];
        if (key) result.errorName = key;
      }
    }
  }

  // Map error to a coarse category for quick triage.
  switch (result.errorCode) {
    case 6002: result.category = 'merkle-root'; break;
    case 6023: result.category = 'maturity'; break;
    case 6001:
    case 6010: result.category = 'nullifier'; break;
    case 6000:
    case 6009:
    case 6013: result.category = 'verification'; break;
    case 6004:
    case 6028:
    case 6044: result.category = 'authorization'; break;
    case 6007:
    case 6020:
    case 6030: result.category = 'budget'; break;
    case 6003:
    case 6006:
    case 6025:
    case 6043: result.category = 'pool-state'; break;
    default: result.category = 'unknown';
  }

  return result;
}
