/**
 * Ledger Solana app wrapper (mobile).
 *
 * Thin layer over @ledgerhq/hw-app-solana that:
 *   - resolves the on-chain pubkey for a BIP44 path
 *   - reads the on-device blind-signing flag (P01 pool ix are custom-program →
 *     require "Allow blind sign" ON)
 *   - signs a COMPILED MESSAGE (the footgun — see below)
 *
 * THE FOOTGUN (spec §1B/§1C, Finding #13): `signTransaction` expects the
 * serialized MESSAGE bytes (`tx.compileMessage().serialize()`), NOT a serialized
 * Transaction. We compile the message here and the caller (signer.ts) reattaches
 * the returned 64-byte signature via `tx.addSignature(pubkey, signature)`.
 *
 * BIP44 path: fixed `44'/501'/0'/0'` for v1 (locked decision), but the value is
 * passed in + persisted as `ledgerPath` so a future account-index chooser is a
 * data change, not a code change.
 *
 * Blind-sign: P01 custom-program ix throw StatusCode 0x6808
 * (BLIND_SIGNATURE_REQUIRED) unless the user enabled "Allow blind sign" in the
 * on-device Solana app. We surface that as a typed error so the UI can show the
 * one-time explainer.
 */

import Solana from '@ledgerhq/hw-app-solana';
import type Transport from '@ledgerhq/hw-transport';
import { PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';

/** v1 fixed Solana BIP44 derivation path (locked decision). */
export const DEFAULT_LEDGER_PATH = "44'/501'/0'/0'";

/**
 * Ledger status code returned when a custom-program (blind) tx is submitted but
 * on-device blind signing is disabled.
 */
export const STATUS_BLIND_SIGN_REQUIRED = 0x6808;
/** Ledger status code returned when the user rejects the on-device prompt. */
export const STATUS_USER_REJECTED = 0x6985;

/** Thrown when the device requires "Allow blind sign" but it is OFF. */
export class LedgerBlindSignRequiredError extends Error {
  constructor() {
    super(
      'Blind signing is required for Protocol 01 transactions. On your Ledger, ' +
        'open the Solana app → Settings → enable "Allow blind sign", then try again.',
    );
    this.name = 'LedgerBlindSignRequiredError';
  }
}

/** Thrown when the user rejects the transaction on the device. */
export class LedgerUserRejectedError extends Error {
  constructor() {
    super('Transaction rejected on the Ledger device.');
    this.name = 'LedgerUserRejectedError';
  }
}

function statusCodeOf(err: unknown): number | null {
  const e = err as { statusCode?: number; statusText?: string } | undefined;
  return typeof e?.statusCode === 'number' ? e.statusCode : null;
}

/** Map raw Ledger errors to typed app errors (best-effort). */
export function mapLedgerError(err: unknown): Error {
  const code = statusCodeOf(err);
  if (code === STATUS_BLIND_SIGN_REQUIRED) return new LedgerBlindSignRequiredError();
  if (code === STATUS_USER_REJECTED) return new LedgerUserRejectedError();
  return err instanceof Error ? err : new Error(String(err));
}

export interface LedgerAppConfig {
  blindSigningEnabled: boolean;
  version: string;
}

/**
 * Resolve the Solana pubkey for the given path. `display=true` shows the address
 * on the device for user confirmation (used during connect).
 */
export async function getLedgerAddress(
  transport: Transport,
  path: string = DEFAULT_LEDGER_PATH,
  display = false,
): Promise<PublicKey> {
  const solana = new Solana(transport);
  const { address } = await solana.getAddress(path, display);
  // `address` is the raw 32-byte Ed25519 pubkey.
  return new PublicKey(new Uint8Array(address));
}

/** Read the on-device app configuration (blind-sign flag + version). */
export async function getLedgerAppConfig(transport: Transport): Promise<LedgerAppConfig> {
  const solana = new Solana(transport);
  const cfg = await solana.getAppConfiguration();
  return { blindSigningEnabled: cfg.blindSigningEnabled, version: cfg.version };
}

/**
 * Sign a Solana transaction with the Ledger and return the SAME transaction with
 * the device signature attached.
 *
 * THE FOOTGUN: we sign the compiled MESSAGE bytes, not a serialized Transaction.
 * The caller must have already set `recentBlockhash` and `feePayer` (= the Ledger
 * pubkey) — the ordering rule (spec §1C, Finding #13) is: proof → assemble ix →
 * FRESH blockhash → compileMessage → device prompt.
 */
export async function signTransactionWithLedger(
  transport: Transport,
  tx: Transaction,
  ledgerPubkey: PublicKey,
  path: string = DEFAULT_LEDGER_PATH,
): Promise<Transaction> {
  if (!tx.recentBlockhash) {
    throw new Error('Ledger sign: transaction is missing recentBlockhash');
  }
  if (!tx.feePayer) {
    tx.feePayer = ledgerPubkey;
  }

  const solana = new Solana(transport);
  // MESSAGE bytes — NOT tx.serialize().
  const messageBytes = tx.compileMessage().serialize();

  let signature: Buffer;
  try {
    const res = await solana.signTransaction(path, Buffer.from(messageBytes));
    signature = res.signature;
  } catch (err) {
    throw mapLedgerError(err);
  }

  tx.addSignature(ledgerPubkey, Buffer.from(signature));
  return tx;
}
