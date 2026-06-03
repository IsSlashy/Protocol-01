/**
 * Ledger BIP44 derivation-path policy for Solana (Protocol-01 extension).
 *
 * v1 policy (docs/pairing-ledger-spec.md §5 Open-Q #6): a FIXED single account
 * path `44'/501'/0'/0'`. We still PERSIST the chosen `ledgerPath` (in the wallet
 * store + the encrypted identity backup) so a future account-index chooser can
 * vary it without breaking already-connected wallets — the persisted path is the
 * source of truth at sign time, never a hard-coded constant in the signer.
 *
 * Note on format: `@ledgerhq/hw-app-solana` expects the path WITHOUT a leading
 * `m/` and promotes every index to hardened (Solana = Ed25519 / SLIP-0010), so
 * the apostrophes here are cosmetic for humans; the app hardens regardless.
 */

/** The fixed v1 Solana account path. Persisted as `ledgerPath` on connect. */
export const DEFAULT_LEDGER_PATH = "44'/501'/0'/0'";

/**
 * Loose validation of a Solana BIP44 path string for hw-app-solana.
 * Accepts 2-5 segments of `<number>` optionally suffixed with `'` / `h`,
 * with an optional leading `m/`. Used to reject obviously-malformed persisted
 * paths before handing them to the device.
 */
export function isValidLedgerPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  const normalized = path.startsWith('m/') ? path.slice(2) : path;
  const segments = normalized.split('/');
  if (segments.length < 2 || segments.length > 5) return false;
  return segments.every((seg) => /^\d+['h]?$/.test(seg));
}

/**
 * Build the account path for a given account index, keeping the fixed
 * `44'/501'/<account>'/0'` shape. Reserved for a future account chooser; v1
 * only ever uses index 0 (== {@link DEFAULT_LEDGER_PATH}).
 */
export function ledgerPathForAccount(account: number): string {
  if (!Number.isInteger(account) || account < 0) {
    throw new Error(`Invalid Ledger account index: ${account}`);
  }
  return `44'/501'/${account}'/0'`;
}
