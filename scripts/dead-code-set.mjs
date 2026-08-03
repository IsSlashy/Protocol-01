#!/usr/bin/env node
// Print the set of `dead_code` findings in a cargo/clippy JSON diagnostic
// stream, one `path :: message` per line, sorted and de-duplicated.
//
// WHY THIS EXISTS RATHER THAN A GREP
//
// `.github/workflows/ci.yml` allows exactly one lint in its `--all-targets`
// clippy gate — `dead_code` — because its two findings in `stark/src/compact.rs`
// are real and neither is fixable without a decision that is not a lint fix.
// An allowed lint is a blind spot unless something else pins it, so the step
// after that one re-reads dead_code and fails unless the finding SET is exactly
// those two. This script produces the set it compares.
//
// Three things were tried first and each was worse:
//
//   * `-A warnings -D dead_code`. Reports correctly, but `-D` ABORTS the build
//     at the first crate that has a finding — `p01-stark` — so the verifier's
//     own targets are never checked. MEASURED 2026-08-03: exit 101, "could not
//     compile p01-stark (lib)", nothing from `programs/p01_stark_verifier`.
//   * `-A warnings -W dead_code`, i.e. the same thing at warn level so nothing
//     aborts. MEASURED on the same tree: BOTH crates compile, and clippy prints
//     NOTHING. `warnings` is a pseudo-group rustc applies over the individual
//     specifications, so `-A warnings` silences `dead_code` no matter that
//     `-W dead_code` comes after it. A gate built on that flag pair reports an
//     empty set forever and therefore fails, or — far worse if it had been
//     written as a ceiling instead of an equality — passes forever.
//   * grepping the rendered text for "is never read" / "is never constructed".
//     That is a pin on rustc's prose. It misses "fields `a` and `b` are never
//     read", the plural form rustc switches to on its own, and it would silently
//     stop matching on a compiler upgrade. A gate nobody notices going blind is
//     the failure mode this whole pass exists to remove.
//
// So: run clippy with its DEFAULT levels, where dead_code is a warning and
// nothing aborts, and select on `message.code.code`, which is the lint's
// identity rather than its wording.
//
// Usage:  cargo clippy -p <pkg> --all-targets --message-format=json | node scripts/dead-code-set.mjs
// Exit 0 always when the input parses; the CALLER decides what the set means.
// Exit 2 if stdin held no JSON diagnostic records at all, because "no findings"
// and "I was handed nothing" must never look the same.

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const found = new Set();
  let sawAnyRecord = false;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    sawAnyRecord = true;
    if (rec.reason !== 'compiler-message') continue;
    const msg = rec.message;
    if (!msg || !msg.code || msg.code.code !== 'dead_code') continue;
    const span = (msg.spans || []).find((s) => s.is_primary);
    if (!span) continue;
    // Normalise Windows separators so the same pin holds on both platforms.
    const file = span.file_name.split('\\').join('/');
    found.add(`${file} :: ${msg.message}`);
  }

  if (!sawAnyRecord) {
    process.stderr.write(
      'dead-code-set: stdin contained no cargo JSON records at all. The clippy ' +
      'invocation that feeds this script did not run, or did not use ' +
      '--message-format=json. This is NOT an empty finding set.\n',
    );
    process.exit(2);
  }

  const lines = [...found].sort();
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
});
