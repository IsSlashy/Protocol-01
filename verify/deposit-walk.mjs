#!/usr/bin/env node
/**
 * deposit-walk — can an auditor get from a deposit back to the buyer?
 *
 * WHY THIS IS SEPARATE FROM `p01-verify.mjs`
 * ─────────────────────────────────────────
 * Those probes start from a SPEND: P4 walks the republished commitment back to
 * its deposit, P11 lists account keys across every reachable surface. A tester
 * who has only deposited has no spend yet, so none of them apply — and "the
 * probes did not run" is exactly the kind of silence this project has been
 * bitten by. This walks the deposit side on its own.
 *
 * IT REPRODUCES THE WALK THAT SUCCEEDED ON 2026-08-18, which needed no
 * cryptography and three RPC calls:
 *
 *     deposit -> its ephemeral -> whoever funded that ephemeral
 *             -> that funder's own history -> a transfer signed by the buyer
 *
 * 🚨 THE ORDER OF `getSignaturesForAddress` IS A TRAP THIS PROJECT HAS ALREADY
 * PAID FOR. It returns NEWEST FIRST. An ephemeral's funding is its OLDEST
 * transaction, followed by ~150 proof-chunk uploads — so a walk that reads "the
 * last 50" finds buffer closes and never the funder, then names whichever
 * address happened to move the most inside that window. That is the defect fixed
 * in `resolveFunderOfPayer` on 2026-08-18, and the first version of THIS file
 * reproduced it: it reported the proof-buffer program as the funder, with a
 * straight face. Funding is found by paginating to the END.
 *
 * ⛔ AND CO-NAMING IS ANSWERED BY INTERSECTING SIGNATURE LISTS, not by reading
 * transactions. A transaction naming two addresses is returned by
 * `getSignaturesForAddress` for BOTH, so "were these two ever in one
 * transaction" costs two listings and is EXACT — no window, no sampling, no
 * "not found in the first 25". Same trick the deployment's own readiness check
 * uses (`app/api/fund-ephemeral/route.ts`, `namesBoth`).
 *
 * ⛔ WHAT A GREEN RESULT DOES NOT MEAN. It says the wallet is not reachable
 * along the edges walked here, from THIS deposit. It does not say the wallet is
 * unused, that no other surface names it, or that a future spend will not
 * republish something. An absence is only as wide as the search that produced
 * it, and this one prints its own width.
 *
 * ⚠️ THE TILL IS EXPECTED TO NAME YOU, and that is not a failure. You paid it.
 * What matters is how many OTHER buyers it names, because a settlement from the
 * till to the float carries all of them forward in one edge: you are hidden
 * among that set, or you are not hidden at all. A set of one is not a set.
 *
 * 🚨 NEVER PIPE THIS INTO ANYTHING. `node … | tail` reports tail's exit code,
 * not this script's, so a hard failure comes back as 0 and reads as a clean run.
 * That trap produced a false green on `p01-verify.mjs` once already. Redirect to
 * a file and read the file, or run it bare.
 *
 * Usage:
 *   node verify/deposit-walk.mjs --wallet <your-address> --deposit <signature>
 *   node verify/deposit-walk.mjs --wallet <addr> --deposit <sig> --till <addr>
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const WALLET = args.get('wallet');
const DEPOSIT = args.get('deposit');
const RPC = args.get('rpc') ?? 'https://api.devnet.solana.com';
/** The deployment's collection address, if you want the settlement hop checked. */
const TILL = args.get('till') ?? null;
/** Milliseconds between calls. The public endpoint refuses a tight loop. */
const PACE_MS = Number(args.get('pace') ?? 120);

if (!WALLET || !DEPOSIT) {
  console.error('usage: node verify/deposit-walk.mjs --wallet <address> --deposit <signature>');
  process.exit(2);
}

let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One RPC call, paced and retried.
 *
 * ⚠️ A rate-limited walk has read less than it thinks, and this whole tool is an
 * argument about how much was read. So a 429 backs off and retries rather than
 * propagating; only a persistent one throws, and the caller reports it as
 * INCONCLUSIVE, never as absence.
 */
async function rpc(method, params, attempt = 0) {
  calls += 1;
  await sleep(PACE_MS);
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) {
    if (/too many|rate|429/i.test(j.error.message ?? '') && attempt < 6) {
      await sleep(400 * 2 ** attempt);
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${j.error.message}`);
  }
  return j.result;
}

const short = (s) => `${s.slice(0, 6)}…${s.slice(-4)}`;

/**
 * EVERY signature for an address, oldest LAST, paginated to the end.
 *
 * Bounded at 20 pages so a hot address cannot spin forever; `complete` says
 * whether the end was actually reached, and every caller reports that rather
 * than assuming it.
 */
async function allSignatures(address) {
  const out = [];
  let before;
  for (let page = 0; page < 20; page += 1) {
    const opts = before ? { limit: 1000, before } : { limit: 1000 };
    const batch = await rpc('getSignaturesForAddress', [address, opts]);
    out.push(...batch);
    if (batch.length < 1000) return { sigs: out, complete: true };
    before = batch[batch.length - 1].signature;
  }
  return { sigs: out, complete: false };
}

/**
 * Were these two addresses ever named by one transaction?
 *
 * Exact when both listings reached their end — no transaction is fetched and no
 * window is sampled. `null` means one listing was cut short, which is "could not
 * establish", never "no".
 */
function coNamed(a, b) {
  const seen = new Set(a.sigs.map((s) => s.signature));
  const hit = b.sigs.find((s) => seen.has(s.signature));
  if (hit) return hit.signature;
  return a.complete && b.complete ? false : null;
}

let failures = 0;
let inconclusive = 0;
const say = (s) => console.log(s);
function verdict(ok, label, detail) {
  if (ok === null) {
    inconclusive += 1;
    say(`  ????  ${label}\n        ${detail}`);
  } else if (ok) {
    say(`  PASS  ${label}\n        ${detail}`);
  } else {
    failures += 1;
    say(`  FAIL  ${label}\n        ${detail}`);
  }
}

(async () => {
  say(`\n  deposit-walk — ${RPC}`);
  say(`  wallet   ${WALLET}`);
  say(`  deposit  ${DEPOSIT}\n`);

  // ── D1. The deposit transaction itself ────────────────────────────────────
  const dep = await rpc('getTransaction', [
    DEPOSIT,
    { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);
  if (!dep) {
    say('  the deposit signature is not on this RPC. Wrong cluster, or pruned.');
    process.exit(2);
  }
  const keys = dep.transaction.message.accountKeys;
  const ephemeral = keys[0];
  verdict(
    !keys.includes(WALLET),
    'D1  the deposit does not name your wallet',
    keys.includes(WALLET)
      ? 'your address IS an account key of the deposit. The detour did not happen.'
      : `${keys.length} account keys, none of them yours. Fee payer is ${short(ephemeral)}.`,
  );

  const mine = await allSignatures(WALLET);
  const eph = await allSignatures(ephemeral);
  say(
    `\n  read ${mine.sigs.length} signatures for your wallet${mine.complete ? '' : ' (CUT SHORT)'}` +
      `, ${eph.sigs.length} for the depositing key${eph.complete ? '' : ' (CUT SHORT)'}\n`,
  );

  // ── D2. The depositing key and your wallet, ever together? ────────────────
  const d2 = coNamed(mine, eph);
  verdict(
    d2 === false ? true : d2 === null ? null : false,
    'D2  the depositing key was never in a transaction with your wallet',
    d2 === false
      ? 'no shared transaction, across both full histories.'
      : d2 === null
        ? 'INCONCLUSIVE: a signature listing was cut short, so absence cannot be argued.'
        : `named together in ${d2}`,
  );

  // ── D3. Who funded it — from the OLDEST transaction, never the newest ─────
  const oldest = eph.sigs[eph.sigs.length - 1];
  if (!oldest || !eph.complete) {
    verdict(null, 'D3  who funded the depositing key', 'INCONCLUSIVE: history incomplete.');
  } else {
    const first = await rpc('getTransaction', [
      oldest.signature,
      { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    const fkeys = first?.transaction?.message?.accountKeys ?? [];
    const i = fkeys.indexOf(ephemeral);
    const credit = first?.meta
      ? (first.meta.postBalances[i] ?? 0) - (first.meta.preBalances[i] ?? 0)
      : 0;
    const funder = fkeys[0] ?? null;
    say(`  funded by ${funder} (+${credit / 1e9} SOL, ${oldest.signature})\n`);

    if (!funder) {
      verdict(null, 'D3  who funded the depositing key', 'INCONCLUSIVE: no payer on the first tx.');
    } else {
      const f = await allSignatures(funder);
      const d3 = coNamed(mine, f);
      verdict(
        d3 === false ? true : d3 === null ? null : false,
        'D3  the address that funded it was never in a transaction with your wallet',
        d3 === false
          ? `no shared transaction, across ${f.sigs.length} of its signatures.`
          : d3 === null
            ? 'INCONCLUSIVE: a signature listing was cut short.'
            : `🚨 THE 2026-08-18 WALK. Your wallet and the funder are named together in ${d3}. ` +
              'Two hops from the deposit, no cryptography. Whatever you shield here is ' +
              'walkable back to you.',
      );

      // ── D4. The settlement hop, one further out ──────────────────────────
      //
      // Not a pass/fail about you. You DID pay the till, so it names you; that
      // is the design. The question is whether the till has since paid the
      // float, because that edge carries everyone the till names forward at
      // once — and whether you are one of many there, or the only one.
      if (TILL) {
        const t = await allSignatures(TILL);
        const settled = coNamed(t, f);
        const youAtTill = coNamed(mine, t);
        say(
          `\n  CONTEXT  the till names you: ${
            youAtTill === false ? 'no' : youAtTill === null ? 'could not establish' : 'yes, expected'
          }.` +
            `\n           the till has settled into the float: ${
              settled === false ? 'no' : settled === null ? 'could not establish' : `yes (${settled})`
            }.` +
            `\n           ${t.sigs.length} signatures at the till — a settlement carries everyone` +
            '\n           it names forward at once. A set of one is not a set.',
        );
      } else {
        say('\n  CONTEXT  pass --till <address> to check the settlement hop as well.');
      }
    }
  }

  say(`\n  ${calls} RPC calls.`);
  if (failures > 0) {
    say(`  ${failures} FAILURE(S): your wallet is reachable from this deposit.\n`);
    process.exit(1);
  }
  if (inconclusive > 0) {
    // ⛔ Reported as a failure on purpose, the convention P3 and P4 already use:
    // an unread channel is not a clean one.
    say(`  ${inconclusive} INCONCLUSIVE, reported as failure: the search could not be completed.\n`);
    process.exit(1);
  }
  say('  Not reachable along the edges walked here. That is all this says.\n');
})().catch((e) => {
  console.error('  error:', e.message);
  process.exit(2);
});
