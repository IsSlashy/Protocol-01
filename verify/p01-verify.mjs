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
  { name: 'unshield_denominated_stark_v3', commitmentOffset: 80, totalLen: 120 },
  { name: 'subscribe_private_stark', commitmentOffset: 160, totalLen: null },
  { name: 'transfer_denominated_stark_v3', commitmentOffset: 80, totalLen: null },
  { name: 'split_note_stark', commitmentOffset: null, totalLen: null },
  // v4 lands here. It must appear with commitmentOffset: null, and P1 then
  // passes only because there is nothing to read — which is the point.
  { name: 'unshield_denominated_stark_v4', commitmentOffset: null, totalLen: null },
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
    flags: { maxChunkTx: opts.maxChunkTx, depositLimit: opts.depositLimit },
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
const SYS_IX_TRANSFER = 2;

/** Decode a System `transfer`. Returns null for every other System instruction. */
function decodeSystemTransfer(data, accounts, keys) {
  if (data.length < 12) return null;
  if (data.readUInt32LE(0) !== SYS_IX_TRANSFER) return null;
  if (accounts.length < 2) return null;
  return {
    source: keys[accounts[0]],
    destination: keys[accounts[1]],
    lamports: data.readBigUInt64LE(4),
  };
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
    found.push({ level, direction: t.source === payer ? 'out' : 'in', counterparty: other, lamports: t.lamports });
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
async function traceFunderEdges(rpc, payer, { historyLimit } = {}) {
  let calls = 0;
  // Request the SAME page size the other history walkers use. The replay cache
  // keys on exact request params, so a different limit here would be a cache
  // miss on every recorded fixture — and, worse, would make three probes fetch
  // three copies of one page against a live RPC.
  const sigs = await rpc('getSignaturesForAddress', [payer, { limit: historyLimit }]);
  calls += 1;
  if (!sigs?.length) {
    return {
      edges: [], historyLength: 0, truncated: false, calls, scanned: 0, deep: false,
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
    for (const t of systemTransfersIn(tx, payer)) {
      edges.push({ role, ...t, signature, slot: tx.slot });
    }
  };

  const newest = live[0];
  const oldest = live[live.length - 1];
  if (oldest) await visit(oldest.signature, 'pre-fund (oldest)');
  if (newest && newest.signature !== oldest?.signature) await visit(newest.signature, 'sweep (newest)');

  // The cheap answer, when there is one: the ends already name someone.
  if (edges.length) {
    return {
      edges, historyLength: sigs.length, truncated, calls, scanned: visited.size, deep: false,
      inconclusive: null,
    };
  }

  // No answer at the ends. Absence is only credible once the whole history has
  // been read, so pay for it.
  for (const s of live) await visit(s.signature, 'mid-life');
  return {
    edges, historyLength: sigs.length, truncated, calls, scanned: visited.size, deep: true,
    inconclusive: null,
  };
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

async function verifySpend(rpc, signature, opts = {}) {
  const chunkLimit = opts.maxChunkTx ?? 200;
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
    deposit = await findDeposit(rpc, POOLS[poolPDA].tree, target, opts.depositLimit ?? 400);
  }
  results.push(
    probe(
      'P4',
      'the spend cannot be traced to its deposit from public data',
      deposit === null,
      deposit === null
        ? target === null
          ? 'no commitment published, so there is nothing to match against a deposit'
          : 'no matching LeafInserted found within the searched window (may be RPC pruning, not privacy)'
        : `deposit ${deposit.signature} inserted the same commitment at leaf ${deposit.leafIndex}`,
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
    const funder = await traceFunderEdges(rpc, payer, { historyLimit });
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
            : `no System transfer names a counterparty in any of this payer's ${funder.scanned} ` +
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
            `${funder.calls} RPC calls over a ${funder.historyLength}-transaction life: ${worst}`,
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
      const depositTrace = await traceFunderEdges(rpc, pre.walk, { historyLimit });
      const out = overlapVerdict(depositTrace, spendTrace, deposit.payer, payer);
      if (out.stop) {
        verdict = probe('P8', P8_NAME, false, `INCONCLUSIVE: ${out.stop}`);
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
 * Walk the tree account's history for the LeafInserted that carries `leaf`.
 *
 * `payer` is returned because P8 needs it and this walk already holds the
 * transaction — fetching the deposit again from P8 would double the cost of the
 * most expensive probe in the file for a field that is already in hand. It is
 * null when the transaction carried no message header, which is the same
 * condition that makes the spend's own payer null.
 */
async function findDeposit(rpc, treePDA, leaf, limit) {
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
          };
        }
      }
    }
    before = page[page.length - 1].signature;
  }
  return null;
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
  // programs/zk_shielded/src/lib.rs — both v3 spends share this prefix.
  unshield_denominated_stark_v3: [
    ['disc', 8], ['nullifier', 32], ['merkle_root', 32], ['min_epoch', 8], ['stark_commitment', 8],
  ],
  transfer_denominated_stark_v3: [
    ['disc', 8], ['nullifier', 32], ['merkle_root', 32], ['min_epoch', 8], ['stark_commitment', 8],
  ],
  // subscribe_private_stark is NOT covered: its argument list has not been read
  // field by field here, and inventing a layout to make a test green would be
  // worse than the gap. Left explicit so the gap is visible rather than assumed
  // away.
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

    console.log(
      broken === 0
        ? '   PASS  all three channel decoders answer in both directions.'
        : `   ${broken} decoder control(s) broken — P6/P7/P8 results are not trustworthy.`,
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
    const total = layout.reduce((n, [, w]) => n + w, 0);
    const buf = Buffer.alloc(total);
    let at = 0;
    for (const [field, width] of layout) {
      if (field === 'stark_commitment') { derived = at; buf.writeBigUInt64LE(COMMITMENT, at); }
      else if (field === 'min_epoch') buf.writeBigUInt64LE(MIN_EPOCH, at);
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
