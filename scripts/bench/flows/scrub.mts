/**
 * What a live-flow log must lose before it is written under the output
 * directory (for a real run, docs/bench/<date>/raw/, which is committed and
 * published). Pure: no I/O, so `node --test` can pin it (scrub.test.mts).
 *
 * Removed, and why:
 *   - the claim code, in both lines the purchase harness prints it:
 *       `claim-for-payment -> 200 {"ok":true,"claimCode":"…",…}` (the route's
 *       JSON, cut at 200 characters, so possibly cut inside the code) and
 *       `CLAIM <first 16 characters>...`. A claim code is a bearer credential
 *       for /api/issue-note (liveNoteInExchange.test.ts:289, 302);
 *   - the `record written to <path>` path and every other path inside the
 *     private directory: the purchase record, and the home directory, whose
 *     name is the Windows user name (liveNoteInExchange.test.ts:373);
 *   - every leaf number, in every form the harnesses print one, including the
 *     two values a failed leaf assertion compares. A leaf given up next to the
 *     leaf received is a funded-to-issued pair
 *     (apps/web/__tests__/lib/docsNoLeafJoin.test.ts); a leaf next to a spend
 *     signature dates the note;
 *   - any exact value the caller names (the codes read back from the private
 *     record after the run), wherever it appears.
 *
 * Kept: the `[bench-t …]` stamps, every marker the parser reads
 * (flows/markers.mts), full signatures, lamport amounts.
 *
 * The unscrubbed log is kept in the private directory, outside the
 * repository, for debugging a failed run.
 */

export interface ScrubOptions {
  /** Directories whose paths must not be published (the private dir). Replaced by `<private-dir>`. */
  privatePaths?: string[];
  /** The home directory: its name is the OS user name. Replaced by `~`. */
  homeDir?: string;
  /** Exact values to remove anywhere (8 characters or more). */
  values?: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Both separators, case-insensitive (Windows paths are). */
function pathPattern(p: string): RegExp {
  const trimmed = p.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]+/).map(escapeRe);
  return new RegExp(parts.join('[\\\\/]+'), 'gi');
}

/** base64url, the claim code's alphabet (route.ts: randomBytes(32).toString('base64url')). */
const B64URL = '[A-Za-z0-9_-]';

export function scrubLiveLog(text: string, o: ScrubOptions = {}): string {
  let out = text;

  for (const v of o.values ?? []) if (v && v.length >= 8) out = out.split(v).join('<redacted>');

  // The claim code as a JSON or object field, quoted or escaped, complete or cut.
  out = out.replace(new RegExp(`(claimCode(?:\\\\?["'])?\\s*[:=]\\s*(?:\\\\?["'])?)${B64URL}+`, 'g'), '$1<redacted>');
  // The `CLAIM <prefix>...` line.
  out = out.replace(new RegExp(`\\bCLAIM ${B64URL}{4,}(?:\\.\\.\\.)?`, 'g'), 'CLAIM <redacted>');

  // The record path, whole, before the generic path rules.
  out = out.replace(/record written to [^\r\n]*/g, 'record written to <private record>');
  for (const p of o.privatePaths ?? []) if (p) out = out.replace(pathPattern(p), '<private-dir>');
  if (o.homeDir) out = out.replace(pathPattern(o.homeDir), '~');

  // Leaf numbers: `leaf 117`, `(leaf 117)`, `leaf: 117`, and JSON / object fields.
  out = out.replace(/\bleaf(\s*[:#]?\s*)\d+/gi, 'leaf <omitted>');
  out = out.replace(/\b(leafIndex|gaveUpLeaf|receivedLeaf)((?:\\?["'])?\s*[:=]\s*)\d+/gi, '$1$2"<omitted>"');
  // A failed assertion prints both values it compared, and a diff of them.
  out = out.replace(/\bexpected (-?\d+) ((?:not )?to (?:be|equal|strictly equal|deeply equal)) (-?\d+)/gi, 'expected <omitted> $2 <omitted>');
  out = out.replace(/^(\s*[-+] )-?\d+\s*$/gm, '$1<omitted>');

  return out;
}
