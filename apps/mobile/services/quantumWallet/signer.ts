/**
 * Wallet signer abstraction for the quantum wallet stack.
 *
 * Unifies the two mobile signing paths (local Ed25519 Keypair vs Privy embedded
 * wallet) behind a single interface. All quantum-wallet services (initWallet,
 * autoDeposit, withdraw) accept a `WalletSigner` instead of a raw `Keypair`, so
 * they work transparently across both wallet types.
 *
 * Privy returns a `signTransaction(tx)` async fn; local keypair uses
 * `tx.partialSign(kp)`. Both end up with the same Transaction object signed
 * for the user's pubkey, ready to send via `sendRawTransaction`.
 */

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { useWalletStore, getPrivySigner } from '../../stores/walletStore';
import { getKeypair } from '../solana/wallet';

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

/** Resolve the current wallet signer, transparently handling Privy or local
 *  keypair. Throws if neither path can produce a signer (e.g. wallet not
 *  hydrated yet). */
export async function getCurrentWalletSigner(): Promise<WalletSigner> {
  const walletStore = useWalletStore.getState();

  if (walletStore.isPrivyWallet) {
    const signFn = getPrivySigner();
    const pubB58 = walletStore.publicKey;
    if (!signFn) throw new Error('Privy signer not available (provider not mounted or wallet not connected)');
    if (!pubB58) throw new Error('Privy wallet pubkey not yet hydrated');
    return {
      publicKey: new PublicKey(pubB58),
      signTransaction: signFn,
    };
  }

  // Local keypair fallback.
  const kp = await getKeypair();
  if (!kp) throw new Error('No wallet available — neither Privy nor local keypair.');
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
