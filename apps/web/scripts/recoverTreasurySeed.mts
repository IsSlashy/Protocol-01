/**
 * Which seed owns the orphaned batch?
 *
 * 🚨 THE PROBLEM, MEASURED 2026-08-31. Ten notes sit at leaves 83-92 of the 1 SOL
 * pool — 10 SOL of real value, deposited deliberately so the TREASURY would hold
 * them — and `P01_TREASURY_POOL_SEED` cannot open any of them. The restock
 * derived its seed from a wallet SIGNATURE plus an ORIGIN; the issuing route
 * reads a fixed hex. Nobody copied one into the other, and nothing failed while
 * it happened.
 *
 * 🎯 THE HANDLE THIS USES. The ephemeral that deposits a leaf is derived from the
 * SAME seed as the note — `deriveShieldEphemeral(seed, pool, counter)`. That
 * ephemeral is a public account key on the deposit transaction. So a candidate
 * seed can be tested in one line, with no chain access and nothing at risk:
 * derive the ephemeral for that leaf and compare it to the depositor.
 *
 * ⛔ IT GUESSES NOTHING ABOUT THE SEED ITSELF. A seed is 32 bytes and is not
 * searchable. What is searchable is the small set of INPUTS a session could have
 * used: which wallet signed, and which origin it signed for. That is a handful of
 * candidates, and either one matches or none does.
 *
 * Read-only. Signs a derivation MESSAGE locally, never a transaction, and prints
 * the seed only when it is proven to be the right one — because a seed that
 * opens ten notes is those ten notes.
 *
 *   cd apps/web && npx tsx scripts/recoverTreasurySeed.mts --leaf 83 --depositor 2gS1vu8F...
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';

import { getPoolsForTokenV3 } from '../lib/privacy/pool/denominatedPool';
import { deriveShieldEphemeral } from '../lib/privacy/pool/shieldEphemeral';
import { derivePoolSeeds } from '../lib/privacy/pool/seedDerivation';
import { buildDerivationMessage } from '../lib/privacy/message';

const argOf = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const LEAF = Number(argOf('--leaf', '83'));
const DEPOSITOR = argOf('--depositor', '2gS1vu8FM4sseiQNGEJGSZNd3Bj67vLTjtzZFN9aLL6U');

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** Every origin a session could plausibly have signed for. */
const ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://styx.build',
  'https://www.styx.build',
  'https://protocol01.com',
  'https://www.protocol01.com',
  'https://protocol-01.vercel.app',
  'https://protocol-01-git-master-domain-expansion.vercel.app',
];
const CHAIN_TAGS = ['solana:devnet', 'solana:mainnet-beta'];

async function main() {
  const e = env();
  const denomination = Number(e.P01_TREASURY_NOTE_DENOMINATION ?? '0.1');
  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === denomination);
  if (!pool) throw new Error(`no ${denomination} SOL pool is configured`);

  const path = (process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`).replace(
    /^~/,
    homedir(),
  );
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

  console.log(`pool       ${pool.poolPDA.toBase58()} (${denomination} SOL)`);
  console.log(`target     leaf ${LEAF} was deposited by ${DEPOSITOR}`);
  console.log(`wallet     ${wallet.publicKey.toBase58()}`);
  console.log(`candidates ${ORIGINS.length} origins x ${CHAIN_TAGS.length} chain tags\n`);

  // The configured seed first: if it matched we would not be here, but proving
  // that in the output is worth one line — a reader should not have to trust it.
  const hex = e.P01_TREASURY_POOL_SEED;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    const configured = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    const eph = deriveShieldEphemeral(configured, pool.poolPDA, LEAF).publicKey.toBase58();
    console.log(`configured seed -> ${eph}  ${eph === DEPOSITOR ? '✅ MATCH' : '(no)'}`);
  }

  for (const chainTag of CHAIN_TAGS) {
    for (const origin of ORIGINS) {
      const message = buildDerivationMessage({
        walletPubkey: wallet.publicKey.toBase58(),
        origin,
        chainTag,
      });
      // Ed25519 is deterministic: the same wallet and the same message give the
      // same signature every time, which is the only reason this is recoverable
      // at all.
      const signature = nacl.sign.detached(
        new TextEncoder().encode(message),
        wallet.secretKey,
      );
      const seeds = derivePoolSeeds(signature, null);
      for (const [label, seed] of [
        ['active', seeds.active],
        ...(seeds.legacy ? [['legacy', seeds.legacy] as const] : []),
      ] as Array<[string, Uint8Array]>) {
        const eph = deriveShieldEphemeral(seed, pool.poolPDA, LEAF).publicKey.toBase58();
        const hit = eph === DEPOSITOR;
        console.log(`${hit ? '✅' : '  '} ${chainTag} ${origin} [${label}] -> ${eph}`);
        if (hit) {
          console.log('\n🎯 RECOVERED. This seed derived the ephemeral that deposited that leaf,');
          console.log('   so it derives the notes too. Put it in P01_TREASURY_POOL_SEED and the');
          console.log('   issuing route discovers every leaf it opens, with nothing to write down.\n');
          console.log(
            `   P01_TREASURY_POOL_SEED=${Buffer.from(seed).toString('hex')}`,
          );
          console.log('\n⛔ That value can spend every note it derives. Treat it as the money.');
          return;
        }
      }
    }
  }

  console.log('\nNo candidate matched.');
  console.log('The batch was deposited by a wallet or an origin not in this list — the');
  console.log('depositor above is the only handle, and it is derived from the seed, so');
  console.log('widening the candidates is the only way forward. Nothing is lost meanwhile:');
  console.log('the notes remain on the tree, and whoever holds that seed still holds them.');
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
