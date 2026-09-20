/**
 * What the PUBLIC Actions log of this repository may carry.
 *
 * github.com/IsSlashy/Protocol-01 is public, so the log and the step summary of
 * every workflow run are public with them. Two jobs write there: the restock
 * tick (`.github/workflows/restock-inventory.yml`) and the settlement tick
 * (`settle-till.yml`). Ledger row E5 and map A defect 9 name what they printed:
 * the float and the restock wallet as base58, the signature of the transfer
 * between them, a leaf index per deposit, balances in SOL, and the random delay
 * each tick waited. A reader of one run could label inventory leaves and name
 * the wallets that fund them.
 *
 * HOW THIS FILE READS A LEAK
 * ──────────────────────────
 * Not by listing the spellings of a public key. The same lines are built in
 * several WORLDS that differ in exactly ONE value each — the float key, the
 * restock key, the balances, the signature, the quiet time, the leaf indices in
 * a library message — and a line is judged by what MOVES it. A public line that
 * changes when the float key changes NAMES the float key, in whatever alphabet
 * it is written. Every world is deterministic (fixed seeds, a frozen clock, no
 * random draw), and the `again` world pins that: if any value here were random,
 * every line would move in every world, nothing could be shown to name
 * anything, and the differential would quietly prove nothing.
 *
 * TWO THINGS THE DIFFERENTIAL CANNOT SEE, each with its own case here:
 *   1. An output path that emits NOTHING passes every differential. So the
 *      positive control asserts each verdict still reaches the log, and that
 *      seven different verdicts give seven different lines.
 *   2. A call site that hands a LEAF to `ciSay` as if it were a count. `ciSay`
 *      bounds what it prints but cannot know what a number means, so the
 *      structural case asserts the two jobs emit through `ciLog` only and that
 *      no call site passes an index.
 * A NAME IS NOT A VALUE, so the last two cases RUN the two jobs, the real
 * files, against a fake chain, in worlds that differ in one value each (the
 * unspent stock, the leaves, the balances, the keys, the random draws), and
 * read their public output by what moves it. That is what caught `before` and
 * `after`: vetted names whose value was the UNSPENT stock (web run round-2
 * verifier, finding 1).
 *
 * THE THREAT MODEL
 * ────────────────
 * In scope, two things. (1) An ACCIDENTAL leak onto a public log: a library
 * message, a debugging echo, a flag dropped from a command, a secret stored
 * in another format than expected. (2) A workflow change nobody reviewed:
 * case 8 pins EVERY non-comment line of the two workflows to an exact vetted
 * list, so any change to what they run, or to what the runner shows, turns
 * this file red until someone reads it and changes the list with it.
 * Out of scope: a maintainer who edits a workflow AND that list on purpose,
 * to exfiltrate. Whoever can merge that can print a secret in ways no test
 * reads; review is the control there, and the pin is what forces it.
 *
 * WHAT A GREEN HERE DOES NOT CLOSE
 *   - The TIME of every run stays public — schedule, queue time, step
 *     durations — so a deposit can still be matched to the tick that made it.
 *     That needs the founder's decisions on retention and on moving the restock
 *     off public Actions (plan decisions 11 and 12).
 *   - Runs already recorded keep whatever they printed until they are deleted.
 *   - One count reaches the log: how many deposits a restock tick landed. The
 *     chain shows those deposits in the step's time window anyway. The UNSPENT
 *     stock is not said: no endpoint serves it (`GET /api/issue-note` serves
 *     the CONFIGURED size, spent or not), and two ticks' counts would give the
 *     number of issued notes spent in between (the restock case below). Whether
 *     a tick deposits at all is said too, and it is on the chain as well.
 *   - The restock wallet can be named without any log: unauthenticated
 *     `GET /api/settle-till` serves the float's public key, and the top-up is a
 *     plain transfer from it. That is topology (DECHAIN-1 / RESTOCK-1), not log
 *     hygiene, and nothing here claims otherwise.
 *   - This reads the SOURCES of the two workflows, not a real run. Closure
 *     counts on a run whose top-up and restock steps both executed.
 *   - Case 8 holds four things the repository can set, beside the code, that
 *     switched the restock's `--silent` back off when measured: the vitest
 *     config, a workspace file beside it, the env blocks, and apps/web/.npmrc.
 *     NOT read here: a pnpm patch or override of a dependency (root
 *     package.json `pnpm.patchedDependencies` / `pnpm.overrides`, both in use
 *     for other apps), and whatever the runner brings (its user-level npm
 *     config, its image's environment).
 *   - A dependency that prints ON ITS OWN. In the top-up step it cannot reach
 *     the log: the step sends its stdout and stderr to private files, pinned by
 *     case 8. In the Restock step, `--silent` drops its console output; a raw
 *     write to the process streams would still print, and none was found on
 *     that path.
 *   - Case 8 pins every non-comment line of both workflows by its exact text
 *     (`VETTED_WORKFLOW_LINES`). A comment or blank line is free, except where
 *     it would change what runs: inside a `\` continuation, which bash splits
 *     there, and anywhere the YAML or the shell would read it as more than a
 *     comment. "Blank" and "comment" are read as bash and YAML read them: an
 *     empty line, or `#` after spaces only. JS's `\s` also takes U+00A0 and
 *     the other Unicode spaces for a blank, where bash reads text, so those are
 *     refused outright (VN1-VN9). The rules below are a second, independent
 *     reading of that vetted text, and say why each line on the list is safe.
 *   - Case 8 reads the shell of the two workflows as a CLOSED SET, not a list
 *     of bad spellings: a command other than echo, printf or a quiet shell
 *     word runs only on a vetted line, whatever its own streams; a redirect
 *     points only at /dev/null, one file in $RUNNER_TEMP, or $GITHUB_OUTPUT;
 *     no variable is set outside a vetted line; a quiet word's arguments
 *     are read where they become public (an exit code, a duration, a branch,
 *     its own error message); no arithmetic, which reads a variable by its
 *     bare name. What the RUNNER prints is a closed set too: a GitHub
 *     expression sits in an env value and nowhere else, and every env value,
 *     action input and `if:` is pinned by its step and its exact text. It
 *     does not read what the vetted programs do
 *     inside: cases 7, 9 and 10 read and run the two that are this
 *     repository's, and `pnpm install` runs whatever the lockfile's packages
 *     run at install.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/ciLogHygiene.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import {
  CI_VERDICT_FILE_ENV,
  CI_WORDS,
  ciFail,
  ciRedactedError,
  ciSay,
  redactForCi,
} from '@/lib/privacy/ciLog';
import {
  DEFAULT_MIN_TOP_UP_LAMPORTS,
  formatTopUpLine,
  planTopUp,
  type TopUpInputs,
  type TopUpResult,
  type TopUpVerdict,
} from './restockTopUp';
import { DEFAULT_SETTLEMENT_CONFIG, floatRequiredForBatch } from './settlementPolicy';
import { DEFAULT_RESTOCK_CONFIG, restockWalletTargetLamports } from './restockConfig';

const HOUR = 3600;
const NOW = 1_800_000_000;
const FUNDER_FLOOR = floatRequiredForBatch(DEFAULT_SETTLEMENT_CONFIG.minPurchases);
const RESTOCK_FLOOR = DEFAULT_RESTOCK_CONFIG.floorLamports;
const RESTOCK_TARGET = restockWalletTargetLamports(DEFAULT_RESTOCK_CONFIG);

/**
 * A run long enough to BE a key: a base58 public key is 32-44 characters, a
 * signature 87-88, a sha256 64.
 *
 * Deliberately NOT ciLog's own threshold (20, which is stricter). Asserting an
 * implementation constant back at itself would be tautological; this states the
 * property that matters — nothing the size of a key survives — and lets the
 * implementation be as strict as it likes above it. It is why a 16-character
 * identifier like `prepareUnshieldV` is allowed to reach the log: an operator
 * still has to learn which step failed.
 *
 * Residual, stated: an all-letter run of 16-19 characters (a hex fragment with
 * no digits, say) is masked by ciLog but would not be caught here. What catches
 * that is the differential — any fragment that moves with the float key, the
 * restock key or the signature fails the case below.
 */
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/;

/** Deterministic, synthetic, and really base58 — no key here is a real one. */
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const sig = (n: number) => bs58.encode(new Uint8Array(64).fill(n));

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../../../${rel}`, import.meta.url));
const webFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

function source(abs: string): string {
  expect(existsSync(abs), `${abs} must exist for this test to mean anything`).toBe(true);
  return readFileSync(abs, 'utf8');
}

/**
 * A line with its trailing comment removed (`//`, `/*`, and `#` for YAML and
 * shell), quote-aware.
 *
 * ⚠️ NEVER USED TO DECIDE THAT A LINE IS INNOCENT IN TYPESCRIPT. There, an
 * offender is matched on the WHOLE line and this text only decides whether the
 * line is one of the vetted sinks, so a comment cannot hide a `console.log` and
 * a mis-cut can only turn a vetted line into an offender. Fail-closed, which is
 * the direction a privacy rule has to fail in. Quote-aware because
 * `restockInventory.test.ts` holds `'http://localhost:3000'` and settle-till
 * holds `"…this repository's secrets."`, and a blind cut would split both.
 */
function withoutComment(line: string, hash = false): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      // A shell or YAML single quote has no escapes.
      if (c === '\\' && !(hash && quote === "'")) i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    // ⚠️ In YAML and shell, `//` is not a comment and `#` is one only at the
    // start of a word: `echo https://x/$KEY` and `echo note#$KEY` print the
    // variable, and a cut there hid it (mutants S6 and S7,
    // `wp-logs/CI-1-fix4-mutants-before.log`).
    // A word starts after bash's blank (space, tab) or one of its operator
    // characters, `<` and `>` included. NOT after JS's `\s`, which also holds
    // U+00A0 and the other Unicode spaces: bash reads those as part of a word,
    // so `echo a # x` runs `# x` as text, and a cut there hid it (mutants
    // VN1-VN4; `web-run/logs2/verify-CI-1-r2-nbsp-bash.log`,
    // `web-run/logs2/CI-1-cr2-bash-probe.log`).
    else if (hash && c === '#' && (i === 0 || /[ \t;&|()<>]/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * `trim()` for the two workflows: spaces only. JS's `trim()` and `\s` also take
 * U+00A0, U+2009, U+3000 and the other Unicode spaces for a blank, which bash
 * and YAML read as text (VN1-VN4). A tab is refused outright (`HIDDEN_CHAR`).
 */
const spaceTrim = (s: string) => s.replace(/^ +| +$/g, '');

/** A YAML/shell file with every comment and blank line gone. */
const noComments = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => withoutComment(l, true))
    .filter((l) => spaceTrim(l) !== '')
    .join('\n');

/** Shell lines with their `\` continuations joined, so a command is one string. */
function joinContinuations(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = spaceTrim(raw);
    if (line === '') continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.endsWith('\\')) out[out.length - 1] = `${spaceTrim(prev.slice(0, -1))} ${line}`;
    else out.push(line);
  }
  return out;
}

/** Every `$VAR` and `${VAR}` a shell line names. `${{ … }}` is GitHub's, not the shell's. */
const shellVars = (line: string) => [...line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);

/**
 * The index of the `)` that closes the `(` at `open`, or -1 if nothing does.
 * Quotes are skipped, so a `)` inside `'…'`, `"…"` or a template literal does
 * not close anything. This is the difference between reading a call's arguments
 * and guessing at them — see `callsOf`.
 */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * The index of the `}` that closes the `{` at `open` in `bare` (see
 * `codeViews`), or -1 if nothing does. `bare` holds no comment, string,
 * template text or regex body, so every brace left in it is code, and a
 * template's `${ … }` is balanced there.
 */
function closingBrace(bare: string, open: number): number {
  let depth = 0;
  for (let i = open; i < bare.length; i += 1) {
    if (bare[i] === '{') depth += 1;
    else if (bare[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The top-level commas of an argument list, respecting nesting and quotes. */
function splitArgs(inside: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < inside.length; i += 1) {
    const c = inside[i];
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += inside[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter((a) => a !== '');
}

/**
 * Every call of `name(` in a TypeScript file, with its arguments, by BALANCING
 * the parentheses.
 *
 * ⚠️ NOT `/name\(([^)]*)\)/`. That regex stops at the FIRST `)`, so
 * `ciSay(String('restock landed'), done.leafIndex, wanted)` handed the rule one
 * argument and no counts at all: the leaf index was never read, the case stayed
 * green, and a leaf under 100 would have been printed to the public log. It was
 * measured, not imagined — mutant N1 of the round-2 verifier's harness, re-run
 * here as N1 in `wp-logs/CI-1-fix2-mutants.log`.
 *
 * `args: null` means the call never closes. That is an offender too: a rule
 * that cannot read a call must not conclude the call is innocent.
 */
function callsOf(text: string, name: string): { at: number; args: string[] | null }[] {
  const out: { at: number; args: string[] | null }[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const at = text.slice(0, m.index).split('\n').length;
    const close = closingParen(text, open);
    out.push({ at, args: close < 0 ? null : splitArgs(text.slice(open + 1, close)) });
  }
  return out;
}

/**
 * The first `want` arguments of the call whose `(` is at `open`, read WITHOUT
 * requiring the call to close.
 *
 * ⚠️ This exists because `closingParen` has to walk the whole call, and the
 * body of `describe(…)` is hundreds of lines of prose in which one apostrophe
 * ("the issuer's credentials") opens a quote that never shuts — measured: the
 * first draft of the name rule flagged `restockInventory.test.ts:132` as a call
 * that never closes, and every control went red with it. A test NAME and an
 * assertion MESSAGE are the first two arguments, always literals if they are
 * honest, so reading only those crosses no comment at all.
 */
function leadingArgs(text: string, open: number, want: number): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += text[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break; // the call closed
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      if (out.length >= want) return out;
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter((arg) => arg !== '');
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/**
 * Two views of a TypeScript file, each the SAME LENGTH as the file, so an index
 * in one is the same place in the other and in the file:
 *   code — comments blanked, strings kept: ARGUMENTS are read from here;
 *   bare — comments AND the insides of strings, template text and regex
 *          literals blanked: NAMES are looked for here, so neither prose nor a
 *          string can hold one — `// never const say = ciSay` is not an alias
 *          (control C3, `wp-logs/CI-1-fix3-mutants-after.log`).
 *
 * ⚠️ A mis-read here can HIDE code, which is the direction a privacy rule must
 * not fail in, so the read is a real lexer rather than a per-line cut: quotes,
 * `${ … }` nested in template literals, and regex literals (told from a
 * division by what precedes the `/`, the usual heuristic). Residual, stated: a
 * regex literal right after `)`, `]` or `}` is read as a division, so a `//`
 * inside one would blank the rest of its line. No scanned file has one.
 */
function codeViews(text: string): { code: string; bare: string } {
  const code = text.split('');
  const bare = text.split('');
  const blank = (view: string[], from: number, to: number) => {
    for (let k = from; k < to && k < view.length; k += 1) if (view[k] !== '\n' && view[k] !== '\r') view[k] = ' ';
  };
  const frames: ('code' | 'template')[] = ['code'];
  const braces: number[] = [0];
  let prev = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (frames[frames.length - 1] === 'template') {
      if (c === '\\') {
        blank(bare, i, i + 2);
        i += 2;
      } else if (c === '`') {
        frames.pop();
        prev = '`';
        i += 1;
      } else if (c === '$' && text[i + 1] === '{') {
        frames.push('code');
        braces.push(0);
        prev = '{';
        i += 2;
      } else {
        blank(bare, i, i + 1);
        i += 1;
      }
      continue;
    }
    const d = text[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      const end = d === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : d === '/' ? end : end + 2;
      blank(code, i, stop);
      blank(bare, i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blank(bare, i + 1, j);
      prev = c;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      frames.push('template');
      i += 1;
      continue;
    }
    const regexMayStart =
      prev === '' ||
      '(,=:[!&|?{};+-*%<>~^'.includes(prev) ||
      /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|throw)\s*$/.test(text.slice(Math.max(0, i - 16), i));
    if (c === '/' && regexMayStart) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      blank(bare, i + 1, j);
      prev = '/';
      i = j + 1;
      continue;
    }
    if (c === '{') braces[braces.length - 1] += 1;
    else if (c === '}') {
      if (braces[braces.length - 1] === 0 && frames.length > 1) {
        frames.pop();
        braces.pop();
        prev = '}';
        i += 1;
        continue;
      }
      braces[braces.length - 1] -= 1;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return { code: code.join(''), bare: bare.join('') };
}

/**
 * Every use of a vitest name in `bare`, with the modifier chain it goes
 * through and the index of the `(` whose arguments are the NAME (for `it`,
 * `test`, `describe`) or the VALUE and MESSAGE (for `expect`). `open: -1` means
 * the name is used without being called — an alias, which is an offender.
 *
 * ⚠️ NOT A REGEX FOR `expect(` AND `it(`. Those let a leaf through as
 * `expect.soft(x, \`leaf ${n}\`)` and as `it.skipIf(false)(\`… ${leaf}\`)`
 * (mutants R1 and R2 of the round-1(b) verifier): the chain is walked here,
 * modifier arguments included, so every spelling ends at the same `(`.
 */
function vitestUses(bare: string): { at: number; index: number; name: string; chain: string[]; open: number }[] {
  const out: { at: number; index: number; name: string; chain: string[]; open: number }[] = [];
  const skipSpace = (k: number) => {
    while (k < bare.length && /\s/.test(bare[k])) k += 1;
    return k;
  };
  for (const m of bare.matchAll(/(?<![\w$.])(describe|it|test|expect)(?![\w$])/g)) {
    const chain: string[] = [];
    let i = skipSpace((m.index ?? 0) + m[0].length);
    let open = bare[i] === '(' ? i : -1;
    while (open < 0 && bare[i] === '.') {
      i = skipSpace(i + 1);
      const word = /^[A-Za-z_$][\w$]*/.exec(bare.slice(i, i + 64));
      if (word === null) break;
      chain.push(word[0]);
      i = skipSpace(i + word[0].length);
      if (bare[i] !== '(') continue;
      const close = closingParen(bare, i);
      const after = close < 0 ? -1 : skipSpace(close + 1);
      // `.skipIf(cond)(name, …)`: the first parens are the modifier's.
      open = after >= 0 && bare[after] === '(' ? after : i;
    }
    out.push({ at: lineAt(bare, m.index ?? 0), index: m.index ?? 0, name: m[1], chain, open });
  }
  return out;
}

/** A plain quoted string with nothing interpolated into it. */
const PLAIN_STRING = /^'[^'\\]*'$/;

/**
 * The only shape the live restock's `it` may have: the work in a helper, and
 * whatever it throws rethrown REDACTED. Read from the comment-free source with
 * whitespace collapsed, so a comment cannot satisfy it and reformatting cannot
 * break it.
 *
 * ⚠️ Before this, nothing pinned the rethrow at all: `throw e;` in its place,
 * or the try/catch deleted with the import left behind, kept every case green
 * (mutants D1 and D2 of the round-1(b) verifier) while vitest printed the raw
 * library message — measured there as `failed on leaf 211 of <base58>` against
 * `failed on leaf [x] of [x]` redacted (`verify/CI-1-r1b-throw-probe*.log`).
 */
const REDACTING_CASE =
  /^'[^'\\]*' ?, ?(?:\{ ?timeout: ?[\d_]+ ?\} ?, ?)?async \( ?\) ?=> ?\{ ?try ?\{ ?await [A-Za-z_$][\w$]* ?\( ?\) ?;? ?\} ?catch ?\( ?([A-Za-z_$][\w$]*) ?\) ?\{ ?throw ciRedactedError ?\( ?\1 ?\) ?;? ?\} ?\}$/;

/**
 * The only way the top-up script may end: every rejection of `main` goes
 * through `fail`, whose one sink is the redacted `::error::` line. A bare
 * `main();` prints an unhandled rejection raw, and a catch that rethrows prints
 * it too (mutants D3 and D4 of the round-1(b) verifier).
 */
const SCRIPT_EXIT = 'main().catch((e: unknown) => fail(`top-up failed: ${(e as Error).message}`));';

/**
 * What builds or decorates a failure message, read in `bare` (case 7): a
 * `throw`, an Error class called or constructed (any name ending in `Error`
 * but `ciRedactedError`, the vetted rethrow), `Promise.reject`, a promise
 * handler (`.catch`, `.then`), and a Promise executor written other than
 * `(resolve) =>`: a second parameter is a reject callback, and another form
 * is not read.
 */
const ERROR_BUILDERS =
  /(?<![\w$.])throw(?![\w$])|(?<![\w$.])(?!ciRedactedError(?![\w$]))[A-Za-z_$][\w$]*Error\s*\(|(?<![\w$.])Promise\s*\.\s*reject(?![\w$])|\.\s*(?:catch|then)\s*\(|(?<![\w$.])new\s+Promise\s*\((?!\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*=>)/g;

/**
 * The only lines of the scanned files that may build or decorate a failure,
 * WHOLE and exact. The top-up leaves through its vetted exit line; the restock
 * rethrows redacted; restockTopUp.ts refuses a transfer the fee would eat, in
 * a message of two amounts that redactForCi masks (case 6 reads digits).
 */
const VETTED_ERROR_LINES: Record<string, readonly string[]> = {
  'lib/privacy/pool/restockInventory.test.ts': ['      throw ciRedactedError(e);'],
  'scripts/topUpRestockWallet.mts': [SCRIPT_EXIT],
  'lib/privacy/pool/restockTopUp.ts': [
    '    throw new Error(`the top-up (${plan.amountLamports} lamports) is smaller than the network fee (${fee})`);',
  ],
};

/** The ciLog functions, which may be reached by their named import and a direct call only. */
const CI_LOG_NAMES = new Set(['ciSay', 'ciFail', 'ciRedactedError', 'redactForCi']);
/** The vitest names the scanned files may import. `vi`, hooks and `assert` are not among them. */
const VITEST_NAMES = new Set(['describe', 'it', 'test', 'expect']);
/** Modifiers a case or suite may go through. `each` and `for` put values INTO the name. */
const CASE_MODIFIERS = new Set(['skip', 'skipIf', 'runIf', 'only', 'concurrent', 'sequential', 'todo']);

/**
 * Every command line a workflow really runs: the body of each `run:` block and
 * each one-line `run:`, comments stripped, `\` continuations joined, with the
 * number of the line it starts on.
 *
 * Reading the `run:` blocks rather than the whole file is what lets the rule
 * below treat every command as public by default — a `name:` or an `env:` key
 * prints nothing, and folding them into the same scan would have forced the
 * rule back towards guessing which lines matter.
 */
function shellLines(text: string): { at: number; line: string }[] {
  const out: { at: number; line: string }[] = [];
  for (const { at, physical } of runBodyLines(text)) {
    const code = spaceTrim(withoutComment(physical, true));
    if (code === '') continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.line.endsWith('\\')) {
      prev.line = `${spaceTrim(prev.line.slice(0, -1))} ${code}`;
      continue;
    }
    out.push({ at, line: code });
  }
  return out;
}

/**
 * The physical lines of every `run:` body, comments INCLUDED, with their line
 * numbers. `shellLines` reads commands from these; the `${{` rule reads them
 * whole, because the runner evaluates an expression into the script file before
 * the shell decides what is a comment.
 *
 * ⚠️ `run: | # note` is still a block: YAML allows a comment after the block
 * indicator, and reading it as a one-line command hid the whole body (mutant
 * S8, `wp-logs/CI-1-fix4-mutants-before.log`).
 */
function runBodyLines(text: string): { at: number; physical: string }[] {
  const out: { at: number; physical: string }[] = [];
  const raw = text.split(/\r?\n/);
  let blockCol = -1;
  for (let i = 0; i < raw.length; i += 1) {
    const physical = raw[i];
    if (blockCol >= 0) {
      if (spaceTrim(physical) === '') continue;
      // YAML's indentation is spaces only (VN1-VN4: `spaceTrim`).
      if (physical.search(/[^ ]/) > blockCol) {
        out.push({ at: i + 1, physical });
        continue;
      }
      blockCol = -1;
    }
    const m = /^ *(?:- +)?run: *(.*)$/.exec(physical);
    if (m === null) continue;
    const rest = spaceTrim(m[1]);
    if (/^(?:[|>](?:[-+]?\d*|\d+[-+]))?$/.test(spaceTrim(withoutComment(rest, true)))) blockCol = physical.indexOf('run:');
    else out.push({ at: i + 1, physical: rest });
  }
  return out;
}

/**
 * A destination a reader of the public run cannot open: nowhere, or ONE file
 * directly in the job's own temp directory.
 *
 * ⚠️ NOT "ANYTHING UNDER $RUNNER_TEMP, $HOME OR $GITHUB_WORKSPACE", which is what
 * this was until web run round 3. The runner keeps the files it PRINTS or LOADS
 * in `<work>/_temp/_runner_file_commands/` (the step summary, set_env,
 * set_output, add_path), and `<work>/_temp` IS $RUNNER_TEMP
 * (`web-run/logs/CI-1-wr3-runner-paths.log`, GitHub's own example values). So
 * `echo … >> $RUNNER_TEMP/_runner_file_commands/step_summary_*` wrote to the
 * public summary, and `… >> $GITHUB_WORKSPACE/../../_temp/<glob>/set_env_<glob>` set an
 * env for every later step, each through a destination called private here
 * (mutants K16, K17; bash: `CI-1-wr3-bash-probe.log` P7,
 * `CI-1-wr3-bash-probe2.log` P12). One name, no `/`, starting with a letter or
 * a digit: no `..`, no subdirectory, no glob. The verdict file sits there too,
 * and case 8 refuses it by name.
 */
const PRIVATE_DEST = /^(?:\/dev\/null|\$RUNNER_TEMP\/[A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** The one other destination a redirect may name: a step output, whose text is read like stdout. */
const READ_DEST = /^\$GITHUB_OUTPUT$/;

/**
 * Every OUTPUT redirection of one segment, read the way bash reads it: outside
 * quotes and outside `( … )`, glued to its word or not, with its stream
 * number, and with the quotes of its target removed.
 *
 * ⚠️ Until web run round 3 this was a regex that wanted a space before `>` and
 * knew streams 1 and 2 only. `echo 'node-options=…'>/home/runner/.npmrc`
 * (glued) and `echo 'node-options=…' 3>/home/runner/.npmrc >/dev/fd/3` (a
 * third stream, one segment) each wrote a user npmrc that the next `npx`
 * loads, and each read as an echo of harmless words to the public log
 * (mutants K14, K15; bash: `CI-1-wr3-bash-probe.log` P2,
 * `CI-1-wr3-bash-probe2.log` P11).
 *
 * Null for a form this rule does not follow: `>&`, `>|`, `<>`, or a `>` with
 * no target. (`segments` already splits `>&` and `&>` at the `&`.)
 */
function outputRedirects(segment: string): { fd: number; to: string }[] | null {
  const out: { fd: number; to: string }[] = [];
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (quote) {
      if (c === '\\' && quote !== "'") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) {
      if (segment[i - 1] === '<') return null;
      // A stream number counts only when it starts its word: `x2>f` is `x2`, then `>f`.
      let from = i;
      while (from > 0 && /\d/.test(segment[from - 1])) from -= 1;
      const fd = from < i && (from === 0 || /\s/.test(segment[from - 1])) ? Number(segment.slice(from, i)) : 1;
      let k = i + 1;
      if (segment[k] === '>') k += 1;
      if (segment[k] === '&' || segment[k] === '|') return null;
      while (k < segment.length && /\s/.test(segment[k])) k += 1;
      let to = '';
      let q: string | null = null;
      for (; k < segment.length; k += 1) {
        const d = segment[k];
        if (q) {
          if (d === q) q = null;
          else to += d;
          continue;
        }
        if (d === "'" || d === '"') q = d;
        else if (/[\s;&|<>()]/.test(d)) break;
        else to += d;
      }
      if (to === '') return null;
      out.push({ fd, to });
      i = k - 1;
    }
  }
  return out;
}

/** Every place one segment sends a file descriptor: 1 is stdout, 2 is stderr. */
function redirectsOf(segment: string, fd: 1 | 2): string[] {
  return (outputRedirects(segment) ?? []).filter((r) => r.fd === fd).map((r) => r.to);
}

const allPrivate = (to: string[]) => to.length > 0 && to.every((t) => PRIVATE_DEST.test(t));

/** The top-level `$( … )` bodies of a segment, or null when one never closes. */
function substitutionsOf(segment: string): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i] !== '$' || segment[i + 1] !== '(') continue;
    const close = closingParen(segment, i + 1);
    if (close < 0) return null;
    out.push(segment.slice(i + 2, close));
    i = close;
  }
  return out;
}

/** The top-level `;`, `|`, `&&`, `||` of a shell line, respecting quotes and `$( )`. */
function segments(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += line[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || c === '|' || c === '&')) {
      out.push(cur);
      cur = '';
      if (line[i + 1] === c) i += 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** Words that precede a command without being one. `if curl …` runs curl. */
const CONTROL_WORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'done', 'fi', 'esac', 'time', 'exec', '!', '{', '}']);

/**
 * Emits nothing of its own — true only while the shell is not tracing, and
 * only for the argument shapes `quietButPrints` does not refuse.
 *
 * ⚠️ NOT `trap`. Its argument is a shell line that runs later, so
 * `trap 'cat "$RUNNER_TEMP/treasury.json"' EXIT` printed the treasury key
 * through a head this set called quiet (mutant R5 of the round-1(b) verifier,
 * `wp-logs/CI-1-fix3-mutants-after.log`). A head whose argument can run a
 * command does not belong here; `eval`, `source` and `.` were never in it.
 *
 * ⚠️ NOT `cd`, `export` OR `local` since web run round 3. Each emits nothing, and
 * each changes what a VETTED line does: `export "P01_CI_VERDICT""_FILE=…"`
 * re-points the vetted `cat "$P01_CI_VERDICT_FILE"` at the top-up's private
 * stderr, and `cd lib` makes the vetted top-up line run another file (mutants
 * K7, K7b, K10; bash: `CI-1-wr3-bash-probe.log` P4, P9). Neither workflow uses
 * them, so each is now a command that has to be vetted by line.
 */
const QUIET_HEADS = new Set([
  'set', 'exit', 'return', 'shift', 'sleep', 'mkdir', 'rm', 'shred', 'true', 'false', ':',
  '[', 'test', 'break', 'continue', 'unset', 'wait',
]);

/**
 * Quiet heads whose ARGUMENT still becomes public: the runner prints a failed
 * step's exit code, and the run page shows each step's duration. A literal
 * number only (mutants K20, K21).
 */
const VALUE_HEADS = new Set(['exit', 'return', 'sleep']);

/**
 * Quiet heads that choose a branch: which line or exit code follows is
 * public, so they may test only the variables the file may print, unless the
 * line is vetted (mutant K22).
 *
 * ⚠️ NOT `[[`, `for` OR `case` SINCE WEB RUN ROUND 3 (SECOND PASS). Bash reads a
 * variable by its BARE name wherever it evaluates arithmetic, and this rule
 * reads `$NAME` only: `if [[ P01_TREASURY_NOTE_LEAVES -gt 150 ]]` put one bit
 * of the authorised leaves on the log, and `for (( i=0; i<NAME; i++ ))` one
 * line per unit of its value (the web run round-3 verifier's Z1, Z2; bash:
 * `web-run/logs/verify-CI-1-r2b-bash-probe.log`). `[[` also prints a
 * non-numeric value whole in its own error (`CI-1-wr3b-bash-probe.log` P5).
 * Neither workflow uses the three, so each is now a command that has to be
 * vetted by line, and `ARITHMETIC` below refuses the forms wherever they sit.
 */
const BRANCH_HEADS = new Set(['[', 'test']);

/**
 * The shell's arithmetic: `(( ))`, `$(( ))`, `for ((` and `[[ ]]` evaluate a
 * bare name. (`let` is not a quiet head, so it is refused as a command, and
 * `$[` with the other expansions.) Matched on the raw segment, quotes
 * included: `$((` still expands inside `"…"`, and a literal `((` in prose
 * costs only a false alarm.
 */
const ARITHMETIC = /\(\(|\[\[/;

/**
 * What `[` and `test` may be given, word by word: an operator from this set, a
 * literal number, a quoted literal that expands nothing, or `"$NAME"` of a
 * printable variable. A closed set, because a bare word is where `test` reads
 * a variable by NAME: `test -v 'a[NAME > 150 ? 1/0 : 1]'` printed an error
 * only when the branch was taken, with no `$` anywhere
 * (`CI-1-wr3b-bash-probe.log` P14, P15), and `-v 'a[KEY]'` printed a
 * non-numeric value whole (P2).
 */
const TEST_OPERATORS = new Set(['-z', '-n', '-s', '-f', '-e', '-d', '=', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '!', ']']);

/** A segment's words, split on unquoted whitespace, quotes kept. */
function shellWords(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') {
        cur += segment[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      cur += c + (segment[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    if (/\s/.test(c)) {
      if (cur !== '') out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** The words `[` or `test` is given that are not in their closed set (see `TEST_OPERATORS`). */
function testOperandOffences(head: string, segment: string, mayName: ReadonlySet<string>): string[] {
  const words = shellWords(segment);
  const out: string[] = [];
  for (const word of words.slice(words.indexOf(head) + 1)) {
    if (TEST_OPERATORS.has(word) || /^\d+$/.test(word)) continue;
    if (/^'[^']*'$/.test(word) || /^"[^"$`\\]*"$/.test(word)) continue;
    const ref = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/.exec(word);
    if (ref !== null && mayName.has(ref[1])) continue;
    out.push(`gives ${head} the word ${word}, which is not a printable variable, a literal or a vetted operator: a bare name or an unknown operator can make the shell evaluate a variable`);
  }
  return out;
}

/** Quiet heads that never print, not even an error about their arguments. */
const SILENT_HEADS = new Set([':', 'true', 'false']);

/**
 * What any OTHER quiet head may name while its stderr is public: `rm`,
 * `mkdir`, `shift` and the rest name their argument in their own error
 * (mutant K26; bash: `CI-1-wr3-bash-probe3.log` P16-P18). Besides the file's
 * printable variables, the job's temp directory: the same path on every hosted
 * runner.
 */
const QUIET_MAY_NAME = new Set(['RUNNER_TEMP']);

/**
 * The files the public record prints, and the top-up's private output. A
 * segment outside a vetted line may not NAME one, whatever its head and its
 * streams: a belt over the rule below. The top-up's private files are
 * `$RUNNER_TEMP/topup.out` and `topup.err`.
 */
const PRINTED_FILE = /GITHUB_STEP_SUMMARY|P01_CI_VERDICT_FILE|ci-verdicts|_runner_file_commands|topup\./;

/**
 * The argument shapes that make a quiet head print: `set`, `export` or `local`
 * with no argument or `-p` list every variable, secrets included (mutant X9);
 * `-v` makes rm/mkdir/shred name what they touched; `cd -` prints a path.
 */
function quietButPrints(head: string, segment: string): boolean {
  const words = segment.split(/\s+/).filter(Boolean);
  const args = words.slice(words.indexOf(head) + 1);
  if (['set', 'export', 'local'].includes(head) && (args.length === 0 || args.includes('-p'))) return true;
  if (head === 'set' && args.some((a) => /^[-+][a-z]*v/.test(a) || a === 'verbose')) return true;
  // Tracing, in any cluster and any segment: `x=1;set -x` has no space before
  // `set`, which the line rule below needed (mutant S2).
  if (head === 'set' && args.some((a) => /^-[a-zA-Z]*x/.test(a) || a === 'xtrace')) return true;
  if (['rm', 'mkdir', 'shred'].includes(head) && args.some((a) => /^-[a-zA-Z]*v/.test(a) || a === '--verbose')) return true;
  return head === 'cd' && args[0] === '-';
}

/** Emits its own arguments, so the arguments are what gets read. */
const SPEAKING_HEADS = new Set(['echo', 'printf']);

/** The command a segment actually runs, past its control words and env prefixes. */
function headOf(segment: string): string {
  for (const word of segment.split(/\s+/).filter(Boolean)) {
    if (CONTROL_WORDS.has(word)) continue;
    // `FOO=bar cmd` runs cmd; `FOO=$(cmd)` runs cmd too, and is not a prefix.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !word.includes('$(') && !word.includes('`')) continue;
    return word;
  }
  return '';
}

/**
 * WHERE A COMMAND'S OUTPUT GOES — ASKED THE WAY ROUND THAT FAILS CLOSED, AND
 * ASKED OF EVERY SEGMENT AND BOTH STREAMS.
 *
 * ⚠️ The round-1 rule asked whether a line STARTED WITH `echo`, `printf`,
 * `cat`, `tee`… — a blocklist of verbs, and the verb is the first thing an
 * evasion changes (mutants N3 and N4, `wp-logs/CI-1-fix2-mutants.log`). So
 * inside a `run:` EVERY command is public unless its output is kept private,
 * and a public command must be one of:
 *   QUIET   — a shell word that emits nothing of its own (`if`, `[`, `exit`);
 *   SPEAKS  — `echo` / `printf`, whose output IS its arguments, which are read;
 *   VETTED  — a whole line, or a whole segment, this test names with a reason.
 * Any other binary, in any spelling, is an offender.
 *
 * ⚠️ PER SEGMENT, NOT PER LINE. The round-2 rule decided privacy for the whole
 * line, so `npx tsx dump.mts >> "$RUNNER_TEMP/x"; cat "$RUNNER_TEMP/x"` — a
 * private redirect beside a public `cat` — was waved through (mutant R3).
 *
 * ⚠️ STDOUT IS NOT THE ONLY STREAM. The runner puts STDERR in the same public
 * log, so `x=$(cmd)` or `cmd > "$RUNNER_TEMP/f"` keeps only half of what cmd
 * says: a script that writes a key with `console.error` inside a capture
 * printed it (mutant X8), and so did one inside `[ -n "$(…)" ]` (X10). A
 * command substitution is read wherever it sits.
 *
 * ⚠️ AND A COMMAND'S STREAMS ARE NOT THE ONLY WAY IT PUBLISHES. Until web run
 * round 3, a command whose stdout AND stderr both went to private files was
 * called innocent. But a command writes files BY ARGUMENT, and two files here
 * are public: the step summary, and the verdict file "Say what happened"
 * prints. `cp "$RUNNER_TEMP/topup.err" "$GITHUB_STEP_SUMMARY" > /dev/null
 * 2> /dev/null` published the top-up's private stderr, where web3.js prints
 * the transfer signature; so did `tee -a` into the verdict file, and `node -e`
 * appending to the summary. A new step running an unread script with both
 * streams private passed too, and a capture `x=$(cp … 2> /dev/null)` was the
 * same exemption spelled another way (the web run round-2 verifier's K1-K4,
 * `web-run/logs/verify-CI-1-r2-mutants-after*.log`; K5, K6). So a command
 * other than QUIET or SPEAKS is an offender WHEREVER ITS STREAMS GO, unless
 * its line is vetted. Redirects still decide one thing: whether an echo's or a
 * printf's arguments reach the log.
 *
 * ⚠️ QUIET IS ONLY TRUE WHILE THE SHELL IS NOT TRACING. `set -x` prints every
 * command with its values expanded, which is why the case below refuses it
 * (mutant N5).
 */
function segmentOffences(
  segment: string,
  mayName: ReadonlySet<string>,
  vetted: [RegExp, string][],
  captured: boolean,
): string[] {
  if (vetted.some(([re]) => re.test(segment))) return [];
  if (/`|[<>]\(/.test(segment)) {
    return ['runs a backtick or process substitution, which nothing reads'];
  }
  const subs = substitutionsOf(segment);
  if (subs === null) return ['has a $( that never closes, so what it runs cannot be read'];
  const out: string[] = [];
  // Arithmetic reads a variable by its bare name, which no `$NAME` rule sees
  // (Z1, Z2; `ARITHMETIC` above).
  if (ARITHMETIC.test(segment)) {
    out.push('evaluates arithmetic or a [[ ]] test, which reads a variable by its bare name, with no $ for this rule to see');
  }
  // The belt (K1-K3, K5, K8, K16, K19): a printed file, or the top-up's
  // private output, named outside a vetted line.
  if (PRINTED_FILE.test(segment)) {
    out.push("names a file the public record prints, or the top-up's private output, outside a vetted line");
  }
  // The SHELL prints some expansions itself, before any redirect applies:
  // `${X:?msg}` printed msg on an echo whose streams were both private, and
  // `$[NAME]` reads a variable with no `$NAME` in the text (K23-K25; bash:
  // `CI-1-wr3-bash-probe3.log` P13-P15). Only `$NAME`, `${NAME}` and a default
  // `${NAME:-word}` whose word expands nothing are read here.
  for (const m of segment.matchAll(/\$(\{[^}]*\}?|\[)/g)) {
    if (!/^\{[A-Za-z_][A-Za-z0-9_]*(?::?-[^${}]*)?\}$/.test(m[1])) {
      out.push(`expands ${m[0]}, a form this rule does not read: the shell can print it on its own`);
    }
  }
  for (const body of subs) {
    for (const inner of segments(body)) out.push(...segmentOffences(inner, mayName, vetted, true));
  }
  // A redirect is a WRITE, so where it points is read, in every stream (K14-K17).
  const redirects = outputRedirects(segment);
  if (redirects === null) out.push('redirects in a form this rule does not follow (`>&`, `>|`, `<>`, or a `>` with no target)');
  for (const { fd, to } of redirects ?? []) {
    if (fd !== 1 && fd !== 2) out.push(`opens stream ${fd}, which this rule does not follow`);
    else if (!PRIVATE_DEST.test(to) && !READ_DEST.test(to)) {
      out.push(`writes ${to}, which is neither private nor read here as public text: a file can be loaded or printed later`);
    }
  }
  // A variable set outside a vetted line can change what a vetted line prints
  // (P01_CI_VERDICT_FILE for the vetted cat) or runs (K7, K8). Neither
  // workflow sets one outside its vetted lines.
  const words = segment.split(/\s+/).filter(Boolean);
  const leadWord = words.find((w) => !CONTROL_WORDS.has(w));
  if (leadWord !== undefined && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(leadWord)) {
    out.push(`sets ${leadWord.split(/\+?=/)[0]} outside a vetted line, which can change what a vetted line prints or runs`);
  }
  // `x=$( … )` as the whole segment: its own stdout is the variable.
  if (/^[A-Za-z_][A-Za-z0-9_]*=\$\(/.test(segment) && closingParen(segment, segment.indexOf('(')) === segment.length - 1) {
    return out;
  }

  const head = headOf(segment);
  if (head === '') return out;
  const args = words.slice(words.indexOf(head) + 1);
  if (QUIET_HEADS.has(head)) {
    if (quietButPrints(head, segment)) out.push(`runs ${head} in a shape that prints`);
    if (VALUE_HEADS.has(head) && !args.every((a) => /^\d+$/.test(a))) {
      out.push(`runs ${head} on something other than a literal number: the exit code and the step's duration are public`);
    }
    if (BRANCH_HEADS.has(head)) {
      for (const v of shellVars(segment)) {
        if (!mayName.has(v)) out.push(`branches on $${v}, which nothing vetted: which line or exit code follows is public`);
      }
      out.push(...testOperandOffences(head, segment, mayName));
    } else if (!SILENT_HEADS.has(head) && !allPrivate(redirectsOf(segment, 2))) {
      for (const v of shellVars(segment)) {
        if (!mayName.has(v) && !QUIET_MAY_NAME.has(v)) {
          out.push(`runs ${head} on $${v}, which it names in its own error message, on the public stderr`);
        }
      }
    }
    return out;
  }
  const stdoutPrivate = captured || allPrivate(redirectsOf(segment, 1));
  if (SPEAKING_HEADS.has(head)) {
    if (head === 'printf' && args.includes('-v')) {
      out.push('runs printf -v, which sets a variable this rule does not follow');
      return out;
    }
    // printf names an argument it cannot convert, ON STDERR: `printf '%d' x`
    // with its stdout private printed x (K18; bash: `CI-1-wr3-bash-probe.log`
    // P1). echo never does, and neither does a format of exactly `%s`.
    const neverFails = head === 'echo' || /^(['"])%s\1$/.test(args.find((a) => a !== '--') ?? '');
    if (stdoutPrivate && (neverFails || allPrivate(redirectsOf(segment, 2)))) return out;
    for (const v of shellVars(segment)) {
      if (!mayName.has(v)) out.push(`prints $${v}, which nothing vetted`);
    }
    if (subs.length > 0) out.push('prints the output of a command substitution, which nothing vetted');
    // A count is at most two digits (ciLog caps it at 99+). Three is a leaf, a
    // balance, a slot or a timestamp, even spelled as a literal.
    if (/\d{3,}/.test(segment)) out.push('prints a number of three digits or more');
    return out;
  }
  out.push(`runs ${head}, which nothing vetted: whatever its own streams, a command can write a file the public record prints`);
  return out;
}

/**
 * What this public shell line puts on the record that nothing vetted.
 *
 * `mayName` is the closed set of variables the file may print; `vetted` is the
 * closed set of whole lines (or segments) allowed to run a real command in
 * public, each with the reason it is allowed.
 */
function publicOffences(
  at: string,
  line: string,
  mayName: ReadonlySet<string>,
  vetted: [RegExp, string][],
): string[] {
  if (vetted.some(([re]) => re.test(line))) return [];
  return segments(line)
    .flatMap((segment) => segmentOffences(segment, mayName, vetted, false))
    .map((why) => `${at} ${why}: ${line}`);
}

/** A vetted line spelled out exactly, as a regex anchored at both ends. */
const exactly = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/**
 * The actions these two workflows may run.
 *
 * An action is code this repository does not read, and its stdout is this same
 * public log — `actions/github-script` with a `console.log` is one line of
 * YAML. A closed set, so a new one has to be looked at.
 */
const VETTED_USES = new Set(['actions/checkout@v4', 'pnpm/action-setup@v2', 'actions/setup-node@v4']);

// ── what the Restock step's vitest LOADS, beside its command line ───────────
//
// ⚠️ `--silent` IS ONLY AS GOOD AS WHAT ELSE THE PROCESS LOADS. Measured on
// vitest 3.2.4 with the step's exact flags, each of these put the pool
// library's leaf-gap warning back on the public log with the command line
// untouched:
//   - `disableConsoleIntercept: true` in the config the command names
//     (`wp-logs/verify/CI-1-r3d-config-probe.log`, the round-3 verifier's
//     major). `--disableConsoleIntercept=false` on the command takes that one
//     back, and only that one;
//   - a `setupFiles` in that config (`web-run/logs/CI-1-wr1-probe.log` P1d);
//   - a `vitest.workspace.*` beside it, which vitest loads on its own
//     (`CI-1-wr1-probe2.log` Q1);
//   - a `NODE_OPTIONS=--require …` preload (`CI-1-wr1-probe2.log` Q3), and
//     npm's `node-options`, which `npx` honours from the env or from
//     apps/web/.npmrc (`CI-1-wr1-probe3.log`).
// No flag takes the last four back, so what is loaded is pinned instead: the
// config's keys, the directory beside it, every env block, and the npm config.

/**
 * Every environment variable each workflow may set, BY NAME, in any `env:`
 * block — workflow, job or step. A closed set, like `VETTED_USES`: a variable
 * a process reads at start (`NODE_OPTIONS`, `npm_config_node_options`,
 * `CURL_HOME`, `PYTHONSTARTUP`…) is looked at before it can change what runs.
 */
const VETTED_ENV: Record<string, ReadonlySet<string>> = {
  'settle-till.yml': new Set(['SECRET', 'ENDPOINT']),
  'restock-inventory.yml': new Set([
    'P01_FUNDER_SECRET_KEY',
    'P01_TREASURY_KEYPAIR_JSON',
    'P01_LIVE_RPC',
    'P01_TREASURY_TARGET',
    'P01_TREASURY_LOW_WATER',
    'P01_TREASURY_MAX_PER_RUN',
    'P01_SETTLE_MIN_PURCHASES',
    'P01_SETTLE_MIN_QUIET_SECONDS',
    'P01_CI_VERDICT_FILE',
    'P01_BASE',
    'TREASURY_KEYPAIR_JSON',
    'STOCK',
    'P01_RESTOCK',
    'P01_LIVE_KEYPAIR',
    'P01_TREASURY_NOTE_LEAVES',
    'NODE_OPTIONS',
  ]),
};

/** The one variable whose VALUE is pinned too: a heap size, and no preload. */
const VETTED_NODE_OPTIONS = '--max-old-space-size=8192';

/**
 * Every `env:` entry in a workflow that nothing vetted. Read on comment-free
 * lines, block form only: `env: { … }` or `env: ${{ … }}` is a form this reader
 * cannot see into, so it is an offender rather than a pass (mutant W15).
 */
function envOffences(name: string, text: string, vetted: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/).map((raw) => withoutComment(raw, true));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*(?:-\s+)?env\s*:\s*$/.test(line)) {
      if (/(?:^|[\s{,'"])env['"]?\s*:/.test(line)) out.push(`${name}:${i + 1} writes env: in a form this test does not read: ${line.trim()}`);
      continue;
    }
    const col = line.indexOf('env');
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j];
      if (inner.trim() === '') continue;
      if (inner.search(/\S/) <= col) break;
      const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(inner);
      if (kv === null) {
        out.push(`${name}:${j + 1} an env entry this test cannot read: ${inner.trim()}`);
      } else if (!vetted.has(kv[1])) {
        out.push(`${name}:${j + 1} sets ${kv[1]}, which is not a vetted variable for this workflow`);
      } else if (kv[1] === 'NODE_OPTIONS' && kv[2].trim() !== VETTED_NODE_OPTIONS) {
        out.push(`${name}:${j + 1} sets NODE_OPTIONS to something other than ${VETTED_NODE_OPTIONS}: a preload runs before vitest silences anything`);
      }
    }
  }
  return out;
}

// ── what the RUNNER prints, beside what the shell prints ────────────────────
//
// ⚠️ A GITHUB EXPRESSION IS PUBLIC WHEREVER IT SITS, AND GITHUB MASKS ONLY THE
// EXACT SECRET. The runner prints each `run:` step's env block with its values
// expanded, a step's name is its public title, and an action's `with:` inputs
// are printed and used. `fromJSON(secrets.X)[0]` or `startsWith(secrets.X,
// 'a')` is not the secret string, so it prints in clear: in a step name, in
// `with: node-version:`, in `STOCK:` (which the keypair step's own warning
// echoes too), and in `ENDPOINT:`'s host, which curl names in its own error
// (the web run round-3 verifier's Z3, E1, E3, E4; curl:
// `web-run/logs/verify-CI-1-r2b-bash-probe.log`). The run-body rule saw none of
// them, and the env rule read names only. So: an expression may sit in an env
// VALUE and nowhere else, and every env value, every `with:` input and every
// `if:` of both workflows is pinned by its step, its key and its exact text.
// `if:` is an expression without `${{`, and which steps run is public. Each
// pin has its own mutant (E5-E7, E10), and every one is RED only since this
// block (`web-run/logs/CI-1-wr3b-mutants-before.log` / `-after.log`).

/**
 * The step a workflow line belongs to, named by the line that opens it
 * (`name: Restock`, `uses: actions/setup-node@v4`), or `(no step)` for a job-
 * or workflow-level key. `lines` are comment-free.
 */
function stepOf(lines: string[], i: number): string {
  const col = lines[i].search(/\S/);
  for (let j = i - 1; j >= 0; j -= 1) {
    const m = /^(\s*)-\s+(\S.*)$/.exec(lines[j]);
    if (m !== null && m[1].length < col) return m[2].trim();
    if (/^\S/.test(lines[j])) break;
  }
  return '(no step)';
}

interface Pinned {
  at: number;
  step: string;
  key: string;
  value: string;
}

/**
 * Every `key: value` of every block-form `env:` or `with:` in a workflow, and
 * every `if:`, each with its step. A block this reader cannot see into (flow
 * form, an alias, a block scalar) is an offender rather than a pass.
 */
function workflowPins(name: string, text: string): { env: Pinned[]; with: Pinned[]; if: Pinned[]; offences: string[] } {
  const lines = text.split(/\r?\n/).map((raw) => withoutComment(raw, true));
  const found = { env: [] as Pinned[], with: [] as Pinned[], if: [] as Pinned[], offences: [] as string[] };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const cond = /^\s*(?:-\s+)?if\s*:\s*(.*)$/.exec(line);
    if (cond !== null) found.if.push({ at: i + 1, step: stepOf(lines, i), key: 'if', value: cond[1].trim() });
    const block = /^\s*(?:-\s+)?(env|with)\s*:\s*(.*)$/.exec(line);
    if (block === null) continue;
    const kind = block[1] as 'env' | 'with';
    if (block[2].trim() !== '') {
      found.offences.push(`${name}:${i + 1} writes ${kind}: in a form this test does not read: ${line.trim()}`);
      continue;
    }
    const col = line.indexOf(kind);
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j];
      if (inner.trim() === '') continue;
      if (inner.search(/\S/) <= col) break;
      const kv = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(inner);
      if (kv === null) found.offences.push(`${name}:${j + 1} a ${kind} entry this test cannot read: ${inner.trim()}`);
      else found[kind].push({ at: j + 1, step: stepOf(lines, i), key: kv[1], value: kv[2].trim() });
    }
  }
  return found;
}

/** What `found` holds that `vetted` does not, and what `vetted` holds that `found` lost: an exact multiset. */
function pinOffences(name: string, what: string, found: Pinned[], vetted: readonly (readonly [string, string, string])[]): string[] {
  const left = vetted.map(([step, key, value]) => `${step} | ${key}: ${value}`);
  const out: string[] = [];
  for (const f of found) {
    const k = left.indexOf(`${f.step} | ${f.key}: ${f.value}`);
    if (k >= 0) left.splice(k, 1);
    else out.push(`${name}:${f.at} ${what} "${f.key}" of "${f.step}" is not a vetted one: ${f.key}: ${f.value}`);
  }
  for (const id of left) out.push(`${name}: the vetted ${what} is gone or moved: ${id}`);
  return out;
}

/**
 * The YAML this file's readers understand, as a closed set: outside a `run:`
 * block, every line is `key:` or `key: value` (optionally after `- `), with a
 * PLAIN key, and a value that opens no other YAML form.
 *
 * ⚠️ Every reader here matches keys as they are usually written, and YAML has
 * other spellings of the same document: `- "run": cut -c2- "$RUNNER_TEMP/treasury.json"`
 * is a run step no reader saw, `- { uses: actions/github-script@v7, with: { … } }`
 * an action the `uses:` allowlist never read, and a double-quoted
 * `"…${{ … }}"` an expression no raw `${{` scan finds (mutants Q1-Q3,
 * `web-run/logs/CI-1-wr3b-mutants-after.log`; the `yaml` package reads each as
 * the ordinary key, `CI-1-wr3b-yaml-forms.log`). So quoted and complex keys,
 * flow collections, anchors, aliases, tags, block scalars other than `run:`,
 * continuation lines and any backslash are refused rather than read.
 *
 * And the KEYS are a closed set too (`WORKFLOW_KEYS`): a job-level
 * `container:` runs every vetted line with an image's own bash, curl and npx,
 * which nothing here read (mutant J1), and a key this test has never seen is
 * looked at before it can change what runs or prints.
 */
const WORKFLOW_KEYS: RegExp[] = [
  /^(?:name|on|concurrency|jobs)$/,
  /^on\.(?:schedule|workflow_dispatch)$/,
  /^on\.schedule\[\]\.cron$/,
  /^on\.workflow_dispatch\.inputs(?:\.[A-Za-z_][\w-]*(?:\.(?:description|required|default))?)?$/,
  /^concurrency\.(?:group|cancel-in-progress)$/,
  /^jobs\.[A-Za-z_][\w-]*(?:\.(?:name|runs-on|timeout-minutes|steps))?$/,
  /^jobs\.[A-Za-z_][\w-]*\.steps\[\]\.(?:name|id|if|uses|with|env|run|working-directory|continue-on-error|timeout-minutes)$/,
  /^jobs\.[A-Za-z_][\w-]*\.steps\[\]\.(?:with|env)\.[A-Za-z_][\w-]*$/,
];

function yamlFormOffences(name: string, text: string): string[] {
  const raw = text.split(/\r?\n/);
  const blockBody = new Set(
    runBodyLines(text)
      .filter(({ at }) => !/^ *(?:- +)?run:/.test(raw[at - 1] ?? ''))
      .map(({ at }) => at),
  );
  const out: string[] = [];
  // The key path of each line, from its indentation: `jobs.restock.steps[].env.STOCK`.
  const stack: { col: number; path: string }[] = [];
  raw.forEach((physical, i) => {
    if (blockBody.has(i + 1)) return;
    const line = withoutComment(physical, true);
    if (spaceTrim(line) === '') return;
    // Spaces only, as YAML reads them (VN1-VN4: `spaceTrim`).
    const m = /^( *)(- +)?([A-Za-z_][A-Za-z0-9_-]*):(?: +(.*))?$/.exec(line);
    const value = spaceTrim(m?.[4] ?? '');
    const blockRun = m !== null && m[3] === 'run' && /^[|>][-+0-9]*$/.test(value);
    if (line.includes('\\') || m === null || (/^[{[&*!|>?%@`]/.test(value) && !blockRun)) {
      out.push(`${name}:${i + 1} is written in a YAML form this test does not read: ${line.trim()}`);
      return;
    }
    const indent = m[1].length;
    let col = indent;
    if (m[2] !== undefined) {
      while (stack.length > 0 && stack[stack.length - 1].col > indent) stack.pop();
      stack.push({ col: indent + 1, path: `${stack[stack.length - 1]?.path ?? ''}[]` });
      col = indent + m[2].length;
    }
    while (stack.length > 0 && stack[stack.length - 1].col >= col) stack.pop();
    const parent = stack[stack.length - 1]?.path;
    const keyPath = parent === undefined ? m[3] : `${parent}.${m[3]}`;
    stack.push({ col, path: keyPath });
    if (!WORKFLOW_KEYS.some((re) => re.test(keyPath))) {
      out.push(`${name}:${i + 1} sets ${keyPath}, a key this test does not vet: it can change what runs or what the runner prints`);
    }
  });
  return out;
}

const TOP_UP_STEP = 'name: Top up the restock wallet from the float';

/**
 * Where the verdict file is, as each step's env names it: ONE expression, the
 * whole value. It read `${{ runner.temp }}/ci-verdicts.txt` until the
 * continued run, and an expression is now the whole of an env value or
 * nowhere (case 8), so the path is built inside it.
 */
const VERDICT_FILE_VALUE = "${{ format('{0}/ci-verdicts.txt', runner.temp) }}";

/**
 * Every env entry of both workflows, by step, name and EXACT value. The runner
 * prints them all, so each value is public text, and an expression is read
 * here as written: a secret passed whole (masked by GitHub), a step output, a
 * runner path, a dispatch input or a repository variable. ENDPOINT and
 * P01_BASE are where the two vetted curl lines send their request, the trigger
 * secret included (mutant E10), and what curl names in its own error (E4).
 */
const VETTED_ENV_VALUES: Record<string, readonly (readonly [string, string, string])[]> = {
  'settle-till.yml': [
    ['name: Ask the deployment to settle if the policy allows it', 'SECRET', '${{ secrets.P01_SETTLE_TRIGGER_SECRET }}'],
    ['name: Ask the deployment to settle if the policy allows it', 'ENDPOINT', 'https://protocol-01.dev/api/settle-till'],
  ],
  'restock-inventory.yml': [
    [TOP_UP_STEP, 'P01_FUNDER_SECRET_KEY', '${{ secrets.P01_FUNDER_SECRET_KEY }}'],
    [TOP_UP_STEP, 'P01_TREASURY_KEYPAIR_JSON', '${{ secrets.P01_TREASURY_KEYPAIR_JSON }}'],
    [TOP_UP_STEP, 'P01_LIVE_RPC', '${{ secrets.P01_FUNDER_RPC }}'],
    [TOP_UP_STEP, 'P01_TREASURY_TARGET', "${{ github.event.inputs.target || '10' }}"],
    [TOP_UP_STEP, 'P01_TREASURY_LOW_WATER', "'7'"],
    [TOP_UP_STEP, 'P01_TREASURY_MAX_PER_RUN', "'3'"],
    [TOP_UP_STEP, 'P01_SETTLE_MIN_PURCHASES', '${{ vars.P01_SETTLE_MIN_PURCHASES }}'],
    [TOP_UP_STEP, 'P01_SETTLE_MIN_QUIET_SECONDS', '${{ vars.P01_SETTLE_MIN_QUIET_SECONDS }}'],
    [TOP_UP_STEP, 'P01_CI_VERDICT_FILE', VERDICT_FILE_VALUE],
    ['name: Read the live stock', 'P01_BASE', 'https://protocol-01.dev'],
    ['name: Write the treasury keypair', 'TREASURY_KEYPAIR_JSON', '${{ secrets.P01_TREASURY_KEYPAIR_JSON }}'],
    // `size` is the vetted parser's output: one integer from the PUBLIC GET
    // /api/issue-note, or nothing. This step echoes $STOCK, and the runner
    // prints it, so its value is pinned rather than trusted (mutant E1).
    ['name: Write the treasury keypair', 'STOCK', '${{ steps.stock.outputs.size }}'],
    ['name: Write the treasury keypair', 'P01_TREASURY_LOW_WATER', "'7'"],
    ['name: Restock', 'P01_RESTOCK', "'1'"],
    ['name: Restock', 'P01_LIVE_KEYPAIR', "${{ format('{0}/treasury.json', runner.temp) }}"],
    ['name: Restock', 'P01_LIVE_RPC', '${{ secrets.P01_FUNDER_RPC }}'],
    ['name: Restock', 'P01_TREASURY_NOTE_LEAVES', '${{ secrets.P01_TREASURY_NOTE_LEAVES }}'],
    ['name: Restock', 'P01_TREASURY_TARGET', "${{ github.event.inputs.target || '10' }}"],
    ['name: Restock', 'P01_TREASURY_LOW_WATER', "'7'"],
    ['name: Restock', 'P01_TREASURY_MAX_PER_RUN', "'3'"],
    ['name: Restock', 'NODE_OPTIONS', VETTED_NODE_OPTIONS],
    ['name: Restock', 'P01_CI_VERDICT_FILE', VERDICT_FILE_VALUE],
    ['name: Say what happened', 'P01_CI_VERDICT_FILE', VERDICT_FILE_VALUE],
  ],
};

/**
 * Every action input. The runner prints them, and an input can change what
 * the action runs: `actions/checkout` with a `ref:` checks out code this test
 * never read (mutant E7).
 */
const VETTED_WITH: Record<string, readonly (readonly [string, string, string])[]> = {
  'settle-till.yml': [],
  'restock-inventory.yml': [
    ['uses: pnpm/action-setup@v2', 'version', '9.15.9'],
    ['uses: actions/setup-node@v4', 'node-version-file', '.node-version'],
    ['uses: actions/setup-node@v4', 'cache', 'pnpm'],
  ],
};

/** Every `if:`: an expression, and whether a step ran is on the run page (mutant E5). */
const VETTED_IFS: Record<string, readonly (readonly [string, string, string])[]> = {
  'settle-till.yml': [],
  'restock-inventory.yml': [
    ['name: Restock', 'if', "steps.keypair.outputs.skip != '1'"],
    ['name: Say what happened', 'if', 'always()'],
    ['name: Shred the key', 'if', 'always()'],
  ],
};

// ── THE EXACT-LINE PIN: every non-comment line of both workflows ────────────
//
// ⚠️ THE RULES ABOVE WERE AN EVASION RACE. Each verifier round found one more
// shell or YAML spelling that a reader of shapes did not model (K1-K26,
// Z1-Z4, X1-X2, E1-E10, Q1-Q3, J1: `web-run/logs/CI-1-wr3b-mutants-after.log`),
// and each fix added a rule. So the race ends by construction: every line of
// the two workflows that is neither blank nor a comment is pinned below by its
// exact text, in order. Any change to what they run, what they pass, which
// step runs or what the runner shows is a change to this list, and is read
// with it. The shell and YAML rules stay, as the reading that says WHY each
// line on the list is safe. The threat model is in the file header.
//
// A comment or blank line stays free, so prose can change without this list,
// but only where it cannot change what runs (measured:
// `web-run/logs2/CI-1-cr1-comment-probe-bash.log`, `…-comment-probe.log`):
//   - not right after a line that ends in `\`. Bash ends the command at a
//     comment or a blank line, so `npx vitest run … --reporter=dot \` then
//     `# note` ran vitest with the rest of its flags and its file filter cut
//     off, and today's readers, which drop comments before joining lines, saw
//     the vetted line (mutants PL1-PL3);
//   - at the indentation of the line it precedes. A less indented one ends a
//     YAML block scalar, and a more indented one at the top of a block sets
//     the block's indentation (PL4);
//   - with no expression: the runner evaluates `${{` inside a run block's
//     bash comments too (the whole-value rule in case 8);
//   - with no character a parser may read as a line break, or that hides text
//     from a reviewer: CR (a line break in YAML 1.2, §5.4; the `yaml` package
//     keeps it inside the line, and GitHub's parser was not measured), NEL,
//     U+2028/2029, any other control character, zero-width and direction
//     characters, a BOM (PL5).
// And no vetted run line may END inside a quote or open a here-document, or a
// comment line after it would be text inside a string, which bash expands.
//
// ⚠️ "BLANK" AND "COMMENT" ARE READ AS BASH AND YAML READ THEM, NOT AS JS DOES.
// Until the continued run's round 2 a free line was `^\s*#`, and JS's `\s`
// also matches U+00A0, U+2009, U+3000 and the other Unicode spaces. Bash and
// YAML read those as text, so `<11 spaces> # note || cut -c2- <key file>`
// was a comment here and a command to bash, which printed the key minus its
// first character (mutants VN1-VN4; `web-run/logs2/verify-CI-1-r2-nbsp-bash.log`).
// So a comment line is `#` after SPACES only, a blank line is EMPTY (a line of
// spaces heading a block scalar, deeper than its first line, is a YAML parse
// error: PL12, `web-run/logs2/CI-1-cr2-yaml-probe.log` W1), and indentation
// counts spaces. And every character JS takes for a blank, other than the
// space and LF, is refused outright, computed from the engine rather than
// listed (`jsOnlyBlanks`), so every other reader in this file, which still uses
// `\s` and `trim()`, reads an accepted file the way bash and YAML do.

/** Every line of each workflow that is neither blank nor a comment, exactly, in order. */
const VETTED_WORKFLOW_LINES: Record<string, readonly string[]> = {
  'settle-till.yml': [
    "name: settle-till",
    "on:",
    "  schedule:",
    "    - cron: '17 * * * *'",
    "  workflow_dispatch:",
    "concurrency:",
    "  group: settle-till",
    "  cancel-in-progress: false",
    "jobs:",
    "  tick:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    steps:",
    "      - name: Ask the deployment to settle if the policy allows it",
    "        env:",
    "          SECRET: ${{ secrets.P01_SETTLE_TRIGGER_SECRET }}",
    "          ENDPOINT: https://protocol-01.dev/api/settle-till",
    "        run: |",
    "          set -euo pipefail",
    "          if [ -z \"${SECRET:-}\" ]; then",
    "            echo \"::error::P01_SETTLE_TRIGGER_SECRET is not set in this repository's secrets.\"",
    "            echo \"Without it every tick is an unauthenticated status read and NOTHING SETTLES,\"",
    "            echo \"silently, while the float drains. Failing loudly instead.\"",
    "            exit 1",
    "          fi",
    "          body=$(curl -sS --fail-with-body --max-time 120 \\",
    "                   -H \"authorization: Bearer $SECRET\" \\",
    "                   \"$ENDPOINT\")",
    "          settled=$(printf '%s' \"$body\" | python3 -c \"import sys,json;print(json.load(sys.stdin).get('settled'))\")",
    "          verdict=$(printf '%s' \"$body\" | python3 -c \"import sys,json;print(json.load(sys.stdin).get('verdict'))\")",
    "          alarm=$(printf '%s' \"$body\" | python3 -c \"import sys,json;print(json.load(sys.stdin).get('floatAlarm'))\")",
    "          echo \"verdict=$verdict settled=$settled floatAlarm=$alarm\" >> \"$GITHUB_STEP_SUMMARY\"",
    "          if [ \"$verdict\" = \"float-too-small-for-batch-floor\" ]; then",
    "            echo \"::error::The float cannot reach the batch floor. Deposits will stop before the till can settle. Fund the float; do NOT lower P01_SETTLE_MIN_PURCHASES.\"",
    "            exit 1",
    "          fi",
  ],
  'restock-inventory.yml': [
    "name: restock-inventory",
    "on:",
    "  schedule:",
    "    - cron: '41 */4 * * *'",
    "  workflow_dispatch:",
    "    inputs:",
    "      target:",
    "        description: 'How many notes the pot should hold'",
    "        required: false",
    "        default: '10'",
    "concurrency:",
    "  group: restock-inventory",
    "  cancel-in-progress: false",
    "jobs:",
    "  restock:",
    "    name: Restock the note inventory",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 90",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: pnpm/action-setup@v2",
    "        with:",
    "          version: 9.15.9",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version-file: .node-version",
    "          cache: pnpm",
    "      - run: pnpm install --frozen-lockfile",
    "      - name: Top up the restock wallet from the float",
    "        working-directory: apps/web",
    "        continue-on-error: true",
    "        env:",
    "          P01_FUNDER_SECRET_KEY: ${{ secrets.P01_FUNDER_SECRET_KEY }}",
    "          P01_TREASURY_KEYPAIR_JSON: ${{ secrets.P01_TREASURY_KEYPAIR_JSON }}",
    "          P01_LIVE_RPC: ${{ secrets.P01_FUNDER_RPC }}",
    "          P01_TREASURY_TARGET: ${{ github.event.inputs.target || '10' }}",
    "          P01_TREASURY_LOW_WATER: '7'",
    "          P01_TREASURY_MAX_PER_RUN: '3'",
    "          P01_SETTLE_MIN_PURCHASES: ${{ vars.P01_SETTLE_MIN_PURCHASES }}",
    "          P01_SETTLE_MIN_QUIET_SECONDS: ${{ vars.P01_SETTLE_MIN_QUIET_SECONDS }}",
    "          P01_CI_VERDICT_FILE: ${{ format('{0}/ci-verdicts.txt', runner.temp) }}",
    "        run: |",
    "          npx tsx scripts/topUpRestockWallet.mts > \"$RUNNER_TEMP/topup.out\" 2> \"$RUNNER_TEMP/topup.err\"",
    "      - name: Read the live stock",
    "        id: stock",
    "        env:",
    "          P01_BASE: https://protocol-01.dev",
    "        run: |",
    "          size=$(curl -sf \"$P01_BASE/api/issue-note\" | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(Number.isInteger(j.inventorySize)?j.inventorySize:'')}catch{console.log('')}})\")",
    "          echo \"size=$size\" >> \"$GITHUB_OUTPUT\"",
    "          echo \"live inventory: ${size:-unknown} notes\"",
    "      - name: Write the treasury keypair",
    "        id: keypair",
    "        env:",
    "          TREASURY_KEYPAIR_JSON: ${{ secrets.P01_TREASURY_KEYPAIR_JSON }}",
    "          STOCK: ${{ steps.stock.outputs.size }}",
    "          P01_TREASURY_LOW_WATER: '7'",
    "        run: |",
    "          if [ -z \"$TREASURY_KEYPAIR_JSON\" ]; then",
    "            if [ -n \"$STOCK\" ] && [ \"$STOCK\" -ge \"$P01_TREASURY_LOW_WATER\" ]; then",
    "              echo \"::warning::P01_TREASURY_KEYPAIR_JSON is unset, but the live inventory holds $STOCK notes (low water $P01_TREASURY_LOW_WATER): nothing to restock, skipping.\"",
    "              echo \"skip=1\" >> \"$GITHUB_OUTPUT\"",
    "              exit 0",
    "            fi",
    "            echo \"::error::P01_TREASURY_KEYPAIR_JSON is unset and the live inventory is ${STOCK:-unknown} (low water $P01_TREASURY_LOW_WATER): the pot cannot be refilled\"",
    "            exit 1",
    "          fi",
    "          printf '%s' \"$TREASURY_KEYPAIR_JSON\" > \"$RUNNER_TEMP/treasury.json\"",
    "      - name: Restock",
    "        if: steps.keypair.outputs.skip != '1'",
    "        working-directory: apps/web",
    "        env:",
    "          P01_RESTOCK: '1'",
    "          P01_LIVE_KEYPAIR: ${{ format('{0}/treasury.json', runner.temp) }}",
    "          P01_LIVE_RPC: ${{ secrets.P01_FUNDER_RPC }}",
    "          P01_TREASURY_NOTE_LEAVES: ${{ secrets.P01_TREASURY_NOTE_LEAVES }}",
    "          P01_TREASURY_TARGET: ${{ github.event.inputs.target || '10' }}",
    "          P01_TREASURY_LOW_WATER: '7'",
    "          P01_TREASURY_MAX_PER_RUN: '3'",
    "          NODE_OPTIONS: --max-old-space-size=8192",
    "          P01_CI_VERDICT_FILE: ${{ format('{0}/ci-verdicts.txt', runner.temp) }}",
    "        run: |",
    "          npx vitest run --config vitest.pool.config.mts --silent --reporter=dot \\",
    "            --disableConsoleIntercept=false \\",
    "            lib/privacy/pool/restockInventory.test.ts",
    "      - name: Say what happened",
    "        if: always()",
    "        env:",
    "          P01_CI_VERDICT_FILE: ${{ format('{0}/ci-verdicts.txt', runner.temp) }}",
    "        run: |",
    "          if [ -s \"$P01_CI_VERDICT_FILE\" ]; then",
    "            cat \"$P01_CI_VERDICT_FILE\"",
    "          else",
    "            echo \"no verdict was recorded\"",
    "          fi",
    "      - name: Shred the key",
    "        if: always()",
    "        run: shred -u \"$RUNNER_TEMP/treasury.json\" 2>/dev/null || rm -f \"$RUNNER_TEMP/treasury.json\"",
  ],
};

/**
 * Characters a YAML parser may read as a line break, a reviewer cannot see, or
 * JS reads as a blank while bash and YAML read them as text: U+00A0, U+1680,
 * U+2000-U+200A, U+202F, U+205F, U+3000 (VN1-VN9). `jsOnlyBlanks` checks this
 * set against the engine's own `\s` and `trim()`.
 */
const HIDDEN_CHAR = /[\u0000-\u0009\u000B-\u001F\u007F-\u00A0\u00AD\u061C\u1680\u2000-\u200F\u2028-\u202F\u205F-\u2069\u3000\uFEFF]/;

/** A comment, as bash and YAML read one: `#` after spaces, and nothing else first. */
const isCommentLine = (line: string) => /^ *#/.test(line);
/** Blank means EMPTY: a line of spaces can be a YAML parse error (PL12). */
const isFreeLine = (line: string) => line === '' || isCommentLine(line);
/** YAML's indentation: spaces only. */
const indentOf = (line: string) => line.search(/[^ ]/);

/**
 * Every code point that JS's `\s` or `trim()` takes for a blank, other than the
 * space and LF, that `HIDDEN_CHAR` does not refuse. Computed from the engine
 * over the whole BMP (the astral planes hold none:
 * `web-run/logs2/CI-1-cr2-yaml-probe.log`), so a character dropped from
 * `HIDDEN_CHAR`, or one a later engine adds to `\s`, is named here.
 */
function jsOnlyBlanks(): string[] {
  const out: string[] = [];
  for (let cp = 0; cp <= 0xffff; cp += 1) {
    const c = String.fromCharCode(cp);
    if (c === ' ' || c === '\n' || !(/\s/.test(c) || c.trim() === '')) continue;
    if (!HIDDEN_CHAR.test(c)) out.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  return out;
}

/**
 * Whether bash is still inside a quote (or a backtick substitution) at the end
 * of `line`, read from an unquoted start; a `#` at the start of a word ends
 * the reading, as it ends bash's.
 */
function endsInsideQuote(line: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    // Bash's word start, as in `withoutComment` (VN1-VN4).
    if (c === '#' && (i === 0 || /[ \t;&|()<>]/.test(line[i - 1]))) return false;
    if (c === "'" || c === '"' || c === '`') quote = c;
  }
  return quote !== null;
}

/** What differs from the vetted lines, and every free line that is not free. */
function workflowLineOffences(name: string, text: string): string[] {
  const out: string[] = [];
  const vetted = VETTED_WORKFLOW_LINES[name];
  if (vetted === undefined) return [`${name}: no vetted line list`];
  const raw = text.split('\n');
  // The readers here take these for a blank, and bash and YAML do not (VN1-VN9).
  const unrefused = jsOnlyBlanks();
  if (unrefused.length > 0) {
    out.push(`${name}: HIDDEN_CHAR lets through ${unrefused.join(' ')}, which JS reads as a blank and bash and YAML read as text`);
  }
  raw.forEach((line, i) => {
    if (HIDDEN_CHAR.test(line)) {
      out.push(`${name}:${i + 1} holds a control, line-break, zero-width, direction or non-ASCII space character, which a parser may read as a line, bash as text, and a reviewer cannot see`);
    }
    if (/^ +$/.test(line)) {
      out.push(`${name}:${i + 1} a line of spaces only: a blank line is empty here, because spaces deeper than a block's first line, heading the block, are a YAML parse error (PL12)`);
    }
  });

  // 1. The pinned lines, exactly and in order. The first divergence is named;
  //    every line after an insertion is shifted, so the rest says nothing new.
  const pinned = raw.map((line, i) => ({ at: i + 1, line })).filter(({ line }) => !isFreeLine(line));
  for (let k = 0; k < Math.max(pinned.length, vetted.length); k += 1) {
    if (pinned[k]?.line === vetted[k]) continue;
    out.push(
      pinned[k] === undefined
        ? `${name}: vetted line ${k + 1} is gone: ${vetted[k].trim()}`
        : `${name}:${pinned[k].at} is not vetted line ${k + 1} (${vetted[k] === undefined ? 'the list has ended' : vetted[k].trim()}): ${pinned[k].line.trim()}`,
    );
    out.push(`${name}: ${pinned.length} pinned lines, ${vetted.length} vetted; every non-comment line is pinned (VETTED_WORKFLOW_LINES)`);
    break;
  }

  // 2. A free line is free only where it cannot change what runs.
  raw.forEach((line, i) => {
    if (!isFreeLine(line)) return;
    const prev = raw[i - 1];
    if (prev !== undefined && !isFreeLine(prev) && prev.endsWith('\\')) {
      out.push(`${name}:${i + 1} a ${line === '' ? 'blank' : 'comment'} line inside a \\ continuation: bash ends the command there and runs the rest as another`);
    }
    if (line === '') return;
    const next = raw.slice(i + 1).find((l) => !isFreeLine(l));
    if (next !== undefined && indentOf(line) !== indentOf(next)) {
      out.push(`${name}:${i + 1} a comment line indented unlike the line it precedes, which YAML may read as the end of a block or as its indentation`);
    }
  });

  // 3. No run line leaves a quote or a here-document open at its end.
  for (const { at, physical } of runBodyLines(text)) {
    if (isFreeLine(physical)) continue;
    if (endsInsideQuote(physical)) out.push(`${name}:${at} ends inside a quote, so a comment line after it would be text bash reads: ${physical.trim()}`);
    if (/<</.test(withoutComment(physical, true))) out.push(`${name}:${at} opens a here-document, whose lines bash reads as text: ${physical.trim()}`);
  }
  return out;
}

/** The keys apps/web/.npmrc may set. npm reads it for every `npx` in apps/web (`npm prefix` is apps/web). */
const VETTED_NPMRC_KEYS = new Set(['legacy-peer-deps']);

/** The names vitest 3.2.4 loads from the config's directory unasked (`WORKSPACES_NAMES` in its constants chunk). */
const WORKSPACE_FILE = /^vitest\.(?:workspace|projects)\./;

/** The only shape of the vitest config the Restock command names. */
const POOL_CONFIG = {
  imports: new Set(['vitest/config', 'node:path']),
  top: new Set(['resolve', 'test']),
  resolve: new Set(['alias']),
  alias: new Set(['@/']),
  test: new Set(['include', 'environment']),
};

/** An object literal's own shape: no prototype of its own, which `for…in` in a config merge would read. */
function plainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * What the config at `abs` holds beyond `{ resolve: { alias: { '@/': <its own
 * directory> } }, test: { include, environment: 'node' } }`, and whether a
 * workspace file sits beside it.
 *
 * READ TWICE. EVALUATED, so a key arriving by a spread, a merge, a computed
 * name, a non-enumerable property (`Reflect.ownKeys`) or a prototype is seen
 * whatever its spelling. And READ, because an evaluation happens HERE, in a
 * test worker, while vitest evaluates the file in its own process: a config
 * that branches on where it runs (`process.env.VITEST_WORKER_ID`) showed this
 * test a clean object and vitest a dirty one (mutant W7). So the source may
 * import only its two modules, name no `process`, `globalThis`, `Object`,
 * `Reflect`…, load nothing at run time, and spread nothing.
 */
async function configOffences(abs: string): Promise<string[]> {
  const rel = path.basename(abs);
  const out: string[] = [];
  if (!existsSync(abs)) return [`${rel}: the config the Restock command names does not exist`];
  const { code, bare } = codeViews(readFileSync(abs, 'utf8'));
  for (const m of code.matchAll(/(?<![\w$.])(?:from|import)\s*(['"])([^'"\n]*)\1/g)) {
    if (!POOL_CONFIG.imports.has(m[2])) out.push(`${rel}:${lineAt(code, m.index ?? 0)} imports ${m[2]}, which is not vetted for this config`);
  }
  for (const m of bare.matchAll(/(?<![\w$.])(?:import|require)\s*\(|(?<![\w$.])import\s*\.\s*meta\b/g)) {
    out.push(`${rel}:${lineAt(bare, m.index ?? 0)} loads a module or reads import.meta at run time`);
  }
  for (const m of bare.matchAll(/(?<![\w$])(process|globalThis|global|require|module|eval|Function|Reflect|Object|Proxy|Symbol)(?![\w$])/g)) {
    out.push(`${rel}:${lineAt(bare, m.index ?? 0)} names ${m[1]}, so what vitest loads could differ from what this test evaluates`);
  }
  for (const m of bare.matchAll(/\.\.\./g)) {
    out.push(`${rel}:${lineAt(bare, m.index ?? 0)} spreads into the config, which hides the keys it adds from a reader`);
  }

  let config: unknown;
  try {
    config = ((await import(/* @vite-ignore */ pathToFileURL(abs).href)) as { default?: unknown }).default;
  } catch (e) {
    return [...out, `${rel} could not be evaluated: ${redactForCi((e as Error).message)}`];
  }
  const extra = (where: string, v: Record<string, unknown>, allowed: ReadonlySet<string>) => {
    for (const k of Reflect.ownKeys(v).map(String)) {
      if (!allowed.has(k)) out.push(`${rel}: ${where}${k} is not a vetted key: it can change what the Restock step's silenced run loads or prints`);
    }
  };
  if (!plainObject(config)) return [...out, `${rel}: its default export is not a plain object, so vitest may not read what this test reads`];
  extra('', config, POOL_CONFIG.top);
  if (config.resolve !== undefined) {
    if (!plainObject(config.resolve)) out.push(`${rel}: resolve is not a plain object`);
    else {
      extra('resolve.', config.resolve, POOL_CONFIG.resolve);
      const alias = config.resolve.alias;
      if (alias !== undefined && !plainObject(alias)) out.push(`${rel}: resolve.alias is not a plain object of prefixes`);
      if (plainObject(alias)) {
        extra('resolve.alias.', alias, POOL_CONFIG.alias);
        const target = alias['@/'];
        if (target !== undefined && (typeof target !== 'string' || path.relative(path.resolve(target), path.dirname(abs)) !== '')) {
          out.push(`${rel}: resolve.alias '@/' points somewhere other than the config's own directory, so a module the restock imports can be swapped`);
        }
      }
    }
  }
  if (!plainObject(config.test)) out.push(`${rel}: test is not a plain object`);
  else {
    extra('test.', config.test, POOL_CONFIG.test);
    if (config.test.environment !== undefined && config.test.environment !== 'node') {
      out.push(`${rel}: test.environment is not 'node', and the silencing was measured in node only`);
    }
  }
  for (const f of readdirSync(path.dirname(abs))) {
    if (WORKSPACE_FILE.test(f)) out.push(`${f} sits beside ${rel}: vitest loads it unasked, and its projects can carry a setupFiles no flag takes back`);
  }
  return out;
}

/**
 * Every way the scanned TypeScript could put a byte where the public reads it.
 *
 * The console and the process streams are the obvious half. The FILE family is
 * the half the round-1 rule missed: `$GITHUB_STEP_SUMMARY` is as public as the
 * log, `topUpRestockWallet.mts` already appends to it, and a deposit loop
 * appending `+1 leaf <index>` there walked straight past a scan that only knew
 * `console.` (mutant M5, `wp-logs/CI-1-fix1-sabotage.log`). A NAME is
 * matched rather than a call, so `const log = console.log` is a sink on the
 * line that takes the reference.
 */
const SINK =
  /\bconsole\s*\.|process\s*\.\s*std(?:out|err)\s*\.\s*write|\b(?:appendFileSync|writeFileSync|appendFile|writeFile|createWriteStream|writeSync|openSync|execSync|execFileSync|spawnSync)\b|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT/;

/**
 * The sinks those files may use, as WHOLE lines with the comment stripped.
 *
 * An allowlist, for the same reason `CI_WORDS` is one: a new way of printing is
 * an offender by default rather than one the rule forgot to name. Whole lines,
 * because a prefix match would exempt `console.error(\`::error::${redactForCi(m)} ${leaf}\`)`,
 * and matching the CALL rather than the line is what stops a raw `console.log`
 * being excused by a trailing comment that merely says `redactForCi` (mutant M6).
 *
 * ⚠️ NO CONSOLE LINE IS VETTED ANY MORE. The script's `::error::` used to go
 * out through `console.error`, i.e. through the step's own stderr, which the
 * workflow now keeps off the public log (case 8: web3.js prints the transfer
 * signature there on its own). So the annotation is recorded by `ciFail` in
 * the verdict file the next step prints, and a console line here would print
 * to a private file, or nowhere a reader can see.
 */
const VETTED_SINKS: [RegExp, string][] = [
  [/^const summary = process\.env\.GITHUB_STEP_SUMMARY;$/, 'the binding the vetted append reads'],
  [/^appendFileSync\(summary, `\$\{said\}\\n`\);$/, 'the verdict ciSay returned, and nothing else'],
];

/**
 * The lines through which `ciLog.ts` ITSELF prints: the verdict file and, when
 * there is none, stdout for a verdict and stderr for an annotation. Its own
 * list, because `console.log(text)` is only innocent where `text` is the
 * joined, allowlisted line or the redacted annotation — vetting it for the
 * three files above would excuse any variable they happened to call `text`.
 */
const CI_LOG_OWN_SINKS: RegExp[] = [
  /^appendFileSync\(file, `\$\{text\}\\n`\);$/,
  /^console\.log\(text\);$/,
  /^console\.error\(text\);$/,
];

/** The objects that print, or reach a printer by another name, looked for in `bare` (case 7). */
const PRINTER_NAMES =
  /(?<![\w$])(console|process|stdout|stderr|emitWarning|globalThis|global|window|self|eval|Function|Reflect|module|require)(?![\w$])/g;

/**
 * The modules each scanned file may import, and the node:fs names it may take.
 * A closed set, like `VETTED_USES`: a new module is looked at before it can
 * print (mutant S10, `wp-logs/CI-1-fix4-mutants-after.log`).
 */
const VETTED_IMPORTS: Record<string, { modules: ReadonlySet<string>; fs: ReadonlySet<string> }> = {
  'lib/privacy/pool/restockInventory.test.ts': {
    modules: new Set([
      'vitest',
      'node:fs',
      '@solana/web3.js',
      'tweetnacl',
      // Reads the key file in base58 as well as a JSON array, the two shapes
      // the top-up reads the same secret in (continued run). A decoder: it
      // prints nothing, and its own error names no input.
      'bs58',
      '@/lib/privacy/worker/poolHandlers',
      '@/lib/privacy/message',
      '@/lib/privacy/pool/denominatedPool',
      '@/lib/privacy/pool/noteBlinding',
      '@/lib/privacy/pool/restockConfig',
      '@/lib/privacy/ciLog',
    ]),
    fs: new Set(['readFileSync']),
  },
  'scripts/topUpRestockWallet.mts': {
    modules: new Set([
      'node:fs',
      '@solana/web3.js',
      'bs58',
      '../lib/privacy/ciLog',
      '../lib/privacy/pool/restockTopUp',
      // Read before it was added: no console, no process, a type-only import
      // of web3. It swaps the websocket confirmation for status polling.
      '../lib/privacy/worker/pollingConfirm',
    ]),
    fs: new Set(['appendFileSync']),
  },
  'lib/privacy/pool/restockTopUp.ts': {
    modules: new Set(['@solana/web3.js', './settlementPolicy', './restockConfig']),
    fs: new Set(),
  },
};

/**
 * Every variable either job may hand `ciSay` as a count, BY NAME.
 *
 * An allowlist again. The round-1 rule refused arguments spelled `leaf`,
 * `index`, `commitment`… which is a blocklist, and `const n = done.leafIndex ?? 0`
 * renames its way out of it in one line (mutant M8). `ciSay` bounds a count to
 * two digits but cannot know what a number MEANS, so what a count may be is
 * decided here, and a genuinely new one costs a line in this test — which is
 * the point: someone has to look at it.
 *
 * ⚠️ ONE NAME, AND WHAT IT HOLDS IS ON THE CHAIN ANYWAY. `landed` counts the
 * deposits this tick made. `before` and `after` were vetted here until the web
 * run round-2 verifier read what they held: `stock()`, the authorised leaves
 * on the tree AND UNSPENT, which no endpoint serves (`GET /api/issue-note`
 * serves the configured size, spent or not). Said on every tick, two ticks
 * apart they gave the number of issued notes spent in between. `wanted` is
 * `min(TARGET - before, MAX_PER_RUN)`, so it gave `before` away under a low
 * dispatch target, and `TARGET` only meant anything beside them. A name is
 * still not a value, so the restock case below RUNS the file and reads its
 * output by what moves it.
 */
const VETTED_COUNTS = new Set(['landed']);

/**
 * Everything one tick hands to the public log, captured from the channel it
 * really uses: `$P01_CI_VERDICT_FILE` when the workflow sets one (the restock
 * step runs vitest `--silent`, which swallows stdout), stdout otherwise.
 */
function emitted(fn: () => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'p01-ci-'));
  const file = path.join(dir, 'verdicts.txt');
  const saved = process.env[CI_VERDICT_FILE_ENV];
  process.env[CI_VERDICT_FILE_ENV] = file;
  const said: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    said.push(a.join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
    if (saved === undefined) delete process.env[CI_VERDICT_FILE_ENV];
    else process.env[CI_VERDICT_FILE_ENV] = saved;
  }
  const fromFile = existsSync(file) ? readFileSync(file, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return [...said, fromFile].join('\n').trim();
}

/** Same as `emitted`, with no verdict file set: the hand-run case. */
function printed(fn: () => void): string {
  const saved = process.env[CI_VERDICT_FILE_ENV];
  delete process.env[CI_VERDICT_FILE_ENV];
  const said: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    said.push(a.join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
    if (saved !== undefined) process.env[CI_VERDICT_FILE_ENV] = saved;
  }
  return said.join('\n').trim();
}

/**
 * EVERYTHING a call writes where a public log could read it: the verdict file,
 * every console method, both process streams, and node's `process._rawDebug`
 * (fd 2 below all of them; printed under `--silent`,
 * `web-run/logs/CI-1-wr1-probe.log` P2c). A throw is swallowed here: what the
 * refusal SAYS is read by the caller, this reads what it WROTE on the way.
 *
 * ⚠️ `emitted` reads console.log and the file only, which is where a verdict
 * goes. A refusal that wrote itself to console.error first — a "which word?"
 * debugging aid — sailed past it (mutant U1 of the round-3 verifier,
 * `wp-logs/verify/CI-1-r3d-mutants.log`).
 */
function everyChannel(fn: () => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'p01-ci-'));
  const file = path.join(dir, 'verdicts.txt');
  const saved = process.env[CI_VERDICT_FILE_ENV];
  process.env[CI_VERDICT_FILE_ENV] = file;
  const said: string[] = [];
  const keep = (...a: unknown[]) => {
    said.push(a.map(String).join(' '));
  };
  const spies = [
    ...(['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(keep as never),
    ),
    ...[process.stdout, process.stderr].map((s) =>
      vi.spyOn(s, 'write').mockImplementation(((chunk: unknown) => {
        keep(chunk);
        return true;
      }) as never),
    ),
  ];
  const raw = process as unknown as { _rawDebug?: (...a: unknown[]) => void };
  if (typeof raw._rawDebug === 'function') {
    spies.push(vi.spyOn(raw as { _rawDebug: (...a: unknown[]) => void }, '_rawDebug').mockImplementation(keep) as never);
  }
  try {
    fn();
  } catch {
    /* the refusal itself is the caller's to read */
  } finally {
    for (const spy of spies) spy.mockRestore();
    if (saved === undefined) delete process.env[CI_VERDICT_FILE_ENV];
    else process.env[CI_VERDICT_FILE_ENV] = saved;
  }
  const fromFile = existsSync(file) ? readFileSync(file, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return [...said, fromFile].join('\n').trim();
}

// ── the worlds ──────────────────────────────────────────────────────────────

interface World {
  name: string;
  funder: string;
  restock: string;
  signature: string;
  funderLamports: number;
  restockLamports: number;
  since: number | null;
  /** Leaf indices inside a message thrown by the pool library, not by us. */
  gaps: number[];
}

const BASE: World = {
  name: 'base',
  funder: key(1),
  restock: key(2),
  signature: sig(3),
  funderLamports: FUNDER_FLOOR + 10 * 1e9,
  restockLamports: RESTOCK_FLOOR,
  since: 48 * HOUR,
  gaps: [118, 119, 120],
};

/** One value moves in each. Every one of them still ends in `move`. */
const WORLDS: World[] = [
  { ...BASE, name: 'again (nothing moves)' },
  { ...BASE, name: 'the float key', funder: key(11) },
  { ...BASE, name: 'the restock key', restock: key(12) },
  { ...BASE, name: 'the transfer signature', signature: sig(13) },
  {
    ...BASE,
    name: 'the balances',
    funderLamports: FUNDER_FLOOR + 40 * 1e9,
    restockLamports: RESTOCK_FLOOR + 1e8,
  },
  { ...BASE, name: 'the quiet time', since: 96 * HOUR },
  { ...BASE, name: 'the leaf indices in a library message', gaps: [7, 8, 9] },
];

function topUpResult(w: World, over: Partial<TopUpInputs> = {}): TopUpResult {
  const plan = planTopUp({
    funderLamports: w.funderLamports,
    restockLamports: w.restockLamports,
    secondsSinceLastFunderActivity: w.since,
    nowSeconds: NOW,
    ...over,
  });
  return {
    plan,
    dryRun: false,
    funder: w.funder,
    restockWallet: w.restock,
    funderLamports: w.funderLamports,
    restockLamports: w.restockLamports,
    secondsSinceLastFunderActivity: w.since,
    feeLamports: 5000,
    sentLamports: Math.max(0, plan.amountLamports - 5000),
    signature: w.signature,
  };
}

/**
 * The public text of one tick, in one world.
 *
 * `verdicts` is what the jobs choose to say: the formatted line AND what the
 * emitter actually put on the record, so a line that is built safely but
 * printed some other way is still read here.
 *
 * `errors` is text this repository did not write — the message of an exception
 * from the pool library or from web3.js — which vitest prints even under
 * `--silent`, and which the job rethrows through `ciRedactedError`.
 */
function publicLog(w: World): { verdicts: string[]; errors: string[] } {
  const r = topUpResult(w);
  const line = formatTopUpLine(r);
  return {
    verdicts: [line, emitted(() => void ciSay(line))],
    errors: [
      // prepareUnshield / prepareUnshieldV4 in denominatedPool.ts, reached
      // whenever the restock's own history read has a hole. Named by function
      // rather than by line: those two lines have already moved once under
      // this comment.
      ciRedactedError(
        new Error(
          `[DenomPool/v4] prepareUnshieldV4: ${w.gaps.length} missing leaf gap(s): ${w.gaps.join(',')}...`,
        ),
      ).message,
      // restockTopUp.ts's own refusal, which carries lamports.
      ciRedactedError(
        new Error(
          `the top-up (${r.plan.amountLamports} lamports) is smaller than the network fee (5000)`,
        ),
      ).message,
      // A send that failed, which carries both wallets and the signature.
      ciRedactedError(
        new Error(`failed to send from ${w.funder} to ${w.restock}: ${w.signature}`),
      ).message,
      // The same failure as the top-up script's fail() puts it on the record:
      // an ::error:: annotation in the verdict file, through ciFail.
      emitted(
        () =>
          void ciFail(
            `top-up failed: ${w.funderLamports} lamports from ${w.funder} to ${w.restock}: ${w.signature}`,
          ),
      ),
    ],
  };
}

const VERDICTS: [TopUpVerdict, Partial<TopUpInputs>][] = [
  ['move', {}],
  ['restock-at-target', { restockLamports: RESTOCK_TARGET }],
  ['float-at-floor', { funderLamports: FUNDER_FLOOR }],
  ['below-minimum-move', { funderLamports: FUNDER_FLOOR + DEFAULT_MIN_TOP_UP_LAMPORTS - 1 }],
  ['float-history-unknown', { secondsSinceLastFunderActivity: null }],
  [
    'too-soon-after-float-activity',
    { secondsSinceLastFunderActivity: DEFAULT_SETTLEMENT_CONFIG.minQuietSeconds - 1 },
  ],
  ['holding-off', { holdUntilSeconds: NOW + 60 }],
];

// ── the two jobs, RUN against a fake chain ──────────────────────────────────
//
// ⚠️ A NAME IS NOT A VALUE. Case 7 reads every count ciSay is given BY NAME,
// and `const landed = before` walks past that in one line; so does the jitter
// in minutes under a vetted name (mutant U3, a stated residual since fix
// round 4). The web run round-2 verifier's major needed no renaming at all:
// `before` and `after` were vetted names, and what they held was the UNSPENT
// stock. So both jobs are also RUN, the real files, against a fake chain, in
// worlds that differ in ONE value each, and what they put on the record is
// read by what moves it: case 2's method, applied to the jobs rather than to
// the lines they build.
//
// A world is compared only with worlds whose CHAIN reads the same (the same
// number of deposits; a transfer or none). What a tick does on chain is public
// whatever the log says, so it is not what this measures.

/** Set each variable (or delete it, for undefined) and return what was there. */
function swapEnv(vars: Record<string, string | undefined>): Record<string, string | undefined> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return before;
}

/** Let promise chains with no timer in them run out, on the real event loop. */
async function drain(): Promise<void> {
  for (let k = 0; k < 10; k += 1) await new Promise((r) => setImmediate(r));
}

/** Synthetic, deterministic, and no real treasury's: the seed the fake worker hands the restock. */
const RESTOCK_SEED_HEX = '5a'.repeat(32);
/** The authorised inventory leaves (`P01_TREASURY_NOTE_LEAVES`) of every restock world. */
const RESTOCK_LEAVES = Array.from({ length: 20 }, (_, i) => 100 + i);
const leavesIn = (from: number, to: number) => RESTOCK_LEAVES.filter((l) => l >= from && l <= to);

interface RestockWorld {
  name: string;
  /** Which synthetic keypair the treasury wallet is. */
  wallet: number;
  /** Authorised leaves already on the tree. */
  onChain: number[];
  /** Of those, the ones whose nullifier is spent. */
  spent: number[];
  /** The treasury wallet's balance, in lamports. */
  balance: number;
  /** What Math.random returns: the start delay and the gaps between deposits. */
  random: number;
  /** The leaf index the pool library reports for a deposit. The job must not read it. */
  reportedLeaf: number;
  /** The first deposit throws a library message naming a leaf, the wallet and an amount. */
  depositFails?: boolean;
  /** The authorised leaves (`P01_TREASURY_NOTE_LEAVES`, a secret). `RESTOCK_LEAVES` when unset. */
  leaves?: number[];
  /** The treasury's note seed, hex (derived from its key, a secret). `RESTOCK_SEED_HEX` when unset. */
  seed?: string;
  /**
   * What the key file holds, made from the wallet's secret key: a JSON array
   * when unset. The workflow writes the file from the P01_TREASURY_KEYPAIR_JSON
   * secret as it is stored, and a wallet exports base58.
   */
  keyText?: (secret: Uint8Array) => string;
}

/** The key file as a wallet exports it. */
const asBase58 = (secret: Uint8Array) => bs58.encode(secret);
/** No keypair: the base58 key cut short, as a bad paste leaves it. */
const cutShort = (secret: Uint8Array) => bs58.encode(secret).slice(0, 60);

/** A second synthetic seed. */
const RESTOCK_SEED_HEX_2 = 'a5'.repeat(32);
const leafRange = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
/** As many authorised leaves as `authorisedLeaves()` reads at most (512), so the stock can reach its ceiling. */
const LEAVES_512 = leafRange(100, 512);
/** How many notes `stock()` counts in a world: authorised, on the tree, and unspent. */
const unspentOf = (w: RestockWorld) =>
  (w.leaves ?? RESTOCK_LEAVES).filter((l) => w.onChain.includes(l) && !w.spent.includes(l)).length;
/** `w` with exactly `k` unspent: the first `k` of `onChain` are live and the rest spent. */
const withUnspent = (w: RestockWorld, k: number, onChain: number[], leaves?: number[]): RestockWorld => ({
  ...w,
  name: `${k} unspent${leaves === undefined ? '' : ` of ${leaves.length} authorised`}, ${w.name}`,
  onChain,
  spent: onChain.slice(k),
  ...(leaves === undefined ? {} : { leaves }),
});
const counts = (from: number, to: number) => leafRange(from, to - from + 1);

/** 9 unspent of 10 on the tree: above the low-water mark (7), so nothing is deposited. */
const R_ABOVE: RestockWorld = {
  name: 'above low water',
  wallet: 50,
  onChain: leavesIn(100, 109),
  spent: [109],
  balance: RESTOCK_FLOOR + 5e9,
  random: 0.25,
  reportedLeaf: 211,
};
/** 5 unspent: below it, so min(10 - 5, 3) = 3 deposits land. */
const R_BELOW: RestockWorld = { ...R_ABOVE, name: 'below low water', spent: leavesIn(105, 109) };
/** The wallet under its floor: nothing is deposited, whatever the stock. */
const R_FLOOR: RestockWorld = { ...R_ABOVE, name: 'at the floor', balance: RESTOCK_FLOOR - 1 };
/** Below low water, and the first deposit throws. */
const R_FAILS: RestockWorld = { ...R_BELOW, name: 'a deposit fails', depositFails: true };
/** A key file that holds no keypair: the job refuses it, and says only that. */
const R_BADKEY: RestockWorld = { ...R_ABOVE, name: 'a key file that holds no keypair', keyText: cutShort };

/**
 * ⚠️ THE UNSPENT STOCK IS SWEPT, NOT SAMPLED. Until web run round 3 (second
 * pass) each class held two stock values (above low water 9 and 8, below 5 and
 * 6, at the floor 9 and 5), so a branch on `before` at any other threshold was
 * never exercised: `if (before > 9) ciSay('restock done')` above low water, and
 * a "pot is full" `if (before >= TARGET) { ciSay('restock done'); return; }`,
 * each put one bit of the stock on every tick's record and stayed green (the
 * web run round-3 verifier's Z4, Z4b; `web-run/logs/verify-CI-1-r2b-mutants-after.log`).
 * A tick costs nothing on the fake clock, so every value a class can hold is
 * run: above low water 8-20 of 20 authorised leaves, at the floor 0-20, below
 * low water 0-7 (each still 3 deposits: min(10 - k, 3)), and a failing
 * deposit 0-7. Past 20 the stock is laddered to the 512 leaves
 * `authorisedLeaves()` reads at most (21, 64, 256, 512), so any one threshold
 * up to the ceiling is straddled; a window between two rungs is not (stated in
 * the report). The seed and the authorised list are secrets too, and each has
 * a world. The balance, the random draws and the reported leaf get their
 * extremes, so any one threshold between them is straddled. Each of those
 * gaps has a mutant that was green before this table and is red with it
 * (Z4d-Z4g, S1, A1, B1, R1, L1; `web-run/logs/CI-1-wr3b-mutants-before.log`,
 * `-after.log`).
 */
const RESTOCK_GROUPS: [RestockWorld, RestockWorld[]][] = [
  [
    R_ABOVE,
    [
      { ...R_ABOVE, name: 'again (nothing moves)' },
      { ...R_ABOVE, name: 'the unspent stock, above low water', spent: [108, 109] },
      { ...R_ABOVE, name: 'which leaves are spent', spent: [100] },
      { ...R_ABOVE, name: 'which leaves are on the tree', onChain: leavesIn(110, 119), spent: [119] },
      { ...R_ABOVE, name: 'the treasury wallet', wallet: 51 },
      { ...R_ABOVE, name: 'the wallet balance', balance: RESTOCK_FLOOR + 40e9 },
      { ...R_ABOVE, name: 'the random draws', random: 0.75 },
      ...counts(8, 20).map((k) => withUnspent(R_ABOVE, k, RESTOCK_LEAVES)),
      ...[21, 64, 256, 512].map((k) => withUnspent(R_ABOVE, k, LEAVES_512, LEAVES_512)),
      { ...R_ABOVE, name: 'the authorised leaves', leaves: leafRange(300, 30), onChain: leafRange(300, 10), spent: [309] },
      { ...R_ABOVE, name: 'the note seed', seed: RESTOCK_SEED_HEX_2 },
      { ...R_ABOVE, name: 'the wallet balance, at its floor', balance: RESTOCK_FLOOR },
      { ...R_ABOVE, name: 'the wallet balance, 10,000 SOL', balance: RESTOCK_FLOOR + 1e13 },
      { ...R_ABOVE, name: 'the random draws, lowest', random: 0 },
      { ...R_ABOVE, name: 'the random draws, highest', random: 0.999 },
      // The key file in base58, two different keys. The job read a JSON array
      // only, and V8's JSON.parse quoted the first 10 characters of a base58
      // key into the rethrown message (the web run round-3 verifier's major).
      { ...R_ABOVE, name: 'the key file, in base58', keyText: asBase58 },
      { ...R_ABOVE, name: 'another treasury wallet, its key file in base58', wallet: 51, keyText: asBase58 },
    ],
  ],
  [
    R_BELOW,
    [
      { ...R_BELOW, name: 'again (nothing moves)' },
      // 6 unspent: min(10 - 6, 3) is still 3 deposits, so the chain reads the same.
      { ...R_BELOW, name: 'the unspent stock, below low water', spent: leavesIn(106, 109) },
      { ...R_BELOW, name: 'which leaves are spent', spent: [100, 102, 104, 106, 108] },
      { ...R_BELOW, name: 'the leaf index the pool reports', reportedLeaf: 7 },
      { ...R_BELOW, name: 'the treasury wallet', wallet: 51 },
      { ...R_BELOW, name: 'the wallet balance', balance: RESTOCK_FLOOR + 40e9 },
      { ...R_BELOW, name: 'the random draws', random: 0.75 },
      ...counts(0, 7).map((k) => withUnspent(R_BELOW, k, leavesIn(100, 109))),
      { ...R_BELOW, name: 'the authorised leaves', leaves: LEAVES_512, onChain: LEAVES_512.slice(0, 300), spent: LEAVES_512.slice(4, 300) },
      { ...R_BELOW, name: 'the note seed', seed: RESTOCK_SEED_HEX_2 },
      { ...R_BELOW, name: 'the wallet balance, at its floor', balance: RESTOCK_FLOOR },
      { ...R_BELOW, name: 'the wallet balance, 10,000 SOL', balance: RESTOCK_FLOOR + 1e13 },
      { ...R_BELOW, name: 'the random draws, lowest', random: 0 },
      { ...R_BELOW, name: 'the random draws, highest', random: 0.999 },
      { ...R_BELOW, name: 'the leaf index the pool reports, lowest', reportedLeaf: 0 },
      { ...R_BELOW, name: 'the leaf index the pool reports, highest', reportedLeaf: 1_000_000 },
      { ...R_BELOW, name: 'the key file, in base58, when it deposits', keyText: asBase58 },
      { ...R_BELOW, name: 'another treasury wallet, its key file in base58, when it deposits', wallet: 51, keyText: asBase58 },
    ],
  ],
  [
    R_FLOOR,
    [
      // Under the floor nothing lands, so the chain cannot tell a pot above low
      // water from one below it, and the log must not tell it either.
      { ...R_FLOOR, name: 'the unspent stock, at the floor', spent: leavesIn(105, 109) },
      { ...R_FLOOR, name: 'the wallet balance, at the floor', balance: RESTOCK_FLOOR - 2e8 },
      ...counts(0, 20).map((k) => withUnspent(R_FLOOR, k, RESTOCK_LEAVES)),
      ...[21, 64, 256, 512].map((k) => withUnspent(R_FLOOR, k, LEAVES_512, LEAVES_512)),
      { ...R_FLOOR, name: 'the note seed, at the floor', seed: RESTOCK_SEED_HEX_2 },
      { ...R_FLOOR, name: 'the wallet balance, empty', balance: 0 },
      { ...R_FLOOR, name: 'the treasury wallet, at the floor', wallet: 51 },
      { ...R_FLOOR, name: 'the key file in base58, at the floor', keyText: asBase58 },
      { ...R_FLOOR, name: 'another treasury wallet, its key file in base58, at the floor', wallet: 51, keyText: asBase58 },
    ],
  ],
  [
    R_FAILS,
    [
      { ...R_FAILS, name: 'the unspent stock, when a deposit fails', spent: leavesIn(106, 109) },
      { ...R_FAILS, name: 'the leaf in the failure', reportedLeaf: 7 },
      { ...R_FAILS, name: 'the treasury wallet, when a deposit fails', wallet: 51 },
      ...counts(0, 7).map((k) => withUnspent(R_FAILS, k, leavesIn(100, 109))),
      // The key file in base58, two keys. With JSON-array files only, all
      // digits, a failure that quoted the file as stored stayed green (the
      // continued run's round-4 verifier's RK1).
      { ...R_FAILS, name: 'the key file in base58, when a deposit fails', keyText: asBase58 },
      { ...R_FAILS, name: 'another treasury wallet, its key file in base58, when a deposit fails', wallet: 51, keyText: asBase58 },
    ],
  ],
  [
    R_BADKEY,
    [
      // Every shape of a key file that holds no keypair reads the same: the
      // refusal names the secret to fix and quotes nothing of what it read.
      { ...R_BADKEY, name: 'another wallet, its key cut short', wallet: 51 },
      { ...R_BADKEY, name: 'the public key instead of the secret one', keyText: (s) => bs58.encode(s.slice(32)) },
      { ...R_BADKEY, name: 'a JSON array with a stray token', keyText: (s) => JSON.stringify(Array.from(s)).replace(']', ',x]') },
      { ...R_BADKEY, name: 'the base58 key inside quotes', keyText: (s) => `"${bs58.encode(s)}"` },
      { ...R_BADKEY, name: 'an empty key file', keyText: () => '' },
    ],
  ],
];

interface RestockTick {
  /** The job resolved or rejected inside the driven clock. */
  settled: boolean;
  /** Everything public: the verdict file, the raw process streams, and the rejection vitest prints. */
  record: string;
  verdicts: string;
  rejection: string;
  deposits: number;
  stockReads: number;
}

/**
 * The live restock, `restockInventory.test.ts`, loaded for real with its
 * dependencies on the chain faked, and its one case captured instead of
 * registered.
 *
 * Faked: vitest's `describe`/`it` (so the case can be called here), the pool
 * worker (a fixed seed; a deposit adds the next free authorised leaf to the
 * fake tree), the two chain reads of `denominatedPool` (the tree and the spent
 * set, BUILT with the pool's own commitment and nullifier functions, so the
 * job's `stock()` runs unmodified), and web3's `Connection` and
 * `sendAndConfirmTransaction`. Real: ciLog, the restock config, the crypto,
 * and every line of the job. The clock is faked, so the start delay and the
 * gaps cost nothing, and `Math.random` is the world's.
 *
 * Public, as the Restock step runs it: the verdict file (printed by "Say what
 * happened"), the raw process streams (`--silent` drops console.*, not those),
 * and the message and stack of a rejection (vitest prints them even under
 * `--silent`).
 */
async function restockHarness(): Promise<{
  captured: boolean;
  tick: (w: RestockWorld) => Promise<RestockTick>;
  close: () => void;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'p01-ci-restock-'));
  const keyFile = path.join(dir, 'treasury.json');
  const saved = swapEnv({
    P01_RESTOCK: '1',
    P01_LIVE_KEYPAIR: keyFile,
    P01_LIVE_RPC: 'http://127.0.0.1:9',
    P01_TREASURY_NOTE_LEAVES: `${RESTOCK_LEAVES[0]}-${RESTOCK_LEAVES[RESTOCK_LEAVES.length - 1]}`,
    // As the workflow sets them.
    P01_TREASURY_TARGET: '10',
    P01_TREASURY_LOW_WATER: '7',
    P01_TREASURY_MAX_PER_RUN: '3',
    P01_TREASURY_FLOOR: undefined,
    P01_RESTOCK_JITTER_MS: undefined,
    [CI_VERDICT_FILE_ENV]: undefined,
  });

  let world = R_ABOVE;
  let body: (() => Promise<void>) | undefined;
  const chain = { onChain: new Set<number>(), deposits: 0, stockReads: 0 };

  vi.doMock('vitest', async (importOriginal) => {
    const real = await importOriginal<typeof import('vitest')>();
    const run = (_name: string, fn: () => void) => fn();
    return {
      ...real,
      describe: Object.assign(run, { skipIf: () => run }),
      it: (...args: unknown[]) => {
        body = args[args.length - 1] as () => Promise<void>;
      },
    };
  });
  vi.doMock('@/lib/privacy/worker/poolHandlers', () => ({
    handlePoolRequest: async (r: { kind: string }) => {
      switch (r.kind) {
        case 'poolDeriveIdentity':
          return { ok: true };
        case 'poolExportSeed':
          return { seedHex: world.seed ?? RESTOCK_SEED_HEX };
        case 'poolShieldPrepare':
          return { jobId: 'job', ephemeralPubkey: key(60), requiredLamports: 1_010_000_000 };
        case 'poolShieldExecute': {
          if (world.depositFails) {
            throw new Error(
              `[DenomPool] poolShieldExecute failed on leaf ${world.reportedLeaf} of ${key(world.wallet)}: ${world.balance / 1e9} SOL left`,
            );
          }
          const next = (world.leaves ?? RESTOCK_LEAVES).find((l) => !chain.onChain.has(l));
          if (next === undefined) throw new Error('the fake tree has no free authorised leaf');
          chain.onChain.add(next);
          chain.deposits += 1;
          return { leafIndex: world.reportedLeaf + chain.deposits, signature: sig(80 + chain.deposits) };
        }
        default:
          throw new Error(`the fake worker does not serve ${r.kind}`);
      }
    },
  }));
  vi.doMock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => {
    const real = await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>();
    const { deriveNoteBlinding } = await import('@/lib/privacy/pool/noteBlinding');
    const pool = real.findPoolV3('SOL', 1);
    if (pool === undefined) throw new Error('the 1 SOL pool is gone from the table');
    const notes = new Map<string, { commitment: bigint; nullifierPDA: string }>();
    const note = (leaf: number) => {
      const hex = world.seed ?? RESTOCK_SEED_HEX;
      let n = notes.get(`${hex}:${leaf}`);
      if (n === undefined) {
        const seed = Uint8Array.from(Buffer.from(hex, 'hex'));
        const { secret, nullifierPreimage } = real.deriveNoteMaterial(seed, pool.poolPDA, leaf);
        const commitment = real.createCommitmentV3(
          nullifierPreimage,
          secret,
          deriveNoteBlinding(seed, pool.poolPDA, leaf),
          real.pubkeyToField(pool.tokenMint),
        );
        const nullifier = real.createNullifierV3(nullifierPreimage, secret);
        const [pda] = real.deriveNullifierPDA(pool.poolPDA, real.goldilocksU64To32(nullifier));
        n = { commitment, nullifierPDA: pda.toBase58() };
        notes.set(`${hex}:${leaf}`, n);
      }
      return n;
    };
    return {
      ...real,
      fetchPoolCommitments: async () => {
        chain.stockReads += 1;
        return new Map([...chain.onChain].map((l) => [note(l).commitment.toString(), { commitment: note(l).commitment, leafIndex: l }]));
      },
      fetchSpentNullifierSet: async () =>
        new Set(world.spent.filter((l) => chain.onChain.has(l)).map((l) => note(l).nullifierPDA)),
    };
  });
  vi.doMock('@solana/web3.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Connection: class {
      async getBalance() {
        return world.balance;
      }
    },
    sendAndConfirmTransaction: async () => sig(70),
  }));
  const close = () => {
    for (const m of ['vitest', '@/lib/privacy/worker/poolHandlers', '@/lib/privacy/pool/denominatedPool', '@solana/web3.js']) {
      vi.doUnmock(m);
    }
    vi.resetModules();
    swapEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    vi.resetModules();
    await import(/* @vite-ignore */ pathToFileURL(webFile('lib/privacy/pool/restockInventory.test.ts')).href);
  } catch (e) {
    // No mock may outlive a harness that failed to start.
    close();
    throw e;
  }

  let n = 0;
  const tick = async (w: RestockWorld): Promise<RestockTick> => {
    world = w;
    chain.onChain = new Set(w.onChain);
    // The job reads its authorised list on every call, so each world can hold its own.
    process.env.P01_TREASURY_NOTE_LEAVES = (w.leaves ?? RESTOCK_LEAVES).join(',');
    chain.deposits = 0;
    chain.stockReads = 0;
    const secret = Keypair.fromSeed(new Uint8Array(32).fill(w.wallet)).secretKey;
    writeFileSync(keyFile, w.keyText === undefined ? JSON.stringify(Array.from(secret)) : w.keyText(secret));
    n += 1;
    const file = path.join(dir, `verdicts-${n}.txt`);
    process.env[CI_VERDICT_FILE_ENV] = file;
    const streams: string[] = [];
    const keep = (chunk: unknown) => {
      streams.push(String(chunk));
      return true;
    };
    const spies: { mockRestore(): void }[] = [
      vi.spyOn(Math, 'random').mockReturnValue(w.random),
      vi.spyOn(process.stdout, 'write').mockImplementation(keep as never),
      vi.spyOn(process.stderr, 'write').mockImplementation(keep as never),
    ];
    const raw = process as unknown as { _rawDebug?: (...a: unknown[]) => void };
    if (typeof raw._rawDebug === 'function') {
      spies.push(vi.spyOn(raw as { _rawDebug: (...a: unknown[]) => void }, '_rawDebug').mockImplementation(keep));
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let rejection = '';
    let settled = false;
    try {
      const job = body ?? (async () => undefined);
      void job().then(
        () => {
          settled = true;
        },
        (e: unknown) => {
          rejection = e instanceof Error ? `${e.message}\n${String(e.stack)}` : String(e);
          settled = true;
        },
      );
      for (let k = 0; k < 400 && !settled; k += 1) await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
      for (const s of spies) s.mockRestore();
      delete process.env[CI_VERDICT_FILE_ENV];
    }
    const verdicts = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    return {
      settled,
      verdicts,
      rejection,
      record: [verdicts, ...streams, rejection].join('\n').trim(),
      deposits: chain.deposits,
      stockReads: chain.stockReads,
    };
  };
  return { captured: body !== undefined, tick, close };
}

interface TopUpWorld {
  name: string;
  funderSeed: number;
  restockSeed: number;
  signature: string;
  funderLamports: number;
  restockLamports: number;
  since: number;
  /** What Math.random returns: the script's start delay. */
  random: number;
  /** The transfer is refused with a library message naming both wallets, the amount and the signature. */
  sendFails?: boolean;
  /** The `P01_FUNDER_SECRET_KEY` secret is unset, so the step passes it empty. */
  noFunderKey?: boolean;
  /** How `P01_FUNDER_SECRET_KEY` stores the float's key: a JSON array when unset. */
  funderVia?: KeyShape;
  /**
   * What `P01_TREASURY_KEYPAIR_JSON` holds: the restock keypair in one of the
   * `KeyShape`s, or `none`, the empty value the step passes while that secret
   * is unset. Required, and `json` in T_MOVE, so every class holds the
   * treasury secret the way the workflow passes it. Until the continued run's
   * round 4, T_MOVE named the restock wallet by its ADDRESS, which the
   * workflow never sets: 7 of the 8 bases held no treasury secret, and a
   * refusal quoting it stayed green on three exits the workflow reaches (that
   * verifier's WK1-WK3, `web-run/logs2/verify-CI-1-r4-mutants.log`).
   */
  restockVia: KeyShape | 'none';
  /**
   * What `P01_RESTOCK_WALLET_ADDRESS` holds, or unset. The step's env block
   * (case 8) does not name it, so only a hand run sets it: T_BAD_ADDRESS, and
   * a variant of the move.
   */
  address?: string;
  /** The genesis hash the chain answers with: devnet's when unset. */
  genesis?: string;
}

/**
 * How a world stores a key secret. The script reads two shapes, a JSON array
 * and base58. The other four hold no keypair, and are the ones case 9 feeds
 * the restock's key file: the base58 key cut short (a bad paste), inside
 * quotes, the public key instead of the secret one, and a JSON array with a
 * stray token. A refusal that quotes what it read moves between them.
 */
type KeyShape = 'json' | 'base58' | 'cut-short' | 'quoted' | 'public-key' | 'json-stray';
const KEY_SHAPES: Record<KeyShape, (secret: Uint8Array) => string> = {
  json: (s) => JSON.stringify(Array.from(s)),
  base58: asBase58,
  'cut-short': cutShort,
  quoted: (s) => `"${bs58.encode(s)}"`,
  'public-key': (s) => bs58.encode(s.slice(32)),
  'json-stray': (s) => JSON.stringify(Array.from(s)).replace(']', ',x]'),
};
const secretOf = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).secretKey;
/** Every 4-character piece of `s`: what a record may not hold of a key (cases 9 and 10). */
const piecesOf = (s: string) => Array.from({ length: s.length - 3 }, (_, i) => s.slice(i, i + 4));

/** The restock keypair secret as the world stores it. */
function restockKeypairText(w: TopUpWorld): string {
  return w.restockVia === 'none' ? '' : KEY_SHAPES[w.restockVia](secretOf(w.restockSeed));
}

/** The float's key secret as the world stores it. */
const funderKeyText = (w: TopUpWorld) => KEY_SHAPES[w.funderVia ?? 'json'](secretOf(w.funderSeed));

/**
 * The top-up step's env block as the runner hands it to the script in world
 * `w`: every entry case 8 pins for that step (`VETTED_ENV_VALUES`, the
 * workflow's text entry for entry), its expression evaluated as a scheduled
 * run evaluates it. An unset secret or variable is the EMPTY string there,
 * not an absent variable. An expression this cannot evaluate throws, so a
 * variable the workflow starts passing reaches these worlds, or turns this
 * case red, the day case 8's list learns it. Until the continued run's round
 * 4 the worlds were given a variable the step never sets, and no base held
 * the secret the step does pass (that verifier's major).
 */
function topUpStepEnv(w: TopUpWorld, verdictFile: string): Record<string, string> {
  const evaluated: Record<string, string> = {
    '${{ secrets.P01_FUNDER_SECRET_KEY }}': w.noFunderKey ? '' : funderKeyText(w),
    '${{ secrets.P01_TREASURY_KEYPAIR_JSON }}': restockKeypairText(w),
    '${{ secrets.P01_FUNDER_RPC }}': 'http://127.0.0.1:9',
    // A scheduled run has no dispatch input.
    "${{ github.event.inputs.target || '10' }}": '10',
    "'7'": '7',
    "'3'": '3',
    // Unset repository variables: the settlement policy's own defaults.
    '${{ vars.P01_SETTLE_MIN_PURCHASES }}': '',
    '${{ vars.P01_SETTLE_MIN_QUIET_SECONDS }}': '',
    [VERDICT_FILE_VALUE]: verdictFile,
  };
  const env: Record<string, string> = {};
  for (const [step, name, value] of VETTED_ENV_VALUES['restock-inventory.yml']) {
    if (step !== TOP_UP_STEP) continue;
    if (!(value in evaluated)) throw new Error(`the top-up harness cannot evaluate ${name}: ${value}`);
    env[name] = evaluated[value];
  }
  return env;
}

/** Synthetic genesis hashes that are not devnet's: the script must refuse the chain. */
const otherGenesis = (n: number) => bs58.encode(new Uint8Array(32).fill(n));

/** The workflow's configuration: the restock wallet named by its keypair, as a JSON array (solana-keygen's shape). */
const T_MOVE: TopUpWorld = {
  name: 'a top-up that moves',
  funderSeed: 1,
  restockSeed: 2,
  signature: sig(3),
  funderLamports: BASE.funderLamports,
  restockLamports: BASE.restockLamports,
  since: 48 * HOUR,
  random: 0.25,
  restockVia: 'json',
};
const T_FAILS: TopUpWorld = { ...T_MOVE, name: 'the transfer is refused', sendFails: true };
const T_NO_KEY: TopUpWorld = { ...T_MOVE, name: 'no float key', noFunderKey: true };
/** The float moved a moment ago, so a LIVE tick decides not to move. */
const T_HOLD: TopUpWorld = { ...T_MOVE, name: 'a live top-up that holds', since: 0 };
/** The restock keypair secret holds no keypair. */
const T_BADKEY: TopUpWorld = { ...T_MOVE, name: 'a restock keypair that is not one', restockVia: 'cut-short' };
/**
 * The FLOAT key secret holds no keypair. Until the continued run's round 3 no
 * world reached this refusal: every world stored the float key as a valid JSON
 * array, so a refusal that quoted `raw.slice(0, 10)` stayed green and, run for
 * real, put 9 of the first 10 characters of a base58 float secret on the
 * record (that verifier's VR1, `web-run/logs2/verify-CI-1-r3-topup-probe-vr1-*.log`).
 */
const T_BADFLOAT: TopUpWorld = { ...T_MOVE, name: 'a float key that is not one', funderVia: 'cut-short' };
/** Neither the restock wallet's address nor its keypair is set, while the float key is. */
const T_NO_RESTOCK: TopUpWorld = { ...T_MOVE, name: 'no restock wallet named', restockVia: 'none' };
/**
 * The restock wallet's address cut short, while the float key and the restock
 * keypair are loaded. The workflow does not set this variable (its env block
 * is pinned by case 8), so only a hand run reaches this refusal; it has a
 * class all the same.
 */
const T_BAD_ADDRESS: TopUpWorld = { ...T_MOVE, name: 'a restock address that is not one', address: key(2).slice(0, 30) };
/** The RPC answers for a chain that is not devnet, with both keys loaded. */
const T_WRONG_CHAIN: TopUpWorld = { ...T_MOVE, name: 'a chain that is not devnet', genesis: otherGenesis(21) };

/**
 * ⚠️ EVERY REFUSAL IS A CLASS, AND EACH SECRET PRESENT IN IT IS VARIED. A
 * refusal no world reaches can quote what it holds and stay green (VR1 above),
 * so each exit of the script has a class: a move, a refused transfer, no float
 * key, a float key that is not one, no restock wallet, a restock address that
 * is not one, a restock keypair that is not one, and a chain that is not
 * devnet. In each, the float key and the restock key are varied (another key,
 * and another shape the script reads), and a bad key is varied across the
 * shapes that hold no keypair. The restock key is varied as the workflow
 * passes it, a keypair: as a JSON array and in base58, from two keypairs, in
 * every class that holds a readable one (the case checks this table before it
 * runs it). The address is a variant only: a hand run's.
 */
const TOPUP_GROUPS: [TopUpWorld, TopUpWorld[]][] = [
  [
    T_MOVE,
    [
      { ...T_MOVE, name: 'again (nothing moves)' },
      { ...T_MOVE, name: 'the float key', funderSeed: 11 },
      { ...T_MOVE, name: 'the restock key', restockSeed: 12 },
      { ...T_MOVE, name: 'the transfer signature', signature: sig(13) },
      { ...T_MOVE, name: 'the balances', funderLamports: BASE.funderLamports + 30e9, restockLamports: RESTOCK_FLOOR + 1e8 },
      { ...T_MOVE, name: 'the quiet time', since: 96 * HOUR },
      { ...T_MOVE, name: 'the random draws', random: 0.75 },
      // The keypair in base58, the shape a wallet exports: the other shape
      // the script reads, and the restock step reads its key file in.
      { ...T_MOVE, name: 'the restock wallet, named by its keypair in base58', restockVia: 'base58' },
      { ...T_MOVE, name: 'another restock keypair, in base58', restockSeed: 12, restockVia: 'base58' },
      // Named by its ADDRESS, as only a hand run does: beside the keypair,
      // alone, and another wallet alone.
      { ...T_MOVE, name: 'the restock wallet, named by its address beside its keypair', address: key(2) },
      { ...T_MOVE, name: 'the restock wallet, named by its address alone', address: key(2), restockVia: 'none' },
      { ...T_MOVE, name: 'another restock wallet, named by its address alone', restockSeed: 12, address: key(12), restockVia: 'none' },
      // The float key in base58, the shape a wallet exports and the header
      // documents. Read as a JSON array only, it was refused, and no case saw
      // it (VR1d).
      { ...T_MOVE, name: 'the float key, in base58', funderVia: 'base58' },
      { ...T_MOVE, name: 'another float key, in base58', funderSeed: 11, funderVia: 'base58' },
    ],
  ],
  [
    T_FAILS,
    [
      { ...T_FAILS, name: 'the float key, when the transfer is refused', funderSeed: 11 },
      { ...T_FAILS, name: 'the restock key, when the transfer is refused', restockSeed: 12 },
      { ...T_FAILS, name: 'the signature, when the transfer is refused', signature: sig(13) },
      { ...T_FAILS, name: 'the balances, when the transfer is refused', funderLamports: BASE.funderLamports + 30e9 },
      { ...T_FAILS, name: 'another float key in base58, when the transfer is refused', funderSeed: 11, funderVia: 'base58' },
      { ...T_FAILS, name: 'the restock keypair in base58, when the transfer is refused', restockVia: 'base58' },
      { ...T_FAILS, name: 'another restock keypair in base58, when the transfer is refused', restockSeed: 12, restockVia: 'base58' },
    ],
  ],
  [
    T_NO_KEY,
    [
      { ...T_NO_KEY, name: 'the restock key, with no float key', restockSeed: 12 },
      { ...T_NO_KEY, name: 'the restock keypair in base58, with no float key', restockVia: 'base58' },
      { ...T_NO_KEY, name: 'another restock keypair in base58, with no float key', restockSeed: 12, restockVia: 'base58' },
    ],
  ],
  [
    T_BADFLOAT,
    [
      { ...T_BADFLOAT, name: 'another float key, cut short', funderSeed: 11 },
      { ...T_BADFLOAT, name: 'the float key inside quotes', funderVia: 'quoted' },
      { ...T_BADFLOAT, name: "the float's public key instead of its secret one", funderVia: 'public-key' },
      { ...T_BADFLOAT, name: 'the float key as a JSON array with a stray token', funderVia: 'json-stray' },
      { ...T_BADFLOAT, name: 'the restock key, when the float key is not one', restockSeed: 12 },
      { ...T_BADFLOAT, name: 'the restock keypair in base58, when the float key is not one', restockVia: 'base58' },
      { ...T_BADFLOAT, name: 'another restock keypair in base58, when the float key is not one', restockSeed: 12, restockVia: 'base58' },
    ],
  ],
  [
    T_NO_RESTOCK,
    [
      { ...T_NO_RESTOCK, name: 'the float key, with no restock wallet named', funderSeed: 11 },
      { ...T_NO_RESTOCK, name: 'the float key in base58, with no restock wallet named', funderVia: 'base58' },
    ],
  ],
  [
    T_BAD_ADDRESS,
    [
      { ...T_BAD_ADDRESS, name: 'another restock address, cut short', restockSeed: 12, address: key(12).slice(0, 30) },
      { ...T_BAD_ADDRESS, name: 'the restock address with a stray character', address: `${key(2)}x` },
      { ...T_BAD_ADDRESS, name: 'the float key, when the restock address is not one', funderSeed: 11 },
      { ...T_BAD_ADDRESS, name: 'the float key in base58, when the restock address is not one', funderVia: 'base58' },
      { ...T_BAD_ADDRESS, name: 'another restock keypair, when the restock address is not one', restockSeed: 12 },
      { ...T_BAD_ADDRESS, name: 'the restock keypair in base58, when the restock address is not one', restockVia: 'base58' },
      { ...T_BAD_ADDRESS, name: 'another restock keypair in base58, when the restock address is not one', restockSeed: 12, restockVia: 'base58' },
      { ...T_BAD_ADDRESS, name: 'the restock address alone, when it is not one', restockVia: 'none' },
    ],
  ],
  [
    T_BADKEY,
    [
      { ...T_BADKEY, name: 'another restock keypair, cut short', restockSeed: 12 },
      { ...T_BADKEY, name: 'the restock public key instead of its keypair', restockVia: 'public-key' },
      { ...T_BADKEY, name: 'the restock keypair inside quotes', restockVia: 'quoted' },
      { ...T_BADKEY, name: 'the restock keypair as a JSON array with a stray token', restockVia: 'json-stray' },
      { ...T_BADKEY, name: 'the float key, when the restock keypair is not one', funderSeed: 11 },
      { ...T_BADKEY, name: 'the float key in base58, when the restock keypair is not one', funderVia: 'base58' },
    ],
  ],
  [
    T_WRONG_CHAIN,
    [
      { ...T_WRONG_CHAIN, name: 'the float key, on a chain that is not devnet', funderSeed: 11 },
      { ...T_WRONG_CHAIN, name: 'the float key in base58, on a chain that is not devnet', funderVia: 'base58' },
      { ...T_WRONG_CHAIN, name: 'the restock key, on a chain that is not devnet', restockSeed: 12 },
      { ...T_WRONG_CHAIN, name: 'the restock keypair in base58, on a chain that is not devnet', restockVia: 'base58' },
      { ...T_WRONG_CHAIN, name: 'another restock keypair in base58, on a chain that is not devnet', restockSeed: 12, restockVia: 'base58' },
      { ...T_WRONG_CHAIN, name: 'another chain that is not devnet', genesis: otherGenesis(22) },
    ],
  ],
];

/**
 * One class per `fail()` call of the script, in the script's order: the float
 * key unset, the float key not a keypair, the restock address not a public
 * key, no restock wallet named, the restock keypair not one, a chain that is
 * not devnet, and main's catch. Case 7 counts the calls against this list, so
 * a refusal added later fails there until a class here reaches it (NF1).
 */
const TOPUP_REFUSAL_CLASSES: readonly TopUpWorld[] = [T_NO_KEY, T_BADFLOAT, T_BAD_ADDRESS, T_NO_RESTOCK, T_BADKEY, T_WRONG_CHAIN, T_FAILS];

interface TopUpTick {
  /** The script ended (a verdict in the summary, or process.exit) inside the driven clock. */
  finished: boolean;
  /** Everything public, as the workflow runs it: the verdict file and the step summary. */
  record: string;
  exits: unknown[];
  sends: number;
}

/**
 * The top-up script, `scripts/topUpRestockWallet.mts`, run for real: imported
 * afresh per world (its `main()` runs on import), with web3's `Connection`
 * faked (status polling, no websocket confirmation) and `process.exit`
 * recorded instead of obeyed. Its environment is the step's env block as the
 * workflow passes it (`topUpStepEnv`). Real: ciLog, restockTopUp, the
 * settlement policy, the polling confirmation, bs58 and every line of the
 * script.
 *
 * Public, as the workflow runs it: the verdict file (printed by "Say what
 * happened") and the step summary. NOT its own stdout and stderr: the step
 * sends both to private files, which case 8 pins, because web3.js prints the
 * transfer signature there on its own. The record is taken at the first
 * `process.exit`, where the real process would have stopped.
 */
async function topUpHarness(): Promise<{ tick: (w: TopUpWorld) => Promise<TopUpTick>; close: () => void }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'p01-ci-topup-'));
  const cleared = Object.fromEntries(
    [
      'P01_FUNDER_SECRET_KEY',
      'P01_TREASURY_KEYPAIR_JSON',
      'P01_RESTOCK_WALLET_ADDRESS',
      'P01_LIVE_RPC',
      'P01_FUNDER_RPC',
      'P01_TOPUP_DRY_RUN',
      'P01_TOPUP_JITTER_MS',
      'P01_TOPUP_MIN_LAMPORTS',
      'P01_SETTLE_MIN_PURCHASES',
      'P01_SETTLE_MIN_QUIET_SECONDS',
      'P01_TREASURY_TARGET',
      'P01_TREASURY_LOW_WATER',
      'P01_TREASURY_MAX_PER_RUN',
      'P01_TREASURY_FLOOR',
      CI_VERDICT_FILE_ENV,
      'GITHUB_STEP_SUMMARY',
    ].map((k) => [k, undefined]),
  ) as Record<string, string | undefined>;
  const saved = swapEnv(cleared);

  let world = T_MOVE;
  let sends = 0;
  const blockhash = bs58.encode(new Uint8Array(32).fill(9));
  vi.doMock('@solana/web3.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Connection: class {
      async getGenesisHash() {
        return world.genesis ?? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      }
      async getBalance(who: { toBase58(): string }) {
        return who.toBase58() === key(world.funderSeed) ? world.funderLamports : world.restockLamports;
      }
      async getSignaturesForAddress() {
        return [{ signature: world.signature, blockTime: Math.floor(Date.now() / 1000) - world.since }];
      }
      async getLatestBlockhash() {
        return { blockhash, lastValidBlockHeight: 1_000 };
      }
      async getFeeForMessage() {
        return { context: { slot: 1 }, value: 5000 };
      }
      async sendTransaction() {
        sends += 1;
        if (world.sendFails) {
          throw new Error(
            `failed to send ${world.funderLamports} lamports from ${key(world.funderSeed)} to ${key(world.restockSeed)}: ${world.signature}`,
          );
        }
        return world.signature;
      }
      // Status polling, and NO `confirmTransaction`: web3.js's own confirms
      // over a websocket `signatureSubscribe`, and prints the transfer
      // signature when that fails. So the script must confirm by polling
      // (`lib/privacy/worker/pollingConfirm.ts`); without that wrapper the
      // call is undefined here, the move world fails, and this case goes red.
      async getSignatureStatuses() {
        return { context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null }] };
      }
    },
  }));

  let n = 0;
  const tick = async (w: TopUpWorld): Promise<TopUpTick> => {
    world = w;
    sends = 0;
    n += 1;
    const file = path.join(dir, `verdicts-${n}.txt`);
    const summary = path.join(dir, `summary-${n}.md`);
    swapEnv({
      ...cleared,
      ...topUpStepEnv(w, file),
      // A hand run's only: the step's env block does not name it.
      P01_RESTOCK_WALLET_ADDRESS: w.address,
      // The runner's own.
      GITHUB_STEP_SUMMARY: summary,
    });
    const read = () => [file, summary].map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')).join('\n').trim();
    const exits: unknown[] = [];
    let record: string | null = null;
    const spies: { mockRestore(): void }[] = [
      vi.spyOn(Math, 'random').mockReturnValue(w.random),
      vi.spyOn(process, 'exit').mockImplementation(((code?: unknown) => {
        exits.push(code);
        if (record === null) record = read();
      }) as never),
    ];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const finished = () => exits.length > 0 || /^top-up /m.test(existsSync(summary) ? readFileSync(summary, 'utf8') : '');
    try {
      vi.resetModules();
      await import(/* @vite-ignore */ pathToFileURL(webFile('scripts/topUpRestockWallet.mts')).href);
      for (let k = 0; k < 400 && !finished(); k += 1) await vi.advanceTimersByTimeAsync(60_000);
      // The real process would have stopped at exit; this one runs on, so it
      // is let finish HERE rather than inside the next world.
      await drain();
    } finally {
      vi.useRealTimers();
      for (const s of spies) s.mockRestore();
      swapEnv(cleared);
    }
    return { finished: finished(), record: record ?? read(), exits, sends };
  };
  const close = () => {
    vi.doUnmock('@solana/web3.js');
    vi.resetModules();
    swapEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  };
  return { tick, close };
}

// ── the cases ───────────────────────────────────────────────────────────────

describe('the public Actions log carries verdicts only', () => {
  it('two runs of the same world are identical, so a moved line means something (determinism control)', () => {
    // Without this, an unseeded random value would make every line move in
    // every world, no line could be shown to name anything, and the
    // differential below would pass by accident.
    expect(publicLog(BASE)).toEqual(publicLog(BASE));
    expect(key(1)).toBe(key(1));
    expect(sig(3)).toBe(sig(3));
    // And the worlds really do differ, or they would compare equal trivially.
    expect(new Set([key(1), key(11), key(2), key(12)]).size).toBe(4);
    expect(LONG_RUN.test(BASE.funder)).toBe(true);
  });

  it('CI output names no key, signature, leaf, balance or jitter', () => {
    const base = publicLog(BASE);

    // 1. The measurement: nothing on the public record moves with any of it.
    for (const w of WORLDS) {
      expect(publicLog(w), `the public log moved with ${w.name}`).toEqual(base);
    }

    // 2. The allowlist: every word a job says is one it was allowed to say,
    //    or a count of at most two digits.
    const stray = base.verdicts
      .join(' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((word) => !CI_WORDS.has(word) && !/^(\d{1,2}|99\+)$/.test(word));
    expect(stray, 'words on a public line that nothing allowlisted').toEqual([]);

    // 3. Text we did not write keeps its short words and loses its data.
    for (const message of base.errors) {
      expect(LONG_RUN.test(message), `a long run survived redaction: ${message}`).toBe(false);
      expect(/\d/.test(message), `a number survived redaction: ${message}`).toBe(false);
    }

    // 4. A belt, not the instrument: the values themselves, spelled out.
    const everything = [...base.verdicts, ...base.errors].join('\n');
    for (const secret of [BASE.funder, BASE.restock, BASE.signature, '118', '119', '120']) {
      expect(everything.includes(secret), `the public log names ${secret.slice(0, 12)}`).toBe(false);
    }
  });

  it('the verdict still reaches the log, so an empty line cannot pass (positive control)', () => {
    // A formatter that returned '' would satisfy every assertion above. This is
    // what stops that: each verdict is reached by driving planTopUp, and each
    // one has to arrive, distinctly.
    const lines = new Map<TopUpVerdict, string>();
    for (const [verdict, over] of VERDICTS) {
      const r = topUpResult(BASE, over);
      expect(r.plan.verdict, `the inputs for ${verdict} no longer produce it`).toBe(verdict);
      const out = emitted(() => void ciSay(formatTopUpLine(r)));
      expect(out, `${verdict} must reach the public log`).toContain(`verdict=${verdict}`);
      lines.set(verdict, out);
    }
    expect(lines.size).toBe(7);
    expect(new Set(lines.values()).size, 'two verdicts read the same on the log').toBe(7);
    // The mode is public on purpose: a dry run that reads as live is worse.
    expect(formatTopUpLine(topUpResult(BASE))).toContain('live');
  });

  it('ciSay refuses a word or a number nothing allowlisted (positive control)', () => {
    expect(emitted(() => void ciSay('restock landed', 3))).toContain('restock landed 3');

    // `everyChannel` below has to SEE each channel, or the '' it returns for a
    // refusal proves nothing.
    const channels: [string, () => void][] = [
      ['console.error', () => console.error('channel-probe')],
      ['console.warn', () => console.warn('channel-probe')],
      ['console.info', () => console.info('channel-probe')],
      ['console.debug', () => console.debug('channel-probe')],
      ['process.stdout', () => void process.stdout.write('channel-probe\n')],
      ['process.stderr', () => void process.stderr.write('channel-probe\n')],
      ['the verdict file', () => void ciSay('restock done')],
    ];
    const rawDebug = (process as unknown as { _rawDebug?: (s: string) => void })._rawDebug;
    if (typeof rawDebug === 'function') {
      channels.push(['process._rawDebug', () => (process as unknown as { _rawDebug: (s: string) => void })._rawDebug('channel-probe')]);
    }
    for (const [channel, write] of channels) {
      expect(everyChannel(write), `the capture misses ${channel}`).not.toBe('');
    }

    // A leaf is not a word, however it is spelled or glued.
    for (const bad of [
      'leaf 211',
      'restock leaf211',
      'restock stock 211',
      `top-up ${BASE.funder}`,
      'restock 0x1f',
      'restock stock 1.0034 SOL',
      // The unspent stock is not a thing a tick may announce at all, with or
      // without a number (VETTED_COUNTS above; web run round-2 verifier).
      'restock stock',
    ]) {
      expect(() => ciSay(bad), `"${bad}" must not be sayable`).toThrow();
      // The refusal is printed too, so it must not quote what it refused
      // (ciLog.ts; mutant S15, `wp-logs/CI-1-fix4-mutants-after.log`).
      let refusal = '';
      try {
        ciSay(bad);
      } catch (e) {
        refusal = (e as Error).message;
      }
      expect(refusal, 'the refusal carries a message').not.toBe('');
      for (const word of bad.split(/\s+/)) {
        expect(refusal.includes(word), `the refusal of "${bad}" quotes ${word}`).toBe(false);
      }
      // Nor may it write what it refused anywhere ELSE on the way out: to a
      // console method, a stream, fd 2, or the verdict file the next step
      // prints (mutants U1-U1d, `web-run/logs/CI-1-wr1-mutants-after.log`).
      expect(everyChannel(() => void ciSay(bad)), `the refusal of "${bad}" wrote something before it threw`).toBe('');
    }

    // Counts are bounded, so the number of digits is bounded whatever the
    // caller holds.
    expect(emitted(() => void ciSay('restock landed', 318))).toContain('99+');
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => ciSay('restock landed', bad), `${bad} must not be sayable`).toThrow();
    }
    // ONE count a line. The second slot is where the stock rode beside its
    // target (`restock stock <before> <TARGET>`), so it is gone.
    expect(() => ciSay('restock landed', 1, 2), 'two counts must not be sayable').toThrow();
  });

  it('a verdict goes to the file the workflow prints, and to stdout when there is none', () => {
    // The restock step runs vitest --silent, which swallows stdout: the file is
    // the channel, and a later step prints it. A developer running the job by
    // hand has no file and still wants to see it.
    const viaFile = emitted(() => void ciSay('restock landed', 2));
    expect(viaFile).toContain('restock landed 2');
    expect(printed(() => void ciSay('restock landed', 2))).toContain('restock landed 2');

    // The top-up's FAILURE takes the same file. That step's own stdout and
    // stderr are kept off the public log (case 8), so an `::error::` written
    // there would raise no annotation anyone can see, the operator included.
    // `everyChannel` reads the file AND every console method and stream, so
    // this also says the annotation went nowhere else.
    expect(everyChannel(() => void ciFail('top-up failed: Signature expired')), 'the annotation reaches the verdict file, and only it').toBe(
      '::error::top-up failed: Signature expired',
    );
    // One line, whatever the message: a library message with a newline in it
    // must not start a second workflow command in the file the next step cats.
    expect(everyChannel(() => void ciFail('top-up failed: first\n::warning::second'))).toBe(
      '::error::top-up failed: first ::warning::second',
    );
    // With no file (a hand run), stderr, where a terminal shows it.
    const saved = process.env[CI_VERDICT_FILE_ENV];
    delete process.env[CI_VERDICT_FILE_ENV];
    const toStderr: string[] = [];
    const toStdout: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      toStderr.push(a.join(' '));
    });
    const out = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      toStdout.push(a.join(' '));
    });
    try {
      ciFail('top-up failed: Signature expired');
    } finally {
      err.mockRestore();
      out.mockRestore();
      if (saved !== undefined) process.env[CI_VERDICT_FILE_ENV] = saved;
    }
    expect(toStderr, 'a hand run shows the annotation on stderr').toEqual(['::error::top-up failed: Signature expired']);
    expect(toStdout, 'and not on stdout').toEqual([]);
  });

  it('a thrown library message reaches the log redacted, and carries no cause', () => {
    const raw = `prepareUnshieldV4 failed on leaf 211 of ${BASE.funder}: 1.0034 SOL left, waiting 517s`;
    const redacted = ciRedactedError(new Error(raw, { cause: new Error(BASE.signature) }));

    expect(redacted).toBeInstanceOf(Error);
    // An Error printed with a cause prints the cause too, so a redacted message
    // with the raw one attached leaks exactly what it was meant to hide.
    expect(redacted.cause, 'a cause would be printed beside the redacted message').toBeUndefined();
    expect(redacted.message).not.toContain(BASE.funder);
    expect(redacted.message).not.toContain(BASE.signature);
    expect(LONG_RUN.test(redacted.message)).toBe(false);
    expect(/\d/.test(redacted.message)).toBe(false);
    // It still says which step failed, or the operator learns nothing at all.
    expect(redacted.message).toContain('prepareUnshield');
    expect(redactForCi(raw)).toBe(redacted.message);

    // The top-up's annotation is redacted by ciFail itself, the same way: the
    // script hands it a library message whole (`top-up failed: <message>`).
    const annotated = everyChannel(() => void ciFail(raw));
    expect(annotated.startsWith('::error::'), 'ciFail writes an annotation').toBe(true);
    expect(annotated).toBe(`::error::${redacted.message}`);
    expect(LONG_RUN.test(annotated)).toBe(false);
    expect(/\d/.test(annotated)).toBe(false);

    // NOT ONLY AN Error IS THROWN. The pool rethrows what a prover rejected
    // with (`throw c1Settled.reason` / `throw c3Settled.reason` in
    // denominatedPool.ts), and a wasm prover often rejects with a STRING; a
    // plain object is the other shape a library throws. A rethrow that redacts
    // only Error instances passed a string through raw (mutant U2 of the
    // round-3 verifier), and one that JSON-stringified an object did the same
    // for its fields (U2b, `web-run/logs/CI-1-wr1-mutants-after.log`).
    const thrownRaw = `prover rejected leaf 211 of ${BASE.funder}: ${BASE.signature}`;
    for (const thrown of [thrownRaw, { message: thrownRaw, leaf: 211, wallet: BASE.funder }, [thrownRaw], 211]) {
      const out = ciRedactedError(thrown);
      const shape = Array.isArray(thrown) ? 'an array' : typeof thrown;
      expect(out, `a thrown ${shape} comes back as an Error`).toBeInstanceOf(Error);
      expect(out.cause, `a thrown ${shape} comes back with no cause`).toBeUndefined();
      const printed = `${out.message}\n${String(out.stack)}`;
      expect(LONG_RUN.test(printed), `a long run survived a thrown ${shape}: ${printed}`).toBe(false);
      expect(/\d/.test(printed), `a number survived a thrown ${shape}: ${printed}`).toBe(false);
    }
    // A thrown string still says which step failed.
    expect(ciRedactedError(thrownRaw).message).toContain('prover rejected');

    // A PARSER QUOTES WHAT IT COULD NOT PARSE. V8's JSON.parse puts the first
    // characters of its input in its own message (`Unexpected token 'A',
    // "AKAh9LUoWF"... is not valid JSON`), and the restock parsed its key file
    // with it: a treasury key stored in base58 put 9 of those 10 characters on
    // the public log, since none is a digit and 10 is not a long run (the web
    // run round-3 verifier's major; re-run on the unfixed tree as
    // `web-run/logs2/CI-1-cr1-probe-before-P1-base58-8.log`). So the redaction
    // masks what sits between quotes, read here on TWO keys: the redacted text
    // must not move with the key, and must hold no 4-character piece of
    // either. Fed the parser's own message, and the same shape written out,
    // so a Node that words it differently still exercises the rule.
    const base58Key = (n: number) => bs58.encode(Keypair.fromSeed(new Uint8Array(32).fill(n)).secretKey);
    const parseError = (text: string) => {
      try {
        JSON.parse(text);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    const piecesOf = (s: string) => Array.from({ length: s.length - 3 }, (_, i) => s.slice(i, i + 4));
    const keyPieces = [...piecesOf(base58Key(8)), ...piecesOf(base58Key(9))];
    // A key file cut by a newline puts the newline INSIDE the quoted span, and a
    // mask that read one line at a time kept the characters on each side of it
    // (the continued run's round-2 verifier, `web-run/logs2/verify-CI-1-r2-multiline.log`).
    const cut = (k: string) => `${k.slice(0, 4)}\n${k.slice(4)}`;
    // A quote INSIDE the quoted input (a key pasted behind a stray `x"`): V8
    // quotes `x"AKAh9LUo`, and a mask that closed at the first quote after it
    // opened kept `AKAh` outside every pair (the continued run's round-3
    // verifier, VR2). A library that quotes in backticks kept the whole
    // quoted piece from a mask that knew only `"` and `'` (VR3). Measured in
    // `web-run/logs2/CI-1-cr3-quote-probe.log`.
    for (const [shape, quoted] of [
      ["V8's own JSON.parse message", (k: string) => parseError(k)],
      ['the same shape, written out', (k: string) => `Unexpected token '${k[0]}', "${k.slice(0, 10)}"... is not valid JSON`],
      ["V8's own JSON.parse message, on a key cut by a newline", (k: string) => parseError(cut(k))],
      ['the same shape, written out, the key cut by a newline', (k: string) => `Unexpected token '${k[0]}', "${cut(k).slice(0, 11)}"... is not valid JSON`],
      ["V8's own JSON.parse message, on a key behind a stray quote", (k: string) => parseError(`x"${k}`)],
      ['the same shape, written out, a quote inside the quoted input', (k: string) => `Unexpected token 'x', "x"${k.slice(0, 8)}"... is not valid JSON`],
      ['the same shape, quoted in backticks', (k: string) => `Unexpected token \`${k[0]}\`, \`${k.slice(0, 10)}\`... is not valid JSON`],
    ] as const) {
      const messages = [base58Key(8), base58Key(9)].map((k) => quoted(k));
      expect(messages[0], `${shape}: parsing a base58 key did not fail, so nothing was read`).not.toBe('');
      const redacted = messages.map((m) => ciRedactedError(new Error(m)).message);
      const annotated = messages.map((m) => everyChannel(() => void ciFail(`top-up failed: ${m}`)));
      expect(redacted[0], `${shape}: the redacted message moved with the key`).toBe(redacted[1]);
      expect(annotated[0], `${shape}: the annotation moved with the key`).toBe(annotated[1]);
      for (const out of [...redacted, ...annotated]) {
        expect(keyPieces.filter((p) => out.includes(p)), `${shape}: a piece of a base58 key survived: ${out}`).toEqual([]);
      }
    }
    // A lone apostrophe opens no span (maskQuoted's comment says so), so a
    // message in plain English keeps its words and loses only its number.
    expect(redactForCi("the pool can't read leaf 211")).toBe("the pool can't read leaf [x]");

    // The NAME of a missing secret is not data and stays readable, or the
    // loud failure cannot say what is missing (mutant S17). Only a name that
    // stands alone: glued to a value it is part of one run, and masked whole.
    expect(redactForCi('P01_FUNDER_SECRET_KEY is unset')).toBe('P01_FUNDER_SECRET_KEY is unset');
    for (const glued of [
      `P01_FUNDER_SECRET_KEY=${BASE.funder}`,
      `P01_FUNDER_SECRET_KEY ${'AB12'.repeat(16)}`,
      `P01_FUNDER_SECRET_KEY: 211`,
    ]) {
      const out = redactForCi(glued);
      expect(out.includes(BASE.funder.slice(0, 8)) || out.includes('AB12') || /\d/.test(out.replace(/P01_/g, '')), `a value beside a name survived: ${out}`).toBe(false);
    }
  });

  it('the restock job and the top-up script print only through ciLog', () => {
    // ciSay cannot know what a number MEANS: a leaf index under 100 handed to it
    // as a count would be printed. Nothing in these files may reach a public
    // channel any other way, and every count is read here by name.
    //
    // ⚠️ THE CHANNEL IS NOT ONLY stdout. `$GITHUB_STEP_SUMMARY` is as public as
    // the log and the script already appends to it, so the file-write family is
    // read too (`SINK` above). A rule that knew only `console.` let a deposit
    // loop append `+1 leaf <index>` to the summary instead.
    const files: [string, string, boolean][] = [
      ['lib/privacy/pool/restockInventory.test.ts', source(webFile('lib/privacy/pool/restockInventory.test.ts')), true],
      ['scripts/topUpRestockWallet.mts', source(webFile('scripts/topUpRestockWallet.mts')), true],
      // It builds the line both jobs print. It speaks through its RETURN VALUE
      // rather than through ciLog, so only the sink half applies to it — but it
      // is read, because a console.log grown here reaches the same public log.
      ['lib/privacy/pool/restockTopUp.ts', source(webFile('lib/privacy/pool/restockTopUp.ts')), false],
    ];
    const offenders: string[] = [];

    for (const [name, text, speaks] of files) {
      if (speaks) {
        // An IMPORT, not the word: prose naming ciLog is not a call to it.
        if (!/^\s*import\s+\{[^}]*\}\s+from\s+'[^']*privacy\/ciLog';/m.test(text)) {
          offenders.push(`${name}: does not import privacy/ciLog (a comment naming it is not an import)`);
        }
        // And it must actually say something: going mute is not a fix.
        if (!/\bciSay\s*\(/.test(text)) offenders.push(`${name}: never calls ciSay`);
      }

      text.split(/\r?\n/).forEach((line, i) => {
        const at = `${name}:${i + 1}`;
        // Importing a writer is not writing. A whole-statement import only, so
        // `import …; console.log(leaf)` on one line is still read.
        if (/^\s*import\s[^;]*;\s*$/.test(line)) return;
        // ⚠️ The sink is matched on the WHOLE line and the exemption on the line
        // WITHOUT its comment, so a comment can add an offender but never hide
        // or excuse one.
        if (!SINK.test(line)) return;
        if (!VETTED_SINKS.some(([re]) => re.test(withoutComment(line).trim()))) {
          offenders.push(`${at} writes where the public can read it: ${line.trim()}`);
        }
      });

      // Every ciSay call: a fixed allowlisted phrase, then vetted counts. The
      // arguments are read by BALANCING the parentheses (`callsOf`), because
      // one extra `(` is all it takes to hide a count from a regex.
      for (const { at, args } of callsOf(text, 'ciSay')) {
        if (args === null) {
          offenders.push(`${name}:${at} has a ciSay( that never closes, so its counts cannot be read`);
          continue;
        }
        const first = args[0] ?? '';
        // A literal phrase is read here, word by word. A phrase held in a plain
        // variable — the script hands ciSay what formatTopUpLine returned — is
        // checked by ciSay ITSELF at run time, which throws on any word nothing
        // allowlisted and fails the step rather than printing it; the positive
        // control above is what pins that. ANY OTHER SHAPE is refused: a call,
        // a template literal or a concatenation both hides what will be said
        // and, spelled `ciSay(String('…'), leaf, wanted)`, hid the counts too.
        const phrase = /^'([^'\\]*)'$/.exec(first);
        if (phrase !== null) {
          for (const word of phrase[1].split(/\s+/).filter(Boolean)) {
            if (!CI_WORDS.has(word)) offenders.push(`${name}:${at} ciSay says "${word}", which is not allowlisted`);
          }
        } else if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(first)) {
          offenders.push(
            `${name}:${at} ciSay is given ${first || '(nothing)'}, which is neither an allowlisted phrase nor a plain variable`,
          );
        }
        // ciSay bounds a count to two digits but cannot know what a number
        // MEANS, so every count is read here, by name.
        for (const arg of args.slice(1)) {
          if (!VETTED_COUNTS.has(arg)) {
            offenders.push(`${name}:${at} ciSay is passed ${arg}, which is not one of the vetted counts`);
          }
        }
      }

      const { code, bare } = codeViews(text);

      // ── ciLog and vitest are reached by a named import, and nothing else ──
      //
      // ⚠️ THE RULES ABOVE READ `ciSay(` BY NAME, so any other name for it walks
      // past them: `const say = ciSay`, `ciSay as say`, or a namespace import
      // indexed by a computed key all handed a leaf to ciSay unread (mutant R4
      // of the round-1(b) verifier; X3, X11). Likewise a local function named
      // `ciRedactedError` or `redactForCi` keeps every vetted line intact while
      // redacting nothing (X1, X2). So: one named import per module, no
      // renaming, no dynamic import, and every other use a direct call.
      const importSpans: [number, number][] = [];
      for (const m of code.matchAll(/^[ \t]*import\s+\{([^}]*)\}\s*from\s*'([^']*)';/gm)) {
        const allowed = /(?:^|\/)ciLog$/.test(m[2]) ? CI_LOG_NAMES : m[2] === 'vitest' ? VITEST_NAMES : null;
        if (allowed === null) continue;
        importSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
        for (const imported of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!allowed.has(imported)) {
            offenders.push(`${name}:${lineAt(code, m.index ?? 0)} imports ${imported} from ${m[2]}, which is not a vetted name`);
          }
        }
      }
      const inImport = (index: number) => importSpans.some(([from, to]) => index >= from && index < to);
      for (const m of code.matchAll(/(['"])([^'"\n]*)\1/g)) {
        if ((/(?:^|\/)ciLog$/.test(m[2]) || m[2] === 'vitest') && !inImport(m.index ?? 0)) {
          offenders.push(`${name}:${lineAt(code, m.index ?? 0)} reaches ${m[2]} other than by a named import`);
        }
      }
      for (const m of bare.matchAll(/(?<![\w$.])(?:import|require)\s*\(/g)) {
        offenders.push(`${name}:${lineAt(bare, m.index ?? 0)} loads a module at run time, which nothing here can read`);
      }
      for (const m of bare.matchAll(/(?<![\w$])(ciSay|ciFail|ciRedactedError|redactForCi)(?![\w$])/g)) {
        const index = m.index ?? 0;
        if (inImport(index)) continue;
        const called = /^\s*\(/.test(bare.slice(index + m[0].length));
        const declared = /(?:\.|\bfunction\s*\*?|\bnew)\s*$/.test(bare.slice(Math.max(0, index - 16), index));
        if (!called || declared) {
          offenders.push(`${name}:${lineAt(bare, index)} uses ${m[1]} other than as a direct call to the import`);
        }
      }
      // A process listener can print, or rethrow raw, whatever the redacted
      // paths above caught (mutant X4).
      for (const m of bare.matchAll(
        /\bprocess\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener|setUncaughtExceptionCaptureCallback)\b/g,
      )) {
        offenders.push(`${name}:${lineAt(bare, m.index ?? 0)} installs a process listener`);
      }
      if (speaks && !/(?<![\w$.])ciSay\s*\(/.test(bare)) offenders.push(`${name}: never calls ciSay (outside comments)`);

      // ── the output objects, by NAME ────────────────────────────────────────
      //
      // ⚠️ `SINK` above is a list of CALL SPELLINGS, and a spelling is the
      // first thing an evasion changes: `const { log } = console`,
      // `process['stdout'].write`, `import { stdout } from 'node:process'`,
      // `process.emitWarning` and `const { info } = console` all printed a
      // wallet past it (mutants T10-T14 of the round-2(c) verifier), and so did
      // `globalThis['con' + 'sole']`, `(0, eval)(…)`, `process.exit(<a byte>)`
      // — the exit code is printed — and `process.env.NODE_DEBUG = …`, which
      // turns on node's own stderr tracing (S9, S11, S12, S14, S19, S20). So
      // the objects are found by name in `bare`, where no comment or string can
      // hold one, and each use must be one of the vetted member reads.
      for (const m of bare.matchAll(PRINTER_NAMES)) {
        const index = m.index ?? 0;
        const at = `${name}:${lineAt(bare, index)}`;
        const rest = bare.slice(index);
        if (m[1] === 'console') {
          const physical = text.split(/\r?\n/)[lineAt(bare, index) - 1] ?? '';
          if (!VETTED_SINKS.some(([re]) => re.test(withoutComment(physical).trim()))) {
            offenders.push(`${at} uses console outside the vetted sink`);
          }
          continue;
        }
        if (m[1] === 'process') {
          const envWrite =
            /^process\s*\.\s*env\s*(?:\??\.\s*[A-Za-z_$][\w$]*|\??\.?\s*\[[^\]]*\])\s*(?:\*\*|<<|>>>?|\?\?|\|\||&&|[-+*/%&|^])?=(?!=)/.test(rest) ||
            /\bdelete\s*$/.test(bare.slice(Math.max(0, index - 16), index));
          const vetted =
            /^process\s*\.\s*env\s*(?:\??\.\s*[A-Za-z_$][\w$]*|\??\.?\s*\[[^\]]*\]|;)/.test(rest) ||
            /^process\s*\.\s*argv\s*\.\s*includes\s*\(/.test(rest) ||
            /^process\s*\.\s*exit\s*\(\s*1\s*\)/.test(rest);
          if (!vetted || envWrite) offenders.push(`${at} uses process other than to read env, read argv, or exit(1)`);
          continue;
        }
        offenders.push(`${at} names ${m[1]}, which can print or reach a printer by another name`);
      }

      // ── no failure text is built here, but on a vetted line ────────────────
      //
      // ⚠️ A WORLD READS ONLY THE PATHS IT REACHES. Every rejection of the
      // script ends in main's catch, and every rejection of the restock in its
      // redacting rethrow, but the fake chains fail in two places (the
      // transfer, a deposit) and a real RPC can fail at any call. A message
      // decorated with a secret there rides out on the day that call fails.
      // The continued run's round-4 verifier's WK3 and RK1
      // (`.catch((e) => Promise.reject(new Error(…)))`) went red only once
      // their class held the secret in base58; the same line on the genesis
      // read, or on the restock's transfer, reaches no world at all (ER1-ER6,
      // `web-run/logs3/CI-1-cr4-mutants-*.log`). So what fails is a library's
      // message, redacted where it leaves, or fail()'s fixed text read above,
      // and these files build no failure text of their own: `ERROR_BUILDERS`
      // appears only on the lines `VETTED_ERROR_LINES` names.
      {
        const physical = text.split(/\r?\n/);
        for (const m of bare.matchAll(ERROR_BUILDERS)) {
          const line = physical[lineAt(bare, m.index ?? 0) - 1] ?? '';
          if ((VETTED_ERROR_LINES[name] ?? []).includes(line)) continue;
          offenders.push(`${name}:${lineAt(bare, m.index ?? 0)} builds or decorates an error, and a failure no world reaches would publish it: ${line.trim()}`);
        }
      }

      // Every module a file imports is one this test names: a new one — a
      // console, a process, a logger — costs a line here (S10). node:fs is
      // reached by named import only, so it cannot be indexed by a computed
      // key (S13); each name it brings is read by `SINK` above.
      const vettedImports = VETTED_IMPORTS[name];
      if (vettedImports === undefined) offenders.push(`${name}: no vetted import list`);
      for (const m of code.matchAll(/(?<![\w$.])(?:from|import)\s*(['"])([^'"\n]*)\1/g)) {
        if (vettedImports !== undefined && !vettedImports.modules.has(m[2])) {
          offenders.push(`${name}:${lineAt(code, m.index ?? 0)} imports ${m[2]}, which is not a vetted module for this file`);
        }
      }
      const fsSpecifiers = [...code.matchAll(/(['"])(?:node:)?fs(?:\/promises)?\1/g)].length;
      const fsImports = [...code.matchAll(/^[ \t]*import\s+\{([^}]*)\}\s*from\s*'node:fs';/gm)];
      if (fsSpecifiers !== fsImports.length) {
        offenders.push(`${name}: reaches fs other than by \`import { … } from 'node:fs'\``);
      }
      for (const m of fsImports) {
        for (const imported of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          if (vettedImports === undefined || !vettedImports.fs.has(imported)) {
            offenders.push(`${name}:${lineAt(code, m.index ?? 0)} imports ${imported} from node:fs, which is not vetted for this file`);
          }
        }
      }

      // ── what vitest prints on failure: the NAME and the MESSAGE ────────────
      //
      // ⚠️ AN ASSERTION MESSAGE IS A PUBLIC CHANNEL TOO. vitest prints the
      // message of a failing expect — under `--silent` as well — so a message
      // interpolating a leaf index publishes it on the run that fails (mutant N6,
      // `wp-logs/CI-1-fix2-mutants.log`). `expect.soft` does not throw, so the
      // redacting rethrow below never sees it (R1); `expect.fail` takes its
      // message FIRST (X6). The NAME of a suite or a case rides out on the same
      // failure (N13), whatever modifier it goes through (R2), and `.each` puts
      // values into it however plain it looks (X5). Every use is walked by
      // `vitestUses`, so each spelling ends at the same `(`.
      const cases: number[] = [];
      for (const use of vitestUses(bare)) {
        const where = `${name}:${use.at}`;
        if (inImport(use.index)) continue;
        if (use.open < 0) {
          offenders.push(`${where} uses ${use.name} without calling it`);
          continue;
        }
        if (use.name === 'expect') {
          if (use.chain.length > 1 || (use.chain.length === 1 && use.chain[0] !== 'soft')) {
            offenders.push(`${where} calls expect.${use.chain.join('.')}, which is not a vetted form`);
            continue;
          }
          const args = leadingArgs(code, use.open, 2);
          if (args.length >= 2 && !PLAIN_STRING.test(args[1])) {
            offenders.push(`${where} gives expect the message ${args[1]}, which is not a plain quoted string: vitest prints it on failure`);
          }
          continue;
        }
        const stray = use.chain.filter((w) => !CASE_MODIFIERS.has(w));
        if (stray.length > 0) {
          offenders.push(`${where} calls ${use.name}.${use.chain.join('.')}, which is not a vetted modifier`);
          continue;
        }
        const [label] = leadingArgs(code, use.open, 1);
        if (label !== undefined && !PLAIN_STRING.test(label)) {
          offenders.push(`${where} names a suite or case ${label}, which is not a plain quoted string: vitest prints it`);
        }
        if (use.name !== 'describe') cases.push(use.open);
      }

      // ── the live restock: every failure leaves through ciRedactedError ─────
      if (name.endsWith('restockInventory.test.ts')) {
        if (cases.length === 0) offenders.push(`${name}: no case, so there is no redacting rethrow to read`);
        for (const open of cases) {
          const close = closingParen(code, open);
          const body = close < 0 ? '' : code.slice(open + 1, close).replace(/\s+/g, ' ').trim();
          if (!REDACTING_CASE.test(body)) {
            offenders.push(
              `${name}:${lineAt(code, open)} a case is not \`try { await work(); } catch (e) { throw ciRedactedError(e); }\`, so a raw library message reaches the log`,
            );
          }
        }
        // One throw per case, and it is the redacted one. A throw at describe
        // or module scope is printed at collection, raw (mutant X7).
        const throws = [...bare.matchAll(/(?<![\w$.])throw(?![\w$])/g)].length;
        if (throws !== cases.length) {
          offenders.push(`${name}: ${throws} throw statements for ${cases.length} redacting case(s); any other throw reaches the log raw`);
        }
      }

      // ── the top-up script: every failure leaves through fail() ─────────────
      if (name.endsWith('topUpRestockWallet.mts')) {
        const exits = code.split(/\r?\n/).filter((l) => l === SCRIPT_EXIT).length;
        if (exits !== 1) offenders.push(`${name}: the vetted exit line appears ${exits} times, at top level; it must appear once`);
        const mains = [...bare.matchAll(/(?<![\w$.])main(?![\w$])/g)].length;
        if (!/^async function main\(\) \{$/m.test(bare) || mains !== 2) {
          offenders.push(`${name}: main is declared or called other than by the vetted exit line (${mains} uses)`);
        }
        if (/(?<![\w$.])throw(?![\w$])/.test(bare)) {
          offenders.push(`${name}: throws, and a throw outside main's vetted catch reaches the log raw; use fail()`);
        }
        // Its own stderr is private (case 8), so a failure that is not recorded
        // through ciFail raises no annotation anyone can read.
        if (!/(?<![\w$.])ciFail\s*\(/.test(bare)) {
          offenders.push(`${name}: never calls ciFail, so a failure is recorded nowhere the public step prints`);
        }
        // A loud failure has to say WHICH secret is missing. fail() redacts
        // everything, and a 21-character env name is a long run, so before
        // `CI_ENV_NAMES` the annotation read `[x] is unset`
        // (`wp-logs/verify/CI-1-r2c-script-noenv.log`). Every name in a fixed
        // fail() message must come out of redactForCi as written (S16).
        let named = 0;
        for (const { at, args } of callsOf(code, 'fail')) {
          const first = args?.[0] ?? '';
          if (!/^'[^'\\]*'(?:\s*\+\s*'[^'\\]*')*$/.test(first)) continue;
          const literal = first.split(/'\s*\+\s*'/).join('').replace(/^'|'$/g, '');
          for (const envName of literal.match(/\bP01_[A-Z0-9_]+\b/g) ?? []) {
            named += 1;
            if (!redactForCi(literal).includes(envName)) {
              offenders.push(`${name}:${at} fail() names ${envName}, which redactForCi masks, so the operator cannot tell what is missing`);
            }
          }
        }
        if (named === 0) offenders.push(`${name}: no fixed fail() message names a secret, so the readability rule reads nothing`);
        // Every refusal has a class in the fake-chain case, which reads what
        // a refusal puts on the record: a refusal no world reaches can quote
        // what it holds and stay green (the continued run's round-3 verifier,
        // VR1). So the calls are counted, and a new one is an offender until
        // `TOPUP_REFUSAL_CLASSES` names the class that reaches it (NF1).
        const lines = code.split('\n');
        const refusals = callsOf(code, 'fail').filter(({ at }) => !/\bfunction\s+fail\s*\(/.test(lines[at - 1] ?? ''));
        if (refusals.length !== TOPUP_REFUSAL_CLASSES.length) {
          offenders.push(
            `${name}: ${refusals.length} fail() calls for ${TOPUP_REFUSAL_CLASSES.length} refusal classes in the fake-chain case; a refusal no world reaches can quote what it holds`,
          );
        }
        for (const c of TOPUP_REFUSAL_CLASSES) {
          if (!TOPUP_GROUPS.some(([base]) => base === c)) offenders.push(`${name}: the refusal class "${c.name}" is not run by the fake-chain case`);
        }
        // ⚠️ THE COUNT READS `fail(` BY NAME. The same refusal spelled
        // `ciFail(…); process.exit(1);`, or made through `const die = fail`,
        // was not counted, and no world reached it (the continued run's
        // round-4 verifier's NF2; NF3, NF4). So fail() is the only way out:
        // ciFail and process.exit are called once each, inside its body and
        // nowhere else, and fail is used only as a direct call.
        const failDecls = [...bare.matchAll(/(?<![\w$.])function\s+fail\s*\(/g)];
        const params = failDecls.length === 1 ? closingParen(bare, (failDecls[0].index ?? 0) + failDecls[0][0].length - 1) : -1;
        const bodyOpen = params < 0 ? -1 : bare.indexOf('{', params);
        const bodyClose = bodyOpen < 0 ? -1 : closingBrace(bare, bodyOpen);
        if (bodyClose < 0) offenders.push(`${name}: fail is not declared once as a function whose body can be read`);
        const insideFail = (index: number) => bodyClose >= 0 && index > bodyOpen && index < bodyClose;
        const onlyInFail: [string, RegExp][] = [
          ['ciFail', /(?<![\w$.])ciFail\s*\(/g],
          ['process.exit', /(?<![\w$.])process\s*\.\s*exit(?![\w$])/g],
        ];
        for (const [what, re] of onlyInFail) {
          const found = [...bare.matchAll(re)].map((m) => m.index ?? 0);
          if (found.length !== 1 || !insideFail(found[0])) {
            offenders.push(`${name}: ${what} appears ${found.length} time(s), not once inside fail(), so a refusal can leave without being counted`);
          }
        }
        for (const m of bare.matchAll(/(?<![\w$.])fail(?![\w$])/g)) {
          const index = m.index ?? 0;
          const declared = /\bfunction\s+$/.test(bare.slice(Math.max(0, index - 16), index));
          if (!declared && !/^\s*\(/.test(bare.slice(index + m[0].length))) {
            offenders.push(`${name}:${lineAt(bare, index)} uses fail other than as a direct call, which hides its calls from the count`);
          }
        }
      }
    }

    // ── ciLog.ts itself: the one module that prints, through three lines ────
    //
    // ⚠️ Cases 2-5 read what ciSay prints where they look for it, which is not
    // everywhere a process can write: a refusal that first went to
    // `process._rawDebug` (fd 2, printed under --silent) passed them all, and
    // until this block nothing read ciLog.ts's own source (mutants U1-U1d,
    // `web-run/logs/CI-1-wr1-mutants-*.log`). So its sinks are read by name,
    // the same way as the three files above, against its own lines.
    {
      const name = 'lib/privacy/ciLog.ts';
      const text = source(webFile(name));
      const { code, bare } = codeViews(text);
      const physical = text.split(/\r?\n/);
      const ownSink = (line: string) => CI_LOG_OWN_SINKS.some((re) => re.test(withoutComment(line).trim()));
      physical.forEach((line, i) => {
        if (/^\s*import\s[^;]*;\s*$/.test(line)) return;
        if (SINK.test(line) && !ownSink(line)) offenders.push(`${name}:${i + 1} writes where the public can read it: ${line.trim()}`);
      });
      for (const m of bare.matchAll(PRINTER_NAMES)) {
        const index = m.index ?? 0;
        const at = `${name}:${lineAt(bare, index)}`;
        if (m[1] === 'console') {
          if (!ownSink(physical[lineAt(bare, index) - 1] ?? '')) offenders.push(`${at} uses console outside its vetted lines`);
          continue;
        }
        // One read of the verdict file's name, and nothing else of process.
        if (m[1] === 'process' && /^process\.env\[CI_VERDICT_FILE_ENV\];/.test(bare.slice(index))) continue;
        offenders.push(`${at} names ${m[1]}, which can print or reach a printer by another name`);
      }
      for (const m of bare.matchAll(/(?<![\w$.])(?:import|require)\s*\(/g)) {
        offenders.push(`${name}:${lineAt(bare, m.index ?? 0)} loads a module at run time, which nothing here can read`);
      }
      for (const m of code.matchAll(/(?<![\w$.])(?:from|import)\s*(['"])([^'"\n]*)\1/g)) {
        if (m[2] !== 'node:fs') offenders.push(`${name}:${lineAt(code, m.index ?? 0)} imports ${m[2]}, which is not a vetted module for ciLog`);
      }
      const fsImports = [...code.matchAll(/^[ \t]*import\s+\{([^}]*)\}\s*from\s*'node:fs';/gm)];
      if ([...code.matchAll(/(['"])(?:node:)?fs(?:\/promises)?\1/g)].length !== fsImports.length) {
        offenders.push(`${name}: reaches fs other than by \`import { … } from 'node:fs'\``);
      }
      for (const m of fsImports) {
        for (const imported of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
          if (imported !== 'appendFileSync') offenders.push(`${name} imports ${imported} from node:fs, which is not vetted for ciLog`);
        }
      }
      // It must still speak through each line, or the rule reads nothing.
      if (CI_LOG_OWN_SINKS.some((re) => physical.filter((l) => re.test(withoutComment(l).trim())).length !== 1)) {
        offenders.push(`${name}: its vetted sinks are not each present once, so this block reads a different module`);
      }
    }
    expect(offenders, 'output that does not go through ciLog').toEqual([]);
  });

  it('the public workflows echo no response body and run the restock silently', async () => {
    const settle = source(repoFile('.github/workflows/settle-till.yml'));
    const restock = source(repoFile('.github/workflows/restock-inventory.yml'));
    const offenders: string[] = [];

    // ── neither workflow may trace its own shell, or run an action nobody read ─
    //
    // `set -x` echoes every command WITH ITS VALUES EXPANDED, so the three
    // vetted body parses would each print the body and every "quiet" line above
    // would print its variables (mutant N5). An action is code this repository
    // does not read, writing to this same public log (`uses:` allowlist).
    for (const [name, text] of [
      ['settle-till.yml', settle],
      ['restock-inventory.yml', restock],
    ] as const) {
      for (const { at, line } of shellLines(text)) {
        if (/(?:^|[\s;&|(])set\s+(?:.*\s)?(?:-[a-zA-Z]*x|[-+]o\s+xtrace)/.test(line)) {
          offenders.push(`${name}:${at} turns on shell tracing, which prints every command with its values: ${line}`);
        }
      }
      // ⚠️ A GITHUB EXPRESSION IN A `run:` BODY IS NOT A SHELL VARIABLE. The
      // runner substitutes it into the script before bash starts, and a
      // repository variable or a step output is not masked the way a secret is,
      // so `echo "wallet ${{ vars.… }}"` printed a value that no `$VAR` rule can
      // see (mutants T2 and T2b of the round-2(c) verifier). Read on the RAW
      // line, comments included: the substitution happens before the shell
      // decides what a comment is (S22). An expression belongs in an env
      // VALUE, and every env value is pinned by its exact text (below).
      for (const { at, physical } of runBodyLines(text)) {
        if (physical.includes('${{')) {
          offenders.push(`${name}:${at} puts a GitHub expression in a run body instead of env: ${physical.trim()}`);
        }
      }
      // ⚠️ AND NOT ANYWHERE ELSE EITHER: a step name, a `with:` input, a job
      // key. Read on the RAW lines, comments included, so a YAML block scalar
      // cannot pass one off as prose (Z3, E3; `VETTED_ENV_VALUES` above). Then
      // every env value, action input and `if:` is held to its exact text (E1,
      // E4, E5, E6, E7, E10). And an expression is the WHOLE value of its env
      // entry, one `${{ … }}` and nothing beside it, so no reader has to decide
      // which part of a value the runner computed (continued run; PL6).
      const pins = workflowPins(name, text);
      const envLines = new Set(pins.env.map((e) => e.at));
      text.split(/\r?\n/).forEach((raw, i) => {
        if (!raw.includes('${{')) return;
        if (!envLines.has(i + 1) || isCommentLine(raw)) {
          offenders.push(`${name}:${i + 1} puts a GitHub expression somewhere other than an env value, where GitHub masks only the exact secret: ${raw.trim()}`);
        } else if (!/^\s*[A-Za-z_][A-Za-z0-9_]*: \$\{\{ (?:(?!\$\{\{|\}\}).)+ \}\}$/.test(raw)) {
          offenders.push(`${name}:${i + 1} an env value that is not one expression, whole: ${raw.trim()}`);
        }
      });
      // Every non-comment line, by its exact text; free lines only where they
      // are free (`workflowLineOffences`).
      offenders.push(...workflowLineOffences(name, text));
      offenders.push(
        ...yamlFormOffences(name, text),
        ...pins.offences,
        ...pinOffences(name, 'env entry', pins.env, VETTED_ENV_VALUES[name]),
        ...pinOffences(name, 'action input', pins.with, VETTED_WITH[name]),
        ...pinOffences(name, 'step condition', pins.if, VETTED_IFS[name]),
      );
      // ⚠️ TRACING HAS MORE SWITCHES THAN `set -x`: `bash -xe {0}` (the flag is
      // not always last in its cluster), and the variables bash reads at start
      // — SHELLOPTS=xtrace in an env block or written to $GITHUB_ENV, BASH_ENV
      // naming a file it sources (mutants T1, T1c, T1d of the round-2(c)
      // verifier; S3, S4). Read on the comment-free text, so prose may name them.
      const TRACE_SWITCH = /\b(?:xtrace|SHELLOPTS|BASHOPTS|BASH_ENV|BASH_XTRACEFD|PS4|GITHUB_ENV|GITHUB_PATH)\b|^\s*ENV\s*:|(?<![\w$])ENV=/m;
      text.split(/\r?\n/).forEach((raw, i) => {
        const line = withoutComment(raw, true).trim();
        const uses = /^-?\s*uses:\s*(\S+)/.exec(line);
        if (uses !== null && !VETTED_USES.has(uses[1])) {
          offenders.push(`${name}:${i + 1} runs an action nothing vetted: ${uses[1]}`);
        }
        // A closed set of one: the runner's default bash. Any other shell
        // line — a flag cluster, `-o xtrace`, another interpreter — is looked
        // at first (T1, T1c; S5).
        const shell = /^-?\s*shell\s*:\s*(.*)$/.exec(line);
        if (shell !== null && shell[1].trim() !== 'bash') {
          offenders.push(`${name}:${i + 1} asks for a shell nothing vetted: ${line}`);
        }
        if (/^shell:.*\s-[a-zA-Z]*x[a-zA-Z]*(?:\s|$)/.test(line)) {
          offenders.push(`${name}:${i + 1} asks for a tracing shell: ${line}`);
        }
        if (TRACE_SWITCH.test(line)) {
          offenders.push(`${name}:${i + 1} names a switch that turns on shell tracing or loads a file into every step: ${line}`);
        }
        // `run:` written any way but as a key (`- { name: x, run: … }`) is a
        // command `shellLines` never reads (S21).
        if (/(?:^|[\s{,])run\s*:/.test(line) && !/^(?:-\s+)?run:/.test(line)) {
          offenders.push(`${name}:${i + 1} writes run: in a form this test does not read: ${line}`);
        }
      });
      // Every env block, at any level: a variable read at process start can
      // load code before anything is silenced (mutants W9-W11, W13, W15).
      offenders.push(...envOffences(name, text, VETTED_ENV[name]));
    }

    // npm reads apps/web/.npmrc for every `npx` the two restock steps run, and
    // its `node-options` is a preload (mutant W12). Keys only are named: a
    // value there can be a registry token.
    const npmrcAbs = webFile('.npmrc');
    if (existsSync(npmrcAbs)) {
      readFileSync(npmrcAbs, 'utf8')
        .split(/\r?\n/)
        .forEach((raw, i) => {
          const line = raw.trim();
          if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
          const key = /^([^=\s]+)\s*=/.exec(line)?.[1] ?? '(a line with no key)';
          if (!VETTED_NPMRC_KEYS.has(key)) offenders.push(`apps/web/.npmrc:${i + 1} sets ${key}, which is not a vetted npm key`);
        });
    }

    // ── settle-till ───────────────────────────────────────────────────────────
    //
    // ⚠️ NOT A LIST OF THE WAYS TO PRINT THE BODY. `echo "$body"` is the shape
    // that shipped; printf, cat, tee, a here-doc or an intermediate variable all
    // walk past a rule that names it, and the response carries the till and
    // float balances, the amount and the batch's purchase count. So it is turned
    // round twice over: EVERY line that names $body must be one of the three
    // vetted parses, whatever verb it uses, and every line whose stdout is not
    // captured or privately redirected is PUBLIC — which is what catches the
    // body piped straight from curl into python without ever being named
    // (`publicOffences`, mutant N3).
    const SETTLE_PARSE =
      /^(?:settled|verdict|alarm)=\$\(printf '%s' "\$body" \| python3 -c "import sys,json;print\(json\.load\(sys\.stdin\)\.get\('(?:settled|verdict|floatAlarm)'\)\)"\)$/;
    const SETTLE_SUMMARY =
      /^echo "verdict=\$verdict settled=\$settled floatAlarm=\$alarm" >> "\$GITHUB_STEP_SUMMARY"$/;
    const SETTLE_MAY_NAME = new Set(['verdict', 'settled', 'alarm', 'GITHUB_STEP_SUMMARY']);
    /**
     * The job is curl, parse, echo. The curl runs inside a capture, but a
     * capture keeps only STDOUT (mutant X8), so it is vetted by line.
     */
    const SETTLE_VETTED_PUBLIC: [RegExp, string][] = [
      [
        exactly('body=$(curl -sS --fail-with-body --max-time 120 -H "authorization: Bearer $SECRET" "$ENDPOINT")'),
        "--fail-with-body sends the body to stdout, which is captured; -sS leaves curl's own one-line error on stderr, which names no field of the body",
      ],
      [
        exactly('if [ -z "${SECRET:-}" ]; then'),
        'branches on whether the secret is SET, which the loud failure below exists to say; never on its value',
      ],
    ];
    let summaryLines = 0;

    for (const { at, line } of shellLines(settle)) {
      const where = `settle-till.yml:${at}`;
      if (SETTLE_PARSE.test(line)) continue; // reads one named field, prints nothing
      if (line.includes('$body')) {
        offenders.push(`${where} names the response body outside the vetted parses: ${line}`);
        continue;
      }
      if (SETTLE_SUMMARY.test(line)) {
        summaryLines += 1;
        continue;
      }
      offenders.push(...publicOffences(where, line, SETTLE_MAY_NAME, SETTLE_VETTED_PUBLIC));
    }
    // It must still SAY what happened, or this case would be satisfied by a job
    // that went mute — and by prose, if it read the whole file for a phrase
    // instead of the one LINE that writes to the public summary.
    expect(summaryLines, 'exactly one line writes the settlement verdict to the public summary').toBe(1);

    // ── restock-inventory: the flags on the COMMAND, not in the prose ─────────
    //
    // ⚠️ THE STEP, AND THE STEP'S COMMAND. `name: Restock the note inventory` on
    // the JOB would let a `--silent` anywhere in the file count; and the comment
    // above the run block names both flags, so a rule that reads the step TEXT
    // is satisfied by its own documentation while the command runs without them.
    const stepAt = restock.indexOf('- name: Restock\n');
    expect(stepAt, 'the Restock step must still be named `- name: Restock`').toBeGreaterThan(-1);
    const nextStep = restock.indexOf('\n      - name:', stepAt);
    const stepCode = noComments(restock.slice(stepAt, nextStep > -1 ? nextStep : undefined));

    const vitestCalls = joinContinuations(stepCode).filter((l) => /\bvitest\b/.test(l));
    if (vitestCalls.length === 0) {
      offenders.push('restock-inventory.yml: the Restock step no longer runs vitest, so this case reads nothing');
    }
    for (const call of vitestCalls) {
      for (const flag of ['--silent', '--reporter=dot', '--disableConsoleIntercept=false']) {
        if (!call.includes(flag)) {
          offenders.push(`restock-inventory.yml: the Restock step runs vitest without ${flag}: ${call}`);
        }
      }
      // The config the command names is READ, not assumed (the round-3
      // verifier's major; mutants W1, W3-W8, W16). It is resolved from the
      // step's working directory, which is pinned so the file read here is the
      // file vitest loads (W14).
      const config = /(?:^|\s)--config[= ](\S+)/.exec(call)?.[1];
      if (config === undefined) {
        offenders.push(`restock-inventory.yml: the Restock step names no --config, so vitest would pick one this test never read: ${call}`);
      } else {
        offenders.push(...(await configOffences(webFile(config))));
      }
    }
    if (!/^\s*working-directory:\s*apps\/web\s*$/m.test(stepCode)) {
      offenders.push('restock-inventory.yml: the Restock step does not run from apps/web, so its --config is not the file read here');
    }
    // --silent swallows stdout, so ciSay writes to a file instead. BOTH halves
    // of that channel are required — the step that sets it and the step that
    // prints it — and prose naming the variable is neither.
    if (!/^\s*P01_CI_VERDICT_FILE:\s*\S/m.test(stepCode)) {
      offenders.push('restock-inventory.yml: the Restock step sets no P01_CI_VERDICT_FILE, so a --silent run says nothing at all');
    }
    if (!/\bcat "\$P01_CI_VERDICT_FILE"/.test(noComments(restock))) {
      offenders.push('restock-inventory.yml: no step prints the verdict file');
    }

    // ── restock-inventory: the top-up's OWN streams stay off the log ──────────
    //
    // ⚠️ A LIBRARY PRINTS ON ITS OWN, AND NOTHING THIS REPOSITORY WRITES CAN
    // REFUSE IT. web3.js answers a failed websocket `signatureSubscribe` with
    // `console.error('Received JSON-RPC error calling `signatureSubscribe`',
    // { args: [<the transfer signature>, …] })`, in a retry loop. The web run
    // round-1 verifier ran the real script against a fake RPC and counted the
    // signature 43,720 times in the step log
    // (`web-run/logs/verify-CI-1-r1-topup-probe-wserror.log`). So the step
    // sends BOTH its streams to private files, and the script records its
    // verdict and its redacted `::error::` in the verdict file, which "Say what
    // happened" prints. `2>&1` is refused by `segments` on purpose: it sends
    // stderr wherever stdout goes, which this rule does not follow. (The script
    // also confirms by status polling now, which removes that one print at its
    // source; the top-up case below pins that. This rule covers the rest.)
    const topUpAt = restock.indexOf('- name: Top up the restock wallet from the float\n');
    expect(topUpAt, 'the top-up step must still be named `- name: Top up the restock wallet from the float`').toBeGreaterThan(-1);
    const topUpNext = restock.indexOf('\n      - name:', topUpAt);
    const topUpCalls = joinContinuations(noComments(restock.slice(topUpAt, topUpNext > -1 ? topUpNext : undefined)))
      .filter((l) => /topUpRestockWallet/.test(l))
      .map((l) => l.replace(/^run:\s*/, ''));
    if (topUpCalls.length !== 1) {
      offenders.push(`restock-inventory.yml: the top-up step runs the script ${topUpCalls.length} times; this case reads exactly one`);
    }
    for (const call of topUpCalls) {
      const parts = segments(call);
      if (parts.length !== 1 || !allPrivate(redirectsOf(parts[0], 1)) || !allPrivate(redirectsOf(parts[0], 2))) {
        offenders.push(
          `restock-inventory.yml: the top-up step does not keep both its stdout and its stderr off the public log, where web3.js prints the transfer signature on its own: ${call}`,
        );
      }
    }
    // ⚠️ THE TWO PROGRAMS THE JOB RUNS ARE VETTED BY THEIR EXACT LINE, and a
    // line names a file RELATIVE to its step's directory. So each vetted line
    // runs once, in its own step, and that step runs from apps/web: the same
    // line in a second step with another `working-directory`, or the top-up's
    // own directory moved, runs a file cases 7, 9 and 10 never read (mutants
    // K11-K13; `cd` is refused as a command, K10).
    const TOPUP_LINE = 'npx tsx scripts/topUpRestockWallet.mts > "$RUNNER_TEMP/topup.out" 2> "$RUNNER_TEMP/topup.err"';
    const RESTOCK_LINE =
      /^npx vitest run --config vitest\.pool\.config\.mts --silent --reporter=dot --disableConsoleIntercept=false lib\/privacy\/pool\/restockInventory\.test\.ts$/;
    if (topUpCalls.length !== 1 || topUpCalls[0] !== TOPUP_LINE) {
      offenders.push(`restock-inventory.yml: the top-up step does not run exactly the vetted line ${TOPUP_LINE}`);
    }
    if (!/^\s*working-directory:\s*apps\/web\s*$/m.test(noComments(restock.slice(topUpAt, topUpNext > -1 ? topUpNext : undefined)))) {
      offenders.push('restock-inventory.yml: the top-up step does not run from apps/web, so its vetted line runs a file this test never read');
    }
    const restockLines = shellLines(restock).map((l) => l.line);
    const topUpRuns = restockLines.filter((l) => l === TOPUP_LINE).length;
    if (topUpRuns !== 1) offenders.push(`restock-inventory.yml: the vetted top-up line runs ${topUpRuns} times; once, in its own step`);
    const restockRuns = restockLines.filter((l) => RESTOCK_LINE.test(l)).length;
    if (restockRuns !== 1 || !vitestCalls.some((c) => RESTOCK_LINE.test(c))) {
      offenders.push(`restock-inventory.yml: the vetted restock line runs ${restockRuns} times, or outside the Restock step; once, in that step`);
    }
    // A private file stays private only while nothing prints it, and the
    // verdict file IS printed. So its path is pinned, and no command may write
    // into it by redirection, in any stream: `2> "$RUNNER_TEMP/ci-verdicts.txt"`
    // is one name in $RUNNER_TEMP, private to `PRIVATE_DEST`, and is cat'ed
    // onto the log a step later.
    for (const [name, text] of [
      ['settle-till.yml', settle],
      ['restock-inventory.yml', restock],
    ] as const) {
      text.split(/\r?\n/).forEach((raw, i) => {
        const m = /^\s*P01_CI_VERDICT_FILE\s*:\s*(.*)$/.exec(withoutComment(raw, true));
        if (m !== null && m[1].trim() !== VERDICT_FILE_VALUE) {
          offenders.push(`${name}:${i + 1} points P01_CI_VERDICT_FILE somewhere other than ${VERDICT_FILE_VALUE}`);
        }
      });
      for (const { at, line } of shellLines(text)) {
        for (const part of segments(line)) {
          for (const { to } of outputRedirects(part) ?? []) {
            if (/ci-verdicts|P01_CI_VERDICT_FILE/.test(to)) {
              offenders.push(`${name}:${at} redirects into the verdict file, which the next step prints: ${line}`);
            }
          }
        }
      }
    }

    // The same public/private rule, over every command the job runs. $size and
    // $STOCK stay: $size is the vetted parser's output, one integer from the
    // public `GET /api/issue-note` (the CONFIGURED size, spent or not), and
    // $STOCK is pinned to `${{ steps.stock.outputs.size }}`, which that step
    // writes from $size (`VETTED_ENV_VALUES`, mutant E1). Neither is the
    // restock's unspent count, which no step here prints (the restock case
    // below runs the file to show it). A wallet, a key,
    // a leaf or a balance is not on this list, so printing one is an offender
    // whatever the verb. And a command that is not QUIET, `echo` or `printf`
    // has to be vetted BY LINE, WHEREVER ITS STREAMS GO (`segmentOffences`):
    // that stops a script redirecting its own stdout into the step summary
    // (mutant N4), and a command with both streams private writing a public
    // file by argument (the web run round-2 verifier's K1-K4). The top-up
    // command is vetted by its exact line again, both redirects included, and
    // the rule above still reads those redirects.
    const RESTOCK_MAY_NAME = new Set(['size', 'STOCK', 'P01_TREASURY_LOW_WATER', 'GITHUB_OUTPUT']);
    const RESTOCK_VETTED_PUBLIC: [RegExp, string][] = [
      [/^pnpm install --frozen-lockfile$/, 'installs the lockfile; it names packages, never this deployment'],
      [
        exactly(TOPUP_LINE),
        "the top-up: both its streams to private files (the rule above), and it speaks only through ciLog into the verdict file and the step summary (cases 7 and 10 read and run it)",
      ],
      [
        exactly(
          `size=$(curl -sf "$P01_BASE/api/issue-note" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(Number.isInteger(j.inventorySize)?j.inventorySize:'')}catch{console.log('')}})")`,
        ),
        'reads the PUBLIC GET /api/issue-note: -sf prints nothing on failure, and the parser prints one integer or nothing, to the capture',
      ],
      [
        exactly('if [ -z "$TREASURY_KEYPAIR_JSON" ]; then'),
        'branches on whether the key is SET, which the warning or the error below exists to say; never on its value',
      ],
      [RESTOCK_LINE, 'the restock, silenced; the flags are read again, off this same command, above'],
      [
        exactly('if [ -s "$P01_CI_VERDICT_FILE" ]; then'),
        'asks whether the verdict file holds anything, so an empty run still says so',
      ],
      [
        /^cat "\$P01_CI_VERDICT_FILE"$/,
        "prints the verdict file: ciSay's allowlisted lines and ciFail's redacted annotations, and nothing redirected into it (above)",
      ],
    ];
    for (const { at, line } of shellLines(restock)) {
      offenders.push(...publicOffences(`restock-inventory.yml:${at}`, line, RESTOCK_MAY_NAME, RESTOCK_VETTED_PUBLIC));
    }

    expect(offenders, 'public workflow steps that print more than a verdict').toEqual([]);
  });

  it('the live restock, run against a fake chain, says nothing that moves with the unspent stock, the leaves, the balance or the random draws', { timeout: 120_000 }, async () => {
    // The sweep is the measurement, so the table is checked before it is run:
    // each class must still hold every unspent count it claims to (a world
    // dropped from a range would silently narrow it back to a sample).
    const held = (base: RestockWorld) =>
      new Set([base, ...(RESTOCK_GROUPS.find(([b]) => b === base)?.[1] ?? [])].map(unspentOf));
    const holds = (base: RestockWorld, want: number[]) => want.every((k) => held(base).has(k));
    expect(holds(R_ABOVE, [...counts(8, 20), 21, 64, 256, 512]), 'the above-low-water class no longer sweeps 8-20 and its ladder').toBe(true);
    expect(holds(R_BELOW, counts(0, 7)), 'the below-low-water class no longer sweeps 0-7').toBe(true);
    expect(holds(R_FLOOR, [...counts(0, 20), 21, 64, 256, 512]), 'the floor class no longer sweeps 0-20 and its ladder').toBe(true);
    expect(holds(R_FAILS, counts(0, 7)), 'the failing class no longer sweeps 0-7').toBe(true);
    // Each class the workflow reaches with a readable key file holds it in
    // both shapes the job reads, from two wallets (RK1).
    for (const base of [R_ABOVE, R_BELOW, R_FLOOR, R_FAILS]) {
      const all = [base, ...(RESTOCK_GROUPS.find(([b]) => b === base)?.[1] ?? [])];
      const shapes = new Set(all.map((w) => `${w.keyText === asBase58 ? 'base58' : w.keyText === undefined ? 'json' : 'other'}:${w.wallet}`));
      expect(['json:50', 'json:51', 'base58:50', 'base58:51'].filter((s) => !shapes.has(s)), `the class "${base.name}" no longer holds the key file in both shapes, from two wallets`).toEqual([]);
    }

    // No 4-character piece of either treasury wallet's key, secret or public,
    // in base58, nor of the deposit's ephemeral or of a signature the fake
    // chain returns, on ANY record, base or variant. The differential cannot
    // see a piece two keys share; this does not rely on one.
    const restockPieces = [
      ...[50, 51].flatMap((w) => [bs58.encode(secretOf(w)), key(w)]),
      key(60),
      ...[70, 81, 82, 83].map(sig),
    ].flatMap(piecesOf);
    const offRestockRecord = (name: string, record: string) =>
      expect(restockPieces.filter((p) => record.includes(p)), `a piece of a key reached the record in the world "${name}"`).toEqual([]);

    const h = await restockHarness();
    try {
      expect(h.captured, 'the restock file registered no case, so nothing here ran it').toBe(true);
      // Discarded: anything a module prints once, on first use, lands here and
      // not in a world being compared.
      await h.tick(R_ABOVE);

      const bases = new Map<string, RestockTick>();
      for (const [base, variants] of RESTOCK_GROUPS) {
        const b = await h.tick(base);
        expect(b.settled, `the restock never finished in the world "${base.name}"`).toBe(true);
        expect(b.record, `the world "${base.name}" put nothing on the record`).not.toBe('');
        offRestockRecord(base.name, b.record);
        bases.set(base.name, b);
        for (const v of variants) {
          const r = await h.tick(v);
          expect(r.settled, `the restock never finished in the world "${v.name}"`).toBe(true);
          offRestockRecord(v.name, r.record);
          // The chain reads the same in both worlds, or a moved line could be
          // a fact the chain already publishes.
          expect(r.deposits, `the world "${v.name}" changed what the chain shows`).toBe(b.deposits);
          // THE MEASUREMENT: two ticks apart, a count that moved with the
          // unspent stock gave the number of issued notes spent in between.
          expect(r.record, `the restock's public record moved with ${v.name}`).toBe(b.record);
        }
      }

      // Positive controls: the job really ran, down every branch, and said so.
      const [above, below, floor, fails, badKey] = [R_ABOVE, R_BELOW, R_FLOOR, R_FAILS, R_BADKEY].map((w) => bases.get(w.name) as RestockTick);
      expect(above.deposits, 'above low water, nothing is deposited').toBe(0);
      expect(below.deposits, 'below low water, the tick deposits up to its bound').toBe(3);
      expect(below.stockReads, 'the stock is read before and after the deposits').toBe(2);
      expect(floor.deposits, 'under the floor, nothing is deposited').toBe(0);
      expect(fails.deposits, 'a failed deposit lands nothing').toBe(0);
      expect(badKey.deposits, 'a key file with no keypair deposits nothing').toBe(0);
      expect(new Set([above, below, floor, fails, badKey].map((t) => t.record)).size, 'two branches read the same, so this harness cannot tell them apart').toBe(5);
      // A key file with no keypair says so and names the secret to fix, and
      // nothing of what it read: the parser's own message quoted it.
      expect(badKey.rejection).toContain('P01_TREASURY_KEYPAIR_JSON');
      expect(badKey.rejection).toContain('holds no keypair');
      expect(LONG_RUN.test(badKey.rejection), 'a long run survived the refusal of a key file').toBe(false);
      expect(/\d/.test(badKey.rejection.split('P01_TREASURY_KEYPAIR_JSON').join('')), 'a number survived the refusal of a key file').toBe(false);
      for (const t of [above, below, floor]) {
        expect(t.rejection, 'a tick that should end cleanly threw').toBe('');
        const stray = t.verdicts
          .split(/\s+/)
          .filter(Boolean)
          .filter((word) => !CI_WORDS.has(word) && !/^\d{1,2}$/.test(word));
        expect(stray, 'words on the record that nothing allowlisted').toEqual([]);
      }
      // A failed deposit still says which step failed, and nothing else.
      expect(fails.rejection).toContain('poolShieldExecute');
      expect(LONG_RUN.test(fails.rejection), 'a long run survived the rethrow').toBe(false);
      expect(/\d/.test(fails.rejection), 'a number survived the rethrow').toBe(false);
    } finally {
      h.close();
    }
  });

  it('the top-up script, run against a fake chain, puts nothing on the record that moves with the keys, the balances, the signature or the random draws', async () => {
    // The table is checked before it is run, as the restock's is. Every base
    // but "no restock wallet named" holds the treasury secret, as the
    // workflow passes it; each class whose treasury secret is a keypair
    // holds it in both shapes the script reads, from two keypairs (WK1-WK3);
    // and each class with a readable float key holds it as a JSON array from
    // two keys, and in base58 (VR1d).
    for (const [base, variants] of TOPUP_GROUPS) {
      const all = [base, ...variants];
      expect(base === T_NO_RESTOCK || (base.restockVia !== 'none' && (base.address === undefined || base === T_BAD_ADDRESS)), `the base "${base.name}" is not the workflow's configuration`).toBe(true);
      if (base !== T_NO_RESTOCK && base !== T_BADKEY) {
        const treasury = new Set(all.map((w) => `${w.restockVia}:${w.restockSeed}`));
        expect(['json:2', 'json:12', 'base58:2', 'base58:12'].filter((s) => !treasury.has(s)), `the class "${base.name}" no longer holds the treasury keypair in both shapes, from two keypairs`).toEqual([]);
      }
      if (base !== T_NO_KEY && base !== T_BADFLOAT) {
        const float = new Set(all.map((w) => `${w.funderVia ?? 'json'}:${w.funderSeed}`));
        expect(['json:1', 'json:11'].filter((s) => !float.has(s)).concat([...float].some((s) => s.startsWith('base58:')) ? [] : ['base58']), `the class "${base.name}" no longer holds the float key in both shapes`).toEqual([]);
      }
    }

    // No 4-character piece of any key (secret or public) or signature a
    // world holds, and no number, on ANY record, base or variant. The
    // differential cannot see a piece two keys happen to share; this does
    // not rely on one, nor on a class's variants reading alike.
    const heldPieces = [
      ...[1, 11, 2, 12].flatMap((seed) => [bs58.encode(secretOf(seed)), key(seed)]),
      sig(3),
      sig(13),
    ].flatMap(piecesOf);
    const offRecord = (name: string, record: string) => {
      expect(heldPieces.filter((p) => record.includes(p)), `a piece of a key reached the record in the world "${name}"`).toEqual([]);
      expect(/\d/.test(record.replace(/\bP01_[A-Z_]+/g, '')), `a number reached the record in the world "${name}"`).toBe(false);
    };

    const h = await topUpHarness();
    try {
      // Discarded, for the same reason as the restock's.
      await h.tick(T_MOVE);

      const bases = new Map<string, TopUpTick>();
      for (const [base, variants] of TOPUP_GROUPS) {
        const b = await h.tick(base);
        expect(b.finished, `the script never finished in the world "${base.name}"`).toBe(true);
        offRecord(base.name, b.record);
        bases.set(base.name, b);
        for (const v of variants) {
          const r = await h.tick(v);
          expect(r.finished, `the script never finished in the world "${v.name}"`).toBe(true);
          offRecord(v.name, r.record);
          expect(r.record, `the top-up's public record moved with ${v.name}`).toBe(b.record);
        }
      }

      // Positive controls: the verdict, and the failure, both reach the record.
      const [move, fails, noKey] = [T_MOVE, T_FAILS, T_NO_KEY].map((w) => bases.get(w.name) as TopUpTick);
      expect(move.exits, 'a top-up that moves ends cleanly').toEqual([]);
      expect(move.sends, 'and sends one transfer').toBe(1);
      expect(move.record).toContain('top-up waiting');
      expect(move.record).toContain('top-up live verdict=move');
      // The step's own streams are private (case 8), so a failure the operator
      // can read is one recorded in the file the next step prints.
      expect(fails.exits, 'a refused transfer fails the step').toEqual([1]);
      const annotations = fails.record.split('\n').filter((l) => l.startsWith('::error::'));
      expect(annotations, 'a refused transfer is recorded as one ::error:: in the file the next step prints').toHaveLength(1);
      expect(annotations[0]).toContain('top-up failed');
      expect(LONG_RUN.test(annotations[0]), 'a long run survived the annotation').toBe(false);
      expect(/\d/.test(annotations[0]), 'a number survived the annotation').toBe(false);
      expect(noKey.exits[0], 'a missing float key fails the step').toBe(1);
      expect(noKey.record, 'a missing float key is named, so the operator knows what to set').toContain(
        '::error::P01_FUNDER_SECRET_KEY is unset',
      );
      // A restock keypair that is not one fails the step, and the annotation
      // says what the script ACCEPTS. It said "(expected a JSON array)" while
      // the script also decoded base58 (the round-3 verifier's major).
      const badKey = bases.get(T_BADKEY.name) as TopUpTick;
      expect(badKey.exits[0], 'a restock keypair that is not one fails the step').toBe(1);
      expect(badKey.record).toContain('::error::P01_TREASURY_KEYPAIR_JSON is not a keypair (expected a JSON array or base');
      // The float key's own refusal, and the two other exits a loaded key
      // reaches, each say what to fix.
      const [badFloat, noRestock, badAddress, wrongChain] = [T_BADFLOAT, T_NO_RESTOCK, T_BAD_ADDRESS, T_WRONG_CHAIN].map(
        (w) => bases.get(w.name) as TopUpTick,
      );
      expect(badFloat.exits[0], 'a float key that is not one fails the step').toBe(1);
      expect(badFloat.record).toContain('::error::P01_FUNDER_SECRET_KEY is not a keypair (expected a JSON array or base');
      expect(noRestock.exits[0], 'no restock wallet named fails the step').toBe(1);
      expect(noRestock.record).toContain('::error::Neither P01_RESTOCK_WALLET_ADDRESS nor P01_TREASURY_KEYPAIR_JSON is set');
      expect(badAddress.exits[0], 'a restock address that is not one fails the step').toBe(1);
      expect(badAddress.record).toContain('::error::P01_RESTOCK_WALLET_ADDRESS is not a public key');
      expect(wrongChain.exits[0], 'a chain that is not devnet fails the step').toBe(1);
      expect(wrongChain.record).toContain('::error::refusing to run against a non-devnet chain');
      const outcomes = [move, fails, noKey, badKey, badFloat, noRestock, badAddress, wrongChain];
      expect(new Set(outcomes.map((t) => t.record)).size, 'two outcomes read the same').toBe(outcomes.length);

      // A LIVE tick that decides not to move says `live`: its verdict comes
      // from the read-only preview, but the run was not a dry run. Until web
      // run round 3 it read `top-up dry-run verdict=…` (the round-2 verifier's
      // minor).
      const hold = await h.tick(T_HOLD);
      expect(hold.finished, 'the script never finished in the world "a live top-up that holds"').toBe(true);
      expect(hold.sends, 'a tick that holds sends nothing').toBe(0);
      expect(hold.record).toContain('top-up live verdict=too-soon-after-float-activity');
      expect(hold.record).not.toContain('dry-run');
    } finally {
      h.close();
    }
  });
});
