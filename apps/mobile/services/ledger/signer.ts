/**
 * Ledger WalletSigner (mobile).
 *
 * Wraps a connected Ledger transport into the app's `WalletSigner` interface so it
 * plugs into the existing seam at services/denominatedPool/index.ts `signAndSend`
 * (which already branches on `walletSigner`) with NO service-layer signature
 * change.
 *
 * Division of labor (spec §1B/§1C, §0):
 *   - The Ledger co-signs the on-chain tx ONLY.
 *   - The ZK spending seed is a SEPARATE CSPRNG 32-byte value (spendingSeed.ts),
 *     fed RAW to the note pipelines. The Ledger never touches it.
 *
 * No off-chain message signing: P01's `signMessage` path was used for the old
 * Privy HKDF note-seed ceremony. A hardware wallet derives notes from its random
 * spending seed instead, so `signMessage` MUST throw — we surface
 * `LedgerNoMessageSigningError` rather than silently calling the device's
 * off-chain message API (which would produce an unrelated signature).
 */

import type Transport from '@ledgerhq/hw-transport';
import { PublicKey, Transaction } from '@solana/web3.js';
import type { WalletSigner } from '../denominatedPool';
import {
  DEFAULT_LEDGER_PATH,
  getLedgerAppConfig,
  signTransactionWithLedger,
  LedgerBlindSignRequiredError,
} from './solanaApp';

/** Thrown when a caller asks a hardware wallet to sign an off-chain message. */
export class LedgerNoMessageSigningError extends Error {
  constructor() {
    super(
      'Hardware wallets cannot sign off-chain messages in Protocol 01. Note ' +
        'identity is derived from the device-local spending seed, not a signed ' +
        'message.',
    );
    this.name = 'LedgerNoMessageSigningError';
  }
}

export interface MakeLedgerSignerOptions {
  transport: Transport;
  publicKey: PublicKey;
  /** Persisted BIP44 path; defaults to the v1 fixed path. */
  path?: string;
  /**
   * Optional hook fired right before the device is prompted (UI shows the
   * "review on your Ledger" sheet). Throw from here to abort.
   */
  onBeforeSign?: (tx: Transaction) => void | Promise<void>;
  /**
   * Pre-flight the blind-sign flag before the FIRST sign of a session. P01 pool
   * ix are custom-program → require "Allow blind sign" ON. Defaults to true.
   */
  enforceBlindSign?: boolean;
}

/**
 * A WalletSigner that additionally carries a defined-but-throwing `signMessage`,
 * so any code path that probes for off-chain message signing (the old Privy/HKDF
 * ceremony) fails loudly with LedgerNoMessageSigningError instead of silently
 * treating a hardware wallet as a software wallet.
 */
export type LedgerWalletSigner = WalletSigner & {
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
};

/**
 * Build a `WalletSigner` backed by a connected Ledger. The returned signer is
 * passed wherever the app passes a `walletSigner` today (denominated pool STARK
 * flows, subscribe, etc.).
 */
export function makeLedgerWalletSigner(opts: MakeLedgerSignerOptions): LedgerWalletSigner {
  const { transport, publicKey } = opts;
  const path = opts.path ?? DEFAULT_LEDGER_PATH;
  const enforceBlindSign = opts.enforceBlindSign ?? true;
  let blindSignChecked = false;

  return {
    publicKey,
    signTransaction: async (tx: Transaction): Promise<Transaction> => {
      // Pre-flight blind signing once per signer — fail fast with the actionable
      // error before the user waits on a device prompt that will reject 0x6808.
      if (enforceBlindSign && !blindSignChecked) {
        try {
          const cfg = await getLedgerAppConfig(transport);
          if (!cfg.blindSigningEnabled) {
            throw new LedgerBlindSignRequiredError();
          }
        } catch (err) {
          if (err instanceof LedgerBlindSignRequiredError) throw err;
          // Config read failed (older app, transient) — don't block; the device
          // will surface 0x6808 itself and signTransactionWithLedger maps it.
        }
        blindSignChecked = true;
      }

      if (opts.onBeforeSign) {
        await opts.onBeforeSign(tx);
      }

      return signTransactionWithLedger(transport, tx, publicKey, path);
    },
    // Defined-but-throwing: hardware never signs off-chain messages here. Note
    // identity is derived from the device-local spending seed, not a signature.
    signMessage: async (): Promise<Uint8Array> => {
      throw new LedgerNoMessageSigningError();
    },
  };
}
