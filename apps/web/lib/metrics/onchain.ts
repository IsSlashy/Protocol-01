/**
 * Live, privacy-safe on-chain reader for the explorer.
 *
 * We enumerate the shielded program's DenominatedPool accounts directly via
 * getProgramAccounts (filtered to the account discriminator) and aggregate
 * their public, fixed fields: denomination + note_count. note_count is the
 * anonymity-set size; TVL = note_count × denomination. We never read note
 * contents, owners, or anything linkable — that's the whole point.
 *
 * Pools from superseded seed versions (v2/v3/v4) can coexist on-chain for the
 * same (token, denomination); we keep the one with the most notes (the active
 * pool) rather than summing distinct, unrelated anonymity sets.
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

const DENOM_POOL_DISC = createHash('sha256').update('account:DenominatedPool').digest().subarray(0, 8);

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

/** DenominatedPool layout after the 8-byte discriminator:
 *  32 authority + 32 token_mint + 8 denomination + 8 epoch_delay +
 *  32 root + 1 tree_depth + 8 next_leaf_index. */
function parsePool(data: Buffer, address: string): PoolMetric | null {
  try {
    // note_count is the last field we read (8 bytes ending at offset 129).
    if (data.length < 129) return null;
    if (!data.subarray(0, 8).equals(DENOM_POOL_DISC)) return null;
    const mintBuf = data.subarray(8 + 32, 8 + 64);
    const mint = mintBuf.equals(ZERO_MINT)
      ? '11111111111111111111111111111111'
      : new PublicKey(mintBuf).toBase58();
    const info = MINT_INFO[mint];
    if (!info) return null; // only surface known tokens
    const denomBase = Number(data.readBigUInt64LE(8 + 64));
    const noteCount = Number(data.readBigUInt64LE(8 + 113));
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
    relayer: null,
  };
}

export async function readNetworkMetrics(): Promise<NetworkMetrics> {
  const url = rpcUrl();
  const rpcHost = hostOf(url);
  try {
    const conn = new Connection(url, 'confirmed');

    // Fetch only the bytes we parse (no leaf data) for every program account,
    // then keep the DenominatedPool ones. dataSlice keeps the payload tiny.
    const accounts = await conn.getProgramAccounts(ZK_SHIELDED, {
      dataSlice: { offset: 0, length: 160 },
    });

    // Collapse seed variants: keep the most-populated pool per (token, denom).
    const best = new Map<string, PoolMetric>();
    let denomPools = 0;
    for (const { pubkey, account } of accounts) {
      const buf = Buffer.from(account.data);
      if (buf.length >= 8 && buf.subarray(0, 8).equals(DENOM_POOL_DISC)) denomPools++;
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
      relayer: null,
      debug: { rpcHost, scanned: accounts.length, denomPools, withNotes: pools.length },
    };
  } catch (e) {
    const r = empty(false);
    r.debug = { rpcHost, scanned: 0, denomPools: 0, withNotes: 0, error: (e as Error)?.message ?? 'unknown' };
    return r;
  }
}
