import { PublicKey } from '@solana/web3.js';

/**
 * Known clusters supported by Protocol 01.
 *
 * `mainnet-beta` is listed here but note that both programs (`zk_shielded`
 * and `p01_registry`) are **not yet deployed on mainnet**.  Constructing a
 * `MerchantSdkConfig` with `cluster: 'mainnet-beta'` without also supplying
 * explicit `programIds` overrides will throw at runtime so merchants cannot
 * accidentally point at a non-existent program.
 */
export type SupportedCluster = 'devnet' | 'mainnet-beta';

/**
 * Program ID overrides.  Both programs default to devnet values — supply
 * mainnet IDs once the programs are deployed on mainnet.
 */
export interface ProgramIdOverrides {
  /**
   * `zk_shielded` program — governs `SubscriptionVault` accounts.
   * Devnet default: `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`
   */
  zkShielded?: PublicKey;
  /**
   * `p01_registry` program — governs `ServiceRegistry` accounts.
   * Devnet default: `QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB`
   */
  registry?: PublicKey;
}

/**
 * Top-level configuration passed to merchant-sdk entry points.
 *
 * @example — minimal devnet usage (defaults)
 * ```ts
 * import { Connection } from '@solana/web3.js';
 * const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com');
 * // no MerchantSdkConfig needed — devnet defaults apply automatically
 * ```
 *
 * @example — mainnet (once programs are deployed)
 * ```ts
 * const sdkConfig: MerchantSdkConfig = {
 *   cluster: 'mainnet-beta',
 *   programIds: {
 *     zkShielded: new PublicKey('YOUR_MAINNET_ZK_SHIELDED_PROGRAM_ID'),
 *     registry:   new PublicKey('YOUR_MAINNET_REGISTRY_PROGRAM_ID'),
 *   },
 * };
 * ```
 */
export interface MerchantSdkConfig {
  /**
   * Target cluster.  Default: `'devnet'`.
   *
   * ⚠ Setting `'mainnet-beta'` without supplying `programIds` overrides will
   * throw — the programs are not yet live on mainnet.
   */
  cluster?: SupportedCluster;
  /**
   * Override individual program IDs.  Useful when you fork/redeploy the
   * programs or when mainnet IDs become available.
   */
  programIds?: ProgramIdOverrides;
  /**
   * Override the RPC endpoint for operations that need to construct their
   * own `Connection` (e.g. helpers that don't receive one as a parameter).
   * Most SDK functions take an explicit `Connection`; this field is only
   * used by the rare utilities that need to know the default endpoint.
   *
   * Prefer passing your own `Connection` rather than relying on this field.
   *
   * @example
   * ```ts
   * { rpcUrl: process.env.RPC_URL }
   * ```
   */
  rpcUrl?: string;
}

// ---------------------------------------------------------------------------
// Well-known devnet defaults
// ---------------------------------------------------------------------------

/** `zk_shielded` devnet program ID (v0.9.9+, V4 pool seed). */
export const ZK_SHIELDED_PROGRAM_ID_DEVNET = new PublicKey(
  'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
);

/** `p01_registry` devnet program ID. */
export const REGISTRY_PROGRAM_ID_DEVNET = new PublicKey(
  'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB',
);

/**
 * Mainnet program IDs are a placeholder (`PublicKey.default`) until the
 * programs are deployed.  Exported so downstream code can check whether
 * mainnet is available.
 *
 * @internal
 */
export const ZK_SHIELDED_PROGRAM_ID_MAINNET = PublicKey.default;
/** @internal */
export const REGISTRY_PROGRAM_ID_MAINNET = PublicKey.default;

// ---------------------------------------------------------------------------
// Resolved config helpers
// ---------------------------------------------------------------------------

/** @internal */
export interface ResolvedProgramIds {
  zkShielded: PublicKey;
  registry: PublicKey;
}

/**
 * Resolve the effective program IDs from a `MerchantSdkConfig`, throwing an
 * informative error when a mainnet ID is requested but not yet available.
 *
 * @internal
 */
export function resolveProgramIds(config: MerchantSdkConfig = {}): ResolvedProgramIds {
  const cluster = config.cluster ?? 'devnet';

  const defaultZkShielded =
    cluster === 'mainnet-beta' ? ZK_SHIELDED_PROGRAM_ID_MAINNET : ZK_SHIELDED_PROGRAM_ID_DEVNET;
  const defaultRegistry =
    cluster === 'mainnet-beta' ? REGISTRY_PROGRAM_ID_MAINNET : REGISTRY_PROGRAM_ID_DEVNET;

  const zkShielded = config.programIds?.zkShielded ?? defaultZkShielded;
  const registry = config.programIds?.registry ?? defaultRegistry;

  // Guard: mainnet default is PublicKey.default (all zeros) — not a real program.
  if (zkShielded.equals(PublicKey.default)) {
    throw new Error(
      'zk_shielded is not yet deployed on mainnet-beta. ' +
        'Supply a programIds.zkShielded override once the program is live, ' +
        'or use cluster: "devnet" for testing.',
    );
  }
  if (registry.equals(PublicKey.default)) {
    throw new Error(
      'p01_registry is not yet deployed on mainnet-beta. ' +
        'Supply a programIds.registry override once the program is live, ' +
        'or use cluster: "devnet" for testing.',
    );
  }

  return { zkShielded, registry };
}
