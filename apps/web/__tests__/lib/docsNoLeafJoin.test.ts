/**
 * PUBLIC DOCUMENTS MUST NOT PUBLISH A FUNDED-TO-ISSUED LEAF PAIR.
 *
 * 🚨 THE FACT THIS PINS. `docs/BENCHMARK-2026-09-13.md` §6d recorded one live
 * note-in exchange and named both halves of it: the leaf the buyer's own
 * payment funded, and the older treasury leaf the deployment sealed to them.
 * The repository is public, so that one record was a join anybody could read:
 * it tied a wallet's deposit to the note it walked away with.
 * `docs/HANDOFF-2026-09-02.md` carried the same pair for an earlier run as
 * prose, `docs/BENCHMARK-2026-09-02.md` carried it as a signature chain ending
 * on a leaf, and `verify/records/note-in-exchange-2026-09-03.json` carried it
 * as two fields. All four were measured before this guard existed:
 * `wp-logs/DOCS-1-probe-rules.log`, `wp-logs/DOCS-1-probe-rules2.log`,
 * `wp-logs/DOCS-1-fix1-probe.log` and `wp-logs/DOCS-1-fix1-probe2.log`.
 *
 * WHAT THE CHAIN ALREADY PUBLISHES IS NOT BANNED HERE. A deposit publishes its
 * depositor, its commitment, its index and its roots (`docs/LEAK-LEDGER.md`
 * row B6), so a single leaf number printed next to its own deposit signature
 * adds nothing an observer cannot already read. The pair is different: the
 * issuance happens off chain, so nothing on chain says which older note was
 * handed to the wallet that funded leaf N. That link exists only if a document
 * prints it. This guard bans the link, not the number.
 *
 * WHY IT IS NOT A LIST OF SPELLINGS. `wp-logs/RED-0-report.md` records a
 * detector that enumerated the forms it looked for and was walked past 18 of 21
 * ways. So the rules here are about the SHAPE of a record, not about how the
 * arrow is typed:
 *   · PAIR     — one record names two DIFFERENT leaves. A record is one line,
 *                or one contiguous markdown table, or one JSON document, so the
 *                §6d shape (the two numbers in separate rows of one table) is
 *                caught as well as the one-cell shape. Arrow, dash, "became",
 *                "then", French, "#", "leaf index", glued — all the same to it,
 *                because none of them is read.
 *   · TRANSFER — one record puts a leaf within 50 characters of a verb of
 *                handing over or collecting. That is the HANDOFF-2026-09-02
 *                shape, where the pair is split across two sentences and only
 *                the possession is stated, and the BENCHMARK-2026-09-02 shape,
 *                where a signature chain ends on the collected leaf.
 * A JSON document is read as ONE record with its camelCase keys split into
 * words, so `"gaveUpLeaf": <n>` reads as the verb and the leaf it names, the
 * same way the prose does. Sizing: over the 283 files in scope that rule fires
 * on one file and on none of the 500 KB of signature-only records
 * (`wp-logs/DOCS-1-fix1-probe2.log` §K/§L).
 *
 * ⛔ THE FINDINGS ARE REDACTED ON PURPOSE. A failure prints the file, the rule
 * and the line, and never the leaf numbers or the surrounding text. CI logs of
 * a public repository are public (that is CI-1's whole subject), so a guard
 * that printed the pair in order to complain about it would republish it on
 * every red run. The file and line are enough to fix it.
 *
 * ⛔ AND SO ARE THE FIXTURES. Every planted record below is ASSEMBLED from the
 * reserved numbers in `SYN` and the placeholder signatures in `SIG`; not one is
 * written out as a literal. Two things follow, and both are checked rather than
 * asserted:
 *   · no identifier from a live run is republished here — the case "the planted
 *     fixtures use reserved numbers that name nothing in the tree" measures it;
 *   · this file is itself inside `ROOTS`, with no exemption, so if anybody ever
 *     pastes a real record into it the scan goes red on this file. Before the
 *     fixtures were assembled the file published 15 findings of its own
 *     (`wp-logs/verify/DOCS-1-r1-detector-probe.log` §E).
 *
 * ⚠️ WHAT A GREEN RUN HERE DOES NOT CLOSE. Stated so nobody reads it as more
 * than it is:
 *   · git history keeps the old text: the pair stays readable in the commits
 *     that carried it, and in any fork or mirror taken before today;
 *   · a leaf named without a leaf word — "index N", the shape in
 *     `app/api/issue-note/route.ts` (ISSUE-1's file, left to ISSUE-1) — is not
 *     read as a leaf reference;
 *   · a range ("leaves N-M") counts as one reference, not two;
 *   · numbers spelled out in words, or in a bespoke encoding;
 *   · a pair split across two records, two sections or two files — including
 *     one person's two own notes in two paragraphs, which is a different leak
 *     class (`docs/HANDOFF-2026-09-13.md` §9, handed to LEDGER-1);
 *   · a fixture assembled at run time, as the ones below are, rather than
 *     written out;
 *   · HTML tables are not treated as records, only markdown ones, so a pair
 *     spread across `<tr>` rows of a deck is missed;
 *   · scope is `docs/`, `apps/web/app/`, `apps/web/__tests__/` and
 *     `verify/records/` — screens, i18n strings, live-harness logs, the
 *     extension and the mobile app are UI-1, EXT-UI and MOB-UI, not this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = join(__dirname, '../../../..');
const ROOTS = ['docs', 'apps/web/app', 'apps/web/__tests__', 'verify/records'];

/** Text formats a reader of the public repository can open. */
const TEXT_EXT = new Set([
  '.md',
  '.html',
  '.htm',
  '.ts',
  '.tsx',
  '.mts',
  '.mjs',
  '.js',
  '.py',
  '.txt',
  '.json',
  '.css',
  '.mmd',
]);
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'out']);

/**
 * A leaf reference: a role word and the number it introduces.
 *
 * `(?![A-Za-z])` is what keeps `leafIndex = 0` in route code from reading as
 * a leaf reference, while a glued `leaf<n>` still does. The qualifier has to
 * be a separate word, so "leaf index <n>" is read and the identifier is not.
 */
const LEAF_REF = /\b(?:leaf|leaves|feuilles?)(?![A-Za-z])(?:\s+(?:index|no\.?|n[o°]))?[\s:=#]*#?\s*(\d{1,6})(?!\d)/gi;

/**
 * Verbs that say a note changed hands, base forms included. The base forms are
 * not decoration: the list without them walked past the signature chain in
 * `docs/BENCHMARK-2026-09-02.md`, which says "collect", never "collected"
 * (`wp-logs/DOCS-1-fix1-probe.log` §D — with them the corpus gives 1 finding
 * and 0 false alarms).
 */
const TRANSFER =
  /\b(?:give|gave|given|gives|giving) up\b|\b(?:hand|handed|hands|handing) (?:over|back|to)\b|\b(?:collect|collects|collected|collecting)\b|\b(?:receive|receives|received|receiving)\b|\b(?:issue|issues|issued|issuing) to\b|\bwalk(?:s|ed)? away with\b|\bin exchange for\b|\bswap(?:s|ped)? for\b|\bc[ée]d[ée]e?s?\b|\br[ée]cup[ée]r[ée]e?s?\b/gi;

/** How close a transfer verb has to sit to a leaf to be about that leaf. */
const NEAR = 50;

interface Ref {
  n: string;
  at: number;
}

interface Finding {
  rule: 'PAIR' | 'TRANSFER';
  where: string;
  detail: string;
}

function leafRefs(text: string): Ref[] {
  const out: Ref[] = [];
  LEAF_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LEAF_REF.exec(text)) !== null) out.push({ n: m[1], at: m.index });
  return out;
}

function distinct(refs: Ref[]): string[] {
  return [...new Set(refs.map((r) => r.n))];
}

/**
 * A JSON document read as words: `"gaveUpLeaf": <n>` becomes
 * `gave Up Leaf : <n>`, so the ordinary rules see the verb and the leaf it
 * names. Both substitutions keep the text's length or grow it evenly, so the
 * NEAR distance still means what it means in prose.
 */
function asWords(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/["']/g, ' ');
}

function transferNear(text: string, refs: Ref[]): boolean {
  TRANSFER.lastIndex = 0;
  let v: RegExpExecArray | null;
  while ((v = TRANSFER.exec(text)) !== null) {
    if (refs.some((r) => Math.abs(r.at - v!.index) <= NEAR)) return true;
  }
  return false;
}

/**
 * The detector. It returns findings with the leaf numbers left out: see the
 * redaction note in the file header.
 */
function scanText(path: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    const refs = leafRefs(line);
    if (refs.length === 0) return;
    const leaves = distinct(refs);
    if (leaves.length >= 2) {
      out.push({
        rule: 'PAIR',
        where: `${path}:${i + 1}`,
        detail: `${leaves.length} different leaves named in one line`,
      });
    }
    if (transferNear(line, refs)) {
      out.push({
        rule: 'TRANSFER',
        where: `${path}:${i + 1}`,
        detail: 'a leaf sits next to a verb of handing over or collecting',
      });
    }
  });

  // A markdown table is one record: §6d put the two halves of the pair in
  // separate rows of the same table, which no per-line rule can see.
  let start = -1;
  let buf: string[] = [];
  const closeTable = (endLine: number) => {
    if (start < 0) return;
    const leaves = distinct(leafRefs(buf.join('\n')));
    if (leaves.length >= 2) {
      out.push({
        rule: 'PAIR',
        where: `${path}:${start}-${endLine}`,
        detail: `${leaves.length} different leaves named in one table`,
      });
    }
    start = -1;
    buf = [];
  };
  lines.forEach((line, i) => {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (start < 0) start = i + 1;
      buf.push(line);
    } else closeTable(i);
  });
  closeTable(lines.length);

  // A JSON document is one record. Its lines mean nothing on their own, and its
  // keys carry the verb: `verify/records/note-in-exchange-2026-09-03.json`
  // published the pair as two fields that no per-line rule reads.
  if (/\.json$/i.test(path)) {
    const words = asWords(text);
    const refs = leafRefs(words);
    const leaves = distinct(refs);
    if (leaves.length >= 2) {
      out.push({
        rule: 'PAIR',
        where: path,
        detail: `${leaves.length} different leaves named in one JSON record`,
      });
    }
    if (transferNear(words, refs)) {
      out.push({
        rule: 'TRANSFER',
        where: path,
        detail: 'a JSON field names a leaf and says it changed hands',
      });
    }
  }

  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (TEXT_EXT.has(extname(e).toLowerCase()) && st.size < 2_000_000) out.push(p);
  }
  return out;
}

const scanned: Array<{ rel: string; text: string }> = [];
for (const r of ROOTS) {
  for (const abs of walk(join(ROOT, r))) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    scanned.push({ rel: relative(ROOT, abs).replace(/\\/g, '/'), text });
  }
}

function pretty(f: Finding[]): string[] {
  return f.map((x) => `${x.rule} ${x.where} (${x.detail})`).sort();
}

/**
 * Reserved numbers, and placeholder signatures, for the planted records below.
 * Nothing here is an identifier from a live run: the case "the planted fixtures
 * use reserved numbers that name nothing in the tree" checks that against the
 * whole corpus, so a document that ever does name one of them turns this file
 * red and the number gets moved.
 */
const SYN = {
  funded: 7001,
  issued: 7002,
  gaveUp: 7003,
  collected: 7004,
  deposit: 7005,
  screen: 7006,
  twin: 7007,
  rangeFrom: 7011,
  rangeTo: 7012,
} as const;
const SIG = {
  shield: 'Zq1Example',
  spend: 'Sy2Sample',
  deposit: 'Ex4mpleDep',
  other: 'Nv5Notreal',
} as const;

describe('public documents do not join a funded leaf to an issued one', () => {
  /**
   * Without this case a path mistake makes the whole file green while reading
   * nothing at all, which is the failure `wp-logs/PROTOCOL.md` calls a test
   * that cannot go red. 283 files were in scope when this was written
   * (`wp-logs/DOCS-1-fix1-probe.log` §H); the floor is set under it so the case
   * reports an empty scan, not a tidy-up.
   */
  it('the scan reaches the public docs, the web app, its tests and the verify records', () => {
    const paths = scanned.map((s) => s.rel);
    expect(paths.length).toBeGreaterThanOrEqual(200);
    expect(paths).toContain('docs/BENCHMARK-2026-09-13.md');
    expect(paths).toContain('docs/BENCHMARK-2026-09-02.md');
    expect(paths).toContain('docs/HANDOFF-2026-09-02.md');
    expect(paths).toContain('verify/records/note-in-exchange-2026-09-03.json');
    // The guard is inside its own scope, with no exemption: a real record
    // pasted into the fixtures below is a finding like any other.
    expect(paths).toContain('apps/web/__tests__/lib/docsNoLeafJoin.test.ts');
    expect(paths.filter((p) => p.startsWith('apps/web/app/')).length).toBeGreaterThan(0);

    // The extractor has to work on the real text, not only on the planted
    // strings below: a regex that matched nothing would otherwise pass.
    const filesWithALeaf = scanned.filter((s) => leafRefs(s.text).length > 0).map((s) => s.rel);
    expect(filesWithALeaf.length).toBeGreaterThanOrEqual(3);
  });

  it('the detector flags a funded-to-issued pair however it is written, and leaves what the chain already publishes alone (positive control)', () => {
    // Planted records that MUST be flagged. Each one is the SHAPE of a record
    // that was published somewhere, with reserved numbers in place of the
    // identifiers: the control tests shapes, not history.
    const mustFlag: Record<string, string> = {
      P1: `| **exchange total** | **28.1 s** | leaf ${SYN.funded} → leaf ${SYN.issued}; inventory 318 notes |`,
      P2: `the exchange: leaf ${SYN.funded} -> leaf ${SYN.issued}, 28.1 s`,
      P3: `leaf ${SYN.funded} => leaf ${SYN.issued}`,
      P4: `la feuille ${SYN.funded} devient la feuille ${SYN.issued}`,
      P5: `leaf #${SYN.funded} became leaf #${SYN.issued}`,
      P6: `leaf no ${SYN.funded} up front, then leaf no. ${SYN.issued}`,
      P7: `the buyer shielded leaf ${SYN.funded} and walked away with leaf ${SYN.issued}`,
      P8: `2. **The note-in exchange ran live**: leaf ${SYN.gaveUp} given up, the till credited`,
      P9: `transaction as \`pool-withdrawal\`, leaf ${SYN.collected} collected. It found a defect`,
      P10: `leaf index ${SYN.funded} in, leaf index ${SYN.issued} out`,
      P11: `Leaf ${SYN.funded} then Leaf ${SYN.issued}`,
      P12: `leaf${SYN.funded} was funded and leaf${SYN.issued} was issued`,
      P13: `the note issued to the payer was leaf ${SYN.issued}`,
      // The cross-row shape: neither row alone names a pair.
      P14: [
        '| leg | time | landed |',
        '|---|---|---|',
        `| shield leg (not the exchange) | 27.6 s | \`${SIG.shield}…\` leaf ${SYN.funded} |`,
        `| **exchange: issue** | 6.3 s | leaf ${SYN.issued}, deposited by the treasury |`,
      ].join('\n'),
      // The signature-chain shape: two of the buyer's own signatures, then the
      // leaf they collected, with the verb 34 characters away.
      P15: `| note-in exchange: shield, withdraw to the till, claim, collect an older note | 522 s for the three chain steps, then 13 s to collect | \`${SIG.shield}…\` → \`${SIG.spend}…\` → leaf ${SYN.collected} |`,
      // The machine-readable shape: two leaf fields in one record.
      'P16.json': `{"flow":"note-in-exchange","spendSig":"${SIG.spend}","gaveUpLeaf":${SYN.gaveUp},"receivedLeaf":${SYN.collected},"tillCreditLamports":995000000}`,
      // And one leaf field whose own key says it changed hands: half the pair
      // is still a join, because the signature beside it names the buyer.
      'P17.json': `{"spendSig":"${SIG.spend}","receivedLeaf":${SYN.issued}}`,
    };

    // Planted records that MUST NOT be flagged.
    const mustPass: Record<string, string> = {
      // A leaf beside its own deposit signature: already public on chain
      // (LEAK-LEDGER B6).
      N1: `| **Shield 1 SOL** | **18.6 s** | tree read, C6 proof | 18.6 s | \`${SIG.deposit}…\` leaf ${SYN.deposit} |`,
      N2: '.progress { position: fixed; z-index: 50; } .hint { z-index: 100; }',
      N3: 'the three verify strings match `/stark proof/i` in the prove phase at index 2 — before open at index 5',
      N4: ` * tree, so leaf ${SYN.twin} of the 1 SOL pool and leaf ${SYN.twin} of the 0.1 SOL pool are`,
      N5: ` * and nobody had copied one into the other. Ten deposits landed at leaves ${SYN.rangeFrom}-${SYN.rangeTo}`,
      N6: '| flow | product time | inside | whole test |\n|---|---|---|---|\n| Shield 1 SOL | 18.6 s | tree read | 18.6 s |',
      N7: `| **exchange: withdraw to the till** | 21.0 s | \`${SIG.spend}…\`, till credited 995,000,000 lamports |`,
      N8: '  for (let leafIndex = 0; leafIndex <= ceiling; leafIndex += 1) {',
      N9: `Signatures: shield \`${SIG.deposit}…\` (leaf ${SYN.deposit}), subscription \`${SIG.other}…\``,
      N10: `**Write down each note‘s leaf index.** It is on the result screen (\`leaf #${SYN.screen}\`)`,
      // The replacement text this work package writes into §6d. If a leaf
      // number ever comes back to those cells, this case turns red too.
      N11: [
        '| leg | time | landed |',
        '|---|---|---|',
        `| shield leg (not the exchange) | 27.6 s | \`${SIG.shield}…\`, the buyer's own fresh leaf |`,
        '| **exchange: issue** | 6.3 s | an older treasury leaf, deposited before this buyer existed |',
        '| **exchange total** | **28.1 s** | a fresh leaf in, an older one out; inventory 318 notes |',
      ].join('\n'),
      // The replacement row in docs/BENCHMARK-2026-09-02.md §4: both signatures
      // and both timings kept, the collected leaf gone.
      N12: `| note-in exchange (2026-09-03): shield, withdraw to the till, claim, collect an older note | 522 s for the three chain steps, then 13 s to collect | \`${SIG.shield}…\` → \`${SIG.spend}…\` → an older treasury note |`,
      // The scrubbed verify record. Same role: a leaf field coming back turns
      // this case red as well as the scan.
      'N13.json': `{"flow":"note-in-exchange","spendSig":"${SIG.spend}","claimKind":"pool-withdrawal","noteHandedBack":"a different, older note than the one given up","tillCreditLamports":995000000}`,
      // A deposit record: its own leaf, its own signature, no verb. B6 again,
      // so the JSON rule stays consistent with the markdown one.
      'N14.json': `{"depositSig":"${SIG.deposit}","leafIndex":${SYN.deposit},"lamports":995000000}`,
    };

    const missed = Object.entries(mustFlag)
      .filter(([id, text]) => scanText(id, text).length === 0)
      .map(([id]) => id);
    const falseAlarms = Object.entries(mustPass).flatMap(([id, text]) =>
      pretty(scanText(id, text)),
    );

    expect({ missed, falseAlarms }).toEqual({ missed: [], falseAlarms: [] });
  });

  /**
   * The round-1 verifier's blocker: the fixtures above used to be the real
   * records, so the guard republished in a test file what it had deleted from
   * the documents, and it could not see itself
   * (`wp-logs/verify/DOCS-1-r1-detector-probe.log` §E, 15 findings).
   * `SYN` and `SIG` answer it only if the numbers really name nothing, so that
   * is measured against the same corpus the scan reads, rather than asserted.
   */
  it('the planted fixtures use reserved numbers that name nothing in the tree', () => {
    const inTheTree = new Set(scanned.flatMap((s) => leafRefs(s.text)).map((r) => r.n));
    const clash = Object.entries(SYN)
      .filter(([, n]) => inTheTree.has(String(n)))
      .map(([k]) => k);
    expect(clash).toEqual([]);

    // And the source of this file carries no record of the banned shape: every
    // fixture is assembled, never written out. This is the same detector the
    // scan runs, aimed at this file's own text.
    const self = scanned.find((s) => s.rel === 'apps/web/__tests__/lib/docsNoLeafJoin.test.ts');
    expect(self, 'the guard has to be inside its own scan scope').toBeDefined();
    expect(pretty(scanText(self!.rel, self!.text))).toEqual([]);
  });

  it('no funded-to-issued leaf pair in docs', () => {
    const findings = scanned.flatMap((s) => scanText(s.rel, s.text));
    expect(pretty(findings)).toEqual([]);
  });
});
