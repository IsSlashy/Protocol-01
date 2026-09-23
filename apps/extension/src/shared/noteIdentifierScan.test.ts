/**
 * NO SOURCE IN THIS PACKAGE NAMES A NOTE — ON SCREEN OR IN A LOG.
 *
 * WHY A SOURCE SCAN AS WELL AS RENDER TESTS. The three screens EXT-UI reworked
 * are covered by render tests (`ShieldedWallet.test.tsx`, deleted with its
 * screen on 2026-09-23, `DenominatedUnshield.test.tsx`,
 * `DenominatedTransfer.test.tsx`), and a render
 * test is the stronger evidence: it measures what a user sees. But a render test
 * only covers a screen someone wrote a test for, and it cannot see a
 * `console.warn` on a path no test walks. Every surface below was reached by no
 * test at all before this file existed.
 *
 * WHAT IT MEASURES.
 *  1. The six rules the plan's baseline leaf-surface probe used on 2026-09-15.
 *     On that day they found 16 hits on 12 lines inside `apps/extension`
 *     (DenominatedTransfer 252/283, DenominatedUnshield 204/235,
 *     ShieldedWallet 633, services/denominatedPool 1051/2746, services/zk 869,
 *     1206, 1437, 1460, 1461). Keeping the same rules is what makes "0 hits"
 *     comparable to that measurement instead of a new number about a new thing.
 *  2. A stronger rule the probe did not have: a `console.*` call, ACROSS LINES,
 *     that carries a note-identifying VALUE. The probe's console rule is a
 *     single-line regex, so it walks past a call whose arguments wrap — and it
 *     flags prose that merely uses the word "commitment" while printing
 *     nothing. This one strips string literals (keeping `${…}` interpolations),
 *     turns `x.length` into a count, and then looks for the names. A count is
 *     allowed; the values are not.
 *
 * ⚠️ WHAT IT DOES NOT MEASURE. A scan reads spellings. Somebody who prints
 * `note.l` or builds the leaf number arithmetically walks past both rules, and
 * so does any surface outside `src/`. The render tests are what measure the
 * screens; this file is the tripwire under the rest of the package.
 *
 * Both detectors carry their own positive control below: planted lines they
 * must flag, and neutral lines they must not. Without that, a detector that
 * matched nothing at all would report a clean package.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** vitest runs with cwd = apps/extension (see `no-refund-warning.test.ts`). */
const SRC = resolve(process.cwd(), 'src');

const BACKSLASH = String.fromCharCode(92);

/** The baseline probe's rules, verbatim (2026-09-15). */
const BASELINE_RULES: Array<[string, RegExp]> = [
  ['ui-leaf-jsx', /leaf\s*#?\{[^}]*leaf/i],
  ['ui-index-jsx', /Index:\s*\{[^}]*index/],
  ['ui-leaf-plain', /leaf \{[^}]*leafIndex\}/],
  ['msg-leaf-template', /leaf #?\$\{[^}]*(leaf|counter|ref\.)/i],
  ['ui-deposit-date', /shieldedAt\)\.toLocale/],
  [
    'log-names-note',
    /console\.(log|warn|error|info|debug)\([^)]*(leafIndex|commitment|nullifier|noteId)/,
  ],
];

/** The names that identify ONE note (or somebody else's leaf), in a value position. */
const NOTE_VALUE_NAMES =
  /(leafIndex|leaf_index|commitment|nullifier|preimage|noteId|randomness|merkleRoot|merklePath|depositEpoch|shieldedAt|missing|\.index\b)/i;

type Hit = { rule: string; file: string; line: number; text: string };

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      // Tests are excluded: this file, and every other, quotes the shapes it
      // forbids. `starkGlueIife` is a generated bundle, as in the probe.
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.test\.|\.spec\.|starkGlueIife/.test(entry)) continue;
      out.push(p);
    }
  };
  walk(SRC);
  return out;
}

const rel = (p: string) => p.split(sep).join('/').replace(/^.*?apps\/extension\//, '');

/** Rule set 1 — the baseline probe, line by line. */
function baselineHits(source: string, file = '<planted>'): Hit[] {
  const hits: Hit[] = [];
  source.split('\n').forEach((line, i) => {
    for (const [rule, re] of BASELINE_RULES) {
      if (re.test(line)) hits.push({ rule, file, line: i + 1, text: line.trim().slice(0, 120) });
    }
  });
  return hits;
}

/**
 * Drop string-literal PROSE, keep `${…}` interpolations and bare arguments, so
 * "…publishes the commitment…" is not a hit and `${note.commitment}` is.
 */
function valuesOnly(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === BACKSLASH) i += 1;
        i += 1;
      }
      i += 1;
      out += ' ';
    } else if (c === '`') {
      i += 1;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === BACKSLASH) {
          i += 2;
          continue;
        }
        if (text[i] === '$' && text[i + 1] === '{') {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth += 1;
            else if (text[i] === '}') depth -= 1;
            i += 1;
          }
          // Recursive: a literal inside `${cond ? 'a' : 'b'}` is prose too.
          out += ' ' + valuesOnly(text.slice(start, i - 1)) + ' ';
          continue;
        }
        i += 1;
      }
      i += 1;
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  // A COUNT of anything is allowed: `${missing.length} gaps` says how many, not which.
  return out.replace(/[A-Za-z_$][\w$.]*\.length\b/g, ' COUNT ');
}

/** Rule set 2 — console calls, across lines, that carry a note value. */
function consoleValueHits(source: string, file = '<planted>'): Hit[] {
  const hits: Hit[] = [];
  const re = /console\.(log|warn|error|info|debug)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    const values = valuesOnly(source.slice(m.index, i));
    if (NOTE_VALUE_NAMES.test(values)) {
      hits.push({
        rule: 'console-carries-note-value',
        file,
        line: source.slice(0, m.index).split('\n').length,
        text: values.replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }
  return hits;
}

/**
 * Rule set 3 (EXT-UI fix round 1) — a thrown message that carries a note value.
 *
 * Found by the round-1 verifier (`wp-logs/verify/EXT-UI-r1-closure-probe.log`):
 * `buildMerkleProofFromLeavesV3` threw `target leafIndex ${targetLeafIndex} not
 * found`, and both spend screens render `err.message` through `setError`, so the
 * user's own leaf number reached the screen on a truncated history. The baseline
 * rule only knew `leaf #${…}`. This one reads the message of every built-in
 * `new Error(` / `TypeError(` / `RangeError(` the way rule 2 reads a console
 * call, and also flags a value that the prose right before it calls an index, a
 * leaf or a position (`at index ${i}`). ALL_CAPS constants are sizes, not notes.
 * A custom error class is read where its message is written (`super('…')`), not
 * at `new XError(noteId)`, whose argument is a field. The render test "an error
 * on the way to a withdrawal names no leaf" (`DenominatedUnshield.test.tsx`) is
 * what measures the screen.
 */
function errorValueHits(source: string, file = '<planted>'): Hit[] {
  const hits: Hit[] = [];
  const re = /new\s+(Error|TypeError|RangeError)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    const raw = source.slice(m.index + m[0].length, i - 1);
    const values = valuesOnly(raw).replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, ' CONST ');
    if (NOTE_VALUE_NAMES.test(values) || /(index|leaf|position|#)\s*\$\{/i.test(raw)) {
      hits.push({
        rule: 'error-carries-note-value',
        file,
        line: source.slice(0, m.index).split('\n').length,
        text: values.replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }
  return hits;
}

/**
 * Rule set 4 (EXT-UI fix round 1) — in the two files that hold notes and tree
 * leaves, a console call may carry prose, a count, a caught error and a boolean
 * that picks between two literals, nothing else. Rule 2 reads NAMES, so
 * `console.warn('… tree leaf:', s)` in `services/zk.ts` printed a stored leaf
 * under a one-letter name and passed (`wp-logs/verify/EXT-UI-r1-closure-probe.log`).
 * Here every identifier left after the literals are stripped must be allowed.
 * The allow-list is by name, so it trusts that `closeErr` holds an error and
 * `isShield` a boolean; the planted controls below keep it from growing silently.
 *
 * Fix round 2 adds the store and the subscription service: both printed the
 * circuit-7 refusal under the neutral name `v4Refusal`, and that reason carried
 * the deposit epoch (`wp-logs/verify/EXT-UI-r2-probe/epoch-probe.log`).
 *
 * `services/zk.ts` (the retired V1 client) left this list on 2026-09-23 because
 * the file itself was deleted, not because the rule was relaxed.
 */
const STRICT_CONSOLE_FILES = [
  'src/shared/services/denominatedPool.ts',
  'src/shared/store/denominatedPool.ts',
  'src/shared/services/subscriptionVault.ts',
];
const CONSOLE_ALLOWED = new Set([
  'COUNT', 'message', 'instanceof', 'Error', 'String', 'as', 'msg', 'skipped',
  'true', 'false', 'null', 'undefined',
]);
const consoleNameAllowed = (n: string) =>
  CONSOLE_ALLOWED.has(n) ||
  /^(e|err|error|[A-Za-z]+(Err|Error))$/.test(n) || // a caught error
  /^(is|in|has)[A-Z]\w*$/.test(n); // a boolean choosing between literals

function consoleBareValueHits(source: string, file = '<planted>'): Hit[] {
  const hits: Hit[] = [];
  const re = /console\.(log|warn|error|info|debug)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    const values = valuesOnly(source.slice(m.index + m[0].length, i - 1)).replace(
      /[A-Za-z_$][\w$.]*Count\b/g,
      ' COUNT ',
    );
    const names = values.match(/[A-Za-z_$][\w$]*/g) ?? [];
    const extra = names.filter((n) => !consoleNameAllowed(n));
    if (extra.length > 0) {
      hits.push({
        rule: 'console-carries-a-value',
        file,
        line: source.slice(0, m.index).split('\n').length,
        text: `${extra.join(',')} :: ${values.replace(/\s+/g, ' ').trim()}`.slice(0, 120),
      });
    }
  }
  return hits;
}

/**
 * Rule set 5 (EXT-UI fix round 2) — any template interpolation, in any source
 * file and whatever the string is used for, that carries a note value or a tree
 * root. Rules 2-4 read a message where it is printed or thrown, so a value that
 * is put into a string in one place and printed under another name in a second
 * place walked past them: `whyCircuit7Cannot` built `epoch (${receipt.depositEpoch})`
 * and two `console.warn` sites printed it as `v4Refusal`
 * (`wp-logs/verify/EXT-UI-r2-verdict.log`). This rule reads the string where it
 * is BUILT. Roots are in it too: the sync toast and three pre-flight errors
 * rendered local and on-chain roots. A count (`historicalRoots.length`), an
 * ALL_CAPS size and a literal chosen by a boolean are not values.
 * It does not read `'…' + value` concatenation; rule 4 and the console cases in
 * `store/unshieldRouting.test.ts` and `services/subscribeRouting.test.ts` cover
 * the printed side of the one path that had it.
 */
const TREE_ROOT_NAMES = /root/i;

function templateValueHits(source: string, file = '<planted>'): Hit[] {
  const hits: Hit[] = [];
  let at = source.indexOf('${');
  while (at >= 0) {
    let i = at + 2;
    let depth = 1;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    const values = valuesOnly(source.slice(at + 2, i - 1)).replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, ' CONST ');
    if (NOTE_VALUE_NAMES.test(values) || TREE_ROOT_NAMES.test(values)) {
      hits.push({
        rule: 'template-carries-note-value',
        file,
        line: source.slice(0, at).split('\n').length,
        text: values.replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
    at = source.indexOf('${', at + 2);
  }
  return hits;
}

const FILES = sourceFiles();
const SOURCES = FILES.map((f) => ({ file: rel(f), source: readFileSync(f, 'utf8') }));

const show = (hits: Hit[]) =>
  hits.map((h) => `${h.file}:${h.line}  [${h.rule}]  ${h.text}`).join('\n');

describe('the extension names no note', () => {
  it('has scanned the files it claims to have scanned', () => {
    // Anti-vacuity. A walk that returned nothing would make every case below
    // pass while measuring an empty set.
    expect(FILES.length).toBeGreaterThan(80);
    const names = SOURCES.map((s) => s.file);
    // ShieldedWallet.tsx and services/zk.ts were anchors here until they were
    // deleted on 2026-09-23; Shield.tsx is the screen that replaced the former.
    for (const f of [
      'src/popup/pages/Shield.tsx',
      'src/popup/pages/DenominatedUnshield.tsx',
      'src/popup/pages/DenominatedTransfer.tsx',
      'src/shared/services/denominatedPool.ts',
      'src/shared/services/subscribePrivateStarkV4.ts',
    ]) {
      expect(names, `${f} is not in the scan`).toContain(f);
    }
  });

  it('shows no leaf number, note index or deposit date (the 2026-09-15 rules)', () => {
    const hits = SOURCES.flatMap(({ file, source }) => baselineHits(source, file));
    expect(show(hits)).toBe('');
  });

  it('logs no note identifier, including in a call that wraps over lines', () => {
    const hits = SOURCES.flatMap(({ file, source }) => consoleValueHits(source, file));
    expect(show(hits)).toBe('');
  });

  it('throws no message that names a leaf, a tree position or a note', () => {
    const hits = SOURCES.flatMap(({ file, source }) => errorValueHits(source, file));
    expect(show(hits)).toBe('');
  });

  it('in the note and tree services, logs prose, counts and errors only', () => {
    const strict = SOURCES.filter((s) => STRICT_CONSOLE_FILES.includes(s.file));
    expect(strict.map((s) => s.file).sort()).toEqual([...STRICT_CONSOLE_FILES].sort());
    const hits = strict.flatMap(({ file, source }) => consoleBareValueHits(source, file));
    expect(show(hits)).toBe('');
  });

  it('builds no string that carries a note value or a tree root, wherever it ends up', () => {
    const hits = SOURCES.flatMap(({ file, source }) => templateValueHits(source, file));
    expect(show(hits)).toBe('');
  });
});

describe('the detectors themselves', () => {
  it('flag what they are for', () => {
    const planted = [
      'const a = <span>leaf {note.leafIndex}</span>;',
      'const b = <p>Index: {note.index ?? 0}</p>;',
      'throw new Error(`pre-flight failed for leaf #${leafCount}`);',
      'const d = <p>{new Date(note.shieldedAt).toLocaleDateString()}</p>;',
    ].join('\n');
    expect(baselineHits(planted).length).toBeGreaterThanOrEqual(4);

    const plantedLogs = [
      'console.warn(`note leaf ${note.leafIndex} -> ${correctIndex}`);',
      'console.warn("dropping note:", note.commitment.toString());',
      ['console.warn(', '  `${missing.length} gaps: ${missing.slice(0, 5).join(",")}`,', ');'].join(
        '\n',
      ),
      'console.error("bad", { nullifier });',
    ].join('\n');
    expect(consoleValueHits(plantedLogs).length).toBe(4);
  });

  it('do not flag a row that shows a tag, an amount or a step', () => {
    const neutral = [
      'const e = <span>{label.text}</span>;',
      'const f = <p>{note.denominationHuman} SOL</p>;',
      'onProgress?.("Building Merkle proof from leaf history...");',
    ].join('\n');
    expect(show(baselineHits(neutral))).toBe('');
    expect(show(consoleValueHits(neutral))).toBe('');
  });

  it('the value rule passes a count and prose that only uses the word', () => {
    const neutral = [
      'console.warn(`[pool] ${missing.length} gap(s) in the leaf history; refusing to build a path`);',
      'console.warn("[pool] the older circuit pair publishes the commitment; falling back");',
      'console.warn("[ZK] skipping a note whose commitment does not verify");',
    ].join('\n');
    expect(show(consoleValueHits(neutral))).toBe('');
  });

  it('the error and strict console rules flag the round-1 escapes, and pass counts and errors', () => {
    // Planted from the lines the round-1 verifier found (EXT-UI-r1-closure-probe.log).
    const plantedErrors = [
      'throw new Error(',
      '  `buildMerkleProofFromLeavesV3: target leafIndex ${targetLeafIndex} not found ` +',
      '  `among ${leaves.filter(Boolean).length} non-empty leaves.`,',
      ');',
      'throw new Error(`Note ${noteId} not found in store`);',
      'throw new Error(`Missing commitment at index ${i} - cannot rebuild tree`);',
    ].join('\n');
    expect(errorValueHits(plantedErrors).length).toBe(3);
    const neutralErrors = [
      'throw new Error(`Circuit 7 must publish exactly 6 felts, got ${publicInputs.length}.`);',
      'throw new Error(`Unsupported note version: ${note?.version}`);',
      'throw new Error("this note is not in the fetched history");',
    ].join('\n');
    expect(show(errorValueHits(neutralErrors))).toBe('');

    const plantedBare = [
      "console.warn('[ZK] Dropping legacy BN254 tree leaf (re-shield required):', s);",
      "console.warn('[ZK Sync] Correct tree root:', newTree.root.toString());",
    ].join('\n');
    expect(consoleBareValueHits(plantedBare).length).toBe(2);
    const neutralBare = [
      "console.warn('[ZK] Failed to save notes:', error);",
      'console.warn(`[ZK] Dropped ${dropped.length} legacy tree leaves`);',
      "console.error('[ZK] x', e instanceof Error ? e.message : String(e));",
      "console.log(`[pool] PRE-FLIGHT OK, root matches ${inCurrent ? 'currentRoot' : 'historicalRoots'}`);",
    ].join('\n');
    expect(show(consoleBareValueHits(neutralBare))).toBe('');
  });

  it('the template rule and the strict console rule flag the round-2 escapes, and pass counts and sizes', () => {
    // Planted from the lines the round-2 verifier found (EXT-UI-r2-verdict.log).
    const plantedTemplates = [
      "  'circuit 7 needs at least a randomised blinding, and this note carries its deposit ' +",
      '  `epoch (${receipt.depositEpoch}) instead — it predates commitment blinding. Proving ` +',
      'message: `Root mismatch! Local: ${result.localRoot.slice(0, 20)}... On-chain: ${result.onChainRoot.slice(0, 20)}...`',
      '`Neither layout matched (direct=${oldRootDirect}, shifted=${oldRootSliced}). `',
      '`PRE-FLIGHT FAIL: Rebuilt Merkle root 0x${hex(retryRootBytes).slice(0, 24)}… `',
    ].join('\n');
    expect(templateValueHits(plantedTemplates).map((h) => h.line)).toEqual([2, 3, 3, 4, 4, 5]);
    const neutralTemplates = [
      '`is not in pool\'s known roots (current + ${parsed.historicalRoots.length} historical). `',
      "console.log(`[pool] PRE-FLIGHT OK, root matches ${inCurrent ? 'currentRoot' : 'historicalRoots'}`);",
      '`Merkle path is ${merkleResult.pathElements.length} deep; circuit 7 needs at least ${C7_SUBTREE_DEPTH}.`',
      'const t = `${label.text} ${note.denominationHuman} SOL`;',
    ].join('\n');
    expect(show(templateValueHits(neutralTemplates))).toBe('');

    // The neutral name the epoch travelled under must not pass the strict rule.
    const plantedRefusal = [
      'console.warn(',
      "  '[DenomPool/ext] circuit 7 could not prove this note; falling back to the ' +",
      "    'C1 + C3 pair, which publishes the note commitment:',",
      '  v4Refusal,',
      ');',
      "console.warn('[SubscriptionVault] circuit 7 refused:', v4Refusal);",
    ].join('\n');
    expect(consoleBareValueHits(plantedRefusal).length).toBe(2);
  });

  it('the 2026-09-15 rules are prose-blind, which is why messages had to be reworded', () => {
    // MEASURED here, not assumed: the baseline console rule matches the WORD
    // "commitment" in a message that prints no value. Two of the extension's 16
    // hits that day were exactly that (services/zk.ts 1206 and 1437), so taking
    // the count to 0 meant rewording them, not only removing values. Stating
    // the limitation is also the reason the value rule above exists.
    const prose = 'console.warn("[ZK Sync] Could not compare commitments:", e);';
    expect(baselineHits(prose).length).toBe(1);
    expect(consoleValueHits(prose)).toEqual([]);
  });
});
