/**
 * NO SOURCE IN THE WEB APP PUTS A NOTE'S LEAF, COMMITMENT OR SECRET-DERIVED
 * VALUE ON A SCREEN OR IN A LOG (UI-1, ledger rows D14 and G3).
 *
 * WHY A SOURCE SCAN AS WELL AS RENDER TESTS. The render tests
 * (`__tests__/components/PoolPanel.test.tsx`, `SendForm.test.tsx`,
 * `ReceivePanel.test.tsx`, `SubscriptionsPanel.test.tsx`) measure what a user
 * sees, which is the stronger evidence, but only on the states a test reaches.
 * A progress line built three files away, an error thrown on a path no test
 * walks, a panel with no test at all (SubscribePanel): those are what this file
 * is for. The adversary is a screenshot, a screen recording, a support ticket,
 * or anyone reading the browser console, and the code is public, so a leaf
 * number printed anywhere names the deposit that created it.
 *
 * WHAT IT MEASURES. Every `.ts` / `.tsx` source under `app/`, `components/`,
 * `lib/`, `i18n/` and `middleware.ts` is parsed with the TypeScript compiler
 * (not a regex), and a VALUE whose name says it identifies a note (a leaf, a
 * commitment, a nullifier or its preimage, a secret, a blinding or deposit
 * epoch, a Merkle root or path, a counter, a gap list) is flagged where it
 * reaches a SINK:
 *   - a JSX child, or a JSX attribute a browser shows (title, aria-label, alt,
 *     placeholder, label);
 *   - a `console.*` argument, or a progress / status / error setter argument
 *     (`onProgress`, `set…Error`, `set…Step`, …);
 *   - an i18n placeholder, `.replace("{x}", value)`;
 *   - a human sentence built from it: a template literal or a `'…' + value`
 *     concatenation whose literal text is prose. A key such as
 *     `${pool}:${leafIndex}` carries no prose and is not a sink: it is the
 *     handle the main thread keeps (the residual the plan names).
 * A value that is only compared, counted (`.length`) or tested (`&&` left side,
 * `!x`, a ternary's condition) is not rendered and is not flagged. ALL_CAPS
 * names are sizes, not notes.
 *
 * Plus the six line rules of the 2026-09-15 baseline probe
 * (`ux-arch/leaf-surface-scan.mjs`), verbatim, so "0 hits" is comparable to
 * that measurement (20 web hits that day; 20 again when this file was written),
 * and a dictionary rule over every web locale string.
 *
 * ⚠️ WHAT IT DOES NOT MEASURE. It reads names, so a leaf smuggled through a
 * neutral name (`const x = note.leafIndex; show(x)`) walks past it; the render
 * tests are what catch that on the screens they reach. Operator scripts under
 * `scripts/` are out of scope on purpose: they run on the operator's machine
 * and some print leaves by design (CI logs of the ones CI runs are CI-1's).
 * The extension has its own scan (`apps/extension/src/shared/noteIdentifierScan.test.ts`);
 * mobile is out of this web-only run.
 *
 * Every detector has its own positive control below (planted lines it must
 * flag, neutral lines it must not), and the allowlist is exact: an entry that
 * matches nothing fails, so it cannot silently widen.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

import en from '@/i18n/en';
import fr from '@/i18n/fr';

/**
 * vitest runs with cwd = apps/web. `P01_TRIPWIRE_ROOT` points the scan at a
 * copy of the tree instead (used once, to measure the pre-UI-1 snapshot; see
 * the UI-1 report). Unset in every ordinary run.
 */
const WEB = resolve(process.env.P01_TRIPWIRE_ROOT ?? process.cwd());
const SCAN_ROOTS = ['app', 'components', 'lib', 'i18n', 'middleware.ts'];

/** A name that identifies ONE note, or a position in somebody's tree. */
const NOTE_VALUE =
  /leaf|commitment|nullifier|preimage|noteId|epoch|shieldedAt|blinding|merkle|root|secret|counter|pathElements|pathIndices/i;
/** A list of missing leaves names other people's deposits; its COUNT does not. */
const GAP_LIST = /^(missing|gaps?)$/;
const TEXT_ATTRIBUTES = new Set(['title', 'aria-label', 'alt', 'placeholder', 'label', 'aria-description']);
/** Callbacks and setters whose argument ends up as text on the screen. */
const TEXT_SINK_CALLEE = /^(onProgress|set\w*(Error|Step|Message|Status|Notice|Warning)|setRecovered|setSwept)$/;
const CONSOLE = /^console\.(log|warn|error|info|debug)$/;

/** The 2026-09-15 baseline probe's rules, verbatim. */
const BASELINE_RULES: Array<[string, RegExp]> = [
  ['ui-leaf-jsx', /leaf\s*#?\{[^}]*leaf/i],
  ['ui-index-jsx', /Index:\s*\{[^}]*index/],
  ['ui-leaf-plain', /leaf \{[^}]*leafIndex\}/],
  ['msg-leaf-template', /leaf #?\$\{[^}]*(leaf|counter|ref\.)/i],
  ['ui-deposit-date', /shieldedAt\)\.toLocale/],
  ['log-names-note', /console\.(log|warn|error|info|debug)\([^)]*(leafIndex|commitment|nullifier|noteId)/],
];

/** A locale string that prints a leaf number or interpolates a note identifier. */
const LEAF_WORDING = /leaf\s*#|leaf\s*n°|feuille\s*n°|#\s*\{\w+\}|n°\s*\{\w+\}/i;
const NOTE_PLACEHOLDER = /\{(leaf|leafIndex|spent|issued|funded|commitment|index|nullifier)\}/i;

type Hit = { rule: string; file: string; line: number; names: string; text: string };

/**
 * The reasoned allowlist. Each entry must match EXACTLY one hit (checked
 * below), so a stale or widened entry fails instead of hiding something new.
 */
const ALLOWLIST: Array<{ file: string; rule: string; contains: string; why: string }> = [
  {
    file: 'app/admin/waitlist/page.tsx',
    rule: 'prose-template',
    contains: 'Bearer ${secret}',
    why:
      'the Authorization header of the admin waitlist fetch, built from the password the operator ' +
      'typed; not a note value, never rendered or logged',
  },
  {
    file: 'components/pay/SubscriptionsPanel.tsx',
    rule: 'jsx-child',
    contains: 'decoded.licenseCommitment',
    why:
      'the vault’s public license fingerprint, rendered only after the user asks for the on-chain ' +
      'addresses (SubscriptionsPanel.test.tsx, "keeps the start slot and the license fingerprint ' +
      'off the screen until asked"; this entry matches the line whatever guards it, so that test ' +
      'is what holds the guard)',
  },
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isFile()) {
      out.push(abs);
      return;
    }
    for (const entry of readdirSync(abs)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const p = join(abs, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      // Tests are excluded: this file, and every other, quotes the shapes it
      // forbids. `starkGlueIife` is a generated bundle, as in the probe.
      if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
      if (/\.test\.|\.spec\.|starkGlueIife|\.d\.ts$/.test(entry)) continue;
      out.push(p);
    }
  };
  for (const r of SCAN_ROOTS) walk(join(WEB, r));
  return out;
}

const rel = (abs: string) => relative(WEB, abs).split(sep).join('/');

const COMPARISON = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
]);

/**
 * The note-identifying names an expression would RENDER. Nested JSX and
 * function bodies are skipped (the walker visits them as their own sinks); a
 * comparison, a negation, a `typeof`, the left side of `&&` and a ternary's
 * condition produce no text; `.length` is a count.
 */
function renderedNoteNames(node: ts.Node | undefined): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node | undefined): void => {
    if (!n) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return;
    if (ts.isStringLiteralLike(n)) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'length') return;
    if (ts.isParenthesizedExpression(n)) return visit(n.expression);
    if (ts.isConditionalExpression(n)) {
      visit(n.whenTrue);
      visit(n.whenFalse);
      return;
    }
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return;
    if (ts.isTypeOfExpression(n)) return;
    if (ts.isBinaryExpression(n)) {
      if (COMPARISON.has(n.operatorToken.kind)) return;
      if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return visit(n.right);
    }
    if (ts.isIdentifier(n)) {
      if (/^[A-Z][A-Z0-9_]{2,}$/.test(n.text)) return;
      if (NOTE_VALUE.test(n.text)) out.push(n.text);
      if (
        GAP_LIST.test(n.text) &&
        ts.isPropertyAccessExpression(n.parent) &&
        n.parent.expression === n &&
        n.parent.name.text !== 'length'
      ) {
        out.push(`${n.text}.${n.parent.name.text}`);
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const hasProse = (s: string) => /[A-Za-z]{2,}/.test(s) && /\s/.test(s);

/** The AST rules, over one source. */
function sinkHits(source: string, file = 'planted.tsx'): Hit[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Hit[] = [];
  const hit = (rule: string, node: ts.Node, names: string[]) => {
    if (names.length === 0) return;
    hits.push({
      rule,
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      names: [...new Set(names)].join(','),
      text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 140),
    });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      hit('jsx-child', n, renderedNoteNames(n.expression));
    }
    if (ts.isJsxAttribute(n) && n.initializer && TEXT_ATTRIBUTES.has(n.name.getText(sf))) {
      hit('jsx-text-attr', n, renderedNoteNames(n.initializer));
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      // Template arguments are read by the prose-template rule below.
      const direct = n.arguments.filter((a) => !ts.isTemplateExpression(a));
      if (CONSOLE.test(callee.getText(sf))) hit('console-arg', n, direct.flatMap(renderedNoteNames));
      if (TEXT_SINK_CALLEE.test(name)) hit('text-sink-arg', n, direct.flatMap(renderedNoteNames));
      if (
        name === 'replace' &&
        n.arguments.length === 2 &&
        ts.isStringLiteralLike(n.arguments[0]) &&
        /^\{\w+\}$/.test(n.arguments[0].text)
      ) {
        hit('i18n-placeholder', n, renderedNoteNames(n.arguments[1]));
      }
    }
    if (ts.isTemplateExpression(n)) {
      const literal = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)];
      if (literal.some(hasProse)) {
        hit('prose-template', n, n.templateSpans.flatMap((s) => renderedNoteNames(s.expression)));
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const parts: ts.Expression[] = [];
      const flat = (x: ts.Expression): void => {
        if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          flat(x.left);
          flat(x.right);
        } else parts.push(x);
      };
      flat(n);
      if (parts.some((p) => ts.isStringLiteralLike(p) && hasProse(p.text))) {
        hit(
          'prose-concat',
          n,
          parts
            .filter((p) => !ts.isStringLiteralLike(p) && !ts.isTemplateExpression(p))
            .flatMap(renderedNoteNames),
        );
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** The baseline probe, line by line. */
function baselineHits(source: string, file = '<planted>'): Hit[] {
  const hits: Hit[] = [];
  source.split('\n').forEach((line, i) => {
    for (const [rule, re] of BASELINE_RULES) {
      if (re.test(line)) hits.push({ rule, file, line: i + 1, names: '', text: line.trim().slice(0, 140) });
    }
  });
  return hits;
}

type Dict = Record<string, unknown>;
function localeStrings(d: Dict, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(d)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...localeStrings(v as Dict, key));
    else if (typeof v === 'string') out.push([key, v]);
    else if (Array.isArray(v)) v.forEach((s, i) => typeof s === 'string' && out.push([`${key}.${i}`, s]));
  }
  return out;
}
const leafWording = (s: string) => LEAF_WORDING.test(s) || NOTE_PLACEHOLDER.test(s);

const FILES = sourceFiles();
const SOURCES = FILES.map((f) => ({ file: rel(f), source: readFileSync(f, 'utf8') }));
const ALL_SINK_HITS = SOURCES.flatMap(({ file, source }) => sinkHits(source, file));

const allowedBy = (h: Hit) =>
  ALLOWLIST.filter((a) => a.file === h.file && a.rule === h.rule && h.text.includes(a.contains));
const show = (hits: Hit[]) =>
  hits.map((h) => `${h.file}:${h.line}  [${h.rule}] ${h.names}  ${h.text}`).join('\n');

describe('the web app puts no note identifier on a screen or in a log', () => {
  it('has scanned the files it claims to have scanned', () => {
    // Anti-vacuity: a walk that found nothing would pass every case below.
    expect(FILES.length).toBeGreaterThan(150);
    const names = SOURCES.map((s) => s.file);
    for (const f of [
      'components/pay/PoolPanel.tsx',
      'components/pay/SendForm.tsx',
      'components/pay/SubscribePanel.tsx',
      'components/pay/ReceivePanel.tsx',
      'components/pay/SubscriptionsPanel.tsx',
      'lib/privacy/shieldClient.ts',
      'lib/privacy/worker/poolHandlers.ts',
      'lib/privacy/pool/recoverFloat.ts',
      'lib/privacy/pool/shieldEphemeral.ts',
      'lib/privacy/pool/denominatedPool.ts',
      'lib/privacy/pool/subscribePrivateStarkV4.ts',
      'i18n/en.ts',
      'i18n/fr.ts',
    ]) {
      expect(names, `${f} is not in the scan`).toContain(f);
    }
  });

  it('renders, logs and reports no leaf, commitment or secret-derived value', () => {
    const unexplained = ALL_SINK_HITS.filter((h) => allowedBy(h).length === 0);
    expect(show(unexplained)).toBe('');
  });

  it('every allowlist entry explains exactly one hit', () => {
    for (const a of ALLOWLIST) {
      const matched = ALL_SINK_HITS.filter((h) => allowedBy(h).includes(a));
      expect(matched.length, `${a.file} :: ${a.contains} matched ${matched.length} hits`).toBe(1);
    }
  });

  it('shows no leaf number, note index or deposit date (the 2026-09-15 probe rules)', () => {
    const hits = SOURCES.flatMap(({ file, source }) => baselineHits(source, file));
    expect(show(hits)).toBe('');
  });

  it('no web locale string prints a leaf number or interpolates a note identifier', () => {
    const offenders: string[] = [];
    for (const [name, d] of [
      ['en', en],
      ['fr', fr],
    ] as const) {
      for (const [key, value] of localeStrings(d as unknown as Dict)) {
        if (leafWording(value)) offenders.push(`${name}.${key}: ${value.slice(0, 100)}`);
      }
    }
    expect(offenders.join('\n')).toBe('');
  });
});

describe('the detectors themselves', () => {
  it('flag the shapes the web app used to ship (UI-1 red tree)', () => {
    const planted = [
      'const a = <p>leaf #{n.leafIndex} · {truncate(n.commitment, 6, 4)}</p>;',
      'parts.push(`⚠️ ${x} SOL left on the key for note #${ref.leafIndex}: ${ref.sentence}`);',
      'const b = <dd>{truncate(bytesToHex(decoded.subscriberCommitment), 10, 6)}</dd>;',
      'const c = <p>{t("pay.pool.contributedNote").replace("{leaf}", String(contributed.fundedLeafIndex))}</p>;',
      "throw new Error('The contribution landed at leaf ' + done.leafIndex + ' but no claim came back.');",
      'console.warn(`[x] ${missing.length} missing leaf gap(s): ${missing.slice(0, 5).join(",")}`);',
      'opts.onProgress?.(`Closing a stranded proof buffer from leaf #${leafIndex}...`);',
      "console.warn('[x] tree root:', onChainRoot);",
      'setError(receipt.depositEpoch);',
      'const d = <span title={note.commitment}>x</span>;',
    ].join('\n');
    const rules = sinkHits(planted).map((h) => `${h.line}:${h.rule}`);
    expect(rules).toEqual([
      '1:jsx-child',
      '1:jsx-child',
      '2:prose-template',
      '3:jsx-child',
      '4:jsx-child',
      '4:i18n-placeholder',
      '5:prose-concat',
      '6:prose-template',
      '7:prose-template',
      '8:console-arg',
      '9:text-sink-arg',
      '10:jsx-text-attr',
    ]);
  });

  it('pass a handle, a count, a comparison, a tag and a size', () => {
    const neutral = [
      'const k = `${n.pool}:${n.leafIndex}`;',
      'const e = <p>{busyNote === `${n.pool}:${n.leafIndex}` ? <Spin /> : <Down />}</p>;',
      'const f = <p>{n.denomination} SOL · <NoteTag tag={n.tag} /></p>;',
      'console.warn(`[x] ${missing.length} missing leaf gap(s)`);',
      'throw new Error(`licenseSecret must be ${LICENSE_SECRET_BYTES} bytes, got ${licenseSecret.length}`);',
      'const g = <p title={busy && busy !== `${n.pool}:${n.leafIndex}` ? t("a") : undefined}>x</p>;',
      'const h = <p>{r.merklePath === "stored" ? t("pay.receive.pathStored") : t("pay.receive.pathMissing")}</p>;',
      'onProgress?.("Building Merkle proof from leaf history...");',
    ].join('\n');
    expect(show(sinkHits(neutral))).toBe('');
  });

  it('the baseline rules and the locale rule flag what they are for', () => {
    expect(baselineHits('<p>leaf #{n.leafIndex} · x</p>').map((h) => h.rule)).toEqual(['ui-leaf-jsx']);
    expect(baselineHits('const x = <p>{n.denomination} SOL</p>;')).toEqual([]);
    for (const planted of [
      'Your note at leaf #{spent} was withdrawn',
      'Votre argent a financé la feuille n°{leaf}',
      'funded leaf {leaf}, which the treasury owns',
    ]) {
      expect(leafWording(planted), planted).toBe(true);
    }
    for (const neutral of [
      'a note is identified by its leaf number and public commitment',
      'Shield {denomination} SOL',
      '{count} notes in this pool',
    ]) {
      expect(leafWording(neutral), neutral).toBe(false);
    }
  });
});
