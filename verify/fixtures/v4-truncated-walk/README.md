# ⚠️ SYNTHETIC FIXTURE — NOT A REAL TRANSACTION

Nothing in this directory ever touched a chain. It is `../v4-stale-root` with
one flag changed, emitted by `generate.mjs`; the same repeated-byte addresses and
counter roots, the same spend. Do not cite anything in here as evidence about
devnet, about any spend, or about any deposit.

## What it pins

The tree walk P12 and P13 share stops at its budget before the history ends:

| | |
|---|---|
| tree history | eight insertions, the spend, one insertion after it (10 signatures) |
| walk budget (`depositLimit` in the manifest) | 7 |
| **P12** | **FAIL, INCONCLUSIVE, no measure** (`--max-root-age 2`) |
| **P13** | **FAIL, INCONCLUSIVE, no measure** |

```bash
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-truncated-walk
```

**Why this needs its own fixture.** A walk that did not reach the end of the
history has seen fewer insertions than exist, so any age it reports can only be
a floor, which can make a stale root look fresh. The walker's `complete` flag
guards against that. In every other fixture the walk completes, so nothing
checked that the flag actually reaches the two verdicts. VERIFY-1 fix round 2
measured this: hard-coding `complete: true` where the walk is handed to P12, or
to P13, left all ten CI replays green (`VERIFY-1-r2-mutants.log`, W13 and W14).

Here the root the spend names *is* inside the part that was read. A tool that
dropped the flag would therefore find it and print age 4 (or P13 PASS, 1
bucket). Both would be a measure where the manifest pins none, and the replay
turns red.

## What it does NOT prove

- Nothing about any real walk budget. 7 is chosen to cut this history, nothing
  more.
- Nothing beyond `v4-stale-root` for the other probes: their pins are copied
  from it, and `depositLimit` reaches no other request on a v4 spend.

## Regenerating

```bash
node verify/fixtures/v4-truncated-walk/generate.mjs
git diff verify/fixtures/v4-truncated-walk   # must be empty — the generator is deterministic
```

Edit `generate.mjs`, never `rpc.json` or `manifest.json` by hand.
