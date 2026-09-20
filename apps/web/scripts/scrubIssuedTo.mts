/**
 * Delete the legacy leaf → recipient rows, `p01:note:issued:<pool>:<leaf>:to`.
 *
 * 🚨 WHAT THE ROW WAS. Until ISSUE-1, `/api/issue-note` recorded the note
 * address every issued leaf had been sealed to, with no expiry and no writer
 * that ever cleared it. A copy of the store therefore held a permanent
 * leaf → recipient table: it names who received a given note, and it groups
 * every note one buyer has ever been handed (map-A defect 3). The route no
 * longer writes it — `__tests__/api/issue-note.node.test.ts` "what the reply
 * and the store hold does not move when the leaf moves, and does not name the
 * recipient" pins that, by comparing every row across leaf and recipient worlds
 * (a hashed `:to` write, verifier mutant N6 in ISSUE-1-r2b-mutants.log, goes red
 * there) — but a deployment that has been issuing notes still holds the rows
 * written before.
 *
 * ⛔ DELETING THEM CANNOT COST A NOTE. Nothing reads the row any more: a leaf is
 * spoken for by its own counter, `p01:note:issued:<pool>:<leaf>`, which this
 * never touches. Losing that counter WOULD hand one note to two buyers, so the
 * `:to` suffix is required on every key this deletes, and the check is in one
 * place (`isLegacyRecipientRow`) with its own self-test below.
 *
 * WHY IT ENUMERATES INSTEAD OF SCANNING. The store is reached through `KvLike`,
 * which has no `keys`/`scan` — deliberately, because a scan over a production
 * Redis is a foot-gun. So the candidates are built the way the route builds its
 * inventory: the configured leaves, plus the acquired set, plus a bounded
 * sweep. A row outside that range is reported as NOT COVERED rather than
 * silently assumed absent.
 *
 * It prints COUNTS ONLY — never a leaf index, never an address, never a key.
 *
 *   cd apps/web && npx tsx scripts/scrubIssuedTo.mts             # dry run
 *   cd apps/web && npx tsx scripts/scrubIssuedTo.mts --apply     # delete
 *   cd apps/web && npx tsx scripts/scrubIssuedTo.mts --max 2048  # wider sweep
 *   cd apps/web && npx tsx scripts/scrubIssuedTo.mts --pool <old pool address>  # retired pool
 *   cd apps/web && npx tsx scripts/scrubIssuedTo.mts --self-test # no KV needed
 */
import { readFileSync } from 'node:fs';

import { getPoolsForTokenV3 } from '../lib/privacy/pool/denominatedPool';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SELF_TEST = args.includes('--self-test');
const MAX = (() => {
  const i = args.indexOf('--max');
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 512;
})();
/**
 * `--pool <address>`, repeatable: a pool this build no longer lists. The sweep
 * otherwise covers only `getPoolsForTokenV3`'s CURRENT pools, so rows written
 * under an older pool address would be neither found nor reported.
 */
const EXTRA_POOLS = args.flatMap((a, i) => (a === '--pool' && args[i + 1] ? [args[i + 1]] : []));

/**
 * The one rule that decides what may be deleted.
 *
 * ⛔ The `:to` suffix is what separates the recipient row from the CLAIM
 * counter that stops a note being issued twice. Anything else is refused.
 */
function isLegacyRecipientRow(key: string): boolean {
  return /^p01:note:issued:[1-9A-HJ-NP-Za-km-z]{32,44}:\d+:to$/.test(key);
}

function selfTest(): number {
  const pool = 'GbVM5yveUqLmHpHz4dTpNJRbdJaSwLRkbsTpKgJkTJmL';
  const mustAccept = [`p01:note:issued:${pool}:0:to`, `p01:note:issued:${pool}:4096:to`];
  const mustRefuse = [
    // The claim counter. Deleting one hands a note to a second buyer.
    `p01:note:issued:${pool}:7`,
    `p01:note:claim:SOME-CLAIM-CODE`,
    `p01:note:claim-minted:SOME-CLAIM-CODE`,
    `p01:note:inventory:${pool}`,
    `p01:note:paid:SOME-SIGNATURE`,
    `p01:note:sealed:${'a'.repeat(64)}`,
    `p01:note:issued:${pool}:7:to:extra`,
    `prefix:p01:note:issued:${pool}:7:to`,
    `p01:note:issued:${pool}:notanumber:to`,
  ];
  let bad = 0;
  for (const k of mustAccept) {
    if (!isLegacyRecipientRow(k)) {
      bad += 1;
      console.error('  MISSED a legacy recipient row');
    }
  }
  for (const k of mustRefuse) {
    if (isLegacyRecipientRow(k)) {
      bad += 1;
      console.error(`  WOULD DELETE a row it must never touch: ${k.split(':').slice(0, 3).join(':')}…`);
    }
  }
  console.log(
    bad === 0
      ? `self-test ok: ${mustAccept.length} accepted, ${mustRefuse.length} refused`
      : `self-test FAILED: ${bad} case(s)`,
  );
  return bad === 0 ? 0 : 1;
}

/** `.env.local`, read into the environment BEFORE the store module is loaded. */
function loadEnvLocal(): void {
  let raw: string;
  try {
    raw = readFileSync('.env.local', 'utf8');
  } catch {
    // Nothing to load. The store falls back to whatever the shell exported,
    // and refuses below if that is nothing.
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    // Never printed, only set: this file holds the RPC key as well as the
    // store's credentials.
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}

function seededLeaves(): number[] {
  const out: number[] = [];
  for (const piece of (process.env.P01_TREASURY_NOTE_LEAVES ?? '').split(',')) {
    const s = piece.trim();
    if (s.length === 0) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(s);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) continue;
      for (let i = lo; i <= hi; i += 1) out.push(i);
      continue;
    }
    const n = Number(s);
    if (Number.isInteger(n) && n >= 0) out.push(n);
  }
  return out;
}

async function main(): Promise<number> {
  if (SELF_TEST) return selfTest();

  loadEnvLocal();
  // Imported only now: `lib/waitlist/store.ts` reads the store's credentials at
  // module load, so importing it before `.env.local` is in the environment
  // yields a null store and a run that reports a clean zero for the wrong
  // reason.
  const { getStore } = await import('../lib/waitlist/store');
  const kv = getStore();
  if (!kv) {
    console.error(
      'No durable KV is configured, so nothing can be read or deleted. Set KV_REST_API_URL and ' +
        'KV_REST_API_TOKEN (or the UPSTASH_* pair) in apps/web/.env.local.',
    );
    return 1;
  }

  const current = [...getPoolsForTokenV3('SOL'), ...getPoolsForTokenV3('USDC')].map((p) =>
    p.poolPDA.toBase58(),
  );
  for (const extra of EXTRA_POOLS) {
    // Same alphabet and length the deletion rule demands, checked up front so
    // a typo is refused loudly instead of sweeping nothing.
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(extra)) {
      console.error('--pool takes a base58 pool address; refused one that is not');
      return 1;
    }
  }
  const pools = [...new Set([...current, ...EXTRA_POOLS])];
  const seeded = seededLeaves();
  let found = 0;
  let deleted = 0;
  let failed = 0;
  let probed = 0;

  for (const poolKey of pools) {
    let acquired: number[] = [];
    try {
      acquired = (await kv.smembers(`p01:note:inventory:${poolKey}`))
        .map((m) => Number(m))
        .filter((n) => Number.isInteger(n) && n >= 0);
    } catch {
      // An unreadable set only narrows the sweep; the bounded range below still
      // covers the leaves an operator configured.
    }
    const candidates = [...new Set([...seeded, ...acquired, ...range(MAX)])].sort((a, b) => a - b);

    for (const leafIndex of candidates) {
      const key = `p01:note:issued:${poolKey}:${leafIndex}:to`;
      if (!isLegacyRecipientRow(key)) continue;
      probed += 1;
      let value: string | null = null;
      try {
        value = await kv.get<string>(key);
      } catch {
        failed += 1;
        continue;
      }
      if (value === null || value === undefined) continue;
      found += 1;
      if (!APPLY) continue;
      try {
        await kv.del(key);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
  }

  // Counts only. A leaf index here would put the thing being deleted into a
  // terminal and, on a CI run, into a public log (map-A defect 9).
  console.log(`pools swept          ${pools.length}  (${EXTRA_POOLS.length} from --pool)`);
  console.log(`keys probed          ${probed}  (leaves 0-${MAX - 1}, plus configured and acquired)`);
  console.log(`recipient rows found ${found}`);
  console.log(APPLY ? `rows deleted         ${deleted}` : 'rows deleted         0 (dry run; pass --apply)');
  if (failed > 0) console.log(`store errors         ${failed}`);
  console.log(
    'NOT COVERED: any leaf outside the range swept, and any pool this build does not list. ' +
      'Raise --max if this deployment has issued past it, pass --pool <address> for each ' +
      'retired pool, and re-run until "recipient rows found" is 0.',
  );
  return failed > 0 ? 1 : 0;
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

process.exit(await main());
