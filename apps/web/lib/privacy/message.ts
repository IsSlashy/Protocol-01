/**
 * Domain-separated derivation message.
 *
 * The user signs this fixed string once; the signature (Ed25519, deterministic)
 * is the ONLY source of the stealth spending/viewing/KEM keys — recoverable
 * from the wallet alone, never stored. Because any site that gets the exact
 * string signed can derive the same keys, the message:
 *   - names the origin the user must be on,
 *   - carries a Version (rotate to invalidate a leaked key set),
 *   - carries the chain + wallet so it reads unambiguously in the wallet dialog.
 *
 * The consumer MUST refuse to derive unless window.location.origin === origin.
 */

export const DERIVATION_VERSION = 'pay-keys-v2';

export function buildDerivationMessage(params: {
  walletPubkey: string;
  origin: string;
  chainTag: string; // e.g. 'solana:devnet'
}): string {
  const { walletPubkey, origin, chainTag } = params;
  return [
    'Protocol 01 — Private Payment Keys',
    '',
    'Sign to derive your stealth spending, viewing, and post-quantum',
    '(ML-KEM-768) keys. This does NOT send a transaction and costs no gas.',
    '',
    `ONLY sign this on ${origin}. Signing it elsewhere exposes your keys.`,
    '',
    `Domain: ${origin}`,
    `Chain: ${chainTag}`,
    `Wallet: ${walletPubkey}`,
    `Version: ${DERIVATION_VERSION}`,
  ].join('\n');
}
