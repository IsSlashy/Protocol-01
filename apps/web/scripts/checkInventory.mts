/**
 * Is the treasury's note inventory actually spendable RIGHT NOW?
 *
 * A read-only answer to the only question that decides whether an end-to-end
 * test can run at all: for each configured leaf, is it on the tree, is its note
 * unspent, and is it old enough for `issue-note` to hand over.
 *
 * Sends no transaction, signs nothing, prints no secret.
 *
 *   cd apps/web && npx tsx scripts/checkInventory.mts
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

function leavesOf(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const range = t.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i += 1) out.push(i);
    } else if (/^\d+$/.test(t)) {
      out.push(Number(t));
    }
  }
  return [...new Set(out)];
}

async function main() {
  const e = env();
  const seedHex = e.P01_TREASURY_POOL_SEED;
  if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error('P01_TREASURY_POOL_SEED is missing or malformed in .env.local');
  }
  const seed = Uint8Array.from(seedHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const denomination = Number(e.P01_TREASURY_NOTE_DENOMINATION ?? '0.1');
  const leaves = leavesOf(e.P01_TREASURY_NOTE_LEAVES ?? '');
  const minAge = Number(e.P01_TREASURY_NOTE_MIN_AGE_SLOTS ?? '9000');

  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === denomination);
  if (!pool) throw new Error(`no ${denomination} SOL pool is configured`);

  const rpc = e.P01_FUNDER_RPC || 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');
  const genesis = await connection.getGenesisHash();

  console.log(`pool          ${pool.poolPDA.toBase58()}  (${denomination} SOL)`);
  console.log(`deposits      ${pool.deposits}`);
  console.log(`genesis       ${genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ? 'devnet' : genesis}`);
  console.log(`configured    ${leaves.length ? leaves.join(', ') : '(none)'}`);
  console.log(`min age       ${minAge} slots\n`);

  const commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  const spent = await fetchSpentNullifierSet(connection, pool.poolPDA);
  const slot = await connection.getSlot('finalized');

  let maxLeaf = -1;
  for (const c of commitments.values()) if (c.leafIndex > maxLeaf) maxLeaf = c.leafIndex;
  console.log(`tree holds    ${commitments.size} commitments, highest leaf ${maxLeaf}`);
  console.log(`spent set     ${spent.size} nullifier records`);
  console.log(`slot          ${slot}\n`);

  let issuable = 0;
  for (const leafIndex of leaves) {
    const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, leafIndex);
    const blinding = deriveNoteBlinding(seed, pool.poolPDA, leafIndex);
    const commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      blinding,
      pubkeyToField(pool.tokenMint),
    );
    const onChain = commitments.get(commitment.toString());
    const notes: string[] = [];
    if (!onChain) {
      notes.push(leafIndex > maxLeaf ? 'NOT DEPOSITED YET' : 'ON NO TREE (seed/pool/index wrong)');
    } else {
      if (onChain.leafIndex !== leafIndex) notes.push(`sits at leaf ${onChain.leafIndex}, not ${leafIndex}`);
      const age = onChain.depositSlot === null ? -1 : slot - onChain.depositSlot;
      if (age < minAge) notes.push(`TOO YOUNG (${age < 0 ? 'slot unknown' : `${age} < ${minAge}`})`);
      if (isNullifierSpentInSet(spent, pool.poolPDA, nullifierPreimage, secret)) notes.push('SPENT');
    }
    const ok = notes.length === 0;
    if (ok) issuable += 1;
    console.log(`leaf ${String(leafIndex).padStart(4)}  ${ok ? 'ISSUABLE' : notes.join(' · ')}`);
  }

  console.log(`\n==> ${issuable} of ${leaves.length} configured leaves can be issued right now.`);
  if (issuable === 0) {
    console.log('    No end-to-end note purchase can complete until this is non-zero.');
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
