# v3-subscribe — recorded negative-control fixture

**Provenance: real.** This directory is a `--record` capture of an actual
devnet transaction — the `subscribe_private_stark` spend
`4v6RLndUyQFZNNKcdzdSi5JckEeR6vh4DHNhc3du77CuLUZnBMh2A7pcUcDiMSFbvkv8h6VFtzmfKq48qKFHx2A3`
in the 1 SOL pool, first recorded 2026-08-12 and re-recorded twice on
2026-08-16. `rpc.json` holds every RPC response the probes read (trimmed to the
fields the tool uses): the spend itself, the payer's full 172-transaction
history including all 148 proof chunks, the walk of the merkle tree's history to
the matching deposit, the deposit payer's own 96-transaction history, and the
pool account.

**Both re-records changed what is read, not what is true.** The first added the
deposit payer's history, which P8 walks and no earlier fixture held; the second
added inner instructions, which `trimForFixture` used to drop entirely. Every
probe reproduced its 2026-08-12 verdict and count across all three recordings.

## What it pins

v3 publishes the note commitment by design, so this spend is *known linkable*.
The manifest pins that knowledge:

```
P1  FAIL   commitment published at instruction byte offset 160
P2  FAIL   same value found by the 8-byte window scan
P3  PASS   commitment absent from all 148 proof chunks (measured, not assumed)
P3b FAIL   inconclusive by construction until trace blinding ships
P4  FAIL   origin reached in 1 hop — the deposit, at leaf 23
P6  FAIL   payer bracketed by 2 System transfers naming BRop3akx…
P7  FAIL   5 instructions publish the commitment in the clear
P8  FAIL   1 address funds BOTH ends: BRop3akx…
```

**Read the P4 hop count.** A `measure` of 1 means the first insertion found was
the origin — a real deposit. A note that had passed through
`transfer_denominated_stark_v3` would show 2 or more, because a transfer mints a
fresh commitment but publishes the old one in the clear at byte 80. The count is
pinned so that a note gaining a hop between two runs cannot slip by inside an
already-failing probe.

**Read the P8 pin, and read what a green one would NOT mean.** FAIL here means a
single wallet funded the deposit and the spend. A PASS would mean no single
wallet did — it would *not* mean the note was received rather than deposited by
the spender. One wallet that deposits its own note and then pays for the spend
through a third-party funder produces a green P8, measured. See the probe's own
PASS text, which says so.

```bash
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v3-subscribe
```

re-runs the probes on these frozen bytes and fails on ANY deviation. This is
the **negative control**: if a change to the tool makes P1, P2 or P4 stop
detecting this leak, CI goes red before anyone quotes a hollow green. Its
counterpart, `fixtures/v4-synthetic`, proves the opposite capability — that a
genuinely clean spend is reported clean.

**Read the P3 pin exactly.** PASS there means one thing: the commitment was
not copied *verbatim* into the uploaded proof bytes. It is NOT a claim that
the proof hides the note. The prover applies no trace blinding
(`stark/src/compact.rs:3460-3484`), so the published openings determine the
trace polynomial and the witness is recoverable by interpolation — a channel a
byte scan is structurally blind to. P3b is the probe that owns that gap; that
is why it is pinned FAIL here and must stay pinned FAIL until trace blinding
ships and the tool grows a real interpolation attempt with its own positive
control. Anyone quoting this fixture's P3 as a privacy result is misreading it.

Under no circumstance "fix" the tool so these probes pass on this fixture.
They fail because the leak is real.

## Re-recording

Only needed when the probes change *what they read* (a replay miss will say so
loudly). Requires live devnet and several minutes of throttled RPC:

```bash
node verify/p01-verify.mjs \
  --spend 4v6RLndUyQFZNNKcdzdSi5JckEeR6vh4DHNhc3du77CuLUZnBMh2A7pcUcDiMSFbvkv8h6VFtzmfKq48qKFHx2A3 \
  --record verify/fixtures/v3-subscribe
```

Then review the regenerated `manifest.json` `expect` map against the run you
watched before committing. If devnet has pruned this transaction by then, pick
any other v3-era spend — the control needs *a* known-linkable spend, not this
one specifically — and update this README's provenance section.
