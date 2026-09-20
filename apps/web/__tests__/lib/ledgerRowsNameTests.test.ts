/**
 * EVERY ROW THE LEAK LEDGER MARKS CLOSED NAMES A TEST, AND THAT TEST EXISTS
 * (LEDGER-1; `docs/LEAK-LEDGER.md` row G3, "la prose lue comme preuve").
 *
 * WHY. The ledger's one rule is that a privacy claim names a test or a
 * measurement. Until this file nothing read the ledger, so a row could say F
 * and name nothing, cite a test by a nickname that is no file, point at a file
 * git does not carry (`/services/` is ignored, row D10b), or lose a column,
 * and stay green for ever. Measured on the ledger as it stood before LEDGER-1
 * edited it: the red log of this file (`wp-logs/LEDGER-1-red.log` in the
 * scratchpad of the 2026-09-19 web run).
 *
 * WHAT IT READS. The table under "## Le tableau", one row per line, four cells:
 * id, what leaks, status, pinned by.
 *   - A row is CLOSED when its status cell carries an F outside a ~~struck~~
 *     span. "**F**", "**F arbre**" and "**O** (…), **F arbre** (…)" all count:
 *     a closed clause makes the row answer for it.
 *   - In the pinned-by cell of a closed row a test is cited as
 *     `path/or/basename.ext` (`test name`, `other test name`). The file must
 *     be in the repository (tracked, or untracked and not ignored, and on
 *     disk) and resolve to ONE path. Each name must be DECLARED as a test in
 *     that file: an `it` / `test` / `describe` title in TS or JS, a `#[test] fn`
 *     in Rust, a step `name:` or `run:` line in a workflow. A name that only
 *     occurs in a comment is not a test.
 *   - Any other backticked token in that cell must be a directory of the
 *     repository. Anything else (`zk_hiding`, `chain.calls == [POOL_58]`) is a
 *     nickname, and a nickname is prose.
 * Open rows are not checked: "rien" is an honest pin for an open row.
 *
 * WHAT A GREEN DOES NOT SAY. That the named test passes (its own suite says
 * that), that it measures what the row claims (a reader decides that), or that
 * the fix is live: "F arbre" means the working tree, and the ledger's legend
 * says so. A declared name is a declaration, not a run.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '../../../..');
const LEDGER = 'docs/LEAK-LEDGER.md';

interface Row {
  id: string;
  line: number;
  cells: string[];
}

type Rule = 'CELLS' | 'NO_STATUS' | 'NO_TEST' | 'NO_FILE' | 'NO_NAME' | 'STRAY';

interface Finding {
  row: string;
  rule: Rule;
  detail: string;
}

interface Citation {
  file: string;
  names: string[];
}

/** One markdown table line, split on the pipes that are not escaped. */
function splitCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (c === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** The rows of the table under "## Le tableau", header and rule excluded. */
function parseLedger(text: string): Row[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Le tableau\s*$/.test(l));
  if (start < 0) return [];
  const rows: Row[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^##\s/.test(l)) break;
    if (!/^\s*\|/.test(l)) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue;
    const cells = splitCells(l);
    if (cells[0] === 'id') continue;
    rows.push({ id: cells[0], line: i + 1, cells });
  }
  return rows;
}

const STRUCK = /~~[\s\S]*?~~/g;
/** A status letter standing on its own: not part of a word, an id or a number. */
const marker = (letters: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}_-])[${letters}](?![\\p{L}\\p{N}_-])`, 'u');
const CLOSED = marker('F');
const ANY_STATUS = marker('OF?');

function isClosed(status: string): boolean {
  return CLOSED.test(status.replace(STRUCK, ' '));
}

function hasStatus(status: string): boolean {
  return ANY_STATUS.test(status.replace(STRUCK, ' '));
}

const FILE_TOKEN = /^[\w@.\/()[\]+-]+\.(?:rs|ts|tsx|mts|cts|js|mjs|cjs|jsx|yml|yaml|json|py|sh|toml|md)$/;

/**
 * The citations of a pinned-by cell: each backticked file, with the backticked
 * names in the parentheses right after it. Every other backticked token is
 * returned as stray.
 */
function parsePinned(cell: string): { citations: Citation[]; stray: string[] } {
  const citations: Citation[] = [];
  const stray: string[] = [];
  let i = 0;
  while (i < cell.length) {
    if (cell[i] !== '`') {
      i += 1;
      continue;
    }
    const end = cell.indexOf('`', i + 1);
    if (end < 0) break;
    const token = cell.slice(i + 1, end);
    i = end + 1;
    if (!FILE_TOKEN.test(token)) {
      stray.push(token);
      continue;
    }
    const cit: Citation = { file: token, names: [] };
    let j = i;
    while (j < cell.length && cell[j] === ' ') j += 1;
    if (cell[j] === '(') {
      let k = j + 1;
      let depth = 1;
      while (k < cell.length && depth > 0) {
        const c = cell[k];
        if (c === '`') {
          const e = cell.indexOf('`', k + 1);
          if (e < 0) {
            k = cell.length;
            break;
          }
          cit.names.push(cell.slice(k + 1, e));
          k = e + 1;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        k += 1;
      }
      i = k;
    }
    citations.push(cit);
  }
  return { citations, stray };
}

/** Git's view of the repository: tracked, or untracked and not ignored, and on disk. */
function repoFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))].filter((p) => existsSync(join(REPO, p)));
}

function resolveFile(token: string, files: string[]): { path?: string; why?: string } {
  if (files.includes(token)) return { path: token };
  const hits = files.filter((p) => p.endsWith(`/${token}`));
  if (hits.length === 1) return { path: hits[0] };
  if (hits.length === 0) return { why: 'is not a file of the repository' };
  return { why: `is ambiguous: ${hits.length} files of the repository end with it` };
}

function isRepoDir(token: string, files: string[]): boolean {
  const t = token.replace(/\/+$/, '');
  return t.length > 0 && files.some((p) => p.startsWith(`${t}/`));
}

const JS_TITLE = /\b(?:it|test|describe)(?:\.[A-Za-z]+(?:\([^()]*\))?)*\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
const RS_TEST =
  /#\[(?:tokio::)?test\]\s*(?:(?:#\[[^\]\n]*\]|\/\/[^\n]*)\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g;
const YML_STEP = /^\s*(?:-\s+)?(?:name|run):\s*(.+?)\s*$/;

/** The tests a file declares, by the rules in the header. */
function declaredTests(path: string, text: string): Set<string> {
  const names = new Set<string>();
  if (/\.rs$/.test(path)) {
    RS_TEST.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RS_TEST.exec(text)) !== null) names.add(m[1]);
  } else if (/\.ya?ml$/.test(path)) {
    for (const line of text.split(/\r?\n/)) {
      const m = YML_STEP.exec(line);
      if (m) names.add(m[1].replace(/^(['"])(.*)\1$/, '$2'));
    }
  } else if (/\.[cm]?[jt]sx?$/.test(path)) {
    // Comment lines are dropped, so a title quoted in a comment is not a test.
    const code = text
      .split(/\r?\n/)
      .filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l))
      .join('\n');
    JS_TITLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = JS_TITLE.exec(code)) !== null) names.add(m[2].replace(/\\(.)/g, '$1').trim());
  }
  return names;
}

/** The whole check, on any ledger text, so the planted rows below run through it too. */
function checkLedger(text: string, files: string[], read: (path: string) => string): { rows: Row[]; findings: Finding[] } {
  const rows = parseLedger(text);
  const findings: Finding[] = [];
  const declared = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.cells.length !== 4) {
      findings.push({ row: row.id, rule: 'CELLS', detail: `line ${row.line} has ${row.cells.length} cells, not 4` });
      continue;
    }
    const [, , status, pinned] = row.cells;
    if (!hasStatus(status)) {
      findings.push({ row: row.id, rule: 'NO_STATUS', detail: 'the status cell carries no O, F or ?' });
      continue;
    }
    if (!isClosed(status)) continue;
    const { citations, stray } = parsePinned(pinned);
    for (const s of stray) {
      if (!isRepoDir(s, files)) {
        findings.push({ row: row.id, rule: 'STRAY', detail: `\`${s}\` is neither a file, a test named after one, nor a directory` });
      }
    }
    let tests = 0;
    for (const c of citations) {
      const r = resolveFile(c.file, files);
      if (!r.path) {
        findings.push({ row: row.id, rule: 'NO_FILE', detail: `\`${c.file}\` ${r.why}` });
        continue;
      }
      if (c.names.length === 0) continue;
      let set = declared.get(r.path);
      if (!set) {
        set = declaredTests(r.path, read(r.path));
        declared.set(r.path, set);
      }
      for (const name of c.names) {
        if (set.has(name)) tests += 1;
        else findings.push({ row: row.id, rule: 'NO_NAME', detail: `\`${name}\` is not a test declared in ${r.path}` });
      }
    }
    if (tests === 0) {
      findings.push({ row: row.id, rule: 'NO_TEST', detail: 'marked closed, and names no test that resolves' });
    }
  }
  return { rows, findings };
}

const pretty = (f: Finding[]) => f.map((x) => `${x.row} ${x.rule}: ${x.detail}`);

const readRepo = (p: string) => readFileSync(join(REPO, p), 'utf8');
const FILES = repoFiles();
const REAL = readRepo(LEDGER);

/** The rows the 2026-09-15 to 2026-09-19 web run added (plan LEDGER-1 and its task). */
const ADDED_BY_THIS_RUN = ['B11', 'B12', 'C7', 'D14', 'D15', 'D16', 'D17', 'D18', 'D19', 'E8', 'E9', 'E10'];

const SELF = 'apps/web/__tests__/lib/ledgerRowsNameTests.test.ts';
const SELF_TEST = 'every row marked closed names a test that exists in the repository';

describe('the leak ledger names a test for every closed row', () => {
  it('reads the whole table of the real ledger, and finds closed rows to check (harness)', () => {
    const { rows } = checkLedger(REAL, FILES, readRepo);
    const ids = rows.map((r) => r.id);
    // The table held 66 rows when this file was written; a path or heading
    // mistake would read none, and a check over no rows is green for nothing.
    expect(rows.length).toBeGreaterThanOrEqual(60);
    for (const id of ['A1', 'B1', 'D10b', 'E7', 'F-a', 'F-f', '?6']) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    const closed = rows.filter((r) => r.cells.length === 4 && isClosed(r.cells[2]));
    expect(closed.length).toBeGreaterThanOrEqual(10);
    // Git answered, and the repository is the one this file lives in.
    expect(FILES).toContain(LEDGER);
    expect(FILES).toContain(SELF);
    expect(FILES.length).toBeGreaterThan(500);
  });

  it('flags a closed row with no test, a missing test, a missing or ambiguous file, a nickname and a lost column, and leaves open rows alone (positive control)', () => {
    const planted = [
      '## Le tableau',
      '',
      '| id | ce qui fuit | statut | épinglé par |',
      '|---|---|---|---|',
      '| Z1 | fermée sans test | **F** | rien |',
      `| Z2 | un test qui n'existe pas | **F** | \`${SELF}\` (\`a test this file never declares\`) |`,
      '| Z3 | un fichier absent | **F** | `noSuchLedgerFixture.test.ts` (`anything`) |',
      '| Z4 | ouverte sans test | **O** | rien |',
      `| Z5 | fermée, bien épinglée | **F arbre** | \`${SELF}\` (\`${SELF_TEST}\`) |`,
      '| Z6 | un F barré ne compte pas | ~~**F**~~ **O** | rien |',
      '| Z7 | une clause fermée engage la ligne | **O** (x), **F arbre** (y) | rien |',
      // A real test title, cited in a file that does not declare it.
      '| Z8 | le nom, dans le mauvais fichier | **F** | `apps/web/__tests__/lib/docsNoLeafJoin.test.ts` (`no KV row joins a leaf to a payment, code or recipient after a full cycle`) |',
      '| Z9 | un nom de fichier ambigu | **F** | `route.ts` (`anything`) |',
      `| Z10 | un surnom à côté d'un vrai test | **F** | \`${SELF}\` (\`${SELF_TEST}\`), \`zk_hiding\` |`,
      '| Z11 | une colonne perdue | **F web / O mobile** — rien |',
      // The phrase is in this file, in the header comment only: a comment is not a test.
      `| Z12 | un nom qui n'est qu'un commentaire | **F** | \`${SELF}\` (\`a nickname is prose\`) |`,
      '| Z13 | sans statut | ouvert | rien |',
      `| Z14 | un répertoire du dépôt est accepté | **F** | \`${SELF}\` (\`${SELF_TEST}\`), \`verify/fixtures/v4-live\` |`,
      // A file on disk that git ignores is not in the repository (row D10b).
      '| Z15 | un fichier ignoré par git | **F** | `services/spend-relay.mjs` (`anything`) |',
    ].join('\n');

    const { rows, findings } = checkLedger(planted, FILES, readRepo);
    expect(rows.map((r) => r.id)).toEqual([
      'Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'Z8', 'Z9', 'Z10', 'Z11', 'Z12', 'Z13', 'Z14', 'Z15',
    ]);
    const by = (id: string) => findings.filter((f) => f.row === id).map((f) => f.rule).sort();

    expect(by('Z1')).toEqual(['NO_TEST']);
    expect(by('Z2')).toEqual(['NO_NAME', 'NO_TEST']);
    expect(by('Z3')).toEqual(['NO_FILE', 'NO_TEST']);
    expect(by('Z4')).toEqual([]);
    expect(by('Z5')).toEqual([]);
    expect(by('Z6')).toEqual([]);
    expect(by('Z7')).toEqual(['NO_TEST']);
    expect(by('Z8')).toEqual(['NO_NAME', 'NO_TEST']);
    expect(by('Z9')).toEqual(['NO_FILE', 'NO_TEST']);
    expect(by('Z10')).toEqual(['STRAY']);
    expect(by('Z11')).toEqual(['CELLS']);
    expect(by('Z12')).toEqual(['NO_NAME', 'NO_TEST']);
    expect(by('Z13')).toEqual(['NO_STATUS']);
    expect(by('Z14')).toEqual([]);
    expect(by('Z15')).toEqual(['NO_FILE', 'NO_TEST']);

    // The three declaration shapes are read, and a comment is not one of them.
    const rs = declaredTests('x.rs', '/// fn not_a_test()\n#[test]\n#[ignore]\n// why\nfn a_rust_test() {}\nfn helper() {}\n');
    expect([...rs]).toEqual(['a_rust_test']);
    const yml = declaredTests('ci.yml', "      - name: A step\n        run: node verify/x.mjs --self-test\n      - name: 'Quoted step'\n");
    expect([...yml].sort()).toEqual(['A step', 'Quoted step', 'node verify/x.mjs --self-test']);
    const ts = declaredTests(
      'x.test.ts',
      "// it('in a line comment')\n/**\n * test('in a doc block')\n */\ndescribe.skipIf(x)('a block', () => {\n  it(\n    'a case, with \\'quotes\\'',\n    () => {},\n  );\n});\n",
    );
    expect([...ts].sort()).toEqual(['a block', "a case, with 'quotes'"]);
  });

  // The title is written out, not taken from SELF_TEST: a title held in a
  // variable is not a declaration this file's own rules can read (Z5 above
  // cites it, so the two cannot drift apart unnoticed).
  it('every row marked closed names a test that exists in the repository', () => {
    const { findings } = checkLedger(REAL, FILES, readRepo);
    expect(pretty(findings)).toEqual([]);
  });

  it('the rows this run added are in the ledger, and F-d answers for the extension and mobile too', () => {
    const { rows } = checkLedger(REAL, FILES, readRepo);
    const ids = new Set(rows.map((r) => r.id));
    // The list itself is pinned: emptying it must not be a way to go green
    // (mutant M12 in the LEDGER-1 mutation log survived before this line).
    expect(ADDED_BY_THIS_RUN).toHaveLength(12);
    expect(ADDED_BY_THIS_RUN.filter((id) => !ids.has(id))).toEqual([]);
    const fd = rows.find((r) => r.id === 'F-d');
    expect(fd?.cells[2] ?? '').toMatch(/mobile/);
    expect(fd?.cells[2] ?? '').toMatch(/extension/);
  });
});
