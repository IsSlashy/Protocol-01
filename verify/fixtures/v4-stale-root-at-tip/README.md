# ⚠️ SYNTHETIC FIXTURE — NOT A REAL TRANSACTION

Nothing in this directory ever touched a chain. It is `../v4-stale-root` with
two things changed, emitted by `generate.mjs`: the same repeated-byte
addresses and counter roots, the same spend. Do not cite anything in here as
evidence about devnet, about any spend, or about any deposit.

## What it pins

The same spend as `../v4-stale-root`, with the spend at the tip of the tree:

| | |
|---|---|
| age of the named root at spend time | 4 insertions |
| insertions after the spend | **0**, so the pool account's `next_leaf_index` is the only upper bound on the tree size at spend time |
| slot of the newest insertion | **one before the spend's** (the other fixtures leave 30 slots) |
| **P12** | **FAIL, measure 4** (`--max-root-age 2`), and its printed detail must say `a root 4 insertion(s) old, over --max-root-age 2.` |
| P13 | PASS, measure 1, and its printed detail must say `16 buckets of 2048 leaves` |

```bash
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-stale-root-at-tip
```

**Why this needs its own fixture.** P12 bounds the tree size at spend time from
both sides. The upper bound is the lowest insertion decoded after the spend, or,
when nothing came after, the pool account's `next_leaf_index`. The other
root-age fixtures all have an insertion after the spend, so the pool account was
never the bound in any of them. VERIFY-1 round 3 measured the gap: handing P12
`next_leaf_index - 1` or `null` where `verifySpend` passes the pool account left
all 13 CI steps green (`VERIFY-1-r3-mutants.log`, R1 and R2). A live spend with
nothing inserted after it has exactly this shape.

Here:

- `- 1` puts the upper bound below the lower one;
- `null` removes the upper bound;
- `+ 1` gives age 5.

In the first two cases P12 reports INCONCLUSIVE with no measure. In the third
it reports the wrong measure. All three deviate from the pins and turn the
replay red.

**The printed pins.** `manifest.printed` requires P13's printed detail
to carry `16 buckets of 2048 leaves`. That is the geometry the spend's bytes
carry: four walked levels under a depth-15 pool. It is the same for every
spend, so it names no position. A verdict pin and a measure pin could not see
P13 handed the wrong level count: forcing 3 levels printed buckets of 4,096
leaves and still passed with measure 1 (`VERIFY-1-r3-mutants.log`, R14).
`../v4-stale-root` and `../v4-fresh-root` carry the same pin.

**Why the newest insertion sits one slot before the spend.** P12 counts an
insertion as earlier than the spend by slot. In every other fixture the newest
earlier insertion is 30 slots before the spend. So handing P12 a spend slot 2
to 30 slots too early (the slot of a proof-chunk upload, say) changed nothing
there. On a live pool, the same mistake moves earlier insertions to "after" and
LOWERS the age, which is the false-clean direction. Measured in VERIFY-1 web-run
fix round 1: `spendSlot - 2` and `- 10` left all 14 CI steps green
(`mutants-slotshift-before.log`, R27 and R28). Here `- 2` reads age 3 against a
pin of 4. `- 1` puts that insertion in the spend's own slot, which gives an age
of 3 to 4. The measure stays 4, the larger age, so only the printed text shows
the change: P12 prints `3 to 4`, and the P12 text pin turns that red.

`- 1` is not harmless. On a live pool, an insertion in the spend's own slot is
the ordinary case, and `- 1` moves it to "after", which lowers the upper bound.
Measured on the tool's own functions: a history that correctly reads
INCONCLUSIVE (age 2 to 3 against `--max-root-age 2`) read PASS, age 2
(VERIFY-1 web-run fix round 1, `VERIFY-1-wr1b/v13-counterexample.log`). Before
the P12 text pin, `- 1` left all 14 CI steps green (`mutants-before.log`, V13).
P12's pinned words are the age and the bound only, which its verdict prints
anyway: no position and no size.

## What it does NOT prove

- Nothing about any real pool size. 8 is `../v4-stale-root`'s eight insertions.
- Nothing beyond `../v4-stale-root` for the other probes. Their pins are
  copied from it, and both changes reach only the tree walk.

## Regenerating

```bash
node verify/fixtures/v4-stale-root-at-tip/generate.mjs
git diff verify/fixtures/v4-stale-root-at-tip   # must be empty — the generator is deterministic
```

Edit `generate.mjs`, never `rpc.json` or `manifest.json` by hand.
