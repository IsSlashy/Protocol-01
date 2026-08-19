export enum PrivacyErrorCode {
  // ─── General (1xxx) ──────────────────────────────────────────────────
  WALLET_NOT_CONNECTED = 1001,
  INVALID_CONFIG = 1002,
  NETWORK_MISMATCH = 1003,
  UNSUPPORTED_TOKEN = 1004,
  TRANSACTION_FAILED = 1005,
  TIMEOUT = 1006,

  // ─── Shield (2xxx) ──────────────────────────────────────────────────
  SHIELD_FAILED = 2001,
  UNSHIELD_FAILED = 2002,
  INSUFFICIENT_SHIELDED_BALANCE = 2003,
  PROOF_GENERATION_FAILED = 2004,
  INVALID_MERKLE_PROOF = 2005,
  NULLIFIER_ALREADY_SPENT = 2006,
  POOL_NOT_FOUND = 2007,
  DENOMINATION_MISMATCH = 2008,

  // ─── Stealth (3xxx) ─────────────────────────────────────────────────
  STEALTH_SEND_FAILED = 3001,
  STEALTH_SCAN_FAILED = 3002,
  STEALTH_CLAIM_FAILED = 3003,
  INVALID_META_ADDRESS = 3004,
  VIEWING_KEY_REQUIRED = 3005,
  SPENDING_KEY_REQUIRED = 3006,

  // ─── Confidential (4xxx) ────────────────────────────────────────────
  CONFIDENTIAL_DEPOSIT_FAILED = 4001,
  CONFIDENTIAL_TRANSFER_FAILED = 4002,
  CONFIDENTIAL_WITHDRAW_FAILED = 4003,
  ACCOUNT_NOT_INITIALIZED = 4004,
  BALANCE_PROOF_FAILED = 4005,

  // ─── Streams (5xxx) ─────────────────────────────────────────────────
  STREAM_CREATE_FAILED = 5001,
  STREAM_WITHDRAW_FAILED = 5002,
  STREAM_CANCEL_FAILED = 5003,
  STREAM_NOT_FOUND = 5004,
  STREAM_EXHAUSTED = 5005,

  // ─── Subscriptions (6xxx) ───────────────────────────────────────────
  SUBSCRIPTION_CREATE_FAILED = 6001,
  SUBSCRIPTION_CANCEL_FAILED = 6002,
  SUBSCRIPTION_PAUSE_FAILED = 6003,
  SUBSCRIPTION_NOT_FOUND = 6004,

  // ─── Vault (7xxx) ───────────────────────────────────────────────────
  VAULT_CREATE_FAILED = 7001,
  VAULT_DEPOSIT_FAILED = 7002,
  VAULT_WITHDRAW_FAILED = 7003,
  VAULT_LOCKED = 7004,
  WOTS_KEY_EXHAUSTED = 7005,

  // ─── Relay (8xxx) ───────────────────────────────────────────────────
  RELAY_SUBMIT_FAILED = 8001,
  RELAY_NO_ACTIVE_RELAYERS = 8002,
  RELAY_JOB_EXPIRED = 8003,
  RELAY_ENCRYPTION_FAILED = 8004,

  // ─── MPC (9xxx) ─────────────────────────────────────────────────────
  MPC_VOTE_FAILED = 9001,
  MPC_AUDIT_FAILED = 9002,
  MPC_PROPOSAL_EXPIRED = 9003,
  MPC_ALREADY_VOTED = 9004,
  MPC_AUCTION_FAILED = 9005,
  MPC_NOT_AVAILABLE = 9006,

  // ─── Registry (10xxx) ───────────────────────────────────────────────
  REGISTRY_NOT_FOUND = 10001,
  REGISTRY_ALREADY_EXISTS = 10002,
  REGISTRY_UPDATE_FAILED = 10003,

}

export class PrivacyError extends Error {
  readonly code: PrivacyErrorCode;
  readonly cause?: Error;

  constructor(code: PrivacyErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'PrivacyError';
    this.code = code;
    this.cause = cause;
  }

  static walletNotConnected(): PrivacyError {
    return new PrivacyError(
      PrivacyErrorCode.WALLET_NOT_CONNECTED,
      'Wallet not connected. Pass a wallet in PrivacySDK config.',
    );
  }

  static unsupportedToken(symbol: string): PrivacyError {
    return new PrivacyError(
      PrivacyErrorCode.UNSUPPORTED_TOKEN,
      `Token "${symbol}" is not supported. Use SOL, USDC, or USDT, or pass a custom mint address.`,
    );
  }

  static proofFailed(circuit: string, cause?: Error): PrivacyError {
    return new PrivacyError(
      PrivacyErrorCode.PROOF_GENERATION_FAILED,
      `Proof generation failed for circuit "${circuit}".`,
      cause,
    );
  }

  static txFailed(operation: string, cause?: Error): PrivacyError {
    return new PrivacyError(
      PrivacyErrorCode.TRANSACTION_FAILED,
      `Transaction failed during ${operation}.`,
      cause,
    );
  }

  static poolNotFound(token: string, denominated?: boolean): PrivacyError {
    return new PrivacyError(
      PrivacyErrorCode.POOL_NOT_FOUND,
      `No ${denominated ? 'denominated ' : ''}pool found for token "${token}".`,
    );
  }

  static nullifierSpent(): PrivacyError {
    return new PrivacyError(
      PrivacyErrorCode.NULLIFIER_ALREADY_SPENT,
      'Note has already been spent (nullifier exists on-chain).',
    );
  }
}
