/**
 * Explorer URL builders for Solana transactions and addresses.
 */

import type { SolanaCluster } from './endpoints';

/**
 * Build a Solana Explorer URL for a transaction signature or account address.
 */
export function getExplorerUrl(
  value: string,
  cluster: SolanaCluster,
  type: 'tx' | 'address' = 'tx',
): string {
  const base = 'https://explorer.solana.com';
  const path = type === 'tx' ? 'tx' : 'address';
  const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `${base}/${path}/${value}${clusterParam}`;
}

/**
 * Build a Solscan URL for a transaction signature or account address.
 * Solscan supports mainnet and devnet.
 */
export function getSolscanUrl(
  value: string,
  cluster: SolanaCluster,
  type: 'tx' | 'address' = 'tx',
): string {
  const path = type === 'tx' ? 'tx' : 'account';

  if (cluster === 'devnet') {
    return `https://solscan.io/${path}/${value}?cluster=devnet`;
  }

  // mainnet (solscan doesn't support testnet/localnet)
  return `https://solscan.io/${path}/${value}`;
}
