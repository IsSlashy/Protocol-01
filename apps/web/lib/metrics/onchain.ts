/**
 * Live, privacy-safe on-chain reader for the explorer.
 *
 * Strategy (robust, no `getProgramAccounts` dependency): we derive the PDA of
 * every *known* denomination pool (token × denomination × candidate seed
 * version) and batch-read them with a single getMultipleAccounts. This works on
 * plain public RPC and survives seed bumps because we try every historical seed
 * and keep whichever account actually exists.
 *
 * Only aggregate counts/sums are returned. We read `note_count` (anonymity set)
 * and multiply by the fixed denomination for TVL — no note contents, no owners,
 * nothing linkable.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import type { NetworkMetrics, PoolMetric, Token } from './types';
import { STARK_CIRCUIT_LIST } from './types';

const ZK_SHIELDED = new PublicKey('2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms');

const MINTS: Record<Token, PublicKey> = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  USDT: new PublicKey('EJwZgeZrdC8TXTQbQBoL6bfuAnFUQQRb18wrLowMGerG'),
};

const DECIMALS: Record<Token, number> = { SOL: 9, USDC: 6, USDT: 6 };

// Base-unit denominations per token.
const DENOMS: Record<Token, number[]> = {
  SOL: [0.1e9, 1e9, 10e9, 100e9],
  USDC: [10e6, 100e6, 1000e6, 10000e6],
  USDT: [10e6, 100e6, 1000e6, 10000e6],
};

// Try newest seed first; keep whichever PDA actually exists on-chain.
const POOL_SEEDS = [
  'denominated_pool_v4',
  'denominated_pool_v3',
  'denominated_pool_v2',
  'denominated_pool',
];

function u64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(Math.round(n)));
  return b;
}

function rpcUrl(): string {
  return (
    process.env.SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    (process.env.HELIUS_API_KEY
      ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
      : 'https://api.devnet.solana.com')
  );
}

interface Candidate {
  token: Token;
  denomination: number; // base units
  pda: PublicKey;
}

function buildCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const token of Object.keys(MINTS) as Token[]) {
    for (const denom of DENOMS[token]) {
      for (const seed of POOL_SEEDS) {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from(seed), MINTS[token].toBuffer(), u64le(denom)],
          ZK_SHIELDED,
        );
        out.push({ token, denomination: denom, pda });
      }
    }
  }
  return out;
}

/** DenominatedPool layout after 8-byte discriminator: 32 authority + 32 mint +
 *  8 denomination + 8 epoch_delay + 32 root + 1 tree_depth + 8 next_leaf_index. */
function parseNoteCount(data: Buffer): number | null {
  try {
    if (data.length < 8 + 121 + 8) return null;
    return Number(data.readBigUInt64LE(8 + 113));
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
  try {
    const conn = new Connection(rpcUrl(), 'confirmed');
    const candidates = buildCandidates();

    // getMultipleAccounts caps at 100 keys per call; chunk to be safe.
    const infos: (Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>[number])[] = [];
    for (let i = 0; i < candidates.length; i += 100) {
      const chunk = candidates.slice(i, i + 100).map((c) => c.pda);
      const res = await conn.getMultipleAccountsInfo(chunk);
      infos.push(...res);
    }

    // Collapse seed variants: keep the existing account per (token, denomination).
    const best = new Map<string, PoolMetric>();
    candidates.forEach((c, i) => {
      const acc = infos[i];
      if (!acc?.data) return;
      const noteCount = parseNoteCount(Buffer.from(acc.data));
      if (noteCount == null) return;
      const denomUnits = c.denomination / 10 ** DECIMALS[c.token];
      const key = `${c.token}:${c.denomination}`;
      const metric: PoolMetric = {
        token: c.token,
        denomination: denomUnits,
        noteCount,
        tvl: noteCount * denomUnits,
        address: c.pda.toBase58(),
      };
      const prev = best.get(key);
      // Prefer the variant with notes; otherwise keep the first that exists.
      if (!prev || noteCount > prev.noteCount) best.set(key, metric);
    });

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
    };
  } catch {
    return empty(false);
  }
}
