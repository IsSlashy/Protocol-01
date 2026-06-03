/**
 * Ledger hardware-wallet service surface (extension).
 *
 * Re-exports the path / transport / solana-app / signer / spending-seed helpers
 * so callers import from a single `services/ledger` entry point. See each module
 * for the load-bearing constraints (docs/pairing-ledger-spec.md §1B / §0).
 */

export {
  DEFAULT_LEDGER_PATH,
  isValidLedgerPath,
  ledgerPathForAccount,
} from './path';

export {
  isWebHidSupported,
  isWebUsbSupported,
  isLedgerSupported,
  openLedgerTransport,
  getActiveLedgerTransport,
  closeLedgerTransport,
  LedgerTransportUnsupportedError,
  LedgerTransportContextError,
} from './transport';

export {
  getSolanaApp,
  getLedgerAddress,
  getLedgerAppConfiguration,
  signMessageBytesWithLedger,
  LedgerBlindSignRequiredError,
  LedgerUserRefusedError,
  SW_BLIND_SIGNATURE_REQUIRED,
  SW_USER_REFUSED,
  type LedgerAppConfig,
} from './solanaApp';

export {
  makeLedgerWalletSigner,
  getSpendingSeed,
  LedgerNoMessageSigningError,
  LedgerNotConnectedError,
  type LedgerSignerConfig,
} from './signer';

export {
  generateSpendingSeed,
  hasSpendingSeed,
  storeSpendingSeed,
  importSpendingSeed,
  removeSpendingSeed,
} from './spendingSeed';
