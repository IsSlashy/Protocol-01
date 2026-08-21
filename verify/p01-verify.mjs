#!/usr/bin/env node
/**
 * p01-verify — an independent, reproducible check of the pool's unlinkability
 * claim, runnable by anyone with a public RPC and no keys, no SOL, no account.
 *
 * WHY THIS EXISTS, AND THE MISTAKE IT REFUSES TO MAKE
 * ───────────────────────────────────────────────────
 * The repo's existing leak test scans the withdrawal INSTRUCTION for values
 * derived from the deposit (`denominatedPool.test.ts:678-694`, and the C7 plan
 * proposes the same shape for v4). That test is good and it is not enough: a
 * STARK proof is uploaded as ordinary instruction data by ~74-145
 * `write_proof_chunk` transactions, archived forever, and all of them are
 * reachable from the withdrawal itself through the proof-buffer PDA. A checker
 * that reads only the 104-byte spend instruction would report GREEN on a system
 * whose proof bytes hand over the note. So this tool follows the proof too.
 *
 * WHAT IT CHECKS
 *   P1  the spend instruction does not carry the deposit's commitment
 *   P2  no 8-byte window anywhere in the spend instruction matches it either
 *   P3  the uploaded proof bytes do not carry it
 *   P4  the spend cannot be matched to a deposit at all
 *   P5  context: the pool's real anonymity set and the deposit->spend gap
 *   P6  the spend's fee payer cannot be traced to a funding wallet
 *   P7  no instruction argument outside the proof payload carries the commitment
 *   P8  no single wallet funded both the deposit and the spend
 *   P9  the DEPOSIT's fee payer cannot be traced to a funding wallet
 *   P10 the withdrawal's PAYEE cannot be traced to a wallet
 *
 * 🚨 WHY P10 EXISTS: EVERY OTHER PROBE HERE WATCHES A PAYER
 * ────────────────────────────────────────────────────────
 * Until 2026-08-17 the string "recipient" did not appear once in this file. A
 * `unshield_denominated_stark_v3` publishes its payee as a 32-byte instruction
 * ARGUMENT in the clear at byte 88 — no walk needed to obtain it — and /pay
 * derives a fresh payout address per note precisely so that value is not the
 * user's wallet. One later transfer undoes that, and the whole road is:
 *
 *   getTransaction(spend) → recipient at byte 88 → getSignaturesForAddress
 *   → getTransaction(the sweep) → the wallet
 *
 * Three RPC calls, same price as the payer walk, same transaction, same person.
 * MEASURED in the mobile client on devnet 2026-08-04: `C4MqLbEx…` forwarded
 * 0.994995 SOL to the user's wallet 8 seconds after the withdrawal, slot
 * 481027703.
 *
 * It is also why funding a withdrawal's pre-fund from a treasury must not be
 * read as a win: that moves the PAYER edge and touches this one not at all.
 *
 * ⚠️ NO COMMITTED FIXTURE EXERCISES P10's PASS OR FAIL. All three are
 * subscribes or synthetic v4s, which publish no payee argument, so all three
 * report INCONCLUSIVE. Its real branches live only in `selfTestChannelDecoders`
 * until a real withdrawal is recorded. A PASS from P10 means "not swept YET",
 * never "cannot be traced" — the address is published permanently.
 *
 * 🚨 WHY P9 EXISTS, AND WHY IT IS NOT P6 TWICE
 * ────────────────────────────────────────────
 * P6 walks the SPEND payer; P8 walks both and reports only their INTERSECTION.
 * Neither survives the change this repo is making: route the spend leg through
 * a shared funder and P6 truthfully names the treasury, P8's two sets become
 * disjoint and it reports PASS or INCONCLUSIVE — and the user's own wallet
 * appears in NO line of a default run, while still being three RPC calls from
 * the deposit. Nothing would have lied. The reading would just have stopped
 * being printed, which for a verification tool is the same failure.
 *
 * P9 names the deposit payer's counterparties unconditionally. P8 already made
 * that walk and threw it away, so the probe costs no extra RPC calls. MEASURED
 * on the committed fixture: P9 FAIL, measure 2 — the deposit payer is bracketed
 * by `BRop3akx…` on both ends (1573486080 lamports in, 570010780 out).
 *
 *   P11 the named address appears in no reachable transaction (--wallet only)
 *
 * --wallet <pubkey>, AND WHY P11 IS THE ONE THAT MATTERS FOR AN AUDIT
 * ──────────────────────────────────────────────────────────────────
 * A structural probe asks "is this payer bracketed by anything". `--wallet`
 * asks the narrower question a structural probe cannot: is THIS address in
 * there. P6 and P9 then say so either way, and P8 FAILS whenever the address
 * appears on either side — because two disjoint counterparty sets are not a
 * defence when the address you asked about is sitting in one of them. It
 * changes no RPC request, so it can be added to any replay of any fixture.
 *
 * 🚨 P6/P8/P9/P10 all reason about EDGES, decoded out of System instructions.
 * That is too narrow for "can an auditor find me", because the cheapest real
 * extraction decodes nothing at all:
 *
 *   $r.result.transaction.message.accountKeys | ForEach-Object { $_.pubkey }
 *
 * One line, one RPC call, every account a transaction names. An address can sit
 * there as a read-only account, a co-signer or a bare program argument, move not
 * one lamport, and be invisible to every edge probe here while being the first
 * thing that output prints. P11 asks that question over every transaction
 * reachable from a spend — the spend, its payer's whole life, the deposit
 * payer's whole life — at no extra RPC cost, because those transactions were
 * already fetched.
 *
 * Its PASS is expensive on purpose: `traceFunderEdges` stops early when it
 * FINDS an edge, so a leaky payer may have been read 2 transactions of 172, and
 * "not in those 2" is not "not in the 172". Any partial walk makes P11
 * INCONCLUSIVE with the arithmetic printed.
 *
 * P4's line here read "the wallet that funded the deposit is not a party to the
 * spend" until 2026-08-16. It never checked that: `findDeposit` returned a
 * signature and a leaf index and never looked at who paid, so the deposit side
 * of the sentence was documented and unmeasured for the whole life of the file.
 * The line now states what P4 does, and P8 is the probe that measures what it
 * used to claim. A docstring that overstates a probe is the same defect as a
 * probe that overstates a result — it just takes longer to find.
 *
 * NEGATIVE CONTROL — READ BEFORE TRUSTING A GREEN RUN
 * Every leak probe must FAIL on a v3 spend. v3 publishes the commitment by
 * design, so a v3 run that comes back clean means the tool is broken, not that
 * the pool is private. `--self-test` asserts exactly that and is the only
 * honest way to believe a future green.
 *
 * FIXTURE REPLAY — HOW THE CONTROLS SURVIVE CI
 * ────────────────────────────────────────────
 * CI cannot depend on devnet: the public endpoint throttles, prunes history,
 * and drifts, and a control that sometimes cannot run is a control nobody
 * reruns. So:
 *
 *   --record <dir>  runs live and freezes every RPC response the probes
 *                   actually read into <dir>/rpc.json (trimmed to the fields
 *                   this tool reads), plus <dir>/manifest.json pinning the
 *                   flags used and the measured outcome of every probe.
 *   --replay <dir>  answers every RPC call from that file and never touches
 *                   the network. A call the fixture cannot answer is a HARD
 *                   ERROR, never a skip — an unread channel reported clean is
 *                   the precise failure mode this tool exists to refuse.
 *
 * `--self-test --replay <dir>` asserts the outcome of EVERY probe matches the
 * manifest pin, in both directions. Three committed fixtures: a control pair,
 * plus one regression pin:
 *
 *   fixtures/v3-subscribe  RECORDED from devnet. v3 leaks by design, so
 *                          P1/P2/P4 are pinned FAIL. If the tool stops seeing
 *                          the leak, CI goes red. (negative control)
 *   fixtures/v4-synthetic  HAND-BUILT, no chain involved — see its README.
 *                          A spend whose instruction carries no commitment;
 *                          P1/P2/P4 are pinned PASS. If the tool becomes
 *                          unable to report a clean result, CI goes red too —
 *                          without this half, a checker that hard-fails
 *                          everything would sail through the negative control
 *                          and a future green would be unfalsifiable.
 *                          (positive control)
 *   fixtures/v4-synthetic-errored
 *                          HAND-BUILT: the same clean spend, but the payer
 *                          history carries two errored signatures. Pins the
 *                          completeness arithmetic in scanProofChunks — P3
 *                          stays PASS when errored entries are skipped. Both
 *                          controls have zero errored entries, so only this
 *                          one catches that regression. (regression pin)
 *
 * USAGE
 *   node verify/p01-verify.mjs --self-test --replay verify/fixtures/v3-subscribe
 *   node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-synthetic
 *   node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-synthetic-errored
 *   node verify/p01-verify.mjs --self-test [--rpc URL]
 *   node verify/p01-verify.mjs --spend <signature> [--rpc URL] [--record DIR]
 *   node verify/p01-verify.mjs --pool <poolPDA> [--limit N] [--rpc URL]
 *   node verify/p01-verify.mjs ... --pools <extra-pools.json>
 *   node verify/p01-verify.mjs ... --wallet <pubkey>   name one address explicitly
 *
 * Exit code 0 = every probe passed (under --self-test: every control held).
 * 1 = a linkage survived (under --self-test: a control broke). 2 = the tool
 * itself failed — config error, unknown pool, replay miss, network dead.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_RPC = 'https://api.devnet.solana.com';
const ZK_SHIELDED = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';
const STARK_VERIFIER = 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs';
const DEFAULT_POOL = '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS';

/**
 * Live V3 SOL pools, `apps/web/lib/privacy/pool/denominatedPool.ts:182-225`.
 *
 * Every entry MUST carry its tree PDA: P4 walks the TREE's transaction history
 * for the `LeafInserted` matching the published commitment, so a pool without
 * its tree cannot support P4 at all. That is why a spend touching a pool this
 * table does not know is a HARD ERROR in verifySpend, not a skip — a run that
 * silently omitted P4 would print green probes and look complete.
 *
 * To extend (a v4 pool lands here): add one line, or pass --pools <json> with
 * the same shape, or let a replay fixture's manifest.json `pools` field
 * register it. All three paths go through registerPools, which rejects a
 * half-entry loudly instead of storing something P4 cannot use.
 */
const POOLS = {
  HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG: { label: '0.1 SOL', tree: '43MRQ91VrrxkD2PqV4QXNJG3BUmu8JmbDUTtWt2dYBAU' },
  '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS': { label: '1 SOL', tree: 'GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi' },
};

function registerPools(extra, source) {
  for (const [addr, cfg] of Object.entries(extra ?? {})) {
    if (!cfg || typeof cfg.label !== 'string' || typeof cfg.tree !== 'string') {
      throw new Error(
        `pool table from ${source} is malformed at ${addr}: need { label, tree }. ` +
          'A pool registered without its tree PDA would silently lose P4.',
      );
    }
    POOLS[addr] = { label: cfg.label, tree: cfg.tree };
  }
}

/**
 * Where each spend instruction publishes the note commitment, as a u64 LE.
 *
 * These offsets are the leak. They are pinned here rather than derived so that
 * a future v4 which removes the field makes this table's entry unreachable
 * instead of silently matching nothing.
 */
const SPEND_KINDS = [
  // The arithmetic, written out, because the transfer entry was wrong by one
  // field and nothing here would have said so. Both v3 spends share a prefix:
  //   disc 8 | nullifier 32 | merkle_root 32 | min_epoch u64 | stark_commitment u64
  //   0..8       8..40           40..72          72..80            80..88
  // so the commitment sits at 80 in BOTH, and 72 is min_epoch. Transfer read 72,
  // which on a real transfer yields min_epoch (0 on every note the client
  // writes), matches no deposit, and reports the spend CLEAN. A false clean, in
  // the tool whose whole purpose is to refuse them.
  // Source: programs/zk_shielded/src/lib.rs:347-356 (arg order) and
  // apps/web/lib/privacy/pool/denominatedPool.ts:2008-2013 (the encoder).
  //
  // `recipientOffset` is the SECOND cleartext address in these instructions and
  // until 2026-08-17 no probe read it. `unshield_denominated_stark_v3` takes the
  // payee as a 32-byte ARGUMENT, not as an account:
  //   disc 8 | nullifier 32 | merkle_root 32 | min_epoch u64 | commitment u64 | recipient 32
  //   0..8       8..40           40..72          72..80          80..88          88..120
  // VERIFIED on both sides rather than taken from one: the arg order is
  // `programs/zk_shielded/src/lib.rs:215-226` and the encoder that produces
  // these bytes is `apps/web/lib/privacy/pool/denominatedPool.ts:1583-1592`.
  // 88 + 32 = 120, which is exactly the `totalLen` already pinned above — so the
  // recipient is the whole remainder of the instruction, and the two independent
  // numbers agree.
  //
  // The other kinds genuinely have no payee argument and must be `null`, not 0:
  // a subscribe pays a vault PDA derived from a commitment, a transfer and a
  // split produce new notes. `null` makes P10 INCONCLUSIVE there rather than
  // reading 32 bytes of something else and reporting an address that does not
  // exist.
  { name: 'unshield_denominated_stark_v3', commitmentOffset: 80, totalLen: 120, recipientOffset: 88 },
  { name: 'subscribe_private_stark', commitmentOffset: 160, totalLen: null, recipientOffset: null },
  { name: 'transfer_denominated_stark_v3', commitmentOffset: 80, totalLen: null, recipientOffset: null },
  // ⚠️ `split_note_stark` was `commitmentOffset: null` — i.e. "this instruction
  // does not publish the commitment" — until 2026-08-17, and that was FALSE.
  // Its signature is `(nullifier: [u8;32], merkle_root: [u8;32], min_epoch: u64,
  // stark_commitment: u64, …)` at `programs/zk_shielded/src/lib.rs:372-381`, so
  // the commitment sits at 8 + 32 + 32 + 8 = 80, the same place the other two v3
  // spends put it.
  //
  // This is the SECOND entry in this table to have been wrong in the
  // false-clean direction (see the transfer note above, which was off by one
  // field). A `null` here does not mean "unchecked", it means "P1 has nothing
  // to read and therefore PASSES" — so a spend routed through a split would
  // have been reported as publishing nothing, which is the exact verdict this
  // tool exists to refuse. It also killed a real idea on the spot: splitting a
  // note before spending it does NOT break the link to its deposit.
  { name: 'split_note_stark', commitmentOffset: 80, totalLen: null, recipientOffset: null },
  // v4 lands here. It must appear with commitmentOffset: null, and P1 then
  // passes only because there is nothing to read — which is the point.
  // ⚠️ If v4 keeps a cleartext recipient argument, give it a real
  // `recipientOffset`. Leaving it null there would silence P10 on the very
  // version that is supposed to be the improvement.
  { name: 'unshield_denominated_stark_v4', commitmentOffset: null, totalLen: null, recipientOffset: null },
];

// ---------------------------------------------------------------------------
// Minimal deps: base58, sha256, an RPC client. No node_modules on purpose —
// a verification tool nobody can run because it needs an install is not one.
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`invalid base58 char ${ch}`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest();
}

/** Anchor instruction discriminator: sha256("global:<name>")[..8]. */
function discriminator(name) {
  return sha256(Buffer.from(`global:${name}`, 'utf8')).subarray(0, 8);
}

/** Anchor EVENT discriminator: sha256("event:<StructName>")[..8]. */
function eventDiscriminator(name) {
  return sha256(Buffer.from(`event:${name}`, 'utf8')).subarray(0, 8);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Throttled JSON-RPC. The public devnet endpoint rate-limits hard, and it
 * signals it two different ways: HTTP 429, and a JSON-RPC error with code
 * -32429 or a "Too many requests" message. Both are retried; anything else is a
 * real error and is raised, because a verification tool that swallows a failed
 * read and calls it a clean result is worse than none.
 */
function makeRpc(url, { minIntervalMs = 120 } = {}) {
  let id = 0;
  let last = 0;
  let calls = 0;
  const rpc = async function rpc(method, params) {
    for (let attempt = 0; attempt < 7; attempt++) {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      calls += 1;

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
      } catch (e) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) {
        await sleep(700 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        await sleep(700 * 2 ** attempt);
        continue;
      }
      if (json.error) {
        const msg = String(json.error.message ?? '');
        if (json.error.code === -32429 || /too many requests|rate/i.test(msg)) {
          await sleep(700 * 2 ** attempt);
          continue;
        }
        throw new Error(`${method}: ${JSON.stringify(json.error)}`);
      }
      return json.result;
    }
    throw new Error(
      `${method}: still rate limited after 7 attempts. Public devnet is throttling; ` +
        'pass --rpc with your own endpoint for a complete read.',
    );
  };
  rpc.calls = () => calls;
  return rpc;
}

// ---------------------------------------------------------------------------
// Fixture record / replay
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted, recursively. Replay lookups key on
 * (method, params), and property insertion order must not matter — a
 * hand-written fixture that lists `{commitment, encoding}` alphabetically has
 * to match code that builds `{encoding, commitment}`.
 */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const body = Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(v);
}

const callKey = (method, params) => canon([method, params]);

/**
 * Trim an RPC response to the fields this tool reads, per method. Applied at
 * RECORD time, and — deliberately — the trimmed value is also what the live
 * caller receives during recording. That way a record run that completes has
 * already proven the trim keeps everything the probes need; a field dropped
 * here by mistake breaks the recording run itself, not a replay months later.
 *
 * For log messages only `Program data: ` lines survive: decodeLeafInserted
 * reads nothing else, and the CU/log noise of ~150 chunk transactions is the
 * bulk of what would otherwise bloat a committed fixture.
 */
function trimForFixture(method, result) {
  if (result == null) return result;
  if (method === 'getTransaction') {
    const msg = result.transaction.message;
    return {
      slot: result.slot,
      meta: result.meta
        ? {
            err: result.meta.err ?? null,
            loadedAddresses: result.meta.loadedAddresses ?? null,
            logMessages: (result.meta.logMessages ?? []).filter((l) => l.startsWith('Program data: ')),
            // Kept because the money often moves here and nowhere else. MEASURED
            // on the real deposit 2PVnaQXD…: three top-level instructions, none
            // of them a System transfer, and the 1 SOL arrives by CPI from
            // zk_shielded — visible only in innerInstructions. Dropping this
            // field made a fixture that could not, even in principle, show P6 or
            // P8 the funding edge they exist to find.
            innerInstructions: (result.meta.innerInstructions ?? []).map((g) => ({
              index: g.index,
              instructions: g.instructions.map((ix) => ({
                programIdIndex: ix.programIdIndex,
                accounts: ix.accounts,
                data: ix.data,
              })),
            })),
          }
        : null,
      transaction: {
        message: {
          header: msg.header ?? null,
          accountKeys: msg.accountKeys,
          instructions: msg.instructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accounts: ix.accounts,
            data: ix.data,
          })),
        },
      },
    };
  }
  if (method === 'getSignaturesForAddress') {
    return (result ?? []).map((s) => ({ signature: s.signature, err: s.err ?? null }));
  }
  if (method === 'getAccountInfo') {
    return { value: result.value ? { data: result.value.data } : null };
  }
  return result;
}

/** Record wrapper: pass calls through to the live rpc, keep the trimmed pairs. */
function wrapRecorder(rpc, store) {
  const wrapped = async (method, params) => {
    const trimmed = trimForFixture(method, await rpc(method, params));
    const key = callKey(method, params);
    if (!store.seen.has(key)) {
      store.seen.add(key);
      store.calls.push({ method, params, result: trimmed });
    }
    return structuredClone(trimmed);
  };
  wrapped.calls = rpc.calls;
  return wrapped;
}

/**
 * Replay rpc: every answer comes from <dir>/rpc.json, nothing from the
 * network. A miss is a hard stop with the exact request printed — the two
 * causes are a probe that changed what it reads (re-record the fixture) and a
 * flag mismatch (replay re-applies the manifest's recorded flags precisely to
 * prevent this, so check the manifest first).
 */
function makeReplayRpc(dir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'rpc.json'), 'utf8'));
  } catch (e) {
    throw new Error(`cannot load fixture ${dir}/rpc.json (${e.message}). Create one with --record <dir>.`);
  }
  const map = new Map();
  for (const c of raw.calls) map.set(callKey(c.method, c.params), c.result);
  let calls = 0;
  const rpc = async (method, params) => {
    calls += 1;
    const key = callKey(method, params);
    if (!map.has(key)) {
      const near = raw.calls
        .filter((c) => c.method === method)
        .slice(0, 4)
        .map((c) => `      ${JSON.stringify(c.params)}`)
        .join('\n');
      throw new Error(
        `replay miss — the fixture holds no response for:\n` +
          `    ${method} ${JSON.stringify(params)}\n` +
          `  A miss is a hard stop: answering it with silence would let an unread channel\n` +
          `  pass as clean. Either the probes changed what they read (re-record with\n` +
          `  --record) or the request shape drifted from what was recorded.\n` +
          (near
            ? `  Nearest ${method} entries in the fixture:\n${near}`
            : `  The fixture has no ${method} entries at all.`),
      );
    }
    return structuredClone(map.get(key));
  };
  rpc.calls = () => calls;
  return rpc;
}

/**
 * Freeze a completed live run: the trimmed RPC pairs, the flags that shaped
 * their request parameters, and — as the `expect` map — the measured outcome
 * of every probe. Committing that map is what turns the fixture into a
 * control: `--self-test --replay` re-runs the probes on the frozen bytes and
 * refuses any deviation, in either direction. Review the pins against the run
 * you just watched before committing them.
 */
function writeFixture(dir, store, report, opts) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rpc.json'), JSON.stringify({ calls: store.calls }, null, 1));
  const manifest = {
    note:
      `Recorded live from devnet on ${new Date().toISOString().slice(0, 10)}. ` +
      'Review `expect` against the run that produced it before committing.',
    spend: report.signature,
    kind: report.kind,
    flags: {
      maxChunkTx: opts.maxChunkTx,
      depositLimit: opts.depositLimit,
      // Recorded because it changes WHICH transactions were fetched, so a
      // replay must reproduce the same walk or it will miss. A fixture taken
      // without a named wallet holds only the two ends of each payer's life;
      // replaying it exhaustively would hard-stop on the first unrecorded
      // transaction, which is the correct behaviour and the wrong experience.
      // Recording it is what lets an old fixture stay valid instead of
      // becoming a landmine the day a new probe wants a deeper read.
      ...(opts.wallet ? { wallet: opts.wallet, exhaustiveWalk: true } : {}),
    },
    expect: Object.fromEntries(report.results.map((r) => [r.id, r.passed ? 'PASS' : 'FAIL'])),
    // PASS/FAIL alone is too coarse for a probe that counts. A sixth instruction
    // publishing the commitment leaves P7 at FAIL, so the pin holds and nobody
    // learns anything got worse. `measure` pins the NUMBER, so a leak that grows
    // inside an already-failing probe still turns the control red.
    measure: Object.fromEntries(
      report.results.filter((r) => r.measure !== null && r.measure !== undefined).map((r) => [r.id, r.measure]),
    ),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n  fixture written: ${dir} (${store.calls.length} RPC responses, ${report.results.length} probe pins)`);
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

/** `DenominatedPoolV3.note_count` — the anonymity set. `pool_v3.rs:53-98`. */
async function readPoolState(rpc, poolPDA) {
  const info = await rpc('getAccountInfo', [poolPDA, { encoding: 'base64' }]);
  if (!info?.value) throw new Error(`pool account not found: ${poolPDA}`);
  const d = Buffer.from(info.value.data[0], 'base64');
  return {
    denomination: Number(d.readBigUInt64LE(72)) / 1e9,
    treeDepth: d[120],
    nextLeafIndex: Number(d.readBigUInt64LE(121)),
    unspentNotes: Number(d.readBigUInt64LE(169)),
  };
}

/**
 * Decode `LeafInserted` from an Anchor `Program data:` log line.
 * Struct: 8-byte event discriminator, pool[32], leaf_index u64, leaf[32],
 * new_root[32], old_root[32] (`merkle_tree_v3.rs:211-217`) — 144 bytes.
 *
 * The discriminator check is what makes this a decoder rather than a guess:
 * without it, ANY event of sufficient length emitted by any program in the
 * transaction was read as a leaf at offset 48, so a different event could
 * satisfy — or, worse, mask — P4. `>=` on the length, not `===`, so a field
 * appended after old_root does not orphan the decoder; the discriminator
 * still pins the event's identity and the offsets below stay valid because
 * Anchor only ever appends.
 */
const LEAF_INSERTED_DISC = eventDiscriminator('LeafInserted');
const LEAF_INSERTED_LEN = 8 + 32 + 8 + 32 + 32 + 32;

function decodeLeafInserted(logs) {
  const out = [];
  for (const line of logs ?? []) {
    if (!line.startsWith('Program data: ')) continue;
    let d;
    try {
      d = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (d.length < LEAF_INSERTED_LEN) continue;
    if (!d.subarray(0, 8).equals(LEAF_INSERTED_DISC)) continue;
    out.push({
      pool: d.subarray(8, 40),
      leafIndex: Number(d.readBigUInt64LE(40)),
      // A V3 commitment is a Goldilocks u64 zero-padded to 32 bytes, so the
      // value that matters is the low limb.
      leaf: d.readBigUInt64LE(48),
      raw: d,
    });
  }
  return out;
}

async function getTx(rpc, signature) {
  return rpc('getTransaction', [
    signature,
    { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' },
  ]);
}

function accountKeysOf(tx) {
  const msg = tx.transaction.message;
  const loaded = tx.meta?.loadedAddresses;
  return [
    ...msg.accountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ];
}

/** Classify a zk_shielded instruction by its Anchor discriminator. */
let spendTable = null;
function classifySpend(tx) {
  spendTable ??= SPEND_KINDS.map((k) => ({ ...k, disc: discriminator(k.name) }));
  const keys = accountKeysOf(tx);
  for (const ix of tx.transaction.message.instructions) {
    if (keys[ix.programIdIndex] !== ZK_SHIELDED) continue;
    const data = b58decode(ix.data);
    for (const kind of spendTable) {
      if (data.length >= 8 && data.subarray(0, 8).equals(kind.disc)) {
        return { kind, data, accounts: ix.accounts.map((i) => keys[i]) };
      }
    }
  }
  return null;
}

/**
 * Reassemble the proof bytes a spend's proof buffers were filled with.
 *
 * This is the step a scan of the spend instruction alone misses. The buffer PDA
 * is an account key of the spend, its whole write history is public, and
 * `write_proof_chunk(offset: u32, data: Vec<u8>)` puts the proof in the clear.
 */
async function scanProofChunks(rpc, payer, target, { maxTx = 200, onProgress } = {}) {
  const writeDisc = discriminator('write_proof_chunk');

  // The payer of the spend IS the proof-buffer authority: the pool requires
  // `c1_authority == payer` (`unshield_denominated_stark_v3.rs:222`, `:263`),
  // and the verifier makes the authority a required Signer on every write
  // (`p01_stark_verifier/src/lib.rs:507-512`). So one address holds the whole
  // upload, and walking it is precisely the analyst's path.
  // Ask for ONE MORE than we intend to scan. Without that, a page that comes
  // back exactly `maxTx` long is indistinguishable from "that is all there is",
  // and the completeness check below would call a capped scan complete — the
  // precise shape of hollow guard this tool exists to avoid.
  const requested = Math.min(1000, maxTx + 1);
  const sigs = await rpc('getSignaturesForAddress', [payer, { limit: requested }]);
  if (!sigs?.length) {
    return { scanned: 0, available: 0, chunkCount: 0, bytesSeen: 0, hit: null, complete: false };
  }
  const moreMayExist = sigs.length >= requested;

  let scanned = 0;
  let chunkCount = 0;
  let bytesSeen = 0;
  // Errored signatures are SKIPPED, not scanned — but they still occupy a slot
  // in `sigs`, so the completeness test below must account for them or a single
  // failed transaction anywhere in the payer's history makes `complete` false
  // forever. That printed "raise --max-chunk-tx", which could never help: the
  // shortfall is not a cap. The payer is a long-lived wallet and chunks are
  // sent with skipPreflight, so one errored entry is ordinary. Fails closed
  // (a false INCONCLUSIVE, never a false PASS), but the advice was inert.
  // Pinned by fixtures/v4-synthetic-errored, the only fixture whose payer
  // history carries errored entries.
  let errored = 0;

  for (const s of sigs) {
    if (scanned >= maxTx) break;
    if (s.err) {
      errored += 1;
      continue;
    }
    const tx = await getTx(rpc, s.signature);
    scanned += 1;
    onProgress?.(scanned, sigs.length);
    if (!tx) continue;
    const keys = accountKeysOf(tx);
    for (const ix of tx.transaction.message.instructions) {
      if (keys[ix.programIdIndex] !== STARK_VERIFIER) continue;
      const data = b58decode(ix.data);
      if (data.length < 16 || !data.subarray(0, 8).equals(writeDisc)) continue;
      const offset = data.readUInt32LE(8);
      const len = data.readUInt32LE(12);
      const bytes = data.subarray(16, 16 + len);
      chunkCount += 1;
      bytesSeen += bytes.length;

      // Early exit on the first hit. The leak this looks for is a trace column
      // constrained constant, so the value repeats throughout the proof and one
      // occurrence settles it — there is no need to reassemble ~130 KB to prove
      // a value is present.
      if (target !== null) {
        for (let i = 0; i + 8 <= bytes.length; i++) {
          if (bytes.readBigUInt64LE(i) === target) {
            return {
              scanned,
              available: sigs.length,
              chunkCount,
              bytesSeen,
              hit: { signature: s.signature, proofOffset: offset + i },
              complete: true,
            };
          }
        }
      }
    }
  }

  return {
    scanned,
    available: sigs.length,
    chunkCount,
    bytesSeen,
    hit: null,
    // Complete only when every entry in the payer's history was accounted for —
    // scanned or skipped as errored — AND the RPC did not signal more pages.
    complete: scanned + errored >= sigs.length && !moreMayExist,
  };
}

/**
 * Walk the fee payer's FUNDING EDGES — where its lamports came from, and where
 * they went.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE CHEAPEST ATTACK IN THE FILE
 * ─────────────────────────────────────────────────────────────
 * P1-P4 chase a commitment. That is the cryptographic channel, and it is the
 * one this project has spent months on. It is not the one an analyst would use.
 *
 * The spend is signed by an ephemeral key, which is good. But an ephemeral key
 * starts with zero lamports and cannot pay a fee, so SOMETHING funded it, and on
 * Solana that something is a public `SystemProgram::transfer`. The client also
 * sweeps the residue back when the job ends. The ephemeral is therefore bracketed
 * by two ordinary transfers, and both name the wallet.
 *
 * MEASURED on the recorded fixture: the ephemeral's ENTIRE life is 172
 * transactions inside ~88 slots. Its oldest transaction is the pre-fund, its
 * newest is the sweep. So the walk does not need the history — it needs its two
 * ends, which is why this probe deliberately fetches only two transactions and
 * prints the call count. An attack that costs three RPC calls is not a
 * theoretical weakness.
 *
 * WHAT A PASS MEANS, EXACTLY
 * ──────────────────────────
 * PASS = no System transfer at either end of this payer's life names a
 * counterparty. It does NOT mean the payer is unreachable: a funder could sit
 * one hop further out, or the link could live off-chain at a relayer that
 * logged the request. Read it as "the one-hop financial edge is closed", never
 * as "the payer is anonymous".
 */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const SYS_IX_CREATE_ACCOUNT = 0;
const SYS_IX_TRANSFER = 2;
const SYS_IX_CREATE_ACCOUNT_WITH_SEED = 3;
const SYS_IX_WITHDRAW_NONCE = 5;
const SYS_IX_TRANSFER_WITH_SEED = 11;

/**
 * Decode any System instruction that MOVES LAMPORTS. Returns null for the ones
 * that do not (`allocate`, `assign`, nonce init/advance/authorize).
 *
 * 🚨 WHY THIS IS NOT JUST `transfer`
 * ──────────────────────────────────
 * Until 2026-08-17 this matched instruction 2 and nothing else, and every probe
 * that reads a funding edge was built on it. `transfer` is not the only way to
 * put lamports on a key: `createAccount` funds and creates in one step,
 * `createAccountWithSeed` and `transferWithSeed` do the same from a derived
 * address, and `withdrawNonceAccount` pays out of a nonce account. A client that
 * pre-funded its ephemeral with any of them would have made probe P6 report
 * "no System transfer names a counterparty" — a GREEN verdict with the user's
 * wallet exactly one hop away.
 *
 * That was never a hypothetical about attackers. It is the shape a well-meaning
 * refactor takes: `createAccount` is the natural call when the destination is a
 * fresh key, which an ephemeral always is. A probe whose blind spot is the
 * idiomatic path is worse than no probe, because it certifies the failure.
 *
 * The returned `kind` travels with the edge so a verdict can say HOW the money
 * moved. "Bracketed by two transfers" and "created by its funder" are different
 * facts and a report that flattens them tells the reader less than it knows.
 */
function decodeSystemTransfer(data, accounts, keys) {
  if (data.length < 4) return null;
  const at = (i) => keys[accounts[i]];
  switch (data.readUInt32LE(0)) {
    // { lamports: u64 } — accounts [from, to]
    case SYS_IX_TRANSFER:
      if (data.length < 12 || accounts.length < 2) return null;
      return { source: at(0), destination: at(1), lamports: data.readBigUInt64LE(4), kind: 'transfer' };

    // { lamports: u64, space: u64, owner: Pubkey } — accounts [payer, created]
    case SYS_IX_CREATE_ACCOUNT:
      if (data.length < 52 || accounts.length < 2) return null;
      return { source: at(0), destination: at(1), lamports: data.readBigUInt64LE(4), kind: 'createAccount' };

    // { base: Pubkey, seed: String, lamports: u64, space: u64, owner: Pubkey }
    // — accounts [payer, created, base?]. The seed is length-prefixed, so the
    // lamports field does not sit at a fixed offset.
    case SYS_IX_CREATE_ACCOUNT_WITH_SEED: {
      if (data.length < 44 || accounts.length < 2) return null;
      const seedLen = Number(data.readBigUInt64LE(36));
      const off = 44 + seedLen;
      if (!Number.isSafeInteger(seedLen) || seedLen < 0 || data.length < off + 8) return null;
      return {
        source: at(0), destination: at(1), lamports: data.readBigUInt64LE(off),
        kind: 'createAccountWithSeed',
      };
    }

    // { lamports: u64 } — accounts [nonce, recipient, ...]
    case SYS_IX_WITHDRAW_NONCE:
      if (data.length < 12 || accounts.length < 2) return null;
      return { source: at(0), destination: at(1), lamports: data.readBigUInt64LE(4), kind: 'withdrawNonce' };

    // { lamports: u64, from_seed: String, from_owner: Pubkey }
    // — accounts [derived source, base signer, destination]. The lamports leave
    // the DERIVED address, so that is the source; naming the base signer instead
    // would report an address that lost nothing.
    case SYS_IX_TRANSFER_WITH_SEED:
      if (data.length < 12 || accounts.length < 3) return null;
      return { source: at(0), destination: at(2), lamports: data.readBigUInt64LE(4), kind: 'transferWithSeed' };

    default:
      return null;
  }
}

/**
 * Every System transfer in one transaction that touches `payer`, from BOTH
 * instruction levels.
 *
 * WHY BOTH LEVELS, STATED WITHOUT EXAGGERATION
 * ────────────────────────────────────────────
 * A System transfer reached by CPI is invisible to a top-level scan, and this
 * chain does that routinely: MEASURED 2026-08-16, the real deposit `2PVnaQXD…`
 * has three top-level instructions — two ComputeBudget and one zk_shielded —
 * and NOT ONE top-level System transfer. Its two lamport movements exist only in
 * `meta.innerInstructions`.
 *
 * ⚠️ Be precise about what that did and did not cost. Those two inner transfers
 * go to the pool and the fee escrow, not to a wallet, so reading them changes no
 * verdict on the committed fixture — MEASURED: `BRop3akx…` funds that ephemeral
 * by a TOP-LEVEL transfer at the oldest index and is swept by another at the
 * newest, so the old walk found it. The gap this closes is a future one: nothing
 * stops a funder paying an ephemeral through a CPI, and a probe blind to that
 * would report a funded key as unfunded. An earlier version of this comment
 * claimed the old walk had already missed this payer. It had not, and a comment
 * that overstates a probe is the defect this file's header names.
 */
function systemTransfersIn(tx, payer) {
  const keys = accountKeysOf(tx);
  const found = [];
  const consider = (ix, level) => {
    if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM) return;
    const t = decodeSystemTransfer(b58decode(ix.data), ix.accounts, keys);
    if (!t) return;
    // Only edges that touch the payer, and only counterparties that are not the
    // payer itself.
    const other = t.source === payer ? t.destination : t.destination === payer ? t.source : null;
    if (!other || other === payer) return;
    found.push({
      level,
      direction: t.source === payer ? 'out' : 'in',
      counterparty: other,
      lamports: t.lamports,
      kind: t.kind,
    });
  };
  for (const ix of tx.transaction.message.instructions) consider(ix, 'top');
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) consider(ix, 'inner');
  }
  return found;
}

/**
 * Walk a payer's funding edges — cheaply when there is a leak, exhaustively
 * when there is not.
 *
 * THE ASYMMETRY IS THE DESIGN
 * ───────────────────────────
 * Finding the link is cheap and proving its absence is not, so this walk stops
 * the moment the two ends of the payer's life name a counterparty: that is the
 * real attack, it costs three RPC calls, and the number is half the finding.
 *
 * But when the ends come back clean it does NOT stop there. It reads every
 * transaction in the history before reporting zero edges, because two samples
 * out of ninety-six are not evidence of absence.
 *
 * The committed fixture is the case where the two ends happen to be right:
 * MEASURED on the deposit payer `HDudHd6Y…`, 96 transactions, pre-fund at index
 * 95 and sweep at index 0, both top-level, both naming `BRop3akx…`. The two-end
 * walk answered correctly there — by the shape of today's client, not by
 * construction. One funder that pre-funds mid-life, or through a CPI, breaks
 * that coincidence, and the probe would have reported a clean payer.
 *
 * So a FAIL is cheap and an INCONCLUSIVE is cheap, and only a PASS pays for
 * itself. That is the right way round for a tool that must never report a false
 * clean.
 */
async function traceFunderEdges(rpc, payer, { historyLimit, exhaustive = false } = {}) {
  let calls = 0;
  // EVERY account key of every transaction read, not only the ones that moved
  // lamports. `systemTransfersIn` answers "who paid whom"; this answers "who is
  // NAMED", which is a strictly larger set and is what the cheapest real-world
  // extraction actually dumps:
  //
  //   $r.result.transaction.message.accountKeys | ForEach-Object { $_.pubkey }
  //
  // An address can sit in accountKeys as a read-only account, a co-signer, or a
  // program argument and move nothing — invisible to every edge probe here, and
  // right there in that one line of output. Collected during the walk that was
  // happening anyway, so it costs no extra RPC call. See probe P11.
  //
  // ⚠️ DECLARED HERE, ABOVE THE EARLY RETURN. It used to be declared further
  // down and referenced by the no-history return below, which is a temporal
  // dead zone: that path threw ReferenceError instead of returning a verdict.
  // It is the path a pruned RPC takes, so the tool crashed exactly where it was
  // meant to say "I could not see".
  const namedKeys = new Set();
  // Request the SAME page size the other history walkers use. The replay cache
  // keys on exact request params, so a different limit here would be a cache
  // miss on every recorded fixture — and, worse, would make three probes fetch
  // three copies of one page against a live RPC.
  const sigs = await rpc('getSignaturesForAddress', [payer, { limit: historyLimit }]);
  calls += 1;
  if (!sigs?.length) {
    return {
      edges: [], historyLength: 0, truncated: false, calls, scanned: 0, deep: false, namedKeys,
      inconclusive: 'no history returned for the payer',
    };
  }
  // getSignaturesForAddress returns NEWEST first. The pre-fund is therefore the
  // LAST entry and the sweep the FIRST — but only if the whole life fits in one
  // page. If it does not, the oldest entry we hold is not the payer's first
  // transaction and its absence of a funder proves nothing, so say so.
  const truncated = sigs.length >= historyLimit;

  // An errored transaction moved no lamports, so it cannot fund anything and is
  // skipped — but it still counts toward the history, exactly as P3 learned to
  // do when one failed chunk upload used to force the whole probe INCONCLUSIVE.
  const live = sigs.filter((s) => !s.err);
  const edges = [];
  const visited = new Set();

  const visit = async (signature, role) => {
    if (visited.has(signature)) return;
    visited.add(signature);
    const tx = await getTx(rpc, signature);
    calls += 1;
    if (!tx) return;
    for (const k of accountKeysOf(tx)) namedKeys.add(k);
    for (const t of systemTransfersIn(tx, payer)) {
      edges.push({ role, ...t, signature, slot: tx.slot });
    }
  };

  const newest = live[0];
  const oldest = live[live.length - 1];
  if (oldest) await visit(oldest.signature, 'pre-fund (oldest)');
  if (newest && newest.signature !== oldest?.signature) await visit(newest.signature, 'sweep (newest)');

  // The cheap answer, when there is one: the ends already name someone.
  //
  // 🚨 UNLESS SOMEBODY ASKED ABOUT A SPECIFIC ADDRESS. This early return is
  // correct for P6, whose question ("is this payer bracketed by anything") is
  // ANSWERED the moment one edge exists. It is fatal to P11, whose question is
  // "is address X anywhere in here" — and whose absence-answer is only credible
  // from a complete read.
  //
  // The two collide on every single correct run of the treasury plan. A
  // funder-paid ephemeral is funded in its oldest transaction and swept in its
  // newest, so the ends ALWAYS name the funder, so `deep` was always false, so
  // P11 was structurally incapable of ever passing. The runbook meanwhile named
  // a P11 PASS as the audit answer and forbade presenting the INCONCLUSIVE that
  // would actually print — scripting a presenter to reach a line the tool was
  // engineered never to emit.
  //
  // So: naming an address buys the whole history. ~268 extra getTransaction on
  // the measured shapes, which the `--record` step the runbook already
  // prescribes absorbs once and replays for free forever.
  //
  // ⛔ NOT "skip the walk if the only counterparty is the declared funder".
  // That gates completeness on an operator's assertion about their own
  // deployment, which is the false clean this whole file exists to refuse.
  if (edges.length && !exhaustive) {
    return {
      edges, historyLength: sigs.length, truncated, calls, scanned: visited.size, deep: false, namedKeys,
      inconclusive: null,
    };
  }

  // No answer at the ends. Absence is only credible once the whole history has
  // been read, so pay for it.
  for (const s of live) await visit(s.signature, 'mid-life');
  return {
    edges, historyLength: sigs.length, truncated, calls, scanned: visited.size, deep: true, namedKeys,
    inconclusive: null,
  };
}

/**
 * The address a withdrawal pays into, read out of the spend instruction itself.
 *
 * WHY THIS IS THE OTHER HALF OF THE ATTACK
 * ────────────────────────────────────────
 * Everything else in this file walks the PAYER — who funded the key that signed.
 * The payee is a separate and equally cheap road to the same person, and it runs
 * through a value that is sitting in the spend instruction in the clear, at a
 * fixed offset, with no walk required to obtain it.
 *
 * `/pay` derives a fresh payout address per note precisely so the pool's payee
 * is not the user's wallet. That mechanism is undone by one later transaction —
 * the user moving the money — and the whole chain is:
 *
 *   getTransaction(spend) → recipient at byte 88 → getSignaturesForAddress
 *   → getTransaction(the sweep) → the wallet
 *
 * Three RPC calls. Same price as the payer walk, same transaction, same person.
 * MEASURED in the mobile client on devnet 2026-08-04: stealth recipient
 * `C4MqLbEx…` forwarded 0.994995 SOL to the user's wallet 8 seconds later, slot
 * 481027703.
 *
 * Returns null when this spend kind publishes no payee argument.
 */
function readRecipient(spend) {
  const off = spend.kind.recipientOffset;
  if (off === null || off === undefined) return null;
  if (spend.data.length < off + 32) return null;
  return b58encode(spend.data.subarray(off, off + 32));
}

/**
 * Count how many INSTRUCTION ARGUMENTS in the payer's history carry the
 * commitment in the clear — every instruction, not only `write_proof_chunk`.
 *
 * WHY P3 IS NOT THIS
 * ──────────────────
 * P3 filters strictly on the `write_proof_chunk` discriminator, because its
 * question is "is the witness inside the proof payload". That filter is correct
 * for P3 and a blind spot for everything else: the verifier takes
 * `public_inputs: Vec<u64>` as an INSTRUCTION ARGUMENT, and C1's public inputs
 * are `[nullifier, commitment]`. So the pair that IS the linkage is published by
 * the verify calls, in the clear, before the spend even lands.
 *
 * This matters for what happens next, not only for what is true today. Removing
 * the commitment from the spend instruction would turn P1 and P2 green while the
 * leak survived in the verify instructions — a fix that reads as a win and is a
 * regression in the report. This probe is what makes that impossible.
 *
 * The count is a FLOOR, not a total. It sees only the payer's own history, so
 * publications on the DEPOSIT side (a different ephemeral) are outside it, as is
 * any occurrence inside an event log rather than an instruction.
 */
async function scanInstructionArguments(rpc, payer, target, { maxTx = 400 } = {}) {
  const writeDisc = discriminator('write_proof_chunk');
  const requested = Math.min(1000, maxTx + 1);
  const sigs = await rpc('getSignaturesForAddress', [payer, { limit: requested }]);
  if (!sigs?.length) return { sites: [], scanned: 0, available: 0, complete: false };
  const moreMayExist = sigs.length >= requested;

  const sites = [];
  let scanned = 0;
  let errored = 0;
  for (const s of sigs) {
    if (scanned >= maxTx) break;
    if (s.err) {
      errored += 1;
      continue;
    }
    const tx = await getTx(rpc, s.signature);
    scanned += 1;
    if (!tx) continue;
    const keys = accountKeysOf(tx);
    for (const ix of tx.transaction.message.instructions) {
      const data = b58decode(ix.data);
      // Proof payload is P3's territory. Counting it here would conflate "the
      // proof contains the witness" with "an instruction argument names it",
      // which are different defects with different fixes.
      if (data.length >= 8 && data.subarray(0, 8).equals(writeDisc)) continue;
      const offsets = [];
      for (let i = 0; i + 8 <= data.length; i++) {
        if (data.readBigUInt64LE(i) === target) offsets.push(i);
      }
      if (offsets.length) {
        sites.push({
          signature: s.signature,
          program: keys[ix.programIdIndex],
          slot: tx.slot,
          dataLength: data.length,
          offsets,
        });
      }
    }
  }
  return {
    sites,
    scanned,
    available: sigs.length,
    complete: scanned + errored >= sigs.length && !moreMayExist,
  };
}

/**
 * P8's rule, split into two pure functions so every fail-closed branch has an
 * offline control instead of only the two branches a fixture happens to hit.
 *
 * The split is where the single RPC walk goes: `overlapPrecheck` decides
 * whether the deposit side is worth walking at all, the caller walks it, and
 * `overlapVerdict` judges the pair. Neither function touches the network, so
 * `--self-test` drives every branch of both with hand-built inputs, and asserts
 * the REASON each refusal gives rather than merely that it refused — the first
 * version checked only stop-vs-walk, and two cases landed on a different branch
 * than their name claimed while still printing green.
 */
const P8_NAME = 'no single wallet funded both the deposit and the spend';

function overlapPrecheck({ deposit, target, payer, spendTrace }) {
  if (deposit === null) {
    return {
      stop:
        target === null
          ? 'no commitment was published, so P4 had nothing to match and there is no deposit side to walk.'
          : 'P4 found no deposit for this commitment within the searched window, so there is no ' +
            'deposit side to compare. That is a gap in what was read, not a clean result — see P4.',
    };
  }
  if (payer === null) return { stop: 'the spend carries no message header, so its fee payer is unknown.' };
  if (deposit.payer === null) {
    return {
      stop: `the deposit ${deposit.signature.slice(0, 12)}… carries no message header, so its fee payer is unknown.`,
    };
  }
  // Checked BEFORE the traces, because it needs no walk and because a shared
  // key is a strictly worse finding than a shared funder: there is no hop at
  // all. Reporting it as "1 common wallet" after two walks would have cost
  // three RPC calls to say something the two payer fields already said.
  if (deposit.payer === payer) return { sameKey: true };
  if (spendTrace === null || spendTrace.inconclusive) {
    return {
      stop:
        `the spend side did not resolve (${spendTrace?.inconclusive ?? 'no walk was performed'}), ` +
        'so it cannot be shown disjoint from anything.',
    };
  }
  if (spendTrace.truncated) {
    return {
      stop:
        `the spend payer's history filled the requested page (${spendTrace.historyLength}), so the ` +
        'set of wallets behind it is not provably complete. An unread edge is not a closed one.',
    };
  }
  if (spendTrace.edges.length === 0) {
    return {
      stop:
        'no counterparty was resolved on the spend side, so there is no set to intersect. See P6: ' +
        'an unfunded payer is a different claim from a disjoint one.',
    };
  }
  return { walk: deposit.payer };
}

function overlapVerdict(depositTrace, spendTrace, depositPayer, spendPayer) {
  if (depositTrace.inconclusive) return { stop: `the deposit side did not resolve (${depositTrace.inconclusive}).` };
  if (depositTrace.truncated) {
    return {
      stop:
        `the deposit payer's history filled the requested page (${depositTrace.historyLength}), so the ` +
        'set of wallets behind it is not provably complete.',
    };
  }
  if (depositTrace.edges.length === 0) {
    return {
      stop:
        `no counterparty was resolved on the deposit side over its ${depositTrace.historyLength}-transaction ` +
        'life, so there is no set to intersect.',
    };
  }
  const spendSide = new Set(spendTrace.edges.map((e) => e.counterparty));
  const depositSide = new Set(depositTrace.edges.map((e) => e.counterparty));
  const common = [...depositSide].filter((a) => spendSide.has(a));

  // 🚨 THE SHORTEST EDGE IN THE GRAPH, AND THE FIRST VERSION DID NOT TEST IT.
  // `traceFunderEdges` excludes the payer from its own counterparty set by
  // construction (`if (!other || other === payer) continue`), so if the deposit
  // payer funded the spend payer DIRECTLY — one hop, the cheapest possible link
  // — neither set contains the other's payer and the intersection is empty.
  // The probe printed "disjoint" on a pair joined by a single transfer.
  // Reproduced by driving these two functions with chained ephemerals: W funds
  // E1 which pays the deposit, E1 funds E2 which pays the spend, and both
  // `spendSide.has(depositPayer)` and `depositSide.has(spendPayer)` answered
  // true while `common` was empty. The direct edge is now part of `common`.
  if (spendPayer !== undefined && spendSide.has(depositPayer)) common.push(depositPayer);
  if (depositPayer !== undefined && depositSide.has(spendPayer) && !common.includes(spendPayer)) {
    common.push(spendPayer);
  }
  return { common, spendSide, depositSide };
}

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

/**
 * `id` is the stable handle the self-test pins against a fixture manifest, so
 * it must never be renamed casually: an id change orphans every committed
 * `expect` map at once (and the self-test will say so loudly).
 */
function probe(id, name, passed, detail, measure = null) {
  return { id, name, passed, detail, measure };
}

/**
 * One sentence about a NAMED address, appended to a funding-edge verdict.
 *
 * WHY `--wallet` EXISTS
 * ─────────────────────
 * Every funding probe here answers a structural question — "is this payer
 * bracketed by anything" — and structural answers get quieter as the client
 * improves. Route the spend leg through a shared treasury and P6 truthfully
 * reports the treasury, P8 truthfully reports two disjoint sets, and a reader
 * skimming the run sees no user wallet anywhere. Nothing lied; the thing they
 * came to check simply stopped being printed.
 *
 * `--wallet <pubkey>` asks the one question a structural probe cannot: is THIS
 * address in there. It changes no verdict on its own (except P8's, below) and
 * exists so the answer cannot go missing by accident.
 */
function namedWalletLine(namedWallet, trace, sideLabel) {
  if (!namedWallet || !trace || trace.inconclusive) return '';
  const hit = trace.edges.filter((e) => e.counterparty === namedWallet);
  return hit.length > 0
    ? ` ⛔ --wallet: ${namedWallet} IS among the ${sideLabel} payer's counterparties ` +
      `(${hit.length} edge(s)).`
    : ` --wallet: ${namedWallet} is NOT among the ${sideLabel} payer's ${trace.edges.length} ` +
      `counterparty edge(s) over ${trace.scanned} transaction(s) read.`;
}

async function verifySpend(rpc, signature, opts = {}) {
  const chunkLimit = opts.maxChunkTx ?? 200;
  /** `--wallet`: an address the operator wants named explicitly. See `namedWalletLine`. */
  const namedWallet = opts.wallet ?? null;
  /** Whether the payer walks read the WHOLE history. True on a live run whenever
   *  an address is named; on a replay it comes from the fixture, because the walk
   *  depth decides which transactions were recorded. */
  const exhaustiveWalk = opts.exhaustiveWalk ?? !!namedWallet;
  const tx = await getTx(rpc, signature);
  if (!tx) throw new Error(`transaction not found (RPC may have pruned it): ${signature}`);

  const spend = classifySpend(tx);
  if (!spend) throw new Error('no recognised zk_shielded spend instruction in that transaction');

  const results = [];
  const keys = accountKeysOf(tx);

  // An unknown pool is a config gap, not a verdict. Refusing here (exit 2)
  // rather than continuing without P4 is deliberate: the run would otherwise
  // print P1-P3 and look complete while the deposit walk was silently skipped.
  const poolPDA = spend.accounts.find((a) => POOLS[a]) ?? null;
  if (!poolPDA) {
    const known = Object.entries(POOLS)
      .map(([k, v]) => `${v.label} = ${k}`)
      .join(', ');
    throw new Error(
      `none of this spend's ${spend.accounts.length} instruction accounts is a known pool. ` +
        `Known pools: ${known}. If a new pool shipped, add it to POOLS in this file or pass ` +
        `--pools <json> ({ "<poolPDA>": { "label": "...", "tree": "<treePDA>" } }) — ` +
        `continuing without it would silently skip P4.`,
    );
  }

  // ── P1: does the spend instruction carry the commitment by name? ──────────
  let published = null;
  if (spend.kind.commitmentOffset !== null && spend.data.length >= spend.kind.commitmentOffset + 8) {
    published = spend.data.readBigUInt64LE(spend.kind.commitmentOffset);
  }
  results.push(
    probe(
      'P1',
      'spend instruction does not publish the note commitment',
      published === null,
      published === null
        ? `${spend.kind.name} carries no commitment argument`
        : `${spend.kind.name} publishes ${published} at instruction byte offset ${spend.kind.commitmentOffset}`,
    ),
  );

  // Everything downstream needs a commitment to hunt for. Without one there is
  // nothing to correlate, and the remaining probes say so rather than passing
  // vacuously.
  const target = published;

  // ── P2: does it appear anywhere else in the instruction data? ─────────────
  if (target !== null) {
    const hits = [];
    for (let i = 0; i + 8 <= spend.data.length; i++) {
      if (spend.data.readBigUInt64LE(i) === target) hits.push(i);
    }
    results.push(
      probe(
        'P2',
        'no 8-byte window of the spend instruction matches the commitment',
        hits.length === 0,
        hits.length === 0
          ? 'clean'
          : `found at byte offset(s) ${hits.join(', ')} of ${spend.data.length}`,
      ),
    );
  } else {
    results.push(probe('P2', 'no 8-byte window of the spend instruction matches the commitment', true, 'no commitment to look for'));
  }

  // ── P3: the proof bytes ───────────────────────────────────────────────────
  // The probe a spend-instruction scan cannot do, and the reason this file
  // exists. See the header.
  //
  // keys[0] is the fee payer only because the message header says so: the
  // first `numRequiredSignatures` account keys are the signers, and the fee
  // payer is defined as the first of them. An RPC response without that header
  // gives no way to identify who uploaded the proof — and a guessed payer
  // would scan the wrong wallet's history and call its silence a clean result.
  // So: no header, no scan, said out loud.
  const numSigners = tx.transaction.message.header?.numRequiredSignatures;
  const payer = Number.isInteger(numSigners) && numSigners >= 1 ? keys[0] : null;

  let proof = null;
  if (payer === null) {
    results.push(
      probe(
        'P3',
        'uploaded proof bytes do not carry the commitment',
        false,
        'INCONCLUSIVE: the message header is absent or declares no signers, so the fee ' +
          'payer — the proof-buffer authority — cannot be determined and nothing was scanned.',
      ),
    );
  } else {
    proof = await scanProofChunks(rpc, payer, target, { maxTx: chunkLimit });
    const coverage = `payer ${payer.slice(0, 8)}…, ${proof.scanned}/${proof.available} tx scanned, ${proof.chunkCount} proof chunks, ${proof.bytesSeen} bytes`;

    if (proof.hit) {
      results.push(
        probe(
          'P3',
          'uploaded proof bytes do not carry the commitment',
          false,
          `commitment present in the PROOF at byte ${proof.hit.proofOffset}, uploaded by ${proof.hit.signature} (${coverage})`,
        ),
      );
    } else if (proof.chunkCount === 0) {
      results.push(
        probe(
          'P3',
          'uploaded proof bytes do not carry the commitment',
          false,
          `INCONCLUSIVE, reported as a failure on purpose: no write_proof_chunk transactions were ` +
            `reachable (${coverage}). An unread channel is not a clean one. Re-run with --rpc ` +
            `pointing at an archival endpoint before believing this one.`,
        ),
      );
    } else if (!proof.complete) {
      results.push(
        probe(
          'P3',
          'uploaded proof bytes do not carry the commitment',
          false,
          `INCONCLUSIVE: scan was capped before exhausting the payer's history (${coverage}). ` +
            `Raise --max-chunk-tx or use an archival RPC.`,
        ),
      );
    } else {
      results.push(
        probe(
          'P3',
          'uploaded proof bytes do not carry the commitment',
          true,
          target === null
            ? `no commitment known to search for; ${coverage}`
            : `commitment absent from every chunk (${coverage})`,
        ),
      );
    }
  }

  // ── P3b: the limit of P3, stated as a probe so it cannot be forgotten ─────
  //
  // MEASURED 2026-08-12 and it matters: a full scan of a real C1+C3 upload
  // (172 transactions, 148 chunks, 147,038 bytes) found the commitment ABSENT.
  // P3 therefore passes on today's proofs — and that is NOT evidence the proof
  // hides the witness.
  //
  // `stark/src/compact.rs:3460-3484` interpolates the trace and evaluates it on
  // the LDE domain with no coset offset, no blinding polynomial and no random
  // rows, then publishes the openings at 22 query positions plus the OOD
  // evaluations of every column. Two agents independently recovered a circuit's
  // secret from that by Lagrange interpolation, each with a positive control
  // (see the B7 record). Recovery is polynomial, not a byte copy, so a byte scan
  // is structurally blind to it.
  //
  // Reported INCONCLUSIVE forever, never PASS, until trace blinding ships and
  // this tool grows a real interpolation attempt with its own positive control.
  // Both committed fixtures pin this probe FAIL, so a well-meaning "fix" that
  // makes it pass turns CI red before it turns a claim dishonest.
  results.push(
    probe(
      'P3b',
      'the proof does not reveal the witness by interpolation',
      false,
      'INCONCLUSIVE BY CONSTRUCTION: this tool only detects a value present verbatim. ' +
        'The prover applies no trace blinding, so the published openings determine the trace ' +
        'polynomial and the witness is recoverable by interpolation. A PASS on P3 says the ' +
        'commitment was not copied into the proof; it says nothing about whether the proof hides it.',
    ),
  );

  // ── P4: find the deposit, and the wallet behind it ────────────────────────
  let deposit = null;
  if (target !== null) {
    deposit = await traceDepositChain(rpc, POOLS[poolPDA].tree, target, opts.depositLimit ?? 400);
  }
  const p4 = p4Verdict(target, deposit);
  results.push(
    probe(
      'P4',
      'the spend cannot be traced to its deposit from public data',
      p4.passed,
      p4.detail,
      // The number of hops is pinned so that a note gaining a transfer between
      // two runs cannot pass unnoticed inside an already-failing probe.
      deposit === null ? null : deposit.hops.length,
    ),
  );

  // ── P6: the financial edge — the cheapest way to the buyer ────────────────
  //
  // Held outside the branch because P8 compares this walk against the deposit's.
  // Re-walking it there would repeat every getTransaction the walk makes — on a
  // deep walk that is one call per transaction in the payer's life, so the cost
  // is real against a live RPC. (An earlier note here claimed a second fetch
  // would miss the replay cache. It would not: makeReplayRpc keys a Map on the
  // request and a repeat is a hit. The cost argument stands on its own.)
  const historyLimit = Math.min(1000, chunkLimit + 1);
  let spendTrace = null;
  if (payer === null) {
    results.push(
      probe(
        'P6',
        'the fee payer cannot be traced to a funding wallet',
        false,
        'INCONCLUSIVE: no message header, so the fee payer is unknown and no edge was walked.',
      ),
    );
  } else {
    // `exhaustive` when an address was named: P11 reads this walk's key set and
    // an absence is only credible from a complete read. See traceFunderEdges.
    const funder = await traceFunderEdges(rpc, payer, { historyLimit, exhaustive: exhaustiveWalk });
    spendTrace = funder;
    if (funder.inconclusive) {
      results.push(
        probe('P6', 'the fee payer cannot be traced to a funding wallet', false, `INCONCLUSIVE: ${funder.inconclusive}`),
      );
    } else if (funder.edges.length === 0) {
      results.push(
        probe(
          'P6',
          'the fee payer cannot be traced to a funding wallet',
          !funder.truncated,
          funder.truncated
            ? `INCONCLUSIVE: the payer's history filled the requested page (${funder.historyLength}), so the ` +
              `oldest entry held is not provably its first transaction. An unread edge is not a closed one.`
            : namedWalletLine(namedWallet, funder, 'spend').trim() +
              (namedWallet ? ' ' : '') +
              `No System instruction names a counterparty in any of this payer's ${funder.scanned} ` +
              `transactions — top-level or inner (${funder.calls} RPC calls). Until 2026-08-16 this probe ` +
              `read only the two ends of the history and only top-level instructions, so this clean ` +
              `verdict now rests on the whole life rather than two samples of it. One-hop financial edge ` +
              `closed; a funder one hop further out, or a relayer that logged the request, is NOT covered ` +
              `by this probe.`,
          funder.truncated ? null : 0,
        ),
      );
    } else {
      const worst = funder.edges
        .map(
          (e) =>
            `${e.role} ${e.direction === 'in' ? 'from' : 'to'} ${e.counterparty} ` +
            `(${e.lamports} lamports, ${e.signature.slice(0, 12)}…)`,
        )
        .join('; ');
      results.push(
        probe(
          'P6',
          'the fee payer cannot be traced to a funding wallet',
          false,
          `the payer is bracketed by ${funder.edges.length} System transfer(s) naming a wallet, found in ` +
            `${funder.calls} RPC calls over a ${funder.historyLength}-transaction life: ${worst}` +
            namedWalletLine(namedWallet, funder, 'spend'),
          funder.edges.length,
        ),
      );
    }
  }

  // ── P7: commitment in instruction ARGUMENTS, outside the proof payload ────
  if (payer === null || target === null) {
    results.push(
      probe(
        'P7',
        'no instruction argument outside the proof payload carries the commitment',
        false,
        payer === null
          ? 'INCONCLUSIVE: no message header, so the payer history could not be walked.'
          : 'INCONCLUSIVE: no commitment was published by the spend, so there is nothing to count. ' +
            'That is not the same as a clean result — see P6.',
      ),
    );
  } else {
    const args = await scanInstructionArguments(rpc, payer, target, { maxTx: chunkLimit });
    const cover = `${args.scanned}/${args.available} tx scanned`;
    if (!args.complete) {
      results.push(
        probe(
          'P7',
          'no instruction argument outside the proof payload carries the commitment',
          false,
          `INCONCLUSIVE: the payer's history was not exhausted (${cover}). ${args.sites.length} site(s) found so far.`,
        ),
      );
    } else if (args.sites.length === 0) {
      results.push(
        probe('P7', 'no instruction argument outside the proof payload carries the commitment', true, `clean across ${cover}`, 0),
      );
    } else {
      const byProgram = new Map();
      for (const s of args.sites) byProgram.set(s.program, (byProgram.get(s.program) ?? 0) + 1);
      const breakdown = [...byProgram].map(([p, n]) => `${p.slice(0, 8)}…×${n}`).join(', ');
      results.push(
        probe(
          'P7',
          'no instruction argument outside the proof payload carries the commitment',
          false,
          `${args.sites.length} instruction(s) publish the commitment in the clear (${breakdown}; ${cover}). ` +
            `This is a FLOOR: publications on the deposit side belong to a different payer and are outside ` +
            `this walk, as is any occurrence in an event log rather than an instruction.`,
          args.sites.length,
        ),
      );
    }
  }

  // ── P8: does one wallet stand behind BOTH ends? ───────────────────────────
  //
  // WHY THIS PROBE EXISTS
  // ─────────────────────
  // This file's own header used to attribute to P4 the sentence "the wallet
  // that funded the deposit is not a party to the spend". P4 has never checked
  // that: `findDeposit` returned a signature and a leaf index and nothing about
  // who paid, so the deposit side of the claim was documented and unmeasured.
  // The header now says what P4 does; this probe is what makes the original
  // sentence true.
  //
  // It is the symmetric twin of P6 — the same three-call walk, pointed at the
  // deposit's fee payer instead of the spend's — plus the intersection of the
  // two counterparty sets.
  //
  // THE NON-EMPTY RULE IS THE WHOLE GUARD
  // ─────────────────────────────────────
  // PASS requires BOTH sides to resolve a non-empty funder set AND the
  // intersection to be empty. Two sides that resolve nothing also intersect in
  // nothing, and reporting that as a pass would convert "we could not see" into
  // "there is nothing there" — the exact false green this tool exists to
  // refuse. So an unresolved side is INCONCLUSIVE, and INCONCLUSIVE is FAIL.
  //
  // WHAT A PASS DOES NOT MEAN
  // ─────────────────────────
  // Only that no single wallet paid for both ends WITHIN ONE HOP. A funder one
  // hop further out, two withdrawals from the same exchange, or an off-chain
  // purchase of the note all survive a PASS untouched. Read it as "the deposit
  // and the spend do not share a one-hop financial parent", never as "the two
  // are unrelated".
  //
  // AND IT WILL GO RED ON A SHARED TREASURY, CORRECTLY
  // ──────────────────────────────────────────────────
  // The moment one funder covers both the shield and the subscribe legs for
  // everybody, this probe FAILS — because one party did finance both ends, and
  // that is a common party whatever its intent. Do not "fix" that by relaxing
  // the rule; it is the probe working.
  //
  // 🚨 A GREEN P8 DOES NOT MEAN THE NOTE WAS RECEIVED. MEASURED 2026-08-16.
  // One wallet W deposits its own note (the shield is always paid by the wallet
  // — `funderConfigured()` is consulted in `subscribeFromPool` and NOWHERE else,
  // apps/web/lib/privacy/shieldClient.ts:286) and then subscribes with the
  // third-party funder paying. Then depositSide = {W}, spendSide = {funder}, the
  // sets are disjoint, and P8 passes while the buyer IS the depositor. The
  // disjointness this probe measures is manufactured by an asymmetry in the
  // client, not by a privacy property.
  //
  // The sentence stays true — no single wallet funded both ends — and it is too
  // narrow to carry the weight a reader will put on it, so the PASS text says so
  // in its own words. What actually separates "received" from "deposited" is who
  // holds the note secret, and that is not a chain fact. No probe here can see
  // it, and inventing one that appeared to would be worse than the gap.
  //
  // ONE STRUCTURAL GUARD, AND IT IS WORTH KNOWING
  // ─────────────────────────────────────────────
  // P8 can never PASS unless P1, P2 and P4 are already FAIL in the same report:
  // a PASS needs `deposit !== null`, which needs `target !== null`, which is
  // exactly the condition under which P1 reports the published commitment. So a
  // green P8 only ever exists inside a report where the note is already traced
  // to its deposit, and the run still exits 1. The danger is quoting this line
  // on its own, not the tool.
  // The deposit payer's walk, done ONCE and shared with P9 below.
  //
  // It used to live inside P8's else-branch, which threw it away after a single
  // set intersection. That was the whole problem: on a report where the spend
  // leg is funded by a treasury and the deposit leg by the user, P8's sets are
  // disjoint and P6 names the treasury — so the user's own wallet, which is
  // sitting right there in this walk, appears in NO probe line. P9 is that
  // reading, promoted to a verdict of its own. It costs nothing extra.
  //
  // `deposit.payer === payer` needs no second walk: the two payers are the same
  // key, so `spendTrace` already IS this trace.
  let depositTrace = null;
  if (deposit !== null && deposit.payer) {
    depositTrace =
      deposit.payer === payer && spendTrace !== null
        ? spendTrace
        : await traceFunderEdges(rpc, deposit.payer, { historyLimit, exhaustive: exhaustiveWalk });
  }

  {
    const pre = overlapPrecheck({ deposit, target, payer, spendTrace });
    let verdict;
    if (pre.stop) {
      verdict = probe('P8', P8_NAME, false, `INCONCLUSIVE: ${pre.stop}`);
    } else if (pre.sameKey) {
      verdict = probe(
        'P8',
        P8_NAME,
        false,
        `the SAME key ${deposit.payer} paid for both the deposit ${deposit.signature.slice(0, 12)}… ` +
          'and the spend. No walk was needed.',
        1,
      );
    } else {
      const out = overlapVerdict(depositTrace, spendTrace, deposit.payer, payer);
      if (out.stop) {
        verdict = probe('P8', P8_NAME, false, `INCONCLUSIVE: ${out.stop}`);
      } else if (
        namedWallet &&
        (out.depositSide.has(namedWallet) || out.spendSide.has(namedWallet))
      ) {
        // The --wallet override, and the only place the flag changes a verdict.
        //
        // Disjointness is a real property and P8 reports it honestly, but it is
        // the WRONG question once one side is funded by a treasury: the sets
        // separate precisely because two different parties paid, which is
        // exactly the arrangement under which a named wallet can sit in one of
        // them and still be reached. An operator who supplies the address they
        // care about is asking a narrower question than P8's, and it outranks
        // P8's here — a green on a run where the address is printed on the next
        // line is the report contradicting itself.
        verdict = probe(
          'P8', P8_NAME, false,
          `--wallet ${namedWallet} appears on the ` +
            [out.depositSide.has(namedWallet) ? 'DEPOSIT' : null,
             out.spendSide.has(namedWallet) ? 'SPEND' : null].filter(Boolean).join(' and ') +
            ' side. The two counterparty sets may still be disjoint — deposit ' +
            `{${[...out.depositSide].join(', ')}}, spend {${[...out.spendSide].join(', ')}} — and ` +
            'that disjointness is not a defence when the address you asked about is sitting in ' +
            'one of them. See P6 and P9 for which edges name it.',
          out.common.length,
        );
      } else {
        // The cost of the two walks only. Reaching this point also required
        // P4's deposit search, which is the expensive part and is NOT counted
        // here — the earlier version said "found in N RPC calls from the spend
        // alone" with N = 6, which understated the real total and would let one
        // defender discard the whole report by measuring it.
        const cost = spendTrace.calls + depositTrace.calls;
        const readAs = (t) => `${t.deep ? `all ${t.scanned}` : `${t.scanned} of ${t.historyLength}`} tx`;
        verdict = probe(
          'P8',
          P8_NAME,
          out.common.length === 0,
          out.common.length === 0
            ? `the deposit payer's counterparties are {${[...out.depositSide].join(', ')}} and the ` +
              `spend payer's are {${[...out.spendSide].join(', ')}}; the two sets are disjoint, and ` +
              `neither payer appears in the other's set (deposit: ${readAs(depositTrace)}, spend: ` +
              `${readAs(spendTrace)}, ${cost} RPC calls on top of P4's deposit search). ` +
              '⛔ THIS DOES NOT MEAN THE NOTE WAS RECEIVED RATHER THAN DEPOSITED BY THE SPENDER. ' +
              'A single wallet that deposits its own note and then pays for the spend through a ' +
              'third-party funder produces exactly this result — MEASURED, and the deposit ' +
              "counterparty printed above is that wallet. Nothing on chain distinguishes the two " +
              'worlds, because what separates them is who holds the note secret, and that is not ' +
              'a chain fact. Read P4 for where this note actually came from. ' +
              'COUNTERPARTIES, not funders: this counts who the payer transacted with in either ' +
              'direction, so a sweep destination is in the set too. And it closes ONE hop only — a ' +
              'shared parent further out, two addresses held by one person, an off-chain hand-over ' +
              'of the note, or a funder that logged the request are all outside this probe.'
            : `${out.common.length} address(es) join BOTH ends: ${out.common.join(', ')}. Read from ` +
              `${cost} RPC calls on top of P4's deposit search. The buyer of this note also paid for ` +
              'its deposit, or one treasury paid for both, or one payer funded the other directly.',
          out.common.length,
        );
      }
    }
    results.push(verdict);
  }

  // ── P9: the DEPOSIT payer's financial edge ────────────────────────────────
  //
  // WHY THIS EXISTS, AND WHY IT IS NOT A DUPLICATE OF P6
  // ────────────────────────────────────────────────────
  // P6 walks the SPEND payer. P8 walks both and reports only their
  // INTERSECTION. Neither of those survives the change this repo is about to
  // make: fund the spend leg from a shared treasury and P6 starts naming the
  // treasury, while P8's two sets become disjoint and it reports INCONCLUSIVE
  // or PASS. The user's wallet then appears in NO line of a default run —
  // while it is still reachable from the deposit in three RPC calls, because
  // `shieldToPool` has no funder path and the spend republishes the deposit's
  // commitment in cleartext.
  //
  // That is the precise shape of a tool going quiet about a leak it can still
  // see. P9 is the reading that must not be allowed to disappear: it names the
  // deposit payer's counterparties unconditionally, whatever the spend leg does.
  //
  // A PASS here means what P6's means and no more: no System instruction at
  // either end of THIS payer's life names a counterparty. It does not mean the
  // depositor is unknown — the deposit itself names the pool, the amount and
  // the commitment, and P4 walks from the spend to it.
  {
    const P9_NAME = 'the deposit payer cannot be traced to a funding wallet';
    if (deposit === null) {
      results.push(
        probe('P9', P9_NAME, false,
          target === null
            ? 'INCONCLUSIVE: no commitment was published, so P4 had nothing to match and there is ' +
              'no deposit payer to walk.'
            : 'INCONCLUSIVE: P4 found no deposit for this commitment within the searched window. ' +
              'That is a gap in what was read, not a clean result — see P4.'),
      );
    } else if (!deposit.payer || depositTrace === null) {
      results.push(
        probe('P9', P9_NAME, false,
          `INCONCLUSIVE: the deposit ${deposit.signature.slice(0, 12)}… carries no message header, ` +
          'so its fee payer is unknown.'),
      );
    } else if (depositTrace.inconclusive) {
      results.push(probe('P9', P9_NAME, false, `INCONCLUSIVE: ${depositTrace.inconclusive}`));
    } else if (depositTrace.edges.length === 0) {
      results.push(
        probe('P9', P9_NAME, !depositTrace.truncated,
          depositTrace.truncated
            ? `INCONCLUSIVE: the deposit payer's history filled the requested page ` +
              `(${depositTrace.historyLength}), so its oldest entry is not provably its first ` +
              'transaction. An unread edge is not a closed one.'
            : `no System instruction names a counterparty in any of this deposit payer's ` +
              `${depositTrace.scanned} transactions (${depositTrace.calls} RPC calls). One-hop ` +
              'financial edge closed on the DEPOSIT side; a funder one hop further out is not ' +
              'covered by this probe.' + namedWalletLine(namedWallet, depositTrace, 'deposit'),
          depositTrace.truncated ? null : 0),
      );
    } else {
      const named = depositTrace.edges
        .map((e) => `${e.kind ?? 'transfer'} ${e.direction === 'in' ? 'from' : 'to'} ${e.counterparty} ` +
          `(${e.lamports} lamports, ${e.signature ? `${e.signature.slice(0, 12)}…` : 'this tx'})`)
        .join('; ');
      results.push(
        probe('P9', P9_NAME, false,
          `the deposit's payer ${deposit.payer} is bracketed by ${depositTrace.edges.length} ` +
          `lamport-moving System instruction(s) naming a wallet, found in ${depositTrace.calls} RPC ` +
          `calls: ${named}. Funding the SPEND leg through a third party does not touch this: the ` +
          'deposit is a separate transaction, paid for separately, and the spend republishes its ' +
          'commitment in cleartext.' + namedWalletLine(namedWallet, depositTrace, 'deposit'),
          depositTrace.edges.length),
      );
    }
  }

  // ── P10: the PAYEE — the road nothing here used to look at ────────────────
  //
  // WHY A TENTH PROBE, AND WHY IT IS NOT ABOUT PAYERS
  // ────────────────────────────────────────────────
  // P1-P3 chase the commitment, P6/P8/P9 chase the payers. Until 2026-08-17 the
  // string "recipient" did not appear once in this file — so the second
  // cleartext address in a withdrawal instruction, sitting at a fixed offset
  // with no walk needed to obtain it, was measured by nothing.
  //
  // That gap is not academic and it is not small. `/pay` derives a fresh payout
  // address per note so the pool's payee is not the user's wallet, and that
  // mechanism is undone completely by one later transfer. The chain costs three
  // RPC calls, the same as the payer walk, from the SAME transaction:
  //
  //   getTransaction(spend) → recipient at byte 88 → getSignaturesForAddress
  //   → getTransaction(the sweep) → the wallet
  //
  // MEASURED in the mobile client on devnet 2026-08-04: `C4MqLbEx…` forwarded
  // 0.994995 SOL to the user's wallet 8 seconds after the withdrawal, slot
  // 481027703.
  //
  // 🚨 IT IS ALSO THE REASON A FUNDER ON THE WITHDRAWAL LEG MUST NOT BE READ AS
  // A WIN. Paying the pre-fund from a treasury moves the PAYER edge and touches
  // this one not at all. Without P10 that change would read as progress in a
  // report structurally unable to see what survived it.
  //
  // WHAT A PASS MEANS, AND WHAT IT DOES NOT
  // ───────────────────────────────────────
  // Only that the payout address has not been emptied YET. It is a statement
  // about time, not about privacy: the address is still printed in the spend
  // instruction forever, so a sweep made tomorrow re-links tomorrow. The pass
  // text says so in its own words, because "P10 passed" is exactly the kind of
  // line that gets quoted without its qualifier.
  {
    const P10_NAME = 'the withdrawal payee cannot be traced to a wallet';
    const recipient = readRecipient(spend);
    if (recipient === null) {
      results.push(
        probe('P10', P10_NAME, false,
          `INCONCLUSIVE: ${spend.kind.name} publishes no payee argument, so there is no address ` +
          'to walk. A subscribe pays a vault PDA derived from a commitment; a transfer and a split ' +
          'produce new notes. This is not a clean result, it is a spend kind this probe does not ' +
          'apply to.'),
      );
    } else {
      const payeeTrace = await traceFunderEdges(rpc, recipient, { historyLimit, exhaustive: exhaustiveWalk });
      // OUTBOUND only. The inbound edge is the withdrawal paying this address —
      // it names the pool, which is not a leak and is the whole point of the
      // transaction. What matters is where the money went NEXT.
      const out = payeeTrace.inconclusive ? [] : payeeTrace.edges.filter((e) => e.direction === 'out');
      if (payeeTrace.inconclusive) {
        results.push(
          probe('P10', P10_NAME, false,
            `INCONCLUSIVE: the payee ${recipient} did not resolve (${payeeTrace.inconclusive}). ` +
            'The address is still published in the spend instruction in the clear; only its ' +
            'onward history could not be read.'),
        );
      } else if (payeeTrace.truncated) {
        results.push(
          probe('P10', P10_NAME, false,
            `INCONCLUSIVE: the payee ${recipient} filled the requested history page ` +
            `(${payeeTrace.historyLength}), so its onward transfers are not provably complete.`),
        );
      } else if (out.length === 0) {
        results.push(
          probe('P10', P10_NAME, true,
            `the payee ${recipient} has sent nothing onward in its ${payeeTrace.scanned}-transaction ` +
            `life (${payeeTrace.calls} RPC calls). ⛔ THIS IS A STATEMENT ABOUT TIME, NOT PRIVACY: ` +
            'the address is published in this spend instruction in the clear at a fixed offset, ' +
            'permanently, so whoever holds it re-links the moment the funds are moved. Read it as ' +
            '"not swept yet", never as "cannot be traced".' +
            (namedWallet && recipient === namedWallet
              ? ` ⛔ --wallet: the payee IS ${namedWallet}. The withdrawal paid the named wallet ` +
                'directly, so no onward transfer was ever needed.'
              : namedWalletLine(namedWallet, payeeTrace, 'payee')),
            0),
        );
      } else {
        const moved = out
          .map((e) => `${e.kind ?? 'transfer'} to ${e.counterparty} (${e.lamports} lamports, ` +
            `${e.signature ? `${e.signature.slice(0, 12)}…` : 'this tx'})`)
          .join('; ');
        results.push(
          probe('P10', P10_NAME, false,
            `the payee ${recipient} — read straight out of this spend's instruction data at byte ` +
            `${spend.kind.recipientOffset}, no walk required — has since paid ${out.length} ` +
            `address(es) in ${payeeTrace.calls} RPC calls: ${moved}. Funding the pre-fund through ` +
            'a third party does not touch this road: it is the payee, not the payer.' +
            namedWalletLine(namedWallet, payeeTrace, 'payee'),
            out.length),
        );
      }
    }
  }

  // ── P11: the named address, by the method an auditor actually uses ────────
  //
  // WHY EVERY OTHER PROBE HERE IS TOO NARROW FOR THIS QUESTION
  // ─────────────────────────────────────────────────────────
  // P6, P8, P9 and P10 all reason about EDGES: who paid whom, decoded out of
  // System instructions. That is the right shape for "is this payer funded",
  // and it is the wrong shape for "can an auditor find my address", because the
  // cheapest real extraction does not decode anything at all:
  //
  //   $r.result.transaction.message.accountKeys | ForEach-Object { $_.pubkey }
  //
  // That prints EVERY account named by a transaction. An address can sit there
  // as a read-only account, a co-signer, an ATA owner or a bare program
  // argument, move not one lamport, and be completely invisible to every edge
  // probe in this file while being the first line of that output.
  //
  // So P11 asks the auditor's question directly: does `--wallet` appear in the
  // account keys of ANY transaction reachable from this spend — the spend
  // itself, the whole life of its payer, the whole life of the deposit's payer,
  // and the payee's onward history. All of those transactions were fetched by
  // the walks above, so this costs no extra RPC call.
  //
  // 🚨 ABSENCE IS ONLY CREDIBLE FROM A COMPLETE WALK. `traceFunderEdges` stops
  // early when it FINDS an edge, so on a leaky payer it may have read 2
  // transactions of 172 — and "not in those 2" is not "not in the 172". Every
  // partial walk is reported as INCONCLUSIVE with the arithmetic shown. This is
  // the same asymmetry the rest of the file uses: a hit is cheap, an absence is
  // expensive, and only the absence has to be paid for in full.
  if (namedWallet) {
    const P11_NAME = 'the named wallet appears in no reachable transaction';

    // 🚨 THE FUNDER'S OWN HISTORY — THE HOP THAT MADE THIS PROBE LIE.
    //
    // MEASURED 2026-08-18 on spend `4zWERbE1NPaR…`. P11 returned PASS over the
    // three surfaces below. The buyer's wallet was TWO hops out, and reaching it
    // cost one getSignaturesForAddress and 27 getTransaction:
    //
    //   spend -> its payer -> H8WtBx3Qap…      <- P6 PRINTS THIS ADDRESS ITSELF
    //         -> that funder's 27-transaction history
    //         -> 21PjRyhLLg…, signed BY THE BUYER, paying the funder 1.003 SOL
    //            one second before the funder financed the ephemeral that made
    //            the deposit. Amount and clock both match the note.
    //
    // The funder was NAMED in two surfaces and READ in none. A probe that hands
    // the auditor an address and then declines to open it measures one step less
    // than the auditor's walk — and reports the shortfall as a PASS. That is the
    // exact failure this file exists to refuse, committed by this file.
    //
    // ⛔ `in` EDGES ONLY, and the direction is the whole argument. An edge where
    // lamports ARRIVED names the party that funded this payer: that is the way
    // back toward a person. `out` edges are vaults, proof buffers and the pool —
    // protocol accounts that lead away from one, and whose histories are every
    // other depositor's business, not this walk's. Nothing is lost by the strict
    // direction: a funder brackets its ephemeral, so its pre-fund already names
    // it before its sweep does.
    //
    // Exhaustive by construction. An absence is the only answer that has to be
    // paid for in full, and a truncated funder history therefore turns P11
    // INCONCLUSIVE rather than green — same asymmetry as every walk above. This
    // cost is P11-only: no other probe reads these transactions.
    const offLimits = new Set(
      [...Object.keys(POOLS), SYSTEM_PROGRAM, ZK_SHIELDED, STARK_VERIFIER, poolPDA, payer,
        deposit?.payer].filter(Boolean),
    );
    const funderSurfaces = [];
    const walked = new Set();
    for (const [origin, trace] of [
      ["the spend payer's funder", spendTrace],
      ["the deposit payer's funder", depositTrace],
    ]) {
      if (!trace || trace.inconclusive) continue;
      for (const e of trace.edges) {
        if (e.direction !== 'in') continue;
        if (offLimits.has(e.counterparty) || walked.has(e.counterparty)) continue;
        walked.add(e.counterparty);
        // A frozen fixture recorded before this surface existed holds no answer
        // for these requests, and `makeReplayRpc` treats a miss as a hard stop —
        // rightly, because answering silence would let an unread channel pass as
        // clean. That invariant is preserved here without invalidating every
        // fixture in the repo: an unreadable funder is an INCOMPLETE surface, so
        // it can only ever turn P11 INCONCLUSIVE, never green. Re-record with
        // --record --wallet to give a fixture a funder surface it can pass on.
        let up = null;
        try {
          up = await traceFunderEdges(rpc, e.counterparty, { historyLimit, exhaustive: true });
        } catch (err) {
          funderSurfaces.push({
            label: `${origin} ${e.counterparty.slice(0, 8)}…'s own history (unread: ${err.message.slice(0, 60)})`,
            keys: new Set(),
            complete: false,
            read: 0,
            of: '?',
          });
          continue;
        }
        funderSurfaces.push({
          label: `${origin} ${e.counterparty.slice(0, 8)}…'s own history`,
          keys: up.namedKeys,
          complete: !up.inconclusive && !up.truncated && up.deep,
          read: up.scanned,
          of: up.historyLength,
        });
      }
    }

    /** Walks whose key set is complete enough to argue absence from. */
    const parts = [
      { label: 'the spend transaction', keys: new Set(keys), complete: true, read: 1, of: 1 },
      spendTrace && {
        label: "the spend payer's history",
        keys: spendTrace.namedKeys,
        complete: !spendTrace.inconclusive && !spendTrace.truncated && spendTrace.deep,
        read: spendTrace.scanned,
        of: spendTrace.historyLength,
      },
      depositTrace && {
        label: "the deposit payer's history",
        keys: depositTrace.namedKeys,
        complete: !depositTrace.inconclusive && !depositTrace.truncated && depositTrace.deep,
        read: depositTrace.scanned,
        of: depositTrace.historyLength,
      },
      ...funderSurfaces,
    ].filter(Boolean);

    const hits = parts.filter((p) => p.keys?.has(namedWallet));
    if (hits.length > 0) {
      results.push(
        probe('P11', P11_NAME, false,
          `${namedWallet} is NAMED in ${hits.map((h) => h.label).join(' and ')}. ` +
          'Found by listing account keys — no instruction decoded, no proof read. This is the ' +
          'cheapest extraction there is and every other probe here can miss it, because an ' +
          'address named by a transaction need not have moved a lamport in it. A hit on a ' +
          "funder's own history costs one extra hop, taken from an address the P6/P9 report " +
          'already prints in full.',
          hits.length),
      );
    } else {
      const partial = parts.filter((p) => !p.complete);
      results.push(
        probe('P11', P11_NAME, partial.length === 0,
          partial.length === 0
            ? `${namedWallet} appears in the account keys of NONE of the ` +
              `${parts.reduce((n, p) => n + p.read, 0)} transactions read across ` +
              `${parts.length} surface(s), each read in full. ⛔ This covers the transactions ` +
              'REACHABLE FROM THIS SPEND and nothing else: it says the address is not in this ' +
              'operation, never that the address is unused or unknown.'
            : `INCONCLUSIVE: not found, but ${partial.map((p) => `${p.label} was read ` +
              `${p.read} of ${p.of}`).join('; ')}. A walk that stopped early because it already ` +
              'found an edge is not evidence of absence — see P6. Absence needs the whole history.',
          partial.length === 0 ? 0 : null),
      );
    }
  }

  // ── P5: context, never a pass/fail ────────────────────────────────────────
  const state = await readPoolState(rpc, poolPDA);
  const context = {
    pool: POOLS[poolPDA].label,
    unspentNotes: state.unspentNotes,
    leavesEverInserted: state.nextLeafIndex,
    gapSlots: deposit ? tx.slot - deposit.slot : null,
  };

  return { signature, kind: spend.kind.name, slot: tx.slot, results, context, deposit, target };
}

/**
 * Which zk_shielded instructions insert a leaf, and whether the one they insert
 * REPLACES an earlier note whose commitment they publish in the clear.
 *
 * 🚨 THIS TABLE IS WHY P4 CANNOT STOP AT THE FIRST MATCH.
 * `transfer_denominated_stark_v3` consumes a note and mints a fresh one whose
 * commitment comes from a CSPRNG — no algebraic link to the old one. It would
 * therefore look like the chain ends there. It does not: the instruction
 * publishes the OLD commitment in the clear as its `stark_commitment` argument
 * at byte 80, and twice more in the verifier's `public_inputs` for C1 and C3.
 * MEASURED 2026-08-16 on both real v3 transfers on devnet: spend commitment →
 * transfer's LeafInserted → byte 80 → the original deposit's LeafInserted →
 * the shield and its payer. Two hops, two out of two.
 *
 * So a probe that stopped at the first insertion would name the TRANSFER as
 * "the deposit" and print a result that reads like privacy. Adding a hop to a
 * public chain is not the same as breaking it, and the difference is exactly
 * what this table exists to keep visible.
 */
const LEAF_SOURCES = [
  { name: 'shield_denominated_v3', predecessorOffset: null },
  { name: 'transfer_denominated_stark_v3', predecessorOffset: 80 },
];

let leafSourceTable = null;

/**
 * Classify the instruction that inserted a leaf, from the transaction that
 * emitted the event. Returns null when no known instruction matches — reported
 * as an unknown hop rather than assumed to be an origin, because assuming would
 * turn "we do not recognise this" into "the chain ends here".
 */
function classifyLeafSource(tx) {
  leafSourceTable ??= LEAF_SOURCES.map((k) => ({ ...k, disc: discriminator(k.name) }));
  const keys = accountKeysOf(tx);
  for (const ix of tx.transaction.message.instructions) {
    if (keys[ix.programIdIndex] !== ZK_SHIELDED) continue;
    const data = b58decode(ix.data);
    for (const kind of leafSourceTable) {
      if (data.length >= 8 && data.subarray(0, 8).equals(kind.disc)) {
        const predecessor =
          kind.predecessorOffset !== null && data.length >= kind.predecessorOffset + 8
            ? data.readBigUInt64LE(kind.predecessorOffset)
            : null;
        return { name: kind.name, predecessor };
      }
    }
  }
  return null;
}

/**
 * Walk the tree account's history for the LeafInserted that carries `leaf`.
 *
 * `payer` is returned because P8 needs it and this walk already holds the
 * transaction — fetching the deposit again from P8 would double the cost of the
 * most expensive probe in the file for a field that is already in hand. It is
 * null when the transaction carried no message header, which is the same
 * condition that makes the spend's own payer null.
 */
async function findLeafInsertion(rpc, treePDA, leaf, limit) {
  let before = undefined;
  let scanned = 0;
  while (scanned < limit) {
    const page = await rpc('getSignaturesForAddress', [
      treePDA,
      { limit: Math.min(100, limit - scanned), ...(before ? { before } : {}) },
    ]);
    if (!page?.length) return null;
    for (const s of page) {
      scanned += 1;
      if (s.err) continue;
      const tx = await getTx(rpc, s.signature);
      if (!tx) continue;
      for (const ev of decodeLeafInserted(tx.meta?.logMessages)) {
        if (ev.leaf === leaf) {
          // Same rule the spend's own payer uses (search `numRequiredSignatures`
          // in verifySpend), deliberately copied
          // rather than approximated: two probes comparing fee payers derived
          // by two different rules would disagree for reasons that have
          // nothing to do with privacy.
          const depositKeys = accountKeysOf(tx);
          const depositSigners = tx.transaction?.message?.header?.numRequiredSignatures;
          return {
            signature: s.signature,
            slot: tx.slot,
            leafIndex: ev.leafIndex,
            payer:
              Number.isInteger(depositSigners) && depositSigners >= 1 ? depositKeys[0] : null,
            source: classifyLeafSource(tx),
          };
        }
      }
    }
    before = page[page.length - 1].signature;
  }
  return null;
}

/** A note cannot be re-transferred more times than this without saying so. */
const MAX_DEPOSIT_HOPS = 8;

/**
 * Follow the commitment back to the note's ORIGIN, through however many
 * transfers stand in between.
 *
 * Each hop costs nothing extra against the tree's history — the walk that finds
 * an insertion already fetched the transaction that classifies it. What it buys
 * is the difference between "this note was transferred once" and "this note was
 * deposited here", which the first version of this probe could not tell apart
 * and reported as the latter.
 *
 * Returns the ORIGIN as `deposit` (so P8 walks the real depositor, not an
 * intermediate ephemeral) plus the `hops` that led to it. `origin` is false when
 * the walk ran out of hops or met an insertion it could not classify — in which
 * case what is reported is the furthest point reached, and it is labelled as
 * such rather than presented as the beginning.
 */
async function traceDepositChain(rpc, treePDA, leaf, limit) {
  const hops = [];
  let target = leaf;
  for (let i = 0; i < MAX_DEPOSIT_HOPS; i++) {
    const found = await findLeafInsertion(rpc, treePDA, target, limit);
    if (!found) return hops.length ? { ...hops[hops.length - 1], hops, origin: false, why: 'a hop in the chain was not found within the searched window' } : null;
    hops.push(found);
    const predecessor = found.source?.predecessor ?? null;
    if (found.source === null) {
      return { ...found, hops, origin: false, why: `the instruction that inserted leaf ${found.leafIndex} is not one this tool recognises` };
    }
    if (predecessor === null) return { ...found, hops, origin: true, why: null };
    target = predecessor;
  }
  const last = hops[hops.length - 1];
  return { ...last, hops, origin: false, why: `the chain is longer than ${MAX_DEPOSIT_HOPS} hops` };
}

/**
 * P4's verdict and its sentence, as one pure function of what the walk found.
 *
 * 🚨 IT USED TO BE `deposit === null`, AND THAT FOLDED TWO OPPOSITE STATES
 * INTO ONE PASS.
 *
 *   target === null                  nothing was published, so there is nothing
 *                                    to match. Genuinely clean. PASS.
 *   target !== null, deposit found    the walk succeeded. The spend IS traceable
 *                                    to its deposit. FAIL.
 *   target !== null, deposit null     a commitment WAS published and the walk
 *                                    did not find it inside `--deposit-limit`.
 *                                    That is "I could not look far enough",
 *                                    which is not the same as "there is nothing
 *                                    there" — and it used to report PASS while
 *                                    its own sentence said "may be RPC pruning,
 *                                    not privacy". The tool contradicted itself
 *                                    in one line and the boolean was the half
 *                                    that got read.
 *
 * The third case is now a FAIL, which is the convention this file already
 * applies to P3 three times over: "INCONCLUSIVE, reported as a failure on
 * purpose ... An unread channel is not a clean one." Two opposite conventions
 * in one auditing tool is worse than either.
 *
 * ⛔ The demo runbook makes P4 an answer to an auditor. A probe that answers
 * PASS because it gave up is the single most expensive kind of wrong here.
 */
function p4Verdict(target, deposit) {
  if (target === null) {
    return {
      passed: true,
      detail: 'no commitment published, so there is nothing to match against a deposit',
    };
  }
  if (deposit === null) {
    return {
      passed: false,
      detail:
        'INCONCLUSIVE, reported as a failure on purpose: a commitment WAS published and no ' +
        'matching LeafInserted was found within the searched window. That is a window too small ' +
        'or an RPC that has pruned, not a demonstration of privacy. Re-run with --deposit-limit ' +
        'raised, or --rpc pointing at an archival endpoint, before believing this one.',
    };
  }
  if (deposit.hops.length === 1) {
    return {
      passed: false,
      detail:
        `deposit ${deposit.signature} inserted the same commitment at leaf ${deposit.leafIndex}` +
        (deposit.origin ? '' : ` — and this is NOT the origin: ${deposit.why}`),
    };
  }
  return {
    passed: false,
    detail:
      `${deposit.hops.length} hops back to ${deposit.origin ? 'the origin' : 'the furthest point reachable'}: ` +
      deposit.hops
        .map((h) => `${h.source?.name ?? 'unrecognised'} ${h.signature.slice(0, 12)}… (leaf ${h.leafIndex})`)
        .join(' ← ') +
      (deposit.origin
        ? '. A transfer mints a fresh commitment but publishes the OLD one in the clear at byte 80, so it adds a ' +
          'public hop rather than breaking the chain.'
        : `. NOT the origin: ${deposit.why}`),
  };
}

// ---------------------------------------------------------------------------
// Self-tests — the controls
// ---------------------------------------------------------------------------

/**
 * Replay self-test: every probe outcome must equal the manifest's pin, both
 * directions, and the mapping must be total — a probe with no pin fails, and a
 * pin with no probe fails. That last rule is deliberate friction: adding a P6
 * forces whoever adds it to state, in the committed fixture, what P6 must do
 * on a known-leaky spend and on a known-clean one. A control nobody had to
 * think about is not a control.
 */
function selfTestAgainstManifest(report, manifest, dir) {
  console.log(`\n  ── SELF-TEST vs ${dir} ──────────────────────────────────`);
  if (manifest.synthetic) {
    console.log('   NOTE  this fixture is SYNTHETIC — hand-built bytes, no chain involved.');
    console.log('         It proves the tool CAN report a clean spend, nothing about any real v4.');
  }
  const expect = manifest.expect ?? {};
  const seen = new Set();
  let deviations = 0;
  for (const r of report.results) {
    seen.add(r.id);
    const want = expect[r.id];
    const got = r.passed ? 'PASS' : 'FAIL';
    if (want === undefined) {
      deviations += 1;
      console.log(`   FAIL  ${r.id} has no pin in the manifest — a new probe must declare its control outcome`);
    } else if (want !== got) {
      deviations += 1;
      console.log(`   FAIL  ${r.id} pinned ${want}, measured ${got} — the tool's behaviour on frozen data changed`);
    } else {
      console.log(`   OK    ${r.id} = ${got}, as pinned`);
    }
  }
  for (const id of Object.keys(expect)) {
    if (!seen.has(id)) {
      deviations += 1;
      console.log(`   FAIL  ${id} is pinned in the manifest but the tool no longer reports it`);
    }
  }

  // The counts, checked separately. A probe that counts can get worse without
  // changing verdict — a sixth publication leaves P7 at FAIL — so the pin above
  // would hold while the leak grew. Pinning the number is what makes "it got
  // worse" visible. A measure that appears where none was pinned is a deviation
  // too: it means a new number is being reported that nobody has reviewed.
  const wantMeasure = manifest.measure ?? {};
  for (const r of report.results) {
    const got = r.measure;
    const want = wantMeasure[r.id];
    if (got === null || got === undefined) {
      if (want !== undefined) {
        deviations += 1;
        console.log(`   FAIL  ${r.id} pinned a measure of ${want} but reported none — the probe went inconclusive`);
      }
      continue;
    }
    if (want === undefined) {
      deviations += 1;
      console.log(`   FAIL  ${r.id} reports a measure of ${got} with no pin — re-record and review it`);
    } else if (want !== got) {
      deviations += 1;
      console.log(`   FAIL  ${r.id} pinned a measure of ${want}, measured ${got}`);
    } else {
      console.log(`   OK    ${r.id} measure = ${got}, as pinned`);
    }
  }
  console.log(
    deviations === 0
      ? '   PASS  every probe behaved exactly as pinned. The control holds.'
      : `   ${deviations} deviation(s). Do NOT quote any result from this tool until resolved.`,
  );
  return deviations === 0 ? 0 : 1;
}

/**
 * Live self-test: the negative control against whatever devnet still serves.
 *
 * Pinned to P1/P2/P4 BY ID, not "any probe failed". The original form asserted
 * `results.some(r => !r.passed)` — which P3b satisfies unconditionally on every
 * spend ever examined, so the control was vacuous: a tool whose leak probes had
 * all rotted to PASS would still have printed "the probes are live". Fixed
 * 2026-08-12. P1, P2 and P4 are exactly the probes a v3 spend leaks through by
 * design, so each one must fail on its own.
 */
function selfTestLive(reports) {
  const v3 = reports.filter((r) => r.kind.endsWith('_v3') || r.kind === 'subscribe_private_stark');
  console.log('\n  ── NEGATIVE CONTROL ──────────────────────────────────────');
  if (!v3.length) {
    console.log('   INCONCLUSIVE: no v3-era spend examined, so the tool proved nothing.');
    return 1;
  }
  const MUST_FAIL = ['P1', 'P2', 'P4'];
  let broken = 0;
  for (const r of v3) {
    const clean = MUST_FAIL.filter((id) => r.results.some((x) => x.id === id && x.passed));
    if (clean.length) {
      broken += 1;
      console.log(`   FAIL  ${r.signature.slice(0, 12)}… came back clean on ${clean.join(', ')}`);
    }
  }
  console.log(
    broken === 0
      ? `   PASS  all ${v3.length} v3-era spend(s) were detected as linkable on P1, P2 and P4,\n` +
          '         as they must be. The probes are live. A future GREEN on a v4 spend is\n' +
          '         therefore meaningful.'
      : '   FAIL  a v3-era spend came back clean. v3 publishes the commitment by design,\n' +
          '         so this tool is broken. Do NOT quote any green result from it.',
  );
  return broken === 0 ? 0 : 1;
}

/**
 * Offline control on the SPEND_KINDS offsets themselves.
 *
 * The transfer entry read byte 72 for months. 72 is min_epoch, which the client
 * writes as 0 on every note, so P1 would have found no commitment on a real
 * transfer and reported the spend CLEAN. A false clean, in the one tool whose
 * job is to refuse them, and no fixture covered it because every recorded
 * fixture is an unshield or a subscribe.
 *
 * Restating the right number here would only move the copy. So the layout is
 * declared as the FIELD LIST the program signature actually has, the offset is
 * derived from it, and the table is asserted against the derivation. Reordering
 * an argument on chain and not here now fails, instead of going quiet.
 */
const SPEND_LAYOUTS = {
  // programs/zk_shielded/src/lib.rs — read field by field from the `pub fn`
  // signatures, which is the only source that cannot drift from the bytes.
  // `unshield` carries a trailing `recipient: [u8; 32]`, so this table derives
  // BOTH published addresses: the commitment P1 reads and the payee P10 reads.
  unshield_denominated_stark_v3: [
    ['disc', 8], ['nullifier', 32], ['merkle_root', 32], ['min_epoch', 8],
    ['stark_commitment', 8], ['recipient', 32],
  ],
  transfer_denominated_stark_v3: [
    ['disc', 8], ['nullifier', 32], ['merkle_root', 32], ['min_epoch', 8], ['stark_commitment', 8],
  ],
  // `:372-381`. Added 2026-08-17 together with the fix to its SPEND_KINDS entry,
  // which claimed it published no commitment at all.
  split_note_stark: [
    ['disc', 8], ['nullifier', 32], ['merkle_root', 32], ['min_epoch', 8], ['stark_commitment', 8],
  ],
  // `:267-278`. This was previously left out with the note "its argument list
  // has not been read field by field here, and inventing a layout to make a
  // test green would be worse than the gap". The signature has now been read,
  // so the gap closes honestly rather than by assumption — and it independently
  // confirms the 160 that P1 has been pinned to all along:
  // 8+32+32+8+32+8+8+32 = 160.
  subscribe_private_stark: [
    ['disc', 8], ['nullifier', 32], ['merkle_root', 32], ['min_epoch', 8],
    ['subscriber_commitment', 32], ['rate', 8], ['interval_slots', 8],
    ['vk_hash_subscriber', 32], ['stark_commitment', 8],
  ],
};

/**
 * CHANNEL CONTROL — proves P6 and P7 can say BOTH words.
 *
 * P6 has a live positive control already: it PASSES on the synthetic fixtures,
 * whose payers carry no System transfer. P7 does not, and cannot get one from
 * those fixtures — they publish no commitment, so P7 has nothing to count and
 * reports INCONCLUSIVE. A probe observed only in its failing state is a hollow
 * guard, so its green state is built here instead.
 *
 * Four cases, and the fourth is the one that matters:
 *   1. payer bracketed by two transfers   → P6 decoder finds 2 edges
 *   2. payer with no System instruction   → P6 decoder finds 0
 *   3. commitment in an instruction arg   → P7 decoder finds 1 site
 *   4. commitment inside write_proof_chunk → P7 decoder finds 0
 *
 * Case 4 is the boundary between P3 and P7. The proof payload legitimately
 * contains whatever the prover put there; counting it here would merge "the
 * proof carries the witness" with "an argument names it" — two defects with
 * two different fixes, one of which is frozen and the other of which is not.
 */
function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = B58[0] + out;
  }
  return out || B58[0];
}

function selfTestChannelDecoders() {
  console.log('\n  ── CHANNEL CONTROL (offline) ─────────────────────────────');
  const PAYER = 'PAYERPAYERPAYERPAYERPAYERPAYERPAYERPAYER111';
  const WALLET = 'WALLETWALLETWALLETWALLETWALLETWALLETWALLET1';
  const TARGET = 0xC0FFEE0000000002n;
  let broken = 0;

  // The encoder is used to build every case below, so it is asserted first.
  // A silently wrong encoder would make all four cases agree with each other
  // and with nothing else.
  const probeBytes = Buffer.from([0, 0, 1, 255, 128, 57, 58]);
  if (!b58decode(b58encode(probeBytes)).equals(probeBytes)) {
    console.log('   FAIL  b58 round-trip broken — every case below is meaningless');
    return 1;
  }

  const sysTransfer = (lamports) => {
    const d = Buffer.alloc(12);
    d.writeUInt32LE(SYS_IX_TRANSFER, 0);
    d.writeBigUInt64LE(lamports, 4);
    return b58encode(d);
  };
  const tx = (keys, instructions, slot = 1) => ({
    slot,
    transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: keys, instructions } },
    meta: {},
  });

  // Fake RPC: two signatures, newest first, exactly as getSignaturesForAddress
  // orders them.
  const mkRpc = (byeSig) => async (method, params) => {
    if (method === 'getSignaturesForAddress') return [{ signature: 'SWEEP' }, { signature: 'FUND' }];
    if (method === 'getTransaction') return byeSig[params[0]] ?? null;
    return null;
  };

  const check = (label, actual, want) => {
    if (actual === want) console.log(`   ok    ${label}: ${actual}`);
    else {
      broken += 1;
      console.log(`   FAIL  ${label}: got ${actual}, want ${want}`);
    }
  };

  return (async () => {
    // 1 — bracketed payer. FUND: wallet -> payer. SWEEP: payer -> wallet.
    const bracketed = {
      FUND: tx([WALLET, PAYER, SYSTEM_PROGRAM], [{ programIdIndex: 2, accounts: [0, 1], data: sysTransfer(1_000_000n) }]),
      SWEEP: tx([PAYER, WALLET, SYSTEM_PROGRAM], [{ programIdIndex: 2, accounts: [0, 1], data: sysTransfer(900_000n) }], 9),
    };
    const leaky = await traceFunderEdges(mkRpc(bracketed), PAYER, { historyLimit: 401 });
    check('P6 decoder on a bracketed payer', leaky.edges.length, 2);

    // 2 — the same two ends, carrying no System instruction at all.
    const clean = {
      FUND: tx([PAYER, ZK_SHIELDED], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(16)) }]),
      SWEEP: tx([PAYER, ZK_SHIELDED], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(16)) }], 9),
    };
    const quiet = await traceFunderEdges(mkRpc(clean), PAYER, { historyLimit: 401 });
    check('P6 decoder on an unfunded payer', quiet.edges.length, 0);

    // 2b — THE FALSE GREEN THAT WAS AVAILABLE UNTIL 2026-08-17.
    //
    // `transfer` is not the only System instruction that moves lamports, and
    // until this control existed the decoder matched nothing else. Every case
    // below is a way to put money on an ephemeral that would have produced the
    // case-2 verdict above — "no System transfer names a counterparty", a GREEN
    // P6 — with the wallet exactly one hop away.
    //
    // `createAccount` is not an exotic choice: it is the IDIOMATIC one when the
    // destination is a fresh key, which an ephemeral always is. A probe whose
    // blind spot is the natural refactor certifies the failure it exists to
    // catch, so each of these is pinned separately rather than as a group.
    const sysCreateAccount = (lamports) => {
      const d = Buffer.alloc(52);
      d.writeUInt32LE(SYS_IX_CREATE_ACCOUNT, 0);
      d.writeBigUInt64LE(lamports, 4);
      d.writeBigUInt64LE(0n, 12); // space
      return b58encode(d); // owner = 32 zero bytes
    };
    const sysCreateAccountWithSeed = (lamports, seed) => {
      const seedBytes = Buffer.from(seed, 'utf8');
      const d = Buffer.alloc(44 + seedBytes.length + 8 + 32);
      d.writeUInt32LE(SYS_IX_CREATE_ACCOUNT_WITH_SEED, 0);
      // base pubkey occupies 4..36 and is irrelevant to the amount
      d.writeBigUInt64LE(BigInt(seedBytes.length), 36);
      seedBytes.copy(d, 44);
      d.writeBigUInt64LE(lamports, 44 + seedBytes.length);
      return b58encode(d);
    };
    const sysTransferWithSeed = (lamports, seed) => {
      const seedBytes = Buffer.from(seed, 'utf8');
      const d = Buffer.alloc(20 + seedBytes.length + 32);
      d.writeUInt32LE(SYS_IX_TRANSFER_WITH_SEED, 0);
      d.writeBigUInt64LE(lamports, 4);
      d.writeBigUInt64LE(BigInt(seedBytes.length), 12);
      seedBytes.copy(d, 20);
      return b58encode(d);
    };
    const sysWithdrawNonce = (lamports) => {
      const d = Buffer.alloc(12);
      d.writeUInt32LE(SYS_IX_WITHDRAW_NONCE, 0);
      d.writeBigUInt64LE(lamports, 4);
      return b58encode(d);
    };

    // One funding instruction, one clean sweep, so the edge count IS the
    // decoder's answer about that instruction and nothing else.
    const fundedBy = (data, keys, accounts) => ({
      FUND: tx(keys, [{ programIdIndex: keys.indexOf(SYSTEM_PROGRAM), accounts, data }]),
      SWEEP: tx([PAYER, ZK_SHIELDED], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(16)) }], 9),
    });

    const created = await traceFunderEdges(
      mkRpc(fundedBy(sysCreateAccount(1_000_000n), [WALLET, PAYER, SYSTEM_PROGRAM], [0, 1])),
      PAYER, { historyLimit: 401 },
    );
    check('P6 decoder sees createAccount funding', created.edges.length, 1);
    check('P6 names the creator', created.edges[0]?.counterparty, WALLET);
    check('P6 says how it was funded', created.edges[0]?.kind, 'createAccount');
    check('P6 reads its amount', String(created.edges[0]?.lamports), '1000000');

    // The seeded variants carry a length-prefixed string BEFORE the amount, so
    // the lamports field sits at no fixed offset. A decoder that hard-coded
    // offset 4 would report a wrong — usually absurd — figure rather than
    // failing, which is the worse outcome of the two.
    const seeded = await traceFunderEdges(
      mkRpc(fundedBy(sysCreateAccountWithSeed(2_000_000n, 'p01-ephemeral'), [WALLET, PAYER, SYSTEM_PROGRAM], [0, 1])),
      PAYER, { historyLimit: 401 },
    );
    check('P6 decoder sees createAccountWithSeed funding', seeded.edges.length, 1);
    check('P6 reads the amount past the seed', String(seeded.edges[0]?.lamports), '2000000');

    // transferWithSeed's accounts are [derived source, base signer, destination]
    // — the destination is the THIRD, not the second. A decoder that assumed
    // [from, to] would name the base signer as the recipient and conclude the
    // payer was never touched.
    const seededTransfer = await traceFunderEdges(
      mkRpc(fundedBy(sysTransferWithSeed(3_000_000n, 'seed'), [WALLET, 'BASE1111111111111111111111111111111111', PAYER, SYSTEM_PROGRAM], [0, 1, 2])),
      PAYER, { historyLimit: 401 },
    );
    check('P6 decoder sees transferWithSeed funding', seededTransfer.edges.length, 1);
    check('P6 names the derived source', seededTransfer.edges[0]?.counterparty, WALLET);
    check('P6 reads the seeded amount', String(seededTransfer.edges[0]?.lamports), '3000000');

    const fromNonce = await traceFunderEdges(
      mkRpc(fundedBy(sysWithdrawNonce(4_000_000n), [WALLET, PAYER, SYSTEM_PROGRAM], [0, 1])),
      PAYER, { historyLimit: 401 },
    );
    check('P6 decoder sees a nonce withdrawal', fromNonce.edges.length, 1);

    // The negative half. `allocate` (8) carries a u64 in the same place as
    // `transfer` carries its lamports, and moves nothing. A decoder that
    // switched on length instead of on the tag would invent an edge here — a
    // false RED, which corrodes a tool just as surely in the other direction.
    const allocate = Buffer.alloc(12);
    allocate.writeUInt32LE(8, 0);
    allocate.writeBigUInt64LE(999_999n, 4);
    const allocated = await traceFunderEdges(
      mkRpc(fundedBy(b58encode(allocate), [WALLET, PAYER, SYSTEM_PROGRAM], [0, 1])),
      PAYER, { historyLimit: 401 },
    );
    check('P6 decoder ignores allocate, which moves nothing', allocated.edges.length, 0);

    // 3 — the commitment as a plain instruction argument.
    const argBuf = Buffer.alloc(24);
    argBuf.writeBigUInt64LE(TARGET, 12);
    const argTx = {
      FUND: tx([PAYER, STARK_VERIFIER], [{ programIdIndex: 1, accounts: [0], data: b58encode(argBuf) }]),
      SWEEP: tx([PAYER, STARK_VERIFIER], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(8)) }], 9),
    };
    const found = await scanInstructionArguments(mkRpc(argTx), PAYER, TARGET, { maxTx: 400 });
    check('P7 decoder on a published argument', found.sites.length, 1);

    // 4 — THE BOUNDARY. Same value, same offset, but inside write_proof_chunk.
    const chunk = Buffer.concat([
      discriminator('write_proof_chunk'),
      Buffer.alloc(8), // offset u32 + len u32, values irrelevant to the filter
      argBuf,
    ]);
    const chunkTx = {
      FUND: tx([PAYER, STARK_VERIFIER], [{ programIdIndex: 1, accounts: [0], data: b58encode(chunk) }]),
      SWEEP: tx([PAYER, STARK_VERIFIER], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(8)) }], 9),
    };
    const skipped = await scanInstructionArguments(mkRpc(chunkTx), PAYER, TARGET, { maxTx: 400 });
    check('P7 decoder ignores the proof payload', skipped.sites.length, 0);

    // ── P8: every branch, and the greens that no fixture can reach ──────────
    //
    // P8 cannot get a green from any committed fixture: the two synthetic ones
    // publish no commitment, so P4 finds no deposit and P8 is INCONCLUSIVE,
    // and the real one is a v3 spend where the buyer funded both ends. So the
    // ONLY place P8's PASS is ever exercised is here, until an E3 spend exists
    // on chain. A probe observed solely in its failing state is a hollow guard.
    //
    // Case 6 is the one that would silently break: it is the difference between
    // "the two sides do not share a funder" and "we did not look".
    // 5 — THE INNER TRANSFER. The one that was measured, missed, and is the
    //     reason P6 could report a funded deposit as clean. Same lamports, same
    //     accounts, moved from top-level to meta.innerInstructions.
    const innerOnly = {
      ...tx([WALLET, PAYER, SYSTEM_PROGRAM], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(8)) }]),
      meta: {
        innerInstructions: [
          { index: 0, instructions: [{ programIdIndex: 2, accounts: [0, 1], data: sysTransfer(1_000_000_000n) }] },
        ],
      },
    };
    check('P6 decoder sees a CPI transfer', systemTransfersIn(innerOnly, PAYER).length, 1);
    check('P6 decoder labels it as inner', systemTransfersIn(innerOnly, PAYER)[0]?.level, 'inner');

    // 6 — THE MID-LIFE EDGE. Ends clean, funding at index 2 of 5: the exact
    //     shape of the measured deposit payer (index 2 of 96). A two-end walk
    //     returns 0 here, which is the false clean this control exists to catch.
    const midSigs = ['S0', 'S1', 'S2', 'S3', 'S4'];
    const midBodies = Object.fromEntries(
      midSigs.map((s) => [
        s,
        s === 'S2'
          ? tx([WALLET, PAYER, SYSTEM_PROGRAM], [{ programIdIndex: 2, accounts: [0, 1], data: sysTransfer(7n) }])
          : tx([PAYER, ZK_SHIELDED], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(8)) }]),
      ]),
    );
    const midRpc = async (method, params) => {
      if (method === 'getSignaturesForAddress') return midSigs.map((s) => ({ signature: s }));
      if (method === 'getTransaction') return midBodies[params[0]] ?? null;
      return null;
    };
    const deep = await traceFunderEdges(midRpc, PAYER, { historyLimit: 401 });
    check('P6 finds an edge buried mid-history', deep.edges.length, 1);
    check('P6 read the whole history to say so', deep.scanned, midSigs.length);
    check('P6 marks that walk as deep', deep.deep, true);

    // ── P4: the transfer hop, which no fixture contains ─────────────────────
    //
    // Both committed fixtures are one-hop: a subscribe over a note that was
    // shielded directly. So the case P4 was WRONG about — a note that passed
    // through `transfer_denominated_stark_v3` — cannot be exercised by any
    // recorded data, and its control has to be built here.
    //
    // Case 3 is the one that matters. Before 2026-08-16 the walk stopped at the
    // first matching LeafInserted, so on a transferred note it named the
    // TRANSFER as "the deposit" and printed a result that reads like privacy.
    const leafEvent = (leafIndex, leafValue) => {
      const b = Buffer.alloc(8 + 32 + 8 + 32 + 32 + 32);
      LEAF_INSERTED_DISC.copy(b, 0);
      b.writeBigUInt64LE(BigInt(leafIndex), 40);
      b.writeBigUInt64LE(leafValue, 48);
      return `Program data: ${b.toString('base64')}`;
    };
    const ixData = (name, predecessor) => {
      const d = Buffer.alloc(predecessor === null ? 8 : 88);
      discriminator(name).copy(d, 0);
      if (predecessor !== null) d.writeBigUInt64LE(predecessor, 80);
      return b58encode(d);
    };
    const leafTx = (name, leafIndex, leafValue, predecessor, payer) => ({
      slot: 1,
      transaction: {
        message: {
          header: { numRequiredSignatures: 1 },
          accountKeys: [payer, ZK_SHIELDED],
          instructions: [{ programIdIndex: 1, accounts: [0], data: ixData(name, predecessor) }],
        },
      },
      meta: { logMessages: [leafEvent(leafIndex, leafValue)] },
    });

    const SHIELD_PAYER = 'SHIELDSHIELDSHIELDSHIELDSHIELDSHIELDSHIELD';
    const HOP_PAYER = 'HOPHOPHOPHOPHOPHOPHOPHOPHOPHOPHOPHOPHOPHOP';
    const SPENT = 0xAAAAAAAAAAAAAAAAn; // what the spend published
    const ORIGIN = 0xBBBBBBBBBBBBBBBBn; // what the deposit published

    const chain = {
      TRANSFER: leafTx('transfer_denominated_stark_v3', 21, SPENT, ORIGIN, HOP_PAYER),
      SHIELD: leafTx('shield_denominated_v3', 19, ORIGIN, null, SHIELD_PAYER),
    };
    const treeRpc = async (method, params) => {
      if (method === 'getSignaturesForAddress') return [{ signature: 'TRANSFER' }, { signature: 'SHIELD' }];
      if (method === 'getTransaction') return chain[params[0]] ?? null;
      return null;
    };

    check('P4 reads a shield as an origin', classifyLeafSource(chain.SHIELD)?.predecessor, null);
    check('P4 reads a transfer predecessor at byte 80', classifyLeafSource(chain.TRANSFER)?.predecessor, ORIGIN);

    const traced = await traceDepositChain(treeRpc, 'TREE', SPENT, 400);
    check('P4 follows the transfer to the real deposit', traced?.hops?.length, 2);
    check('P4 lands on the shield, not the hop', traced?.payer, SHIELD_PAYER);
    check('P4 says it reached the origin', traced?.origin, true);

    // And it must NOT claim an origin it cannot recognise.
    const opaque = { OPAQUE: leafTx('split_note_stark', 21, SPENT, null, HOP_PAYER) };
    const blindRpc = async (m, p) =>
      m === 'getSignaturesForAddress' ? [{ signature: 'OPAQUE' }] : m === 'getTransaction' ? opaque[p[0]] ?? null : null;
    const unknown = await traceDepositChain(blindRpc, 'TREE', SPENT, 400);
    check('P4 refuses to call an unrecognised insertion an origin', unknown?.origin, false);

    // ── P4's VERDICT, all three states, because a fixture reaches only two ───
    //
    // 🚨 THE BRANCH THAT WAS WRONG IS THE BRANCH NO FIXTURE REACHES. All three
    // committed fixtures land on `target === null` (the synthetic v4s, PASS) or
    // on a deposit that is found (v3-subscribe, FAIL). The middle state — a
    // commitment WAS published and the walk did not find it — is unreachable by
    // replay without recording a fourth fixture, and it is precisely the state
    // that reported PASS while its own sentence read "may be RPC pruning, not
    // privacy". This is the same reason P10's real branches live here.
    check('P4 passes only when nothing was published', p4Verdict(null, null).passed, true);
    check('P4 fails when the deposit is found', p4Verdict(SPENT, traced).passed, false);
    check(
      'P4 fails when it published a commitment and could not find the deposit',
      p4Verdict(SPENT, null).passed,
      false,
    );
    check(
      'P4 says WHY that failure is inconclusive rather than clean',
      /INCONCLUSIVE, reported as a failure on purpose/.test(p4Verdict(SPENT, null).detail),
      true,
    );
    // And the two failures must not read alike: one is a demonstration, the
    // other is an admission. An auditor acts differently on each.
    check(
      'P4 does not describe an unread window as a traced deposit',
      /hops back to|inserted the same commitment/.test(p4Verdict(SPENT, null).detail),
      false,
    );

    // ── P8's rule: every branch, asserted by its REASON ──────────────────────
    //
    // The first version of this control checked only 'stop' vs 'walk', so two
    // cases silently landed on a different branch than the one they were named
    // after and still printed green. Asserting a token from the reason string is
    // what makes each case test the branch it claims to.
    const DEP_PAYER = 'DEPOSITDEPOSITDEPOSITDEPOSITDEPOSITDEPOSIT';
    const ISSUER = 'ISSUERISSUERISSUERISSUERISSUERISSUERISSUER';
    const FUNDER = 'FUNDERFUNDERFUNDERFUNDERFUNDERFUNDERFUNDER';
    const deposit = { signature: 'DEPOSITSIG', slot: 1, leafIndex: 34, payer: DEP_PAYER };
    const trace = (counterparties, extra = {}) => ({
      edges: counterparties.map((c) => ({ counterparty: c })),
      historyLength: counterparties.length + 1,
      scanned: counterparties.length + 1,
      deep: true,
      truncated: false,
      calls: 3,
      inconclusive: null,
      ...extra,
    });
    // 'walk' / 'sameKey' / or the distinguishing fragment of the refusal.
    const why = (r) => {
      if (r.sameKey) return 'sameKey';
      if (!r.stop) return 'walk';
      for (const frag of ['nothing to match', 'no deposit for this commitment', 'the spend carries no message header',
        'the deposit DEPOSITSIG', 'did not resolve', 'filled the requested page', 'no counterparty was resolved']) {
        if (r.stop.includes(frag)) return frag;
      }
      return `stop:${r.stop.slice(0, 40)}`;
    };
    const P = (over) => overlapPrecheck({ deposit, target: 7n, payer: PAYER, spendTrace: trace([FUNDER]), ...over });

    check('P8 · no commitment published', why(P({ deposit: null, target: null })), 'nothing to match');
    check('P8 · P4 found no deposit', why(P({ deposit: null })), 'no deposit for this commitment');
    check('P8 · spend has no header', why(P({ payer: null })), 'the spend carries no message header');
    check('P8 · deposit has no header', why(P({ deposit: { ...deposit, payer: null } })), 'the deposit DEPOSITSIG');
    check('P8 · one key paid both ends', why(P({ deposit: { ...deposit, payer: PAYER } })), 'sameKey');
    check('P8 · spend walk inconclusive', why(P({ spendTrace: trace([FUNDER], { inconclusive: 'no history' }) })), 'did not resolve');
    check('P8 · spend history truncated', why(P({ spendTrace: trace([FUNDER], { truncated: true }) })), 'filled the requested page');
    check('P8 · spend side resolved nothing', why(P({ spendTrace: trace([]) })), 'no counterparty was resolved');
    check('P8 · both ends known and distinct', why(P({})), 'walk');

    const V = (dep, spend, dp = DEP_PAYER, sp = PAYER) => overlapVerdict(dep, spend, dp, sp);
    check('P8 · deposit walk inconclusive', why(V(trace([ISSUER], { inconclusive: 'no history' }), trace([FUNDER]))), 'did not resolve');
    check('P8 · deposit history truncated', why(V(trace([ISSUER], { truncated: true }), trace([FUNDER]))), 'filled the requested page');
    check('P8 · deposit side resolved nothing', why(V(trace([]), trace([FUNDER]))), 'no counterparty was resolved');

    // THE GREEN: issuer funded the deposit, the funder funded the spend.
    check('P8 · disjoint counterparties (the E3 shape)', V(trace([ISSUER]), trace([FUNDER])).common?.length, 0);
    // THE RED THAT MUST NOT BE RELAXED: one treasury behind both ends.
    check('P8 · one treasury behind both', V(trace([FUNDER, ISSUER]), trace([FUNDER])).common?.length, 1);
    // THE RED THE FIRST VERSION MISSED: the two payers joined directly, one hop.
    check('P8 · deposit payer funded the spend payer', V(trace([ISSUER]), trace([DEP_PAYER])).common?.length, 1);
    check('P8 · spend payer funded the deposit payer', V(trace([PAYER]), trace([FUNDER])).common?.length, 1);

    // ── --wallet: the question a structural probe cannot ask ────────────────
    //
    // THE SHAPE THIS EXISTS FOR is one line above: `V(trace([ISSUER]),
    // trace([FUNDER]))` — deposit paid by one party, spend by another, sets
    // disjoint, P8 GREEN. That is exactly what this repo is about to build on
    // the withdrawal leg, and in that report P6 names the treasury, P8 says
    // "disjoint", and the user's wallet is printed by nothing. `--wallet` is
    // the reading that survives it, so its controls are pinned here rather
    // than left to a live run nobody replays.
    const walletTrace = trace([ISSUER]);
    check(
      '--wallet · names an address that IS present',
      namedWalletLine(ISSUER, walletTrace, 'deposit').includes('IS among'),
      true,
    );
    check(
      '--wallet · says so when the address is ABSENT',
      namedWalletLine(FUNDER, walletTrace, 'deposit').includes('is NOT among'),
      true,
    );
    // The flag must be inert when unused, or every existing verdict string
    // changes and every pinned fixture drifts for no reason.
    check('--wallet · adds nothing when not supplied', namedWalletLine(null, walletTrace, 'deposit'), '');
    // An inconclusive walk resolved no set, so "not among them" would be a
    // statement about a set that was never read — the false clean in miniature.
    check(
      '--wallet · stays silent on an inconclusive walk',
      namedWalletLine(ISSUER, trace([ISSUER], { inconclusive: 'no history' }), 'deposit'),
      '',
    );
    // And the override itself: disjoint sets, a green P8 by its own rule, and
    // the named address sitting in one of them.
    const disjoint = V(trace([ISSUER]), trace([FUNDER]));
    check('--wallet · P8 would be green on these sets', disjoint.common?.length, 0);
    check('--wallet · but the address is on the deposit side', disjoint.depositSide.has(ISSUER), true);
    check('--wallet · and absent from the spend side', disjoint.spendSide.has(ISSUER), false);

    // ── P10: the payee, whose real branches NO fixture reaches ──────────────
    //
    // Every committed fixture is a subscribe or a synthetic v4, and neither
    // publishes a payee argument — so all three report INCONCLUSIVE and P10's
    // PASS and FAIL paths are exercised nowhere but here. A probe observed only
    // in the state that does not apply to it is a hollow guard, so these cases
    // carry the whole weight until a real withdrawal is recorded.
    const PAYEE = 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB';
    const unshieldIx = (payeeB58, len = 120) => {
      const d = Buffer.alloc(len);
      discriminator('unshield_denominated_stark_v3').copy(d, 0);
      if (payeeB58 && len >= 120) b58decode(payeeB58).copy(d, 88);
      return b58encode(d);
    };
    const spendOf = (data) =>
      classifySpend(tx([PAYER, ZK_SHIELDED], [{ programIdIndex: 1, accounts: [0], data }]));

    // The offset itself, end to end: real discriminator, real table lookup,
    // real byte range. Asserting `readRecipient` against a hand-made `kind`
    // would have agreed with itself and proved nothing about SPEND_KINDS.
    check('P10 · reads the payee at byte 88', readRecipient(spendOf(unshieldIx(PAYEE))), PAYEE);
    // A subscribe genuinely has no payee. `null` and not 0: reading 32 bytes at
    // an offset that means something else would invent an address.
    const subIx = b58encode(Buffer.concat([discriminator('subscribe_private_stark'), Buffer.alloc(200)]));
    check('P10 · no payee on a subscribe', readRecipient(spendOf(subIx)), null);
    // A truncated instruction must refuse rather than read past the end and
    // report whatever zero bytes decode to — which is a real, valid-looking
    // address that belongs to nobody.
    check('P10 · refuses a short instruction', readRecipient(spendOf(unshieldIx(null, 100))), null);

    // The direction filter, which is the probe's actual judgement. The pool
    // paying the payee is INBOUND and is the transaction working as intended;
    // counting it would make every withdrawal ever fail this probe for the
    // crime of having been paid.
    const payeeIn = {
      FUND: tx([ZK_SHIELDED, PAYEE, SYSTEM_PROGRAM], [{ programIdIndex: 2, accounts: [0, 1], data: sysTransfer(1_000_000_000n) }]),
      SWEEP: tx([PAYEE, ZK_SHIELDED], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(16)) }], 9),
    };
    const inOnly = await traceFunderEdges(mkRpc(payeeIn), PAYEE, { historyLimit: 401 });
    check('P10 · an inbound edge exists', inOnly.edges.length, 1);
    check('P10 · but nothing went OUT', inOnly.edges.filter((e) => e.direction === 'out').length, 0);

    // And the leak: the payee sends the money on. This is the shape measured in
    // the mobile client on devnet — stealth recipient, then the wallet, 8
    // seconds later.
    const payeeOut = {
      FUND: tx([ZK_SHIELDED, PAYEE, SYSTEM_PROGRAM], [{ programIdIndex: 2, accounts: [0, 1], data: sysTransfer(1_000_000_000n) }]),
      SWEEP: tx([PAYEE, WALLET, SYSTEM_PROGRAM], [{ programIdIndex: 2, accounts: [0, 1], data: sysTransfer(994_995_000n) }], 9),
    };
    const swept = await traceFunderEdges(mkRpc(payeeOut), PAYEE, { historyLimit: 401 });
    const sweptOut = swept.edges.filter((e) => e.direction === 'out');
    check('P10 · sees the onward sweep', sweptOut.length, 1);
    check('P10 · names where it went', sweptOut[0]?.counterparty, WALLET);

    // ── P11: the gap between "moved money" and "is named" ──────────────────
    //
    // THE CASE THIS FILE EXISTED WITHOUT UNTIL 2026-08-17. A transaction that
    // NAMES the wallet without transferring anything to or from the payer:
    // WALLET sits in accountKeys as a plain account of a zk_shielded
    // instruction. Every edge probe here decodes System instructions, so all of
    // them see nothing — P6 reports a CLEAN payer. And the cheapest extraction
    // there is,
    //
    //   $r.result.transaction.message.accountKeys | ForEach-Object { $_.pubkey }
    //
    // prints the wallet on its first line. Both halves are asserted together
    // below, because the finding is the DIFFERENCE between them, not either one.
    const namedNotPaid = {
      FUND: tx([WALLET, PAYER, ZK_SHIELDED], [{ programIdIndex: 2, accounts: [0, 1], data: b58encode(Buffer.alloc(16)) }]),
      SWEEP: tx([PAYER, ZK_SHIELDED], [{ programIdIndex: 1, accounts: [0], data: b58encode(Buffer.alloc(16)) }], 9),
    };
    const quietWalk = await traceFunderEdges(mkRpc(namedNotPaid), PAYER, { historyLimit: 401 });
    check('P11 · P6 sees no edge at all here', quietWalk.edges.length, 0);
    check('P11 · but the wallet IS named', quietWalk.namedKeys.has(WALLET), true);
    // The walk must have been complete for that absence-of-edges to have meant
    // anything, and complete is also what makes a P11 absence credible.
    check('P11 · and the walk was deep, so absence would be arguable', quietWalk.deep, true);

    // The other direction: a payer whose history genuinely never names the
    // address. Without this, a P11 that returned every key it ever saw — or
    // simply `true` — would pass the case above and be worthless.
    check('P11 · a stranger is not named', quietWalk.namedKeys.has(ISSUER), false);

    // And the partial-walk rule. The bracketed payer from case 1 stops early
    // (2 of 2 here, but `deep` is false), so an absence read off it is not
    // evidence — P11 reports INCONCLUSIVE on exactly this shape.
    check('P11 · an early-stopping walk is not marked deep', leaky.deep, false);

    // 🚨 THE CASE THAT MADE P11 UNREACHABLE, AND THE FIX.
    //
    // A funder-paid ephemeral is funded in its oldest transaction and swept in
    // its newest, so BOTH ends always name the funder, so the early return
    // above always fired, so `deep` was always false — and P11's completeness
    // test requires `deep`. The probe the runbook calls "the audit answer" was
    // therefore incapable of ever passing on a correct run of the very plan it
    // was written to evidence.
    //
    // Naming an address now buys the whole history. Asserted on the SAME
    // bracketed shape as case 1, so the two lines differ only in the flag.
    const forced = await traceFunderEdges(mkRpc(bracketed), PAYER, {
      historyLimit: 401, exhaustive: true,
    });
    check('P11 · a named address forces the deep walk', forced.deep, true);
    check('P11 · and the edges are still all found', forced.edges.length, 2);
    check('P11 · nothing in the history goes unread', forced.scanned, forced.historyLength);

    console.log(
      broken === 0
        ? '   PASS  every channel decoder answers in both directions.'
        : `   ${broken} decoder control(s) broken — P6/P7/P8/P9/P10/P11 results are not trustworthy.`,
    );
    return broken === 0 ? 0 : 1;
  })();
}

function selfTestOffsets() {
  console.log('\n  ── OFFSET CONTROL (offline) ──────────────────────────────');
  const COMMITMENT = 0xC0FFEE0000000001n;
  const MIN_EPOCH = 0x00000000DEADBEEFn;
  let broken = 0;
  let checked = 0;

  for (const kind of SPEND_KINDS) {
    const layout = SPEND_LAYOUTS[kind.name];
    if (!layout) continue;
    checked += 1;

    let derived = 0;
    let derivedRecipient = null;
    const total = layout.reduce((n, [, w]) => n + w, 0);
    const buf = Buffer.alloc(total);
    let at = 0;
    for (const [field, width] of layout) {
      if (field === 'stark_commitment') { derived = at; buf.writeBigUInt64LE(COMMITMENT, at); }
      else if (field === 'min_epoch') buf.writeBigUInt64LE(MIN_EPOCH, at);
      else if (field === 'recipient') { derivedRecipient = at; buf.fill(0xAB, at, at + width); }
      at += width;
    }

    const read = buf.readBigUInt64LE(kind.commitmentOffset);
    const ok = kind.commitmentOffset === derived && read === COMMITMENT;
    if (!ok) {
      broken += 1;
      console.log(
        `   FAIL  ${kind.name}: table says ${kind.commitmentOffset}, the signature says ${derived}` +
          (read === MIN_EPOCH ? ' — it is reading min_epoch' : ''),
      );
    } else {
      console.log(`   ok    ${kind.name}: commitment at ${derived}, read back intact`);
    }

    // The payee offset, derived from the same signature. P10 was pinned to 88
    // from the ENCODER alone; this is the second, independent source, and the
    // two must agree or one of them is describing bytes nobody writes.
    const declaredRecipient = kind.recipientOffset ?? null;
    if (declaredRecipient !== derivedRecipient) {
      broken += 1;
      console.log(
        `   FAIL  ${kind.name}: table says recipient at ${declaredRecipient}, the signature says ` +
          `${derivedRecipient}. A wrong payee offset reads 32 bytes of something else and prints ` +
          'a syntactically valid address belonging to nobody.',
      );
    } else if (derivedRecipient !== null) {
      console.log(`   ok    ${kind.name}: recipient at ${derivedRecipient}, agrees with the encoder`);
    }
  }

  if (checked === 0) {
    console.log('   FAIL  no kind was checked, so this control asserted nothing.');
    return 1;
  }
  console.log(
    broken === 0
      ? `   PASS  ${checked} spend layout(s) agree with the program signature.`
      : '   FAIL  an offset disagrees with the signature. Any GREEN from P1 is worthless.',
  );
  return broken === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Newest spends on a pool, found through the NullifierRecord each one creates. */
async function findSpends(rpc, poolPDA, limit) {
  const accounts = await rpc('getProgramAccounts', [
    ZK_SHIELDED,
    {
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      filters: [{ dataSize: 41 }, { memcmp: { offset: 8, bytes: poolPDA } }],
    },
  ]);
  const found = [];
  for (const a of accounts.slice(0, limit)) {
    const sigs = await rpc('getSignaturesForAddress', [a.pubkey, { limit: 1 }]);
    if (sigs?.length) found.push(sigs[0].signature);
  }
  return found;
}

/**
 * A probe that could not look is not a probe that looked and found nothing.
 *
 * Both report FAIL and both keep the exit code at 1 — refusing to pass on an
 * unread channel is the whole discipline here. But the summary line called all
 * of them "a surviving linkage", so `--replay verify/fixtures/v4-synthetic`, the
 * fixture this repo calls "clean stays reportable", printed "3 probe(s) found a
 * surviving linkage". Those three had found nothing; they had been unable to
 * look. Naming that a detection is the same overstatement in the other
 * direction, and a hostile reader meets this line first.
 */
function isInconclusive(r) {
  return !r.passed && typeof r.detail === 'string' && r.detail.startsWith('INCONCLUSIVE');
}

function render(report) {
  const failed = report.results.filter((r) => !r.passed);
  console.log(`\n  spend ${report.signature}`);
  console.log(`  instruction ${report.kind}  ·  slot ${report.slot}`);
  for (const r of report.results) {
    console.log(`   ${r.passed ? 'PASS' : isInconclusive(r) ? '????' : 'FAIL'}  ${r.id.padEnd(3)} ${r.name}`);
    console.log(`         ${r.detail}`);
  }
  if (report.context) {
    console.log(
      `   INFO  pool ${report.context.pool}: ${report.context.unspentNotes} unspent of ` +
        `${report.context.leavesEverInserted} ever deposited` +
        (report.context.gapSlots !== null ? `; deposit->spend gap ${report.context.gapSlots} slots` : ''),
    );
  }
  return { failed: failed.length, inconclusive: failed.filter(isInconclusive).length };
}

async function main() {
  const selfTest = process.argv.includes('--self-test');
  const recordDir = arg('--record', null);
  const replayDir = arg('--replay', null);
  if (recordDir && replayDir) throw new Error('--record and --replay are mutually exclusive');
  if (recordDir && !arg('--spend', null)) {
    throw new Error('--record needs --spend: a fixture freezes exactly one spend');
  }

  const poolsFile = arg('--pools', null);
  if (poolsFile) registerPools(JSON.parse(readFileSync(poolsFile, 'utf8')), poolsFile);

  const opts = {
    maxChunkTx: Number(arg('--max-chunk-tx', '200')),
    depositLimit: Number(arg('--deposit-limit', '400')),
    // ⚠️ An earlier version of this comment said `--wallet` is deliberately NOT
    // read from a manifest, because "pinning it would freeze one operator's
    // question into everyone's control". That was wrong for the one fixture it
    // matters on. `verify/fixtures/v3-subscribe` is the NEGATIVE control: it
    // exists to assert that a real, leaky v3 spend is still seen as leaky. "The
    // buyer's wallet is findable in it" is exactly such an assertion, and P11
    // only exists when a wallet is named — so leaving it off the manifest meant
    // the cheapest extraction in the file had no frozen control at all.
    //
    // The command line still overrides, so anyone can point it at any address.
    wallet: arg('--wallet', null),
  };

  let rpc;
  let manifest = null;
  let store = null;
  let signatures = [];

  if (replayDir) {
    manifest = JSON.parse(readFileSync(join(replayDir, 'manifest.json'), 'utf8'));
    if (manifest.pools) registerPools(manifest.pools, `${replayDir}/manifest.json`);
    // The manifest's flags override the command line: they shaped the request
    // parameters at record time (e.g. getSignaturesForAddress limit), so any
    // other value can only produce replay misses.
    if (manifest.flags?.maxChunkTx) opts.maxChunkTx = manifest.flags.maxChunkTx;
    if (manifest.flags?.depositLimit) opts.depositLimit = manifest.flags.depositLimit;
    // The manifest's wallet is a DEFAULT, not an override, unlike the two
    // above: those shaped the recorded RPC requests, so a different value is a
    // replay miss. `--wallet` shapes no request at all, so a caller naming
    // their own address must win.
    if (!opts.wallet && manifest.flags?.wallet) opts.wallet = manifest.flags.wallet;
    // Naming an address makes the payer walks exhaustive (see traceFunderEdges),
    // which fetches transactions a shallow recording never captured. So on a
    // replay the walk depth comes from the FIXTURE, not from the flag: a
    // fixture recorded shallow replays shallow and P11 says INCONCLUSIVE with
    // its arithmetic, which is the truth about what was read. Re-record with
    // --wallet to get a fixture that can support a P11 pass.
    opts.exhaustiveWalk = manifest.flags?.exhaustiveWalk === true;
    rpc = makeReplayRpc(replayDir);
    const sig = arg('--spend', manifest.spend);
    if (!sig) throw new Error(`${replayDir}/manifest.json names no spend`);
    signatures = [sig];
  } else {
    rpc = makeRpc(arg('--rpc', DEFAULT_RPC));
    if (recordDir) {
      store = { seen: new Set(), calls: [] };
      rpc = wrapRecorder(rpc, store);
    }
    const spendSig = arg('--spend', null);
    if (spendSig) {
      signatures = [spendSig];
    } else {
      const pool = arg('--pool', DEFAULT_POOL);
      if (!POOLS[pool]) {
        const known = Object.entries(POOLS)
          .map(([k, v]) => `${v.label} = ${k}`)
          .join(', ');
        throw new Error(`unknown pool ${pool}. Known pools: ${known}. Add it to POOLS or pass --pools <json>.`);
      }
      console.log(`Searching pool ${pool} for spends...`);
      signatures = await findSpends(rpc, pool, Number(arg('--limit', '3')));
    }
  }

  let totalFailures = 0;
  let totalInconclusive = 0;
  const reports = [];
  for (const sig of signatures) {
    const report = await verifySpend(rpc, sig, opts);
    reports.push(report);
    const tally = render(report);
    totalFailures += tally.failed;
    totalInconclusive += tally.inconclusive;
  }

  if (recordDir) writeFixture(recordDir, store, reports[0], opts);

  if (selfTest) {
    // The offset control runs on every --self-test, replay or live: it needs no
    // chain and no fixture, and it guards the one thing every fixture missed.
    const offsets = selfTestOffsets();
    // Same rule as the offset control: no chain, no fixture, runs every time.
    // It is the ONLY place P7's green state is ever exercised.
    const channels = await selfTestChannelDecoders();
    const probes = manifest?.expect
      ? selfTestAgainstManifest(reports[0], manifest, replayDir)
      : selfTestLive(reports);
    process.exit(offsets === 0 && channels === 0 && probes === 0 ? 0 : 1);
  }

  const detected = totalFailures - totalInconclusive;
  console.log(
    totalFailures === 0
      ? '\n  All probes passed.\n'
      : `\n  ${detected} probe(s) found a surviving linkage; ${totalInconclusive} could not look ` +
        `(INCONCLUSIVE, reported FAIL and counted against the exit code, because an unread ` +
        `channel is not a closed one).\n`,
  );
  process.exit(totalFailures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(2);
});
