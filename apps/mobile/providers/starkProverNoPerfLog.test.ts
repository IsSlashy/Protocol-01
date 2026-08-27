/**
 * Guard: the SHARED proof funnel must not log.
 *
 * # What went wrong, once
 *
 * `StarkProverProvider.sendRequestRaw` is the single funnel every
 * `generate*Proof` wrapper goes through — C1, C2, C3, C4, C5, C6 and C7 alike.
 * A `[P01PERF] circuit=… prover=… ms bridge=… ms proofSize=…` line was added to
 * its `resolve`, to benchmark C7. Because the funnel is shared, it did not
 * benchmark C7: it fired on every proof any circuit ever produced, including a
 * real user's spend.
 *
 * That line named no proof, no witness, no nullifier and no commitment — only a
 * circuit id, two durations and a size. It is still a linkage. It timestamps
 * "this handset produced a circuit-7 spend proof at T"; the v4 withdrawals on
 * chain around T are public. Timing is metadata and metadata is the edge C7
 * exists to cut.
 *
 * And it shipped: `babel.config.js` has `transform-remove-console` commented
 * out and nothing else noops console in release, so the line survives into a
 * release APK, readable over `adb logcat -s ReactNativeJS` by anyone holding
 * the phone.
 *
 * # Why a source scan
 *
 * The defect is a console call on a code path, not a return value. No assertion
 * on what `generateSpendProof` RESOLVES can see it, and driving the provider
 * for real needs a React tree plus a live WebView. So the funnel is extracted
 * from the file as text and read. `webviewSpend.test.ts` in this repo reads
 * `StarkProver.tsx` the same way and for the same reason.
 *
 * The extraction is asserted before it is scanned: if the slice ever stops
 * containing the funnel's own landmarks, this test fails LOUDLY rather than
 * scanning an empty string and passing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function read(rel: string): string {
  return readFileSync(join(__dirname, rel), 'utf8').split(CR + LF).join(LF);
}

/**
 * Strip `//` line comments and block comments.
 *
 * Required, not cosmetic: the funnel now carries a long comment that names
 * `[P01PERF]` and `console` precisely to warn the next person off. Scanning raw
 * text would trip on the warning itself and make this guard un-passable.
 * (Safe here — no string literal inside the funnel contains a `//`.)
 */
function stripComments(src: string): string {
  return src
    .split('/*').map((part, i) => (i === 0 ? part : part.slice(part.indexOf('*/') + 2))).join('')
    .split(LF).map((line) => {
      const i = line.indexOf('//');
      return i < 0 ? line : line.slice(0, i);
    }).join(LF);
}

/** The body of `sendRequestRaw`, as text: from its declaration to the next
 *  top-level `const` in the component (2-space indent). */
function extractSendRequestRaw(): string {
  const src = read('StarkProverProvider.tsx');
  const open = src.indexOf('const sendRequestRaw = useCallback(');
  expect(open, 'sendRequestRaw was renamed or removed — re-aim this guard').toBeGreaterThan(-1);
  const rest = src.slice(open + 'const sendRequestRaw'.length);
  const close = rest.indexOf(LF + '  const ');
  expect(close, 'could not find the end of sendRequestRaw').toBeGreaterThan(-1);
  return rest.slice(0, close);
}

describe('the shared STARK proof funnel does not log', () => {
  it('extracts a slice that really is the funnel', () => {
    // Guards the guard. Without this, a broken extraction returns '' and every
    // assertion below passes on nothing.
    const body = extractSendRequestRaw();
    expect(body).toContain('pendingRequests.current.set');
    expect(body).toContain('callFn(id)');
    expect(body).toContain('STARK proof generation timed out');
  });

  it('makes no console call of any kind', () => {
    const body = stripComments(extractSendRequestRaw());
    // console.log / warn / error / info / debug / trace alike. On the shared
    // path the level is irrelevant: logcat shows them all.
    const calls = body.match(/console\s*\.\s*[a-zA-Z]+/g) ?? [];
    expect(calls, `sendRequestRaw is on EVERY circuit's path, including a real \
user spend, and console survives into the release APK. Put the timing in \
services/stark/c7Bench.ts instead. Found: ${calls.join(', ')}`).toEqual([]);
  });

  it('emits no [P01PERF] line anywhere in the provider', () => {
    // Broader than the funnel: no wrapper below it may reintroduce the line
    // either, and the marker is what an operator greps logcat for.
    const src = stripComments(read('StarkProverProvider.tsx'));
    expect(src).not.toContain('P01PERF');
  });

  it('leaves the benchmark as the only owner of the [P01PERF] line', () => {
    // The other half of the fix: this guard must not be satisfiable by simply
    // deleting the measurement everywhere. The bench still emits it, in the
    // recorded 2026-08-03 device format, through a caller-supplied sink.
    //
    // stripComments is LOAD-BEARING here. c7Bench.ts's header quotes the
    // 2026-08-03 capture verbatim — `[P01PERF] circuit=3 prover=1482 ms
    // bridge=1546 ms proofSize=78157`. Scanning raw text let this assertion
    // pass on that comment while the real emitter was deleted; a mutation run
    // caught it. Only executable code counts.
    const bench = stripComments(read('../services/stark/c7Bench.ts'));
    expect(bench).toContain('[P01PERF] circuit=');
    expect(bench).toContain('bridge=');
    expect(bench).toContain('proofSize=');
    // Caller-supplied sink === opt-in. If `log` ever stops being a parameter,
    // the bench has become another unconditional emitter.
    expect(bench).toMatch(/log:\s*\(line:\s*string\)\s*=>\s*void/);
  });

  /**
   * ⛔ THE FUNNEL GUARD ABOVE WAS NOT ENOUGH, MEASURED.
   *
   * A re-attacker inserted, into the WRAPPERS rather than into sendRequestRaw:
   *
   *   StarkProverProvider.tsx:227  console.log('[c1] proving np=' + np + ' secret=' + secret);
   *   StarkProverProvider.tsx:368  console.log('[spend] proving nf=' + nullifierPreimage + ' blinding=' + blinding);
   *
   * Both stayed GREEN, 4/4. The funnel guard scans only sendRequestRaw's body,
   * and the [P01PERF] guard matches only that literal — a witness printed under
   * any other prefix satisfies both. The second line is the live circuit-7
   * spend path, and it prints the nullifier preimage and the blinding: not
   * timing metadata this time, the SECRETS THEMSELVES.
   *
   * So the guard is an INVENTORY. Every console call this file is allowed to
   * make is listed below with its reason. Adding one — anywhere, at any level,
   * under any prefix — goes red and forces the author to come here and justify
   * it. Removing one goes red too, so the list cannot rot into a rubber stamp.
   *
   * ⚠️ THE LIST IS NOT AN ENDORSEMENT. Line 90 is
   * `console.log('[StarkProver/WebView]', msg.message)`, which prints whatever
   * the injected WebView sends on its `log` channel, unfiltered. That channel
   * is dormant today — services/stark/StarkProver.tsx:89 declares `log()` and
   * nothing calls it — but the receiver is live, and the injected script is a
   * plain ES5 string: not type-checked, not linted, shipped verbatim. It is one
   * `log(secret)` away from being exactly the defect this file exists to catch.
   * Recorded rather than removed, because deleting either end is a behaviour
   * change with its own blast radius.
   */
  const ALLOWED_CONSOLE = [
    { line: "console.log('[StarkProver] WASM loaded", why: 'boot, no witness in scope' },
    { line: "console.error('[StarkProver] WASM error:'", why: 'boot failure, error object only' },
    { line: "console.log('[StarkProver/WebView]'", why: 'unfiltered, but __DEV__-gated since 2026-08-27 — pinned below' },
    { line: "console.error('[StarkProver] WebView error:'", why: 'transport failure, error object only' },
    { line: "console.log('[StarkProver] merkle_update + transfer provers wired", why: 'wiring, constant string' },
    { line: "console.warn('[StarkProver] Failed to wire into ZkService:'", why: 'wiring failure, error object only' },
  ];

  it('makes exactly the console calls this file has justified, and no others', () => {
    const src = stripComments(read('StarkProverProvider.tsx'));
    const found = src.match(/console\s*\.\s*[a-zA-Z]+/g) ?? [];
    expect(
      found.length,
      `this provider wraps EVERY circuit, including the live circuit-7 spend, and console \
survives into the release APK (babel.config.js:51 has transform-remove-console commented out). \
A new console call here is one edit away from printing a nullifier preimage or a blinding. \
If you added one, add it to ALLOWED_CONSOLE with its reason and say in the commit why it \
cannot carry witness material. Expected ${ALLOWED_CONSOLE.length}, found ${found.length}.`,
    ).toBe(ALLOWED_CONSOLE.length);

    // ANTI-VACUITY: the inventory must describe THIS file, not a file that has
    // moved on. Each listed call has to still be present verbatim.
    for (const { line } of ALLOWED_CONSOLE) {
      expect(src, `ALLOWED_CONSOLE lists a call this file no longer makes: ${line}`).toContain(line);
    }
  });

  it('keeps the unfiltered WebView log receiver behind __DEV__', () => {
    // The one console call on this inventory that prints CONTENT it did not
    // author. Its emitter is a plain ES5 string injected into the WebView —
    // not type-checked, not linted — so the day someone adds `log(secret)`
    // there, this line decides whether a nullifier preimage reaches logcat on
    // a shipped device.
    //
    // Gated rather than redacted: a debug channel that hides what it was asked
    // to show is a channel nobody uses, and dev builds do not ship.
    //
    // Two independent defences, because one was measured insufficient on
    // 2026-08-27: this gate, and transform-remove-console re-enabled in
    // babel.config.js with only error and warn excluded. Either alone would do;
    // both means neither being reverted quietly reopens it.
    const src = stripComments(read('StarkProverProvider.tsx'));
    const line = src
      .split('\n')
      .find((l) => l.includes('[StarkProver/WebView]'));
    expect(line, 'the WebView log receiver is gone — drop this guard with it').toBeDefined();
    expect(
      line!,
      'the WebView log receiver lost its __DEV__ gate. It prints whatever the injected ' +
        'script sends, verbatim, and that script is not type-checked. Restore the gate, ' +
        'or delete the receiver.',
    ).toContain('__DEV__');
  });


  it('never interpolates witness material into a console call', () => {
    // The narrower, sharper half: even a call that IS on the inventory must not
    // name a secret. These are the parameter names the proof wrappers bind.
    const src = stripComments(read('StarkProverProvider.tsx'));
    const WITNESS = [
      'nullifierPreimage', 'blinding', 'spendingKey', 'pathElements',
      'recipientHash', 'tokenMint', 'secret', 'np',
    ];
    const offenders: string[] = [];
    for (const m of src.matchAll(/console\s*\.\s*[a-zA-Z]+\s*\(([^;]*)\)/g)) {
      const args = m[1] ?? '';
      for (const w of WITNESS) {
        // Word-boundary so `secretless` or `blindingCeiling` do not trip it.
        if (new RegExp(`\\b${w}\\b`).test(args)) offenders.push(`${w} in ${m[0].slice(0, 70)}`);
      }
    }
    expect(
      offenders,
      `a console call in the provider names witness material. On the spend path \
that is the nullifier preimage and the blinding — the two values the whole \
circuit exists to keep off the wire. Found: ${offenders.join(' | ')}`,
    ).toEqual([]);
  });
});
