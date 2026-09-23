/**
 * node --test scripts/bench/flows/scrub.test.mts
 *
 * The scrub that runs on every live-flow log before it is written under the
 * output directory (and so, for a real run, under docs/bench/<date>/raw/).
 *
 * Every input line below is built with the SAME template literal the harness
 * uses to print it (apps/web/lib/privacy/pool/liveNoteInExchange.test.ts and
 * the other live*.test.ts files), behind the `[bench-t …]` stamp that
 * stamp.setup.ts adds and the `stdout | file > test` header vitest prints. A
 * change of format in a harness that the scrub no longer recognises has to
 * fail here, not in a published log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { scrubLiveLog } from './scrub.mts';

// A claim code as the route mints it: randomBytes(32).toString('base64url'),
// app/api/claim-for-payment/route.ts:382. 43 characters of [A-Za-z0-9_-].
const CODE = randomBytes(32).toString('base64url');
const SIG = '2xm8EGkp' + 'Q'.repeat(80);
const EPH = 'EphXq7mZ1ab2cD3eF4gH5iJ6kL7mN8oP9qR1sT2uV3w';
const HOME = 'C:\\Users\\Alice';
const PRIVATE = `${HOME}\\AppData\\Local\\Temp\\styx-bench-private\\2026-09-22`;
const RECORD = `${PRIVATE}\\purchase-record-3.json`;

const stampLine = (t: number, s: string) => `[bench-t ${t.toFixed(1)}] ${s}`;
const HEADER = 'stdout | lib/privacy/pool/liveNoteInExchange.test.ts > the note-in exchange, live > gives up a note to the till and collects an older one the buyer never deposited';

/** The route's 200 body, in the route's key order (route.ts:427-440). */
function claimBody(code: string) {
  return {
    ok: true, claimCode: code, kind: 'pool-withdrawal', payer: EPH, received: 995_000_000,
    priceLamports: 995_000_000, floorLamports: 990_000_000, expires: false,
    note: 'Redeem this at /api/issue-note. The note you receive was deposited by the treasury long before you paid.',
  };
}

// The harness's own expressions, verbatim (liveNoteInExchange.test.ts:289, 302, 373).
const claimLine = (status: number, claim: unknown) => `  claim-for-payment -> ${status} ${JSON.stringify(claim).slice(0, 200)}`;
const claimShortLine = (code: string) => `  CLAIM ${code.slice(0, 16)}...`;
const recordLine = (p: string) => `  record written to ${p}`;

const opts = { privatePaths: [PRIVATE], homeDir: HOME };

test('the claim-for-payment line keeps the status and the kind but not the claim code', () => {
  const log = [HEADER, stampLine(1758000000100.2, claimLine(200, claimBody(CODE)))].join('\n');
  const out = scrubLiveLog(log, opts);
  assert.ok(!out.includes(CODE), 'the full claim code survived');
  assert.ok(!out.includes(CODE.slice(0, 16)), 'a 16-character prefix of the claim code survived');
  assert.match(out, /claim-for-payment -> 200 /);
  assert.match(out, /"claimCode":"<redacted>"/);
  assert.match(out, /"kind":"pool-withdrawal"/);
  assert.match(out, /^\[bench-t 1758000000100\.2\]/m, 'the stamp the marker parser needs was damaged');
});

test('a claim-for-payment line cut by .slice(0, 200) inside the code is still scrubbed', () => {
  // A longer body ahead of the code (a future field) pushes the cut into the code.
  const body = { ok: true, pad: 'x'.repeat(150), claimCode: CODE, kind: 'pool-withdrawal' };
  const line = claimLine(200, body);
  assert.ok(!line.includes(CODE) && line.includes(CODE.slice(0, 10)), 'fixture: the cut must fall inside the code');
  const out = scrubLiveLog(stampLine(1.0, line), opts);
  assert.ok(!out.includes(CODE.slice(0, 10)), 'a partial claim code survived');
  assert.match(out, /"claimCode":"<redacted>/);
});

test('the CLAIM prefix line keeps the marker and drops the code prefix', () => {
  const out = scrubLiveLog(stampLine(1758000000200.0, claimShortLine(CODE)), opts);
  assert.ok(!out.includes(CODE.slice(0, 16)), 'the CLAIM prefix survived');
  // The marker parser's claim phase ends on /^\s*CLAIM / (markers.mts): it must still match.
  assert.match(out, /\] {3}CLAIM <redacted>/);
});

test('the record path, the private directory and the home directory never reach the log', () => {
  const lines = [
    stampLine(1.0, recordLine(RECORD)),
    // vitest failure output names the progress file with either separator.
    `Error: ENOENT: no such file or directory, open '${RECORD}.progress.json'`,
    `    at ${PRIVATE.replace(/\\/g, '/')}/purchase-record-3.json.progress.json`,
    `    at ${HOME.toLowerCase()}\\AppData\\Roaming\\npm\\node_modules\\x.js:1:1`,
  ].join('\n');
  const out = scrubLiveLog(lines, opts);
  assert.ok(!/alice/i.test(out), 'the Windows user name survived');
  assert.ok(!out.toLowerCase().includes('styx-bench-private'), 'the private directory survived');
  assert.match(out, /record written to <private record>/);
});

test('leaf numbers are omitted in every form the harnesses print them', () => {
  const lines = [
    // liveNoteInExchange.test.ts:188, 147, 157
    stampLine(1, `  SHIELD LANDED: ${SIG} | leaf 117`),
    stampLine(2, `resuming after the withdrawal ${SIG} (leaf 117)`),
    stampLine(3, `  reusing unspent note at leaf 117`),
    // liveDevnetShield.test.ts:236 console.log('  SHIELD LANDED:', sig, 'leaf', n)
    stampLine(4, ['  SHIELD LANDED:', SIG, 'leaf', 118].join(' ')),
    // liveDevnetUnshieldV4.test.ts:156
    stampLine(5, `  using leaf 119 (P01_LIVE_LEAF)`),
    // a JSON echo of a note or a progress record
    stampLine(6, `{"leafIndex":120,"gaveUpLeaf":121,"receivedLeaf":122}`),
  ].join('\n');
  const out = scrubLiveLog(lines, opts);
  for (const n of ['117', '118', '119', '120', '121', '122']) assert.ok(!out.includes(n), `leaf ${n} survived`);
  assert.ok(out.includes(SIG), 'the signature must stay: signatures are published in full');
});

test('a failed leaf assertion does not publish the two leaves it compared', () => {
  // vitest's output for liveNoteInExchange.test.ts:345 when it fails.
  const lines = [
    'AssertionError: the exchange handed back the same leaf that was given up: expected 117 not to be 117 // Object.is equality',
    'AssertionError: the note re-opened to a different leaf: expected 131 to be 117 // Object.is equality',
    '- Expected',
    '+ Received',
    '',
    '- 117',
    '+ 131',
  ].join('\n');
  const out = scrubLiveLog(lines, opts);
  assert.ok(!out.includes('117') && !out.includes('131'), out);
  assert.match(out, /handed back the same leaf/);
});

test('exact secret values (the codes read back from the private record) are removed anywhere', () => {
  const out = scrubLiveLog(`some future line that prints ${CODE} bare`, { ...opts, values: [CODE] });
  assert.ok(!out.includes(CODE));
});

test('what the timing needs survives: stamps, markers, signatures, lamport amounts', () => {
  const lines = [
    stampLine(10.0, `  unshield-prepare: Reading the tree...`),
    stampLine(20.0, `  route v4 | job unshield-v4:abc | float 612000000`),
    stampLine(30.0, `  funded ${EPH} with 612000000`),
    stampLine(40.0, `  WITHDRAWAL TO THE TILL: ${SIG}`),
    stampLine(50.0, `  the till received 995000000 lamports (expected 995000000)`),
    stampLine(60.0, `  issue-note -> 200, an older note sealed to the buyer`),
  ].join('\n');
  assert.equal(scrubLiveLog(lines, opts), lines);
});
