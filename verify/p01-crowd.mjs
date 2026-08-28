#!/usr/bin/env node
/**
 * How big was the crowd, at the moment of a spend?
 *
 * ⛔ THIS IS NOT A PROBE, AND THAT IS DELIBERATE.
 *
 * `p01-verify.mjs` answers P1..P11 against a FROZEN record: eight fixtures pin
 * every verdict, and the self-test refuses a probe that no manifest declares —
 * "a new probe must declare its control outcome". Adding a twelfth would
 * invalidate all eight at once, and their recorded RPC responses hold no answer
 * for the requests it would make, so they could not be replayed either. Six days
 * before a demo, destabilising the audit record to add a measurement is a bad
 * trade. So this lives beside it, live-only, and pins nothing.
 *
 * WHAT IT MEASURES, AND WHY IT IS THE NUMBER THAT MATTERS
 * ──────────────────────────────────────────────────────
 * P11 asks whether the buyer's address is findable. On 2026-08-28 it PASSED on a
 * relayed spend. That answer is about NAMES, and it is silent about the other
 * way an analyst identifies a withdrawal: arithmetic on the crowd.
 *
 * The deck argues "the guarantee is a crowd and it is worth nothing at a crowd
 * of one". That sentence is an argument. This makes it a number, read off the
 * chain, that anyone can re-measure:
 *
 *   k(S) = leaves inserted at or before slot S
 *          - notes already spent at or before slot S
 *
 * Both halves come from public data. Leaves are counted by decoding the
 * `LeafInserted` event out of every transaction that touched the tree — the
 * tree is also an account of every SPEND, so counting its signatures alone
 * overcounts, and the event is what separates a deposit from a spend. Spends are
 * counted from the `NullifierRecord` PDAs, which are 41 bytes with the pool at
 * offset 8.
 *
 * ⚠️ WHAT k IS NOT. It is a CEILING. A crowd of forty-five means an analyst who
 * knows nothing else has forty-five candidates; it does not survive any channel
 * that partitions the pool. If every one of those notes was deposited minutes
 * before it was spent, timing cuts the ceiling to the handful deposited near
 * this one — which is why the youngest-note age is printed beside it, and why a
 * large k with a young tail is worth less than it looks.
 *
 * Usage:
 *   node verify/p01-crowd.mjs --rpc <url> --spend <signature>
 *   node verify/p01-crowd.mjs --rpc <url> --pool <poolPDA>     (crowd right now)
 *
 * 🚨 --rpc is effectively required. The public devnet endpoint throttles this
 * walk and gives up after a few hundred calls, which reads as a small crowd
 * rather than as a failure to count.
 */

const ZK_SHIELDED = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';

/** The two pools, and the tree each one inserts into. */
const POOLS = {
  '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS': { label: '1 SOL', tree: 'GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi' },
  HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG: { label: '0.1 SOL', tree: '43MRQ91VrrxkD2PqV4QXNJG3BUmu8JmbDUTtWt2dYBAU' },
};

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const RPC_URL = flag('--rpc') ?? 'https://api.devnet.solana.com';
const SPEND = flag('--spend');
const POOL_ARG = flag('--pool');

if (!SPEND && !POOL_ARG) {
  console.error('usage: node verify/p01-crowd.mjs --rpc <url> (--spend <sig> | --pool <pda>)');
  process.exit(2);
}

let calls = 0;
async function rpc(method, params) {
  calls += 1;
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Anchor event discriminator: sha256("event:<Name>")[..8]. */
async function eventDiscriminator(name) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

/**
 * Every signature of an account, oldest first, with its slot.
 *
 * 🚨 OLDEST FIRST MATTERS. `getSignaturesForAddress` returns newest first and
 * pages backwards with `before`. Reading only the first page and calling it a
 * history is the sort-order trap this repository has caught twice; the loop
 * below pages to exhaustion and says so if it hits the cap.
 */
async function allSignatures(address, cap = 5000) {
  const out = [];
  let before;
  for (;;) {
    const page = await rpc('getSignaturesForAddress', [address, before ? { limit: 1000, before } : { limit: 1000 }]);
    if (!page?.length) break;
    out.push(...page);
    before = page[page.length - 1].signature;
    if (out.length >= cap) return { list: out, truncated: true };
  }
  return { list: out.reverse(), truncated: false };
}

async function main() {
  let pool = POOL_ARG;
  let slot = null;
  let spendSig = null;

  if (SPEND) {
    const tx = await rpc('getTransaction', [SPEND, { maxSupportedTransactionVersion: 0 }]);
    if (!tx) throw new Error(`spend not found: ${SPEND}`);
    slot = tx.slot;
    spendSig = SPEND;
    const keys = (tx.transaction.message.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
    pool = keys.find((k) => POOLS[k]) ?? null;
    if (!pool) throw new Error('this transaction names no known pool');
  }
  if (!POOLS[pool]) throw new Error(`unknown pool: ${pool}`);
  const { label, tree } = POOLS[pool];

  console.log(`pool     ${label}  ${pool}`);
  if (spendSig) console.log(`spend    ${spendSig.slice(0, 16)}… at slot ${slot}`);
  else console.log('spend    (none given — measuring the crowd as of now)');
  console.log('');

  // ── leaves inserted at or before the slot ────────────────────────────────
  const LEAF_DISC = await eventDiscriminator('LeafInserted');
  const treeSigs = await allSignatures(tree);
  if (treeSigs.truncated) {
    console.log('⛔ the tree history hit the cap; every number below is a FLOOR, not a count');
  }
  let leaves = 0;
  let youngestLeafSlot = null;
  for (const s of treeSigs.list) {
    if (slot !== null && s.slot > slot) continue;
    if (s.err) continue;
    const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0 }]);
    const logs = tx?.meta?.logMessages ?? [];
    const inserted = logs.some((l) => {
      const m = /^Program data: (.+)$/.exec(l);
      if (!m) return false;
      const d = Buffer.from(m[1], 'base64');
      return d.length >= 8 && d.subarray(0, 8).equals(LEAF_DISC);
    });
    if (inserted) {
      leaves += 1;
      youngestLeafSlot = s.slot;
    }
  }

  // ── notes already spent at or before the slot ────────────────────────────
  const nullifiers = await rpc('getProgramAccounts', [
    ZK_SHIELDED,
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 41 }, { memcmp: { offset: 8, bytes: pool } }] },
  ]);
  let spent = 0;
  for (const a of nullifiers) {
    const sigs = await rpc('getSignaturesForAddress', [a.pubkey, { limit: 1 }]);
    const s = sigs?.[0];
    if (!s) continue;
    if (slot === null || s.slot <= slot) spent += 1;
  }

  const k = leaves - spent;
  const ageSlots = youngestLeafSlot !== null && slot !== null ? slot - youngestLeafSlot : null;

  console.log(`leaves inserted    ${String(leaves).padStart(5)}`);
  console.log(`already spent      ${String(spent).padStart(5)}`);
  console.log(`CROWD  k =         ${String(k).padStart(5)}   ${k <= 1 ? '⛔ a crowd of one hides nobody' : ''}`);
  if (ageSlots !== null) {
    const mins = (ageSlots * 0.4) / 60;
    console.log(`youngest note      ${String(ageSlots).padStart(5)} slots before the spend  (~${mins.toFixed(1)} min)`);
    if (ageSlots < 9000) {
      console.log('                   ⚠️ under DEFAULT_MIN_AGE_SLOTS (9,000): a note this fresh');
      console.log('                      narrows the crowd by timing whatever k says');
    }
  }
  console.log('');
  console.log(`${calls} RPC calls`);
  console.log('');
  console.log('⚠️ k is a CEILING. It is what an analyst has who knows nothing else, and it');
  console.log('   does not survive any channel that partitions the pool — the fee payer, the');
  console.log('   deposit funder, timing. log2(k) bits, and zero at k = 1.');
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
