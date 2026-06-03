/**
 * Thin wrapper over `@ledgerhq/hw-app-solana` for the extension.
 *
 * THE SIGNING FOOTGUN (docs/pairing-ledger-spec.md §1B, Finding #13):
 *   Ledger's `signTransaction(path, buffer)` expects the COMPILED MESSAGE bytes
 *   (`tx.compileMessage().serialize()`), NOT a serialized `Transaction`. Passing
 *   the wrong bytes yields an invalid signature that fails on-chain with no clear
 *   device error. The signer (signer.ts) is the only caller and always passes
 *   message bytes.
 *
 * BLIND-SIGN (P01 blocker): every P01 pool instruction is a custom-program ix, so
 * the Solana app returns `0x6808 (BLIND_SIGNATURE_REQUIRED)` unless the on-device
 * "Allow blind sign" setting is ON. We pre-flight via {@link getAppConfiguration}
 * (`blindSigningEnabled`) and surface a one-time explainer, and we also catch the
 * raw `0x6808` at sign time as a fallback (the UI shows the same explainer).
 */

import Solana from '@ledgerhq/hw-app-solana';
import type Transport from '@ledgerhq/hw-transport';

/**
 * Solana-app status word returned when an instruction requires blind signing but
 * the device setting is OFF. Not a generic Ledger StatusCode — it is specific to
 * the Solana app, so we match it numerically.
 */
export const SW_BLIND_SIGNATURE_REQUIRED = 0x6808;
/** Status word returned when the user rejects the on-device prompt. */
export const SW_USER_REFUSED = 0x6985;

export interface LedgerAppConfig {
  blindSigningEnabled: boolean;
  version: string;
}

/** Thrown when the device needs "Allow blind sign" enabled to proceed. */
export class LedgerBlindSignRequiredError extends Error {
  constructor() {
    super(
      'Your Ledger needs blind signing enabled for Protocol-01. On the device, ' +
        'open the Solana app → Settings → Allow blind sign → Enabled, then retry.',
    );
    this.name = 'LedgerBlindSignRequiredError';
  }
}

/** Thrown when the user rejects the signing prompt on the device. */
export class LedgerUserRefusedError extends Error {
  constructor() {
    super('Signing was rejected on the Ledger device.');
    this.name = 'LedgerUserRefusedError';
  }
}

/** Build a Solana app instance bound to an already-open transport. */
export function getSolanaApp(transport: Transport): Solana {
  return new Solana(transport);
}

/**
 * Read the on-device public key for `path`, base58-encoded. `display` shows the
 * address on the device for the user to verify (used during connect).
 */
export async function getLedgerAddress(
  transport: Transport,
  path: string,
  display = false,
): Promise<string> {
  const app = getSolanaApp(transport);
  const { address } = await app.getAddress(path, display);
  // `address` is a Buffer of the raw 32-byte Ed25519 public key.
  const bs58 = (await import('bs58')).default;
  return bs58.encode(Uint8Array.from(address));
}

/** Read the Solana app configuration (blind-sign flag + version). */
export async function getLedgerAppConfiguration(transport: Transport): Promise<LedgerAppConfig> {
  const app = getSolanaApp(transport);
  const cfg = await app.getAppConfiguration();
  return { blindSigningEnabled: cfg.blindSigningEnabled, version: cfg.version };
}

/**
 * Sign COMPILED MESSAGE bytes with the device, returning the 64-byte Ed25519
 * signature. `messageBytes` MUST be `tx.compileMessage().serialize()` — see the
 * footgun note above.
 *
 * Maps the two P01-relevant status words to typed errors so the UI can react:
 *   - 0x6808 → {@link LedgerBlindSignRequiredError}
 *   - 0x6985 → {@link LedgerUserRefusedError}
 */
export async function signMessageBytesWithLedger(
  transport: Transport,
  path: string,
  messageBytes: Uint8Array,
): Promise<Uint8Array> {
  const app = getSolanaApp(transport);
  try {
    const { signature } = await app.signTransaction(
      path,
      Buffer.from(messageBytes),
    );
    return Uint8Array.from(signature);
  } catch (err) {
    const sw = (err as { statusCode?: number })?.statusCode;
    if (sw === SW_BLIND_SIGNATURE_REQUIRED) throw new LedgerBlindSignRequiredError();
    if (sw === SW_USER_REFUSED) throw new LedgerUserRefusedError();
    throw err;
  }
}
