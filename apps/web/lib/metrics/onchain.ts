/**
 * Live, privacy-safe on-chain reader for the explorer.
 *
 * We enumerate the shielded program's DenominatedPool accounts directly via
 * getProgramAccounts (filtered to the account discriminator) and aggregate
 * their public, fixed fields: denomination + note_count. TVL = note_count ×
 * denomination. We never read note contents, owners, or anything linkable —
 * that's the whole point.
 *
 * note_count is a POOL SIZE, not a delivered anonymity set. The v3 unshield
 * passes the note commitment as a public instruction argument (bytes 80..88)
 * and the deposit emitted the same value, so a withdrawal is publicly matchable
 * to its deposit and the effective anonymity set is ONE. Closing that needs the
 * C7 spend circuit (docs/C7_SPEND_CIRCUIT_PLAN.md). Copy rendered from these
 * numbers must not call them an anonymity set until it ships.
 *
 * Pools from superseded seed versions (v2/v3/v4) can coexist on-chain for the
 * same (token, denomination); we keep the one with the most notes (the active
 * pool) rather than summing distinct, unrelated pools.
 */
import { createHash } from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import type { NetworkMetrics, PoolMetric, Token } from './types';
import { STARK_CIRCUIT_LIST } from './types';

// The deployed (declare_id) shielded program on devnet — NOT the Anchor.toml
// dev alias, which is empty. Verified on-chain: 46 DenominatedPool accounts.
const ZK_SHIELDED = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');

// Native-SOL pools store token_mint = Pubkey::default (32 zero bytes), NOT the
// wrapped-SOL mint. Map both forms to SOL.
const ZERO_MINT = Buffer.alloc(32);

const MINT_INFO: Record<string, { token: Token; decimals: number }> = {
  '11111111111111111111111111111111': { token: 'SOL', decimals: 9 },
  So11111111111111111111111111111111111111112: { token: 'SOL', decimals: 9 },
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { token: 'USDC', decimals: 6 },
  EJwZgeZrdC8TXTQbQBoL6bfuAnFUQQRb18wrLowMGerG: { token: 'USDT', decimals: 6 },
};

// Standard product denominations, in base units. Non-standard (test) pools with
// arbitrary amounts are excluded — they aren't part of the denomination product
// and a 1-note "0.008 SOL" pool only adds noise (and zero anonymity).
const STD_DENOMS: Record<Token, Set<number>> = {
  SOL: new Set([0.1e9, 1e9, 10e9, 100e9]),
  USDC: new Set([10e6, 100e6, 1000e6, 10000e6]),
  USDT: new Set([10e6, 100e6, 1000e6, 10000e6]),
};

/**
 * The pools /pay actually uses are `DenominatedPoolV3`, so that is the name the
 * Anchor discriminator has to be built from.
 *
 * 🚨 It used to read `account:DenominatedPool`, which is the V2 struct. That
 * discriminator never matches a V3 account, so this page has never once counted
 * a pool the application writes to — it counted the deprecated v2 pools instead
 * (`lib.rs:152`: "Deprecated v2 (circuit-1 only, no C3 membership proof =
 * unshield-undeposited risk). Production is v3-only"). Two of those hold notes
 * whose spend instruction is commented out of the program, so their balance is
 * not a treasury and must not be presented as one.
 */
const DENOM_POOL_V3_DISC = createHash('sha256')
  .update('account:DenominatedPoolV3')
  .digest()
  .subarray(0, 8);

/**
 * `DenominatedPoolV3`, field by field, from `state/pool_v3.rs:53-84`.
 *
 * Written as a field LIST and not as offsets, then the offsets are derived. The
 * previous code carried the layout in a comment and the offsets as literals, and
 * the two disagreed: the comment ended the layout at `next_leaf_index` while the
 * literal `8 + 113` was labelled `noteCount`. 8 + 113 IS `next_leaf_index` — the
 * count of leaves ever inserted, which only equals the note count when nothing
 * has ever been spent. On the measured 1 SOL pool that is 25 against 6, so the
 * page would have overstated the anonymity set by a factor of four and the TVL
 * with it. Deriving from the list means a field added on chain shifts every
 * offset here at once instead of silently moving one.
 */
const POOL_V3_FIELDS = [
  ['discriminator', 8],
  ['authority', 32],
  ['token_mint', 32],
  ['denomination', 8],
  ['epoch_delay', 8],
  ['merkle_root', 32],
  ['tree_depth', 1],
  ['next_leaf_index', 8],
  ['vk_hash', 32],
  ['total_shielded', 8],
  ['note_count', 8],
] as const;

function offsetOf(field: (typeof POOL_V3_FIELDS)[number][0]): number {
  let at = 0;
  for (const [name, width] of POOL_V3_FIELDS) {
    if (name === field) return at;
    at += width;
  }
  throw new Error(`unknown pool field ${field}`);
}

export const POOL_V3_OFFSETS = {
  tokenMint: offsetOf('token_mint'),
  denomination: offsetOf('denomination'),
  nextLeafIndex: offsetOf('next_leaf_index'),
  totalShielded: offsetOf('total_shielded'),
  noteCount: offsetOf('note_count'),
};

/** Every byte the parser reads, so `dataSlice` cannot cut the last field off. */
export const POOL_V3_READ_LEN = POOL_V3_OFFSETS.noteCount + 8;

function rpcUrl(): string {
  // The shielded program is devnet-only, so we must hit a DEVNET endpoint.
  // A dedicated override wins; otherwise prefer Helius devnet (reliable for
  // getProgramAccounts from serverless), else the public devnet RPC. We do NOT
  // fall back to a generic SOLANA_RPC_URL here — it may point at mainnet, where
  // the devnet program has zero accounts (the exact 0-pool bug we hit).
  const heliusKey = process.env.HELIUS_API_KEY || process.env.NEXT_PUBLIC_HELIUS_API_KEY;
  return (
    process.env.EXPLORER_RPC_URL ||
    (heliusKey ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://api.devnet.solana.com')
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function parsePool(data: Buffer, address: string): PoolMetric | null {
  try {
    // Every field the parser reads must be present, `note_count` included. A
    // short buffer here means `dataSlice` was narrowed without updating
    // POOL_V3_READ_LEN, and reading past it would throw into the catch below and
    // silently drop the pool from the metrics.
    if (data.length < POOL_V3_READ_LEN) return null;
    if (!data.subarray(0, 8).equals(DENOM_POOL_V3_DISC)) return null;
    const mintBuf = data.subarray(POOL_V3_OFFSETS.tokenMint, POOL_V3_OFFSETS.tokenMint + 32);
    const mint = mintBuf.equals(ZERO_MINT)
      ? '11111111111111111111111111111111'
      : new PublicKey(mintBuf).toBase58();
    const info = MINT_INFO[mint];
    if (!info) return null; // only surface known tokens
    const denomBase = Number(data.readBigUInt64LE(POOL_V3_OFFSETS.denomination));
    // The anonymity set is the number of notes STILL IN the pool, which is what
    // `note_count` tracks. `next_leaf_index` counts leaves ever inserted and only
    // matches when nothing has been spent — 25 against 6 on the measured 1 SOL
    // pool. Quoting the wrong one overstates both the set and the TVL.
    const noteCount = Number(data.readBigUInt64LE(POOL_V3_OFFSETS.noteCount));
    if (!STD_DENOMS[info.token].has(denomBase)) return null; // standard denoms only
    const denomination = denomBase / 10 ** info.decimals;
    return {
      token: info.token,
      denomination,
      noteCount,
      tvl: noteCount * denomination,
      address,
    };
  } catch {
    return null;
  }
}

function empty(live: boolean): NetworkMetrics {
  return {
    live,
    network: 'devnet',
    snapshotAt: Date.now(),
    tvlByToken: { SOL: 0, USDC: 0, USDT: 0 },
    totalNotes: 0,
    activePools: 0,
    pools: [],
    circuits: STARK_CIRCUIT_LIST,
  };
}

export async function readNetworkMetrics(): Promise<NetworkMetrics> {
  const url = rpcUrl();
  const rpcHost = hostOf(url);
  try {
    const conn = new Connection(url, 'confirmed');

    // Fetch only the bytes we parse (no leaf data) for every program account,
    // then keep the DenominatedPool ones. dataSlice keeps the payload tiny.
    // The slice must cover every field the parser reads. It was 160, and
    // `note_count` ends at 177 — so even with the right offset the last field
    // would have been cut off and every pool silently dropped.
    const accounts = await conn.getProgramAccounts(ZK_SHIELDED, {
      dataSlice: { offset: 0, length: POOL_V3_READ_LEN },
    });

    // Collapse seed variants: keep the most-populated pool per (token, denom).
    const best = new Map<string, PoolMetric>();
    let denomPools = 0;
    for (const { pubkey, account } of accounts) {
      const buf = Buffer.from(account.data);
      if (buf.length >= 8 && buf.subarray(0, 8).equals(DENOM_POOL_V3_DISC)) denomPools++;
      const metric = parsePool(buf, pubkey.toBase58());
      if (!metric) continue;
      const key = `${metric.token}:${metric.denomination}`;
      const prev = best.get(key);
      if (!prev || metric.noteCount > prev.noteCount) best.set(key, metric);
    }

    const pools = [...best.values()].filter((p) => p.noteCount > 0);
    const tvlByToken: Record<Token, number> = { SOL: 0, USDC: 0, USDT: 0 };
    let totalNotes = 0;
    for (const p of pools) {
      tvlByToken[p.token] += p.tvl;
      totalNotes += p.noteCount;
    }
    pools.sort((a, b) => b.noteCount - a.noteCount);

    return {
      live: true,
      network: 'devnet',
      snapshotAt: Date.now(),
      tvlByToken,
      totalNotes,
      activePools: pools.length,
      pools,
      circuits: STARK_CIRCUIT_LIST,
      debug: { rpcHost, scanned: accounts.length, denomPools, withNotes: pools.length },
    };
  } catch (e) {
    const r = empty(false);
    r.debug = { rpcHost, scanned: 0, denomPools: 0, withNotes: 0, error: (e as Error)?.message ?? 'unknown' };
    return r;
  }
}
