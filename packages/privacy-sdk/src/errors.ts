export enum PrivacyErrorCode {
  // ─── General (1xxx) ──────────────────────────────────────────────────
  WALLET_NOT_CONNECTED = 1001,
  INVALID_CONFIG = 1002,
  NETWORK_MISMATCH = 1003,
  UNSUPPORTED_TOKEN = 1004,
  TRANSACTION_FAILED = 1005,
  TIMEOUT = 1006,

  // ─── Retired in 2.0.0, with the modules that threw them (CHANGELOG.md):
  //   2xxx shield / liquidity, 3xxx stealth, 4xxx confidential, 5xxx streams,
  //   6xxx subscriptions, 7xxx vault, 9xxx private governance (MPC).
  //   The numbers are not reused.

  // ─── Relay (8xxx) ───────────────────────────────────────────────────
  RELAY_SUBMIT_FAILED = 8001,
  RELAY_NO_ACTIVE_RELAYERS = 8002,
  RELAY_JOB_EXPIRED = 8003,
  RELAY_ENCRYPTION_FAILED = 8004,

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

  static txFailed(operation: string, cause?: Error): PrivacyError {
    return new PrivacyError(
      PrivacyErrorCode.TRANSACTION_FAILED,
      `Transaction failed during ${operation}.`,
      cause,
    );
  }
}
