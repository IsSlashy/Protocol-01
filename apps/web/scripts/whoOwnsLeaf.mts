/**
 * Which of the treasury's seeds owns a given leaf?
 *
 * 🚨 WRITTEN BECAUSE THE ANSWER DECIDED WHETHER A BUYER GOT THEIR MONEY BACK.
 * `contribute-note` confirms a leaf by deriving from the ACTIVE seed only — the
 * first in the list — while the scan that reports what the treasury owns tries
 * every seed. So a leaf can be "owned by the treasury" and still be unconfirmable,
 * and the route's refusal ("no commitment derived from this treasury sits at that
 * index") reads like the leaf is missing when it is merely owned by a different
 * seed of the same treasury.
 *
 * Read-only.
 *
 *   cd apps/web && npx tsx scripts/whoOwnsLeaf.mts 94 95 96 97 98
 */
import { readFileSync } from 'node:fs';
import { Connection } from '@solana/web3.js';

import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  getPoolsForTokenV3,
  pubkeyToField,
} from '../lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '../lib/privacy/pool/noteBlinding';

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

async function main() {
  const e = env();
  const seeds = (e.P01_TREASURY_POOL_SEED ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^[0-9a-fA-F]{64}$/.test(p))
    .map((p) => Uint8Array.from(p.match(/../g)!.map((h) => parseInt(h, 16))));
  if (seeds.length === 0) throw new Error('no well-formed seed in P01_TREASURY_POOL_SEED');

  const denomination = Number(e.P01_TREASURY_NOTE_DENOMINATION ?? '0.1');
  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === denomination);
  if (!pool) throw new Error(`no ${denomination} SOL pool is configured`);

  const leaves = process.argv
    .slice(2)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (leaves.length === 0) throw new Error('pass one or more leaf indices');

  const connection = new Connection(e.P01_FUNDER_RPC || 'https://api.devnet.solana.com', 'confirmed');
  const commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  const mintField = pubkeyToField(pool.tokenMint);

  console.log(`pool  ${pool.poolPDA.toBase58()} (${denomination} SOL) · ${seeds.length} seed(s)\n`);
  for (const leafIndex of leaves) {
    let owner = 'NOBODY this treasury can derive';
    seeds.forEach((seed, i) => {
      const m = deriveNoteMaterial(seed, pool.poolPDA, leafIndex);
      const commitment = createCommitmentV3(
        m.nullifierPreimage,
        m.secret,
        deriveNoteBlinding(seed, pool.poolPDA, leafIndex),
        mintField,
      );
      const hit = commitments.get(commitment.toString());
      if (hit && hit.leafIndex === leafIndex) {
        owner = `seed #${i + 1}${i === 0 ? ' (ACTIVE — confirmable)' : ' (recovered — NOT confirmable)'}`;
      }
    });
    console.log(`leaf ${String(leafIndex).padStart(4)}  ${owner}`);
  }
  console.log(
    '\nOnly the ACTIVE seed can be confirmed by /api/contribute-note, because that\n' +
      'route derives the expected commitment from it alone.',
  );
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
