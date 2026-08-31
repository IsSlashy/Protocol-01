/**
 * Which leaves on the tree does THIS treasury actually own?
 *
 * `checkInventory.mts` answers "are the CONFIGURED leaves good". This answers
 * the question before it: which leaves exist at all that the treasury seed can
 * open. A note deposited but never added to `P01_TREASURY_NOTE_LEAVES` is
 * invisible to `issue-note` — it sits on the tree, spendable by nobody, while
 * the route reports an empty inventory.
 *
 * Read-only. Sends nothing, signs nothing, prints no secret.
 *
 *   cd apps/web && npx tsx scripts/findTreasuryLeaves.mts [--max 200]
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
  const hex = e.P01_TREASURY_POOL_SEED;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('P01_TREASURY_POOL_SEED is missing or malformed in .env.local');
  }
  const seed = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const denomination = Number(e.P01_TREASURY_NOTE_DENOMINATION ?? '0.1');
  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === denomination);
  if (!pool) throw new Error(`no ${denomination} SOL pool is configured`);

  const at = process.argv.indexOf('--max');
  const max = at >= 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : 200;

  const connection = new Connection(e.P01_FUNDER_RPC || 'https://api.devnet.solana.com', 'confirmed');
  const commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  const spent = await fetchSpentNullifierSet(connection, pool.poolPDA);
  const slot = await connection.getSlot('finalized');
  const minAge = Number(e.P01_TREASURY_NOTE_MIN_AGE_SLOTS ?? '9000');

  console.log(`pool        ${pool.poolPDA.toBase58()}  (${denomination} SOL)`);
  console.log(`tree        ${commitments.size} commitments · ${spent.size} spent records`);
  console.log(`configured  ${e.P01_TREASURY_NOTE_LEAVES ?? '(none)'}`);
  console.log(`scanning    leaves 0..${max - 1} against the treasury seed\n`);

  const mine: number[] = [];
  const issuable: number[] = [];
  const young: number[] = [];
  const dead: number[] = [];

  for (let leafIndex = 0; leafIndex < max; leafIndex += 1) {
    const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, leafIndex);
    const commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      deriveNoteBlinding(seed, pool.poolPDA, leafIndex),
      pubkeyToField(pool.tokenMint),
    );
    const onChain = commitments.get(commitment.toString());
    if (!onChain || onChain.leafIndex !== leafIndex) continue;
    mine.push(leafIndex);
    if (isNullifierSpentInSet(spent, pool.poolPDA, nullifierPreimage, secret)) {
      dead.push(leafIndex);
      continue;
    }
    const age = onChain.depositSlot === null ? -1 : slot - onChain.depositSlot;
    if (age < minAge) young.push(leafIndex);
    else issuable.push(leafIndex);
  }

  console.log(`the treasury OWNS ${mine.length} leaf/leaves: ${mine.join(', ') || '(none)'}`);
  console.log(`  issuable now   ${issuable.join(', ') || '(none)'}`);
  console.log(`  too young      ${young.join(', ') || '(none)'}`);
  console.log(`  already spent  ${dead.join(', ') || '(none)'}`);

  const configured = new Set(
    (e.P01_TREASURY_NOTE_LEAVES ?? '')
      .split(',')
      .flatMap((t) => {
        const r = t.trim().match(/^(\d+)-(\d+)$/);
        if (r) {
          const out: number[] = [];
          for (let i = Number(r[1]); i <= Number(r[2]); i += 1) out.push(i);
          return out;
        }
        return /^\d+$/.test(t.trim()) ? [Number(t.trim())] : [];
      }),
  );
  const unlisted = mine.filter((l) => !configured.has(l));
  if (unlisted.length > 0) {
    console.log(
      `\n🚨 ${unlisted.length} leaf/leaves the treasury owns are NOT in ` +
        `P01_TREASURY_NOTE_LEAVES, so issue-note cannot hand them out:`,
    );
    console.log(`   ${unlisted.join(',')}`);
    console.log(`\n   Set P01_TREASURY_NOTE_LEAVES=${mine.join(',')}`);
    console.log('   in Vercel AND in the GitHub secret — the value lives in two places.');
  } else if (mine.length > 0) {
    console.log('\n✅ Every leaf the treasury owns is configured.');
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
