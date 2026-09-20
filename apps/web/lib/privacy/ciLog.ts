/**
 * What a PUBLIC GitHub Actions log is allowed to carry.
 *
 * WHY THIS EXISTS
 * ───────────────
 * github.com/IsSlashy/Protocol-01 is public, so the logs and the step summaries
 * of every workflow run are public with it, for as long as the runs are kept.
 * Two jobs write there: the restock tick (`.github/workflows/restock-inventory.yml`)
 * and the settlement tick (`settle-till.yml`). Ledger row E5 and map A defect 9
 * name what they used to print: the restock wallet and the float as base58, the
 * signature of the transfer between them, a leaf index per deposit, balances in
 * SOL, and the random delay each tick waited. Anyone reading a run could label
 * the inventory leaves and name the wallets that fund them.
 *
 * THE RULE HERE IS AN ALLOWLIST, NOT A BLOCKLIST
 * ──────────────────────────────────────────────
 * `ciSay` is how these jobs say what happened. It refuses any word that is not
 * in `CI_WORDS` and any number that is not a small count, so a line that names
 * a key, a signature, a leaf or an amount cannot be emitted at all — not in
 * base58, not in hex, not glued to a word. A blocklist has to be told each new
 * spelling; this cannot be dodged by inventing one. `ciFail` is how the top-up
 * says it failed: one redacted `::error::` line in the same file, because that
 * step's own stdout and stderr are kept off the public log (a library prints
 * there on its own; see `ciFail`).
 *
 * `redactForCi` is the other half, and it IS best effort. It exists for text
 * this repository did not write: the message of an exception thrown by a
 * library, which vitest prints even under `--silent`. It masks the two shapes
 * that carry data — a long alphanumeric run (a key, a signature, a hash, a
 * blob) and any digit run (a leaf, a balance, a slot, a delay) — and whatever
 * sits between quote marks, where a parser puts the input it could not read.
 * It keeps the short words, so the operator still reads which step failed.
 *
 * Pinned by `lib/privacy/pool/ciLogHygiene.test.ts`, which builds the same
 * lines in several worlds that differ in one value each and asserts the public
 * text does not move with the float key, the restock key, the balances, the
 * signature, the quiet time or a leaf index.
 *
 * ⚠️ NODE ONLY. This reads the environment and appends to a file. Nothing in a
 * client bundle imports it; the two callers are `scripts/topUpRestockWallet.mts`
 * and `lib/privacy/pool/restockInventory.test.ts`, both node.
 *
 * ⚠️ WHAT IT DOES NOT CLOSE. The TIME of a run stays public: the schedule, the
 * queue time and the duration of each step are on the run page whatever the log
 * says, so a deposit can still be matched to the tick that made it. Closing
 * that needs the founder's decision on log retention and on scheduling the
 * restock outside public Actions (plan decisions 11 and 12). Nor does it keep
 * the restock wallet unnamed: unauthenticated `GET /api/settle-till` serves
 * the float's public key, and the top-up is a plain transfer from the float
 * to that wallet, on chain. That is topology (DECHAIN-1 / RESTOCK-1).
 */

import { appendFileSync } from 'node:fs';

/**
 * Every word a public log line may contain.
 *
 * A line is split on spaces and each piece must be in this set. The verdict
 * words mirror `TopUpVerdict` in `pool/restockTopUp.ts`; `ciLogHygiene.test.ts`
 * drives `planTopUp` through all seven and asserts each one's line is sayable.
 * An eighth verdict added without a word here makes `ciSay` throw in CI, which
 * fails the step loudly rather than printing something nobody vetted.
 */
export const CI_WORDS: ReadonlySet<string> = new Set([
  // the top-up script
  'top-up',
  'dry-run',
  'live',
  'waiting',
  'verdict=restock-at-target',
  'verdict=float-at-floor',
  'verdict=below-minimum-move',
  'verdict=float-history-unknown',
  'verdict=too-soon-after-float-activity',
  'verdict=holding-off',
  'verdict=move',
  // the restock tick. Never the stock itself: `stock()` counts the authorised
  // leaves still UNSPENT, which no endpoint serves, and two ticks' counts gave
  // the number of issued notes spent in between. Whether a tick deposits is on
  // the chain anyway. Pinned by `pool/ciLogHygiene.test.ts`, case "the live
  // restock, run against a fake chain, says nothing that moves with the
  // unspent stock, the leaves, the balance or the random draws".
  'restock',
  'above-low-water',
  'below-low-water',
  'floor',
  'landed',
  'done',
]);

/** The environment variable a later workflow step prints. */
export const CI_VERDICT_FILE_ENV = 'P01_CI_VERDICT_FILE';

/**
 * At most this many counts on a line, and each one is capped. One: how many
 * deposits a tick landed. The second slot carried the stock beside its target
 * (`restock stock <n> <target>`), and is gone with it (case "ciSay refuses a
 * word or a number nothing allowlisted (positive control)").
 */
const MAX_COUNTS = 1;
const MAX_COUNT = 99;

/**
 * What replaces a redacted run. ASCII and distinctive on purpose: closing
 * ledger row E5 means grepping a real run's log and finding no key, no leaf and
 * no amount, which is easier when what replaced them is greppable too.
 */
const MASK = '[x]';

/**
 * The shortest alphanumeric run masked as an identifier.
 *
 * A base58 public key is 32-44 characters, a signature 87-88, a sha256 64; 20
 * catches all of them while leaving an identifier like `prepareUnshieldV4`
 * readable, so an operator still learns which step failed. This number is a
 * belt, not the instrument: the differential in `ciLogHygiene.test.ts` builds
 * the same message with a different key and asserts the redacted text does not
 * move, so a surviving fragment of a key goes red whatever the threshold is.
 */
const LONG_RUN_MIN = 20;

/**
 * Say one line, on the public record.
 *
 * `line` is a fixed phrase built from `CI_WORDS`. `counts` are small integers:
 * how many deposits a tick landed, which the chain shows anyway. Anything
 * above 99 is said as `99+`, so the number of digits is bounded whatever the
 * caller holds.
 *
 * Where it goes: `$P01_CI_VERDICT_FILE` when the workflow set one — the restock
 * step runs vitest with `--silent`, which swallows stdout, and the top-up step
 * keeps its own streams private, so the file is the channel and a later step
 * prints it — otherwise stdout, which is what a developer running the job by
 * hand wants.
 *
 * ⚠️ It cannot know what a number MEANS. Passing a leaf index where a count
 * belongs would print a leaf index under 100. No call site does; that is
 * asserted structurally by `ciLogHygiene.test.ts`, not by this function.
 */
export function ciSay(line: string, ...counts: number[]): string {
  const words = line.split(/\s+/).filter(Boolean);
  words.forEach((word, i) => {
    if (!CI_WORDS.has(word)) {
      // ⚠️ The refused word is NOT quoted back. This throw is itself printed in
      // the public log, and a refusal that echoes what it refused publishes it.
      // Nor is it written anywhere else first. Both pinned by case "ciSay
      // refuses a word or a number nothing allowlisted (positive control)" of
      // `pool/ciLogHygiene.test.ts`, which reads every channel a refusal
      // could write to on its way out.
      throw new Error(`ciLog: word ${i + 1} of this line is not in CI_WORDS (lib/privacy/ciLog.ts)`);
    }
  });
  if (counts.length > MAX_COUNTS) {
    throw new Error(`ciLog: at most ${MAX_COUNTS} counts on a line, given ${counts.length}`);
  }

  const said = [...words];
  for (const n of counts) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error('ciLog: a count is a whole number, zero or more');
    }
    said.push(n > MAX_COUNT ? `${MAX_COUNT}+` : String(n));
  }
  return publish(said.join(' '), 'stdout');
}

/**
 * Record a failure of the top-up as one GitHub annotation, redacted.
 *
 * 🚨 NOT THROUGH THE STEP'S OWN STDERR. A library prints there on its own:
 * web3.js answers a failed websocket `signatureSubscribe` with the transfer
 * signature, in a retry loop, and nothing this repository writes can refuse
 * it. So `restock-inventory.yml` sends the top-up step's stdout and stderr to
 * private files, and the annotation goes into the verdict file, where "Say
 * what happened" prints it and GitHub raises it. Redacted like
 * `ciRedactedError`, and folded onto ONE line: a newline in a library message
 * would start a second workflow command in the file that step prints. With no
 * verdict file (a hand run), stderr.
 *
 * Pinned by `pool/ciLogHygiene.test.ts`: case "a verdict goes to the file the
 * workflow prints, and to stdout when there is none" (the file, one line,
 * nothing else), case "a thrown library message reaches the log redacted, and
 * carries no cause" (the redaction), and case "the top-up script, run against
 * a fake chain, puts nothing on the record that moves with the keys, the
 * balances, the signature or the random draws" (the script's failures arrive).
 */
export function ciFail(message: string): string {
  return publish(`::error::${redactForCi(message).replace(/\s+/g, ' ').trim()}`, 'stderr');
}

/**
 * Append one line to the verdict file, or print it when there is none. The
 * only place this module writes: case "the restock job and the top-up script
 * print only through ciLog" of `pool/ciLogHygiene.test.ts` reads its three
 * sink lines by name and requires each exactly once.
 */
function publish(text: string, stream: 'stdout' | 'stderr'): string {
  const file = process.env[CI_VERDICT_FILE_ENV];
  if (file) {
    try {
      appendFileSync(file, `${text}\n`);
      return text;
    } catch {
      /* fall through to the stream, which --silent or a private redirect may swallow */
    }
  }
  if (stream === 'stderr') {
    // eslint-disable-next-line no-console
    console.error(text);
    return text;
  }
  // eslint-disable-next-line no-console
  console.log(text);
  return text;
}

/**
 * Mask the shapes that carry data, for text this repository did not write.
 *
 * Whatever a line quotes, long alphanumeric runs (keys, signatures, hashes,
 * base64 blobs) and every digit run (leaf indices, lamports, SOL amounts,
 * slots, seconds) become `[x]`. Short words survive, so
 * `prepareUnshieldV4: missing leaf gap(s)` still reads.
 */
export function redactForCi(text: string): string {
  // A vetted env name standing alone is kept; every other part is masked.
  return maskQuoted(String(text))
    .split(CI_ENV_NAME_RUN)
    .map((part, i) => (i % 2 === 1 ? part : maskData(part)))
    .join('');
}

/**
 * The environment variable names a failure may name, so an operator reads
 * WHICH secret is missing: each is a long run and would read `[x] is unset`
 * (`wp-logs/verify/CI-1-r2c-script-noenv.log`). A closed set of fixed names,
 * not a shape: an uppercase rule would also keep an uppercase hex hash. Kept
 * only when it stands alone — glued to a value (`NAME=<key>`) it is one run and
 * masked whole. Pinned by `ciLogHygiene.test.ts` (case 6, and case 7 reads
 * every name in the script's fixed fail() messages).
 */
const CI_ENV_NAMES = ['P01_FUNDER_SECRET_KEY', 'P01_TREASURY_KEYPAIR_JSON', 'P01_RESTOCK_WALLET_ADDRESS'];
const CI_ENV_NAME_RUN = new RegExp(`(?<![A-Za-z0-9+/=_-])(${CI_ENV_NAMES.join('|')})(?![A-Za-z0-9+/=_-])`);

/**
 * Mask everything between the first and the last quote mark of the text.
 *
 * A parser quotes what it could not parse. V8's JSON.parse answers a base58
 * key with `Unexpected token 'A', "AKAh9LUoWF"... is not valid JSON`, and
 * those characters are neither digits nor a long run, so `maskData` kept 9 of
 * the 10 (the web run round-3 verifier's major). From the FIRST quote mark to
 * the LAST, of any kind, so quotes side by side or nested (`'A', "…"`, a quote
 * inside the quoted input) leave nothing between them; one character is
 * masked too, because `'A'` is the key's first. A lone apostrophe masks
 * nothing. Across lines, because a key file cut by a newline puts the newline
 * inside the quoted span, and a mask that read one line at a time kept the
 * characters on each side of it (the continued run's round-2 verifier). Pinned
 * by case "a thrown library message reaches the log redacted, and carries no
 * cause" of `pool/ciLogHygiene.test.ts`, on two base58 keys: whole, cut by a
 * newline, behind a stray quote (the nested case, which a lazy mask left open:
 * the continued run's round-3 verifier's VR2), and quoted in backticks (VR3).
 */
function maskQuoted(text: string): string {
  return text.replace(/["'`][\s\S]*["'`]/g, (span) => `${span[0]}${MASK}${span[span.length - 1]}`);
}

function maskData(text: string): string {
  return (
    text
      // ⚠️ Identifiers BEFORE digits. A key masked after its digits were would
      // already have been split into short fragments that survive the rule.
      .replace(new RegExp(`[A-Za-z0-9+/=_-]{${LONG_RUN_MIN},}`, 'g'), MASK)
      // Then every number: a leaf index, a balance, a slot, a delay.
      .replace(/\d+/g, MASK)
      // `1.0034 SOL` and `118,119,120` read as one masked value, not as three.
      .replace(/\[x\](?:[.,:]\[x\])+/g, MASK)
  );
}

/**
 * The error to rethrow from a job whose failure message reaches a public log.
 *
 * Redacted, and with NO `cause`: an `Error` carrying a cause prints the cause
 * too, so a redacted message with the raw one attached leaks exactly what it
 * was meant to hide. The stack goes for the same reason — it names absolute
 * paths from the runner and the frames of the library that threw. A thrown
 * value that is NOT an Error (a prover's rejection string, a plain object) is
 * redacted the same way. Pinned by case "a thrown library message reaches the
 * log redacted, and carries no cause" of `pool/ciLogHygiene.test.ts`.
 */
export function ciRedactedError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const redacted = new Error(redactForCi(message));
  redacted.stack = `Error: ${redacted.message}`;
  return redacted;
}
