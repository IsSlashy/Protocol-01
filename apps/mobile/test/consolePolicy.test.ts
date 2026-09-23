/**
 * What the mobile privacy screens are allowed to put on a screen and into
 * logcat. (The retired V1 zk service, services/zk/index.ts, had its own cases
 * here; they were deleted with that file on 2026-09-23.)
 *
 * WHY LOGCAT IS A REAL READER, not a developer convenience. `babel.config.js`
 * strips `console.log` and `console.debug` from a production bundle
 * (`transform-remove-console`) but deliberately EXCLUDES `error` and `warn`, so
 * that failures stay visible in a release build. Every `console.warn` and
 * `console.error` in this app therefore ships, and anyone with `adb logcat` on
 * an unlocked handset reads them. A warn that prints a leaf number or a
 * commitment prefix hands that reader the row of the chain that says who
 * deposited the note and when. The first case below pins the exclusion, so the
 * rule this file enforces and the reason for it cannot drift apart.
 *
 * BE HONEST ABOUT WHAT THIS IS. It reads source as text, like its siblings
 * `app/privacy-claims.test.ts` and `services/privacy/storeNullifierReads.test.ts`,
 * and for the same reason: these modules cannot be imported in this
 * environment. A green here does not prove the screens render — it proves the
 * source no longer contains the call that leaked. What the rows now say is
 * measured in `services/privacy/noteSubtitle.test.ts`.
 *
 * Every rule below has a positive control in `the detector fires on the old
 * shape and stays quiet on the new one`, built from the exact lines this WP
 * removed. A text rule that cannot be shown to fire is worth nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/** vitest runs with cwd = apps/mobile. */
const APP = process.cwd();

const raw = (rel: string) => readFileSync(resolve(APP, rel), 'utf8');

/**
 * Source as a user could experience it: comments gone. A comment recording what
 * a line USED to print is not itself a print, which is what lets the history
 * stay written next to the fix.
 */
const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const code = (rel: string) => strip(raw(rel));

const NOTES = 'app/(main)/(privacy)/denominated-notes.tsx';
const UNSHIELD = 'app/(main)/(privacy)/denominated-unshield.tsx';
const TRANSFER = 'app/(main)/(privacy)/denominated-transfer.tsx';

/** The three rows that used to print a deposit date. */
const SCREENS = [NOTES, UNSHIELD, TRANSFER] as const;

// ── the rules ────────────────────────────────────────────────────────────────

/**
 * A note's time, formatted for a human. `ui-deposit-date` in
 * `scratchpad/ux-arch/leaf-surface-scan.mjs` is the narrow form of this rule
 * (`shieldedAt).toLocale`); this one also catches the same date arriving
 * through a receipt field or a local variable.
 */
const RENDERED_DATE =
  /\b(shieldedAt|depositEpoch|createdAt|openedAt|recoveredAt)\b[^;\n]{0,40}\.toLocale|\.toLocale(?:Date|Time)?String\s*\([^)]*\)[^;\n]{0,20}\b(shieldedAt|depositEpoch)\b/;

/** `leaf #${...}` in a message the user or a log reader sees. */
const LEAF_IN_MESSAGE = /leaf\s*#?\$\{/i;

/**
 * A console argument that names one note. Applied to the call's arguments with
 * every string literal removed, so a message that merely says the WORD
 * "leafIndex" (`[ZK] Cannot add note without leafIndex`) is not a finding,
 * while an expression that prints one IS. `note.id` is in the list because a
 * stored note's id is a commitment prefix (`stores/denominatedPoolStore.ts`,
 * "id: commitment hex (first 16 chars)").
 */
const NAMES_A_NOTE =
  /\.(leafIndex|commitment|nullifierPreimage|merkleRoot|randomness|secret)\b|\b(noteId|noteCommitmentStr|leafIndex|commitment|nullifierPreimage)\b|\b\w*[Nn]ote\.id\b/;

interface Finding {
  method: string;
  args: string;
  /** Did the walker find this call's closing parenthesis? */
  closed: boolean;
}

/**
 * Every `console.*` call and its arguments, found by walking parentheses with
 * quote and template awareness rather than by a regex.
 *
 * WHY NOT A REGEX. A regex that cannot balance a nested call returns a
 * TRUNCATED argument list instead of failing, so a leak in the tail of a long
 * call is never read and the suite stays green. `every console call is read to
 * its closing parenthesis` below is the case that keeps this honest.
 */
function consoleCalls(src: string): Finding[] {
  const out: Finding[] = [];
  const opener = /console\.(log|warn|error|info|debug)\(/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    let i = start;
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i];
      if (quote !== null) {
        if (c === '\\') i += 1;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
    }
    out.push({
      method: m[1],
      args: src.slice(start, Math.max(start, i - 1)),
      closed: depth === 0,
    });
  }
  return out;
}

/** Arguments with string and template TEXT removed; expressions survive. */
const withoutLiteralText = (args: string): string =>
  args
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // A template keeps ONLY its ${...} expressions: the prose around them is
    // as much a literal as a quoted string is.
    .replace(/`(?:[^`\\]|\\.)*`/g, (tpl) =>
      [...tpl.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)].map((x) => x[1]).join(' '),
    );

/** Every console call in `src` whose ARGUMENTS name a note. */
function loggedNotes(src: string, methods: readonly string[]): Finding[] {
  return consoleCalls(src).filter(
    (c) => methods.includes(c.method) && NAMES_A_NOTE.test(withoutLiteralText(c.args)),
  );
}

/** A finding, short enough to read in a failure message. */
const show = (rel: string, f: Finding): string =>
  `${rel} :: ${f.method} :: ${f.args.replace(/\s+/g, ' ').slice(0, 120)}`;

const ALL_METHODS = ['log', 'warn', 'error', 'info', 'debug'] as const;
/** What survives `transform-remove-console` in a release build. */
const SHIPS_TO_LOGCAT = ['warn', 'error'] as const;

// ── fix round 1: rules that do not depend on how a leak is spelled ───────────
//
// The round-1 verifier (scratchpad/wp-logs/verify/MOB-UI-r1-mutants.log) kept
// every rule above green against five leaks that were spelled differently:
// `.toDateString()` on the row, a date built on one line and rendered on the
// next, a commitment prefix passed as the row's tag, the leaf count under
// another word, and a leaf index through a local variable. The rules below are
// ALLOWLISTS instead: they name what may reach a row, a message or a log that
// ships, and anything else is a finding, whatever it is called. Each one is run
// against those five mutations of the real files in `the allowlists fire on
// the round-1 mutations`, and against the pre-WP files in
// scratchpad/wp-logs/MOB-UI-fix1/old-tree.log.

/**
 * Source with every string literal emptied, and every template literal turned
 * into the concatenation of its `${}` expressions: `` `a ${x} b` `` becomes
 * `(''+(x))`. After this, no quote character carries text, so parentheses,
 * commas and `+` can be counted without tracking quotes, and "which values
 * reach this call" is a question about the skeleton alone.
 */
function skeleton(src: string): string {
  let i = 0;
  const template = (): string => {
    const parts: string[] = [];
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i += 1; break; }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        parts.push(`(${run(true)})`);
        continue;
      }
      i += 1;
    }
    return parts.length > 0 ? `(''+${parts.join('+')})` : "''";
  };
  const run = (insideBrace: boolean): string => {
    let out = '';
    let braces = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "'" || c === '"') {
        i += 1;
        while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
        i += 1;
        out += "''";
        continue;
      }
      if (c === '`') {
        i += 1;
        out += template();
        continue;
      }
      if (insideBrace && c === '{') braces += 1;
      if (insideBrace && c === '}') {
        if (braces === 0) {
          i += 1;
          return out;
        }
        braces -= 1;
      }
      out += c;
      i += 1;
    }
    return out;
  };
  return run(false);
}

/** Every call a skeleton opens with `opener`, read to its closing parenthesis. */
function callsIn(skel: string, opener: RegExp): { args: string; closed: boolean }[] {
  const out: { args: string; closed: boolean }[] = [];
  const re = new RegExp(opener.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(skel)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < skel.length && depth > 0; i += 1) {
      if (skel[i] === '(') depth += 1;
      else if (skel[i] === ')') depth -= 1;
    }
    out.push({ args: skel.slice(start, depth === 0 ? i - 1 : i), closed: depth === 0 });
  }
  return out;
}

/** Split at the top level (outside any bracket) on any character of `seps`. */
function splitTop(s: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (depth === 0 && seps.includes(c)) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** `((x))` → `x`, but `(a)(b)` stays whole. */
function unwrapParens(s: string): string {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (const c of t.slice(1, -1)) {
      if (c === '(') depth += 1;
      else if (c === ')' && (depth -= 1) < 0) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * The values an argument list puts into a message: every top-level operand of
 * `,` and `+`, descending through parentheses and template expressions. The
 * text of a literal is not a value (it is emptied by `skeleton`).
 */
function operands(args: string): string[] {
  const out: string[] = [];
  const walk = (s: string): void => {
    for (const piece of splitTop(s, ',+')) {
      const inner = unwrapParens(piece);
      if (inner === '' || inner === "''") continue;
      if (inner !== piece.trim() && /[,+]/.test(inner)) walk(inner);
      else out.push(squash(inner));
    }
  };
  walk(args);
  return out;
}

// ── fix round 2: parsed, not scanned ─────────────────────────────────────────
//
// The round-2 verifier (scratchpad/wp-logs/verify/MOB-UI-r2-mutants.log) kept
// the suite green with a note id rendered as a JSX child next to the row's
// subtitle (r2) and a date from a helper (r3). Neither passes through a call
// the round-1 rules read. The rules below use the TypeScript parser, which the
// app already depends on, to list what a screen renders.

const parse = (rel: string, src: string): ts.SourceFile =>
  ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/**
 * `src` with the prose of every JSX text node blanked (newlines kept). An
 * apostrophe in JSX prose (`the pool's delay` in denominated-notes.tsx) is not
 * a quote, but `skeleton` would read it as one and fall out of step for the
 * rest of the file, so a call after it would never be read. `the skeleton reads
 * every sink call the parser finds` holds this, with a control that fails
 * without it.
 */
function jsxSafe(rel: string, src: string): string {
  if (!rel.endsWith('.tsx')) return src;
  const spans: [number, number][] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) spans.push([n.getStart(), n.getEnd()]);
    ts.forEachChild(n, visit);
  };
  visit(parse(rel, src));
  let out = src;
  for (const [a, b] of spans.reverse()) {
    out = out.slice(0, a) + out.slice(a, b).replace(/[^\n]/g, ' ') + out.slice(b);
  }
  return out;
}

/** The sink calls the parser finds, for comparison with the skeleton's. */
function parsedSinkCount(rel: string, src: string, sink: RegExp): number {
  // `\bconsole\.(?:warn|error)\(|\bError\(` → `^(?:console\.(?:warn|error)|Error)$`
  const callee = new RegExp(`^(?:${sink.source.replace(/\\b|\\\(/g, '')})$`);
  let count = 0;
  const visit = (n: ts.Node): void => {
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && callee.test(n.expression.getText())) count += 1;
    ts.forEachChild(n, visit);
  };
  visit(parse(rel, src));
  return count;
}

/** Props whose value a component shows, or reads out to accessibility services. */
const TEXT_PROPS = /^(?:label|sub|title|text|message|placeholder|value|progress|accessibilityLabel|accessibilityHint)$/;

/**
 * Every value a screen renders as text: each `{…}` child of any JSX element
 * or fragment, and each text prop. A child that is structure (`cond && <View>`,
 * `a ? <X/> : b`) is followed into its branches; a JSX branch is read where it
 * is declared, and a non-JSX branch (`b`) is a value. The condition of `&&`/`?:`
 * is not rendered, so it is not a value. What remains is split with `operands`
 * after `skeleton`, so `` `${note.denomination} ${note.token}` `` is two values.
 */
function renderedValues(rel: string, src: string): string[] {
  const sf = parse(rel, src);
  const out: string[] = [];
  const hasJsx = (n: ts.Node): boolean => {
    let found = false;
    const walk = (m: ts.Node): void => {
      if (found) return;
      if (ts.isJsxElement(m) || ts.isJsxSelfClosingElement(m) || ts.isJsxFragment(m)) found = true;
      else ts.forEachChild(m, walk);
    };
    walk(n);
    return found;
  };
  const leaves = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) return leaves(e.expression);
    if (ts.isConditionalExpression(e)) {
      leaves(e.whenTrue);
      leaves(e.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return leaves(e.right);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        leaves(e.left);
        leaves(e.right);
        return;
      }
    }
    // Structure (an element, a `.map` renderer, an IIFE returning JSX): its
    // text is read where the parser meets it.
    if (hasJsx(e)) return;
    for (const v of operands(skeleton(strip(e.getText(sf))))) out.push(v);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      for (const c of n.children) if (ts.isJsxExpression(c) && c.expression) leaves(c.expression);
    }
    if (ts.isJsxAttribute(n) && TEXT_PROPS.test(n.name.getText(sf)) && n.initializer) {
      if (ts.isJsxExpression(n.initializer) && n.initializer.expression) leaves(n.initializer.expression);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * What the three screens may render as text. Reviewed 2026-09-16 against the
 * files; every value is an amount, a token, a translation, a count of the
 * user's own list, a clock, the tag (`noteSubtitle`, pinned by
 * `each row names its note by tagOf(note)`), the recipient and the transaction
 * the user just sent, or an error string. `the allowlists name no note` holds
 * that none names a leaf, commitment, root, id or deposit time, with one
 * reviewed exception listed there.
 */
const RENDERED_VALUES: Record<string, readonly string[]> = {
  [NOTES]: [
    "t('')", "t('', { count: selectedCount })", 'null',
    'note.denomination', 'note.token', 'countdown',
    'noteSubtitle(note, { lead: srcLabel(note), tag: tagOf(note) })',
    // route progress of the user's own multi-hop spend
    'rp.completedHops', 'rp.totalHops',
    // counts and sums of the user's own list
    'matureActive.length', 'maturingActive.length', 'historyNotes.length', 'recoverableCount', 'selectedSum',
    'matureActive.find(n => n.id === batchSelectedIds[0])?.token',
    // renderers: renderNote's own JSX is read where it is declared
    'activeNotes.map((n, i) => renderNote(n, i))',
    'historyNotes.map((n, i) => renderNote(n, i + activeNotes.length))',
    // ActionChip / ToolRow bodies; every caller's label and sub is read above
    'label', 'sub',
  ],
  [UNSHIELD]: [
    "t('')", "t('', { count: pendingNotes.length })", 'null',
    "t('', { amount: selectedNote.denomination, token: selectedNote.token })",
    'note.denomination', 'note.token', 'tone.label',
    'noteSubtitle(note, { lead: tone.label, tag: tagOf(note) })',
    "noteSubtitle(note, { lead: note.status === '' ? t('') : t(''), tag: tagOf(note), })",
    'usedNotes.length',
    // the address the user typed or their own wallet, the flow's progress and error text
    'recipient', "progress ?? ''", 'progress', 'error',
    // ToggleBtn body; its callers pass t('') labels
    'label',
  ],
  [TRANSFER]: [
    "t('')", 'null',
    'note.denomination', 'note.token', 'n.denomination', 'n.token',
    // the transaction the user just sent, and the note the user must hand to
    // the recipient (the screen's purpose; it is shown to its holder only)
    'result.txSig.slice(0, 16)', 'result.shareableNote',
    'progress', 'error',
  ],
};

/** Every rendered value of `src` that its screen's list does not name. */
function renderedFindings(rel: string, src: string): string[] {
  const ok = new Set(RENDERED_VALUES[rel]);
  return [...new Set(renderedValues(rel, src).filter((v) => !ok.has(v)).map((v) => `${rel} :: ${v}`))];
}

/** Where a value becomes text somebody else can read. */
const SCREEN_SINK = /\bconsole\.(?:log|warn|error|info|debug)\(|\bError\(|\bp01Alert\(/;

/** Every value `src` hands to `sink` that `allowed` does not name. */
function sinkFindings(rel: string, src: string, sink: RegExp, allowed: readonly string[]): string[] {
  const ok = new Set(allowed);
  const bad = new Set<string>();
  for (const c of callsIn(skeleton(strip(jsxSafe(rel, src))), sink)) {
    if (!c.closed) bad.add(`${rel} :: unclosed call :: ${squash(c.args).slice(0, 80)}`);
    for (const v of operands(c.args)) if (!ok.has(v)) bad.add(`${rel} :: ${v}`);
  }
  return [...bad];
}

/**
 * The values the three screens may put into a message, an alert or a log.
 * Literal text is emptied (`''`), so `t('')` is any translation key.
 *
 * `err.message` / `(e as Error).message` forward a service error. The unshield
 * success alert shows the recipient the user typed and the transaction the
 * user just sent, both of which the user already has.
 */
const SCREEN_SINK_VALUES: Record<string, readonly string[]> = {
  [NOTES]: [
    "t('')",
    "t('', { count })",
    "t('', { count: enc.length })",
    '(e as Error).message',
    "[ { text: t(''), style: '' }, { text: t(''), onPress: async () => { setIsRescanning(true); const KEEP_AWAKE_TAG = ''; await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {}); setRecoveryModalOpen(true); }, }, ]",
    "[{ text: t(''), onPress: async () => { await Clipboard.setStringAsync(JSON.stringify(enc)); setTimeout(() => Clipboard.setStringAsync(''), 60000); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } }, { text: t(''), style: '' }]",
    "[{ text: t(''), style: '' }, { text: t(''), onPress: () => { recoverTransferredNotes(); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } }]",
    "[{ text: t(''), style: '' }, { text: t(''), style: '', onPress: () => router.push({ pathname: '' as any, params: { noteId: n.id, emergency: '' } }) }]",
  ],
  [UNSHIELD]: [
    "t('')",
    'err.message',
    'C3_SUBTREE_DEPTH',
    'c3Path.length',
    'SIG_SCAN_LIMIT * 2',
    'label',
    "ok ? '' : ''",
    'routed.version',
    "emergency ? t('') : (''+(t('')))",
    'selectedNote.denomination',
    'selectedNote.token',
    'finalRecipient.slice(0, 8)',
    'stealthNote',
    'sig.slice(0, 16)',
    "[{ text: '', onPress: () => router.back() }]",
    "[ { text: t(''), style: '' }, { text: t(''), style: '', onPress: () => executeUnshield(true) }, ]",
  ],
  [TRANSFER]: [
    "t('')",
    "(err as Error).message || t('')",
    'C3_SUBTREE_DEPTH',
    'C6_SUBTREE_DEPTH',
    'c3Path.length',
    'c6Path.length',
    "[ { text: t(''), onPress: () => { handleCopy(); } }, { text: t(''), style: '', onPress: go }, ]",
  ],
};

/** Counts whose value at the moment they are logged can place a note. */
const POOL_COUNT = /leafcount|missingcount|cachehits|\.logs\b/i;

/** A value that names a note, a root, or a secret, whatever else it is. */
const NOTE_OR_ROOT = /root|commit|nullifier|secret|preimage|randomness|leafIndex|\bidx\b|\.id\b/i;

/**
 * Lines of the three screens that may touch a time. A note's deposit time is
 * `shieldedAt` / `recoveredAt` on the stored note and `depositEpoch` in its
 * receipt; everything that formats a date is `Date`/`Intl`/`to*String`/`get*`.
 * The count is how many times the exact line may appear. What each one is:
 *  - notes: newest-copy de-duplication (a comparison), the batch-progress map
 *    key (never rendered), the slot clock (`Date.now()`, the phone's own time),
 *    and the maturity arithmetic behind the immature-only countdown
 *    (noteSubtitle.test.ts, "never puts a clock on a note that is not immature");
 *  - unshield/transfer: the epoch handed to the C1 prover, and the fresh epoch
 *    of the note a transfer creates.
 */
const TIME_FIELD = /shieldedAt|recoveredAt|depositEpoch|depositSlot|depositTime|createdAt|timestamp|blockTime/i;
const DATE_API =
  /\bDate\b|\bIntl\b|toLocale\w*String|\bto(?:Date|Time|ISO|UTC|GMT)String\b|\bget(?:UTC)?(?:Date|Day|Month|FullYear|Year|Hours|Minutes|Seconds|Time)\s*\(|\b(?:dayjs|moment|luxon|date-fns)\b/;
const TIME_LINES: Record<string, Readonly<Record<string, number>>> = {
  [NOTES]: {
    "if (!ex || n.status === 'spent' || n.shieldedAt > ex.shieldedAt) seen.set(n.id, n);": 1,
    'progress[`${r.sourceDenomination}_${r.createdAt}`] = {': 1,
    'const t1 = Date.now();': 1,
    'if (diff > 0) setSlotMs(Math.max(200, Math.min(800, (Date.now() - t1) / diff)));': 1,
    'if (receipt.depositEpoch <= minEpoch) return { isMature: true, remainingMs: 0 };': 1,
    'const matSlot = Number(receipt.depositEpoch + delay) * SLOTS_PER_EPOCH;': 1,
  },
  [UNSHIELD]: {
    'receipt.depositEpoch.toString(),': 2,
  },
  [TRANSFER]: {
    'receipt.depositEpoch.toString(),': 2,
    'const newDepositEpoch = slotToEpoch(slot);': 1,
    'newNullifierPreimage, newSecret, newDepositEpoch, tokenMintField,': 1,
    'newDepositEpoch,': 1,
  },
};

/** Every line of `src` that touches a time and is not on its allowlist. */
function timeFindings(rel: string, src: string): string[] {
  const seen = new Map<string, number>();
  const bad: string[] = [];
  for (const raw of strip(src).split('\n')) {
    const line = raw.trim();
    if (!TIME_FIELD.test(line) && !DATE_API.test(line)) continue;
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    if (n > (TIME_LINES[rel]?.[line] ?? 0)) bad.push(`${rel} :: ${line}`);
  }
  return bad;
}

/**
 * How a row names a note: exactly these `noteSubtitle` calls, each with the
 * note, one of these leads, and `tag: tagOf(note)` — and `tagOf` is exactly the
 * decrypt-then-TAG-0 function below, in both screens. `noteTagText` is a
 * SHA-256 over `pool`/`secret`/`nullifierPreimage` (noteSubtitle.test.ts,
 * "reads the note's secrets, and refuses to invent a tag"), so the three
 * fields are read from the decrypted receipt and nothing else of the note is.
 */
const SUBTITLE_CALLS: Record<string, number> = { [NOTES]: 1, [UNSHIELD]: 2 };
const SUBTITLE_LEADS: Record<string, readonly string[]> = {
  [NOTES]: ['srcLabel(note)'],
  [UNSHIELD]: ['tone.label', "note.status === '' ? t('') : t('')"],
};
const TAG_OF =
  '(note:StoredNote):string|null=>{constcached=tagCacheRef.current.get(note.receiptJSON);' +
  'if(cached!==undefined)returncached;' +
  'try{constreceipt=receiptFromJSON(vaultDecrypt(note.receiptJSON));' +
  'consttext=noteTagText({pool:note.poolPDA,secret:receipt.secret,nullifierPreimage:receipt.nullifierPreimage,});' +
  'if(text!==null)tagCacheRef.current.set(note.receiptJSON,text);returntext;}' +
  'catch{returnnull;}},[]';
const TAG_CACHE_DECL = 'consttagCacheRef=useRef(newMap<string,string>());';

const noSpace = (s: string): string => s.replace(/\s+/g, '');

function subtitleFindings(rel: string, src: string): string[] {
  const skel = skeleton(strip(jsxSafe(rel, src)));
  const bad: string[] = [];

  const calls = callsIn(skel, /\bnoteSubtitle\(/);
  if (calls.length !== SUBTITLE_CALLS[rel]) {
    bad.push(`${rel} :: ${calls.length} noteSubtitle calls, expected ${SUBTITLE_CALLS[rel]}`);
  }
  for (const c of calls) {
    const args = splitTop(c.args, ',').map((s) => s.trim()).filter((s) => s !== '');
    const [subject, parts] = args;
    if (args.length !== 2 || subject !== 'note' || !parts.startsWith('{') || !parts.endsWith('}')) {
      bad.push(`${rel} :: noteSubtitle(${squash(c.args)})`);
      continue;
    }
    const props = splitTop(parts.slice(1, -1), ',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map((p) => {
        const k = p.indexOf(':');
        return k < 0 ? [p, ''] : [p.slice(0, k).trim(), squash(p.slice(k + 1))];
      });
    const keys = props.map(([k]) => k).sort();
    const value = new Map(props.map(([k, v]) => [k, v]));
    if (keys.join(',') !== 'lead,tag') bad.push(`${rel} :: subtitle keys ${keys.join(',')}`);
    if (value.get('tag') !== 'tagOf(note)') bad.push(`${rel} :: tag: ${value.get('tag')}`);
    if (!SUBTITLE_LEADS[rel].includes(value.get('lead') ?? '')) {
      bad.push(`${rel} :: lead: ${value.get('lead')}`);
    }
  }

  const declarations = skel.match(/\b(?:const|let|var|function)\s+tagOf\b/g) ?? [];
  const tagOf = callsIn(skel, /\bconst\s+tagOf\s*=\s*useCallback\(/);
  if (declarations.length !== 1 || tagOf.length !== 1) {
    bad.push(`${rel} :: ${declarations.length} tagOf declarations, ${tagOf.length} as useCallback`);
  } else if (noSpace(tagOf[0].args) !== TAG_OF) {
    bad.push(`${rel} :: tagOf is ${noSpace(tagOf[0].args)}`);
  }
  if (!noSpace(skel).includes(TAG_CACHE_DECL) || (skel.match(/\btagCacheRef\b/g) ?? []).length !== 3) {
    bad.push(`${rel} :: tagCacheRef is declared or used outside tagOf`);
  }
  return bad;
}

/** Apply one mutation to real source text, and prove the anchor was there. */
function mutate(src: string, from: string, to: string): string {
  expect(src.includes(from), `mutation anchor missing: ${from}`).toBe(true);
  return src.replace(from, to);
}

// ── the cases ────────────────────────────────────────────────────────────────

describe('the release bundle keeps warn and error, so they carry no note', () => {
  it('babel still strips console.log in production, and still excludes warn and error', () => {
    // A regression guard, green before this WP as well: it is the premise the
    // rest of the file rests on. If someone drops the plugin, the `console.log`
    // rule below stops being "dev only" and this case says so.
    const babel = code('babel.config.js');
    expect(babel).toMatch(/transform-remove-console/);
    expect(babel).toMatch(/exclude:\s*\[\s*'error'\s*,\s*'warn'\s*\]/);
    expect(babel).toMatch(/env:\s*\{\s*production:/);

    // The control: the rule can fail.
    const withoutPlugin = babel.replace(/'transform-remove-console'/g, "'noop'");
    expect(/transform-remove-console/.test(withoutPlugin)).toBe(false);
  });
});

describe('the detector fires on the old shape and stays quiet on the new one', () => {
  it('flags the exact lines this work package removed', () => {
    // Verbatim from the pre-change files (services/zk/index.ts 603, 925,
    // 2021-2023, 2267, 2287, 2526; denominated-unshield.tsx 324).
    const before = [
      'console.warn(`[ZK] Note at index ${note.leafIndex} appears to be already spent (nullifier in bloom filter)`);',
      "console.warn('[ZK Shield] On-chain leaf index mismatch:', note.leafIndex, '!=', onChainLeafIndex);",
      "console.error('[ZK] CORRUPTION DETECTED: Different note exists at leafIndex', note.leafIndex);",
      "console.error('[ZK] Existing commitment:', existingNote.commitment.toString().slice(0, 20));",
      "console.error('[ZK] New commitment:', note.commitment.toString().slice(0, 20));",
      "console.warn('[ZK] Dropping legacy BN254 note (commitment > 2^64):', note.commitment.toString().slice(0, 20));",
      'console.warn(`[ZK] Duplicate leafIndex ${note.leafIndex} detected - keeping first, removing duplicate`);',
      "console.warn('[ZK] Note commitment not found in tree:', noteCommitmentStr.slice(0, 20));",
      "console.error('[ZK Unshield] Expected:', note.merkleRoot.toString().slice(0, 20) + '...');",
      'console.log(`[Unshield] note ${selectedNote.id.slice(0, 8)}… spent via ${routed.version}`);',
    ];
    for (const line of before) {
      expect(loggedNotes(line, ALL_METHODS), line).toHaveLength(1);
    }

    // And the shapes that are NOT findings, so the rule is not "no console".
    const after = [
      "console.warn('[ZK] Cannot add note without leafIndex');",
      "console.warn('[ZK] Skipping note without leafIndex');",
      "console.error('[ZK] CRITICAL: Stored commitment does not match recomputed!');",
      "console.error('[ZK] Error checking nullifier on-chain:', error);",
      "console.warn('[ZK Sync] Leaf count mismatch! Local:', local, 'On-chain:', onChainLeafCount);",
      'console.log(`[Unshield] spent via ${routed.version}`);',
      "console.log('[ZK Shield] STARK shield complete');",
    ];
    for (const line of after) {
      expect(loggedNotes(line, ALL_METHODS), line).toHaveLength(0);
    }

    // A comment carrying the old call is not a call.
    expect(
      loggedNotes(strip("// console.warn('x', note.leafIndex);\nconst x = 1;"), ALL_METHODS),
    ).toHaveLength(0);
  });

  it('flags a rendered deposit date, and not a date-free row', () => {
    expect(
      RENDERED_DATE.test(
        "{srcLabel(note)} · {new Date(note.shieldedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}",
      ),
    ).toBe(true);
    expect(RENDERED_DATE.test('{tone.label} · {new Date(note.shieldedAt).toLocaleDateString()}')).toBe(true);
    expect(RENDERED_DATE.test('{noteSubtitle(note, { lead: srcLabel(note), tag: tagOf(note) })}')).toBe(false);
    // A slot clock is not a deposit date: `fmtTime` counts a wait down.
    expect(RENDERED_DATE.test('const countdown = fmtTime(maturity.remainingMs);')).toBe(false);

    expect(
      LEAF_IN_MESSAGE.test("`from the pool's filled_subtrees for leaf #${leafCount} (direct=${a})`"),
    ).toBe(true);
    expect(LEAF_IN_MESSAGE.test('`Merkle path has ${c3Path.length} elements`')).toBe(false);
  });
});

describe('the privacy screens name no note', () => {
  it('no screen renders a deposit date', () => {
    const bad: string[] = [];
    for (const rel of SCREENS) {
      for (const [i, line] of code(rel).split('\n').entries()) {
        if (RENDERED_DATE.test(line)) bad.push(`${rel}:${i + 1}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the rows that used to print a date go through the shared helper', () => {
    for (const rel of [NOTES, UNSHIELD]) {
      const src = code(rel);
      expect(src, rel).toMatch(/from\s+'@\/services\/privacy\/noteSubtitle'/);
      expect(src, rel).toMatch(/\bnoteSubtitle\s*\(/);
    }
  });

  it('no screen puts a leaf number in a message', () => {
    const bad: string[] = [];
    for (const rel of SCREENS) {
      for (const [i, line] of code(rel).split('\n').entries()) {
        if (LEAF_IN_MESSAGE.test(line)) bad.push(`${rel}:${i + 1}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no screen logs a note, on any console method', () => {
    // `log` is included although production strips it: a development build on
    // a real handset writes it to the same logcat.
    const bad: string[] = [];
    for (const rel of SCREENS) {
      for (const f of loggedNotes(code(rel), ALL_METHODS)) bad.push(show(rel, f));
    }
    expect(bad).toEqual([]);
  });
});

describe('the console walker reads every call to its end', () => {
  it('every console call is read to its closing parenthesis', () => {
    // The coverage guard for the walker: a call it could not close would have
    // its arguments truncated, and a note named in the tail would go unread.
    const unclosed: string[] = [];
    for (const rel of [...SCREENS, 'babel.config.js']) {
      for (const c of consoleCalls(code(rel))) if (!c.closed) unclosed.push(show(rel, c));
    }
    expect(unclosed).toEqual([]);
    // And it really did find the calls it claims to have read (the unshield
    // screen makes 3 on 2026-09-23; the retired zk service used to carry this
    // guard with more than 80).
    expect(SCREENS.flatMap((rel) => consoleCalls(code(rel))).length).toBeGreaterThanOrEqual(3);
  });
});

describe('fix round 1: what reaches a row, a message or a log is named, not guessed', () => {
  it('each row names its note by tagOf(note), and tagOf reads only the decrypted secrets', () => {
    const bad = [NOTES, UNSHIELD].flatMap((rel) => subtitleFindings(rel, raw(rel)));
    expect(bad).toEqual([]);
  });

  it('no screen touches a time outside the reviewed lines', () => {
    const bad = SCREENS.flatMap((rel) => timeFindings(rel, raw(rel)));
    expect(bad).toEqual([]);
  });

  it('every value a screen puts in a message, an alert or a log is one reviewed here', () => {
    const bad = SCREENS.flatMap((rel) => sinkFindings(rel, raw(rel), SCREEN_SINK, SCREEN_SINK_VALUES[rel]));
    expect(bad).toEqual([]);
  });

  it('the allowlists name no note, no root and no deposit time', () => {
    // Without this, "fixing" a red above by adding `note.leafIndex` to a list
    // would be a one-line change. Upper-case constants (C3_SUBTREE_DEPTH) are
    // circuit shapes, not values of a note.
    const lists = [
      ...Object.values(SCREEN_SINK_VALUES).flat(),
      ...Object.values(RENDERED_VALUES).flat(),
    ];
    const named = lists.filter((v) => {
      const lower = v.replace(/\b[A-Z][A-Z0-9_]+\b/g, '');
      return NOTE_OR_ROOT.test(lower) || NAMES_A_NOTE.test(lower) || TIME_FIELD.test(lower) || POOL_COUNT.test(lower);
    });
    // Two reviewed exceptions, where an id is COMPARED or ROUTED, not shown:
    //  - the emergency-unshield button routes to the unshield screen with the
    //    note's id as a navigation PARAM; the value in the alert is the label;
    //  - the batch bar shows the TOKEN of the first selected note, found by id.
    expect(named).toEqual([
      "[{ text: t(''), style: '' }, { text: t(''), style: '', onPress: () => router.push({ pathname: '' as any, params: { noteId: n.id, emergency: '' } }) }]",
      'matureActive.find(n => n.id === batchSelectedIds[0])?.token',
    ]);
  });
});

describe('fix round 1: the allowlists fire on the round-1 mutations', () => {
  // Each mutation is the verifier's, applied to the REAL file text, so a rule
  // that cannot see it goes red here rather than in a later audit
  // (scratchpad/wp-logs/verify/MOB-UI-r1-mutants.log, m1-m6).
  const ROW = '{noteSubtitle(note, { lead: srcLabel(note), tag: tagOf(note) })}';

  it('m1: a date rendered with .toDateString() on the row', () => {
    const src = mutate(raw(NOTES), ROW, `${ROW} · {new Date(note.shieldedAt).toDateString()}`);
    expect(timeFindings(NOTES, src).length).toBeGreaterThan(0);
  });

  it('m2: a commitment prefix passed as the tag', () => {
    const src = mutate(raw(NOTES), ROW, '{noteSubtitle(note, { lead: srcLabel(note), tag: note.id.slice(0, 8) })}');
    expect(subtitleFindings(NOTES, src)).toEqual([`${NOTES} :: tag: note.id.slice(0, 8)`]);
  });

  it('m2b: tagOf itself returning, or hashing, a public field', () => {
    const intoTag = mutate(raw(NOTES), 'secret: receipt.secret,', 'secret: note.id,');
    expect(subtitleFindings(NOTES, intoTag).length).toBeGreaterThan(0);
    const out = mutate(raw(UNSHIELD), 'return text;', 'return note.id.slice(0, 8);');
    expect(subtitleFindings(UNSHIELD, out).length).toBeGreaterThan(0);
    const shadow = mutate(raw(NOTES), ROW, `{(() => { const tagOf = (n: StoredNote) => n.id; return noteSubtitle(note, { lead: srcLabel(note), tag: tagOf(note) }); })()}`);
    expect(subtitleFindings(NOTES, shadow).length).toBeGreaterThan(0);
  });

  it('m3: a date built on one line and rendered on another', () => {
    const src = mutate(
      raw(NOTES),
      ROW,
      `{(() => { const dep = new Date(note.shieldedAt);\n const depDay = dep.toLocaleDateString();\n return depDay; })()}`,
    );
    expect(timeFindings(NOTES, src).length).toBeGreaterThanOrEqual(2);
  });

  it('m4: the leaf count and root back in the transfer message under another word', () => {
    const src = mutate(
      raw(TRANSFER),
      "'current Merkle root, so no proof was generated. Refresh and try again.',",
      '`current Merkle root (pool at ${leafCount} deposits, root ${onChainRoot}). Refresh and try again.`,',
    );
    const before = new Set(sinkFindings(TRANSFER, raw(TRANSFER), SCREEN_SINK, SCREEN_SINK_VALUES[TRANSFER]));
    const added = sinkFindings(TRANSFER, src, SCREEN_SINK, SCREEN_SINK_VALUES[TRANSFER]).filter((f) => !before.has(f));
    expect(added.sort()).toEqual([
      `${TRANSFER} :: leafCount`,
      `${TRANSFER} :: onChainRoot`,
    ]);
  });

  it('m6: the original line-394 date', () => {
    const src = mutate(
      raw(NOTES),
      ROW,
      "{srcLabel(note)} · {new Date(note.shieldedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}",
    );
    expect(timeFindings(NOTES, src).length).toBeGreaterThan(0);
    expect(subtitleFindings(NOTES, src).length).toBeGreaterThan(0);
  });

  it('the skeleton keeps apostrophes inside templates from hiding a value', () => {
    // `two's complement` sat inside a template in the retired zk/index.ts; a quote-naive
    // reader would pair that apostrophe with a later one and skip the value.
    expect(operands(skeleton("`it's ${a}` + 'b' + `c ${d.e(1, 2)} f`"))).toEqual(['a', 'd.e(1, 2)']);
    expect(operands(skeleton("'x', \"y\", `z`"))).toEqual([]);
  });
});

describe('fix round 2: what a screen renders is parsed, and a log carries no pool count', () => {
  // The mutations are the round-2 verifier's r1-r3
  // (scratchpad/wp-logs/verify/MOB-UI-r2-mutants.mjs), applied to the real files.
  const ROW2 = '{noteSubtitle(note, { lead: srcLabel(note), tag: tagOf(note) })}';

  it('every value a screen renders as text is one reviewed here', () => {
    const bad = SCREENS.flatMap((rel) => renderedFindings(rel, raw(rel)));
    expect(bad).toEqual([]);
    // Coverage guard: the parser really did read the rows, so an empty
    // finding list is not an empty reading.
    expect(renderedValues(NOTES, raw(NOTES))).toContain("noteSubtitle(note, { lead: srcLabel(note), tag: tagOf(note) })");
    expect(renderedValues(UNSHIELD, raw(UNSHIELD)).length).toBeGreaterThan(20);
  });

  it('the skeleton reads every sink call the parser finds', () => {
    for (const rel of SCREENS) {
      const src = raw(rel);
      expect(callsIn(skeleton(strip(jsxSafe(rel, src))), SCREEN_SINK).length, rel).toBe(parsedSinkCount(rel, src, SCREEN_SINK));
    }
  });

  it('r2: a note id rendered as a JSX child next to the subtitle', () => {
    const src = mutate(raw(NOTES), ROW2, `${ROW2} {note.id.slice(0, 8)}`);
    expect(renderedFindings(NOTES, src)).toEqual([`${NOTES} :: note.id.slice(0, 8)`]);
  });

  it('r3: a date from a helper, on a line that names no time', () => {
    const row = '{noteSubtitle(note, { lead: tone.label, tag: tagOf(note) })}';
    const src = mutate(raw(UNSHIELD), row, `${row} {fmtWhen(note)}`);
    expect(renderedFindings(UNSHIELD, src)).toEqual([`${UNSHIELD} :: fmtWhen(note)`]);
  });

  it('r2b: an id in a branch, in a template, or in an accessibility label', () => {
    // The pill's child (the first `{countdown}` in the file is the row's
    // accessibility label, which the template form below covers).
    const branch = mutate(raw(NOTES), '\n              {countdown}\n', '\n              {isSelected ? note.id : countdown}\n');
    expect(renderedFindings(NOTES, branch)).toEqual([`${NOTES} :: note.id`]);
    const inLabel = mutate(raw(NOTES), '${countdown}`}', '${countdown} ${note.id}`}');
    expect(renderedFindings(NOTES, inLabel)).toEqual([`${NOTES} :: note.id`]);
    const label = mutate(raw(TRANSFER), 'accessibilityLabel={`${n.denomination} ${n.token}`}', 'accessibilityLabel={`${n.denomination} ${n.token} ${n.leafIndex}`}');
    expect(renderedFindings(TRANSFER, label)).toEqual([`${TRANSFER} :: n.leafIndex`]);
  });

  it('an apostrophe in JSX prose no longer hides a later call', () => {
    // A leak placed right after a line of prose with an apostrophe in it.
    const src = mutate(
      raw(NOTES),
      '<View style={st.actions}>',
      "<View style={st.actions}>\n<Text>the note's route</Text>\n<Text onPress={() => p01Alert(t('common.error'), note.id)}>x</Text>",
    );
    expect(sinkFindings(NOTES, src, SCREEN_SINK, SCREEN_SINK_VALUES[NOTES])).toContain(`${NOTES} :: note.id`);
    // The control: the round-1 reading, without jsxSafe, does not see it.
    const blind = callsIn(skeleton(strip(src)), SCREEN_SINK).length;
    expect(blind).toBeLessThan(parsedSinkCount(NOTES, src, SCREEN_SINK));
  });
});
