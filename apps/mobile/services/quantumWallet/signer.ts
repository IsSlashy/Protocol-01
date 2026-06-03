/**
 * Wallet signer abstraction for the quantum wallet stack.
 *
 * Wraps the local Ed25519 Keypair signing path behind a single interface. All
 * quantum-wallet services (initWallet, autoDeposit, withdraw) accept a
 * `WalletSigner` instead of a raw `Keypair`.
 *
 * Local keypair uses `tx.partialSign(kp)` to produce a Transaction object signed
 * for the user's pubkey, ready to send via `sendRawTransaction`.
 *
 * NOTE: the former Privy embedded-wallet signing branch has been removed (Privy
 * removal, spec §3 Phase 1). `signMessage?` is reserved for the Phase 3 external
 * (software-wallet) signing path.
 */

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getKeypair } from '../solana/wallet';

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
  /** Phase 3 (external/software wallets): off-chain message signing for HKDF
   *  identity derivation. Undefined for the local-keypair path today. */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

/** Resolve the current wallet signer from the local keypair. Throws if no local
 *  keypair is available (e.g. wallet not hydrated yet). */
export async function getCurrentWalletSigner(): Promise<WalletSigner> {
  const kp = await getKeypair();
  if (!kp) throw new Error('No wallet available — local keypair missing.');
  return keypairToSigner(kp);
}

/** Wrap a raw Keypair into the WalletSigner interface (sync sign via
 *  `partialSign`). Used by tests, the STARK ephemeral submitter, and the
 *  local-keypair branch of `getCurrentWalletSigner`. */
export function keypairToSigner(kp: Keypair): WalletSigner {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
  };
}
