/**
 * Ledger WalletSigner builder (extension).
 *
 * Produces a {@link WalletSigner} whose `signTransaction` co-signs the on-chain
 * transaction with the Ledger device. It plugs into the SAME seam every ZK
 * service already uses (denominatedPool / subscriptionVault / shielded), so no
 * service-layer signature changes are needed: the service assembles the full ix
 * set, generates the STARK proof (~2 min), sets a FRESH blockhash + feePayer at
 * submit time, and THEN calls `signer.signTransaction(tx)`. That call order is
 * exactly the proof → assemble → fresh-blockhash → device-sign ordering the spec
 * mandates (Finding #13) — the device is only ever prompted at the very end.
 *
 * THE FOOTGUN (Finding #13): we sign `tx.compileMessage().serialize()` (the
 * MESSAGE bytes), not a serialized Transaction, then attach the returned
 * signature with `tx.addSignature(ledgerPubkey, signature)`.
 *
 * NO OFF-CHAIN MESSAGE SIGNING (§1B): a hardware wallet refuses `signMessage`
 * — the ZK note identity comes from the separate spending seed (spendingSeed.ts),
 * never from an Ed25519 message signature. Any caller that reaches for message
 * signing on a hardware wallet gets {@link LedgerNoMessageSigningError}.
 */

import { PublicKey, Transaction } from '@solana/web3.js';
import type { WalletSigner } from '../stark';
import { signMessageBytesWithLedger } from './solanaApp';
import { getActiveLedgerTransport } from './transport';
import { getSpendingSeed as readSpendingSeed } from './spendingSeed';

/**
 * Thrown when off-chain message signing is attempted on a hardware wallet. The
 * Solana Ledger app has no general-purpose message signer we rely on, and the ZK
 * identity must NOT be tied to one (§0/§1B).
 */
export class LedgerNoMessageSigningError extends Error {
  constructor() {
    super(
      'Hardware wallets cannot sign off-chain messages in Protocol-01. The private ' +
        'identity uses a separate device-encrypted seed, not a wallet signature.',
    );
    this.name = 'LedgerNoMessageSigningError';
  }
}

/** Thrown when a sign is requested but no Ledger transport is open on this page. */
export class LedgerNotConnectedError extends Error {
  constructor() {
    super('Ledger is not connected. Reconnect your Ledger and try again.');
    this.name = 'LedgerNotConnectedError';
  }
}

export interface LedgerSignerConfig {
  /** base58 public key reported by the device at connect time. */
  publicKey: string;
  /** Persisted BIP44 path used to sign (e.g. `44'/501'/0'/0'`). */
  ledgerPath: string;
  /**
   * Called right before the device prompt so the UI can show the per-sign review
   * modal (blind-sign explainer, 0x6808 handling). Optional.
   */
  onBeforeSign?: () => void;
}

/**
 * Build a hardware WalletSigner. The returned `signTransaction`:
 *   1. ensures a recentBlockhash + feePayer are set (the service usually sets a
 *      FRESH one just before calling us; we never overwrite an existing one),
 *   2. compiles the message and serializes it,
 *   3. prompts the device (via onBeforeSign → device APDU),
 *   4. attaches the returned signature.
 *
 * Requires an OPEN transport (opened on the connect tab). Because Ledger signing
 * only happens on that tab, this builder reads the active transport at sign time.
 */
export function makeLedgerWalletSigner(config: LedgerSignerConfig): WalletSigner {
  const ledgerPubkey = new PublicKey(config.publicKey);

  return {
    publicKey: ledgerPubkey,
    signTransaction: async (tx: Transaction): Promise<Transaction> => {
      const transport = getActiveLedgerTransport();
      if (!transport) throw new LedgerNotConnectedError();

      if (!tx.feePayer) tx.feePayer = ledgerPubkey;
      if (!tx.recentBlockhash) {
        throw new Error(
          'Ledger signer expected a recent blockhash to be set before signing. ' +
            'This is a bug in the calling flow (proof → assemble → fresh blockhash → sign).',
        );
      }

      // MESSAGE bytes — not a serialized Transaction (footgun).
      const messageBytes = tx.compileMessage().serialize();

      config.onBeforeSign?.();
      const signature = await signMessageBytesWithLedger(
        transport,
        config.ledgerPath,
        messageBytes,
      );

      tx.addSignature(ledgerPubkey, Buffer.from(signature));
      return tx;
    },
  };
}

/**
 * Derive the hardware ZK spending seed (RAW 32 bytes, §0) for a Ledger wallet.
 * Thin re-export so callers branch via a single `services/ledger` surface; the
 * caller MUST `fill(0)` the result after feeding the note pipeline.
 */
export async function getSpendingSeed(
  publicKey: string,
  password: string,
): Promise<Uint8Array> {
  return readSpendingSeed(publicKey, password);
}
