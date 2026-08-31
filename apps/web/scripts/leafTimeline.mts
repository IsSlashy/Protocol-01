/**
 * Every leaf on the pool tree, in the order it was deposited.
 *
 * Written to answer one question: a batch of notes was deposited and this
 * deployment cannot open any of them, so WHERE are they? A batch lands close
 * together in slot, so it shows up as a run — and knowing the run tells us which
 * transactions to read to find whose seed owns them.
 *
 * Read-only. Sends nothing, signs nothing, prints no secret.
 *
 *   cd apps/web && npx tsx scripts/leafTimeline.mts [--tail 40]
 */
import { readFileSync } from 'node:fs';
import { Connection } from '@solana/web3.js';

import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  fetchSpentNullifierSet,
  isNullifierSpentInSet,
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
  const denomination = Number(e.P01_TREASURY_NOTE_DENOMINATION ?? '0.1');
  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === denomination);
  if (!pool) throw new Error(`no ${denomination} SOL pool is configured`);

  const at = process.argv.indexOf('--tail');
  const tail = at >= 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : 40;

  const connection = new Connection(e.P01_FUNDER_RPC || 'https://api.devnet.solana.com', 'confirmed');
  const commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  const spent = await fetchSpentNullifierSet(connection, pool.poolPDA);

  // Which of these can THIS treasury open? Derived, not guessed.
  const hex = e.P01_TREASURY_POOL_SEED ?? '';
  const seed = /^[0-9a-fA-F]{64}$/.test(hex)
    ? Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)))
    : null;
  const mintField = pubkeyToField(pool.tokenMint);
  const ours = new Set<number>();
  const spentByIndex = new Set<number>();
  if (seed) {
    for (const c of commitments.values()) {
      const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, c.leafIndex);
      const mine = createCommitmentV3(
        nullifierPreimage,
        secret,
        deriveNoteBlinding(seed, pool.poolPDA, c.leafIndex),
        mintField,
      );
      if (mine === c.commitment) {
        ours.add(c.leafIndex);
        if (isNullifierSpentInSet(spent, pool.poolPDA, nullifierPreimage, secret)) {
          spentByIndex.add(c.leafIndex);
        }
      }
    }
  }

  const rows = [...commitments.values()].sort((a, b) => a.leafIndex - b.leafIndex);
  console.log(`pool ${pool.poolPDA.toBase58()} (${denomination} SOL)`);
  console.log(`${rows.length} leaves · ${spent.size} spent records · treasury opens ${ours.size}\n`);
  console.log('leaf  deposit slot   gap   owner');

  let prev: number | null = null;
  for (const r of rows.slice(-tail)) {
    const slot = r.depositSlot;
    const gap = prev !== null && slot !== null ? slot - prev : null;
    // A run of small gaps is a BATCH: one operator depositing back to back.
    const mark = gap !== null && gap < 200 ? '·' : ' ';
    const owner = ours.has(r.leafIndex)
      ? (spentByIndex.has(r.leafIndex) ? 'TREASURY (spent)' : 'TREASURY')
      : '';
    console.log(
      `${String(r.leafIndex).padStart(4)}  ${String(slot ?? '?').padStart(12)}  ` +
        `${String(gap ?? '').padStart(5)}${mark} ${owner}`,
    );
    if (slot !== null) prev = slot;
  }
  console.log('\n· = deposited within 200 slots of the one above, i.e. part of a batch.');
  console.log('Blank owner = a leaf THIS treasury seed cannot open.');
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
