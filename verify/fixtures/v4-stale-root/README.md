# ⚠️ SYNTHETIC FIXTURE — NOT A REAL TRANSACTION

Nothing in this directory ever touched a chain. Every address, signature, root
and leaf is a repeated-byte or counter pattern emitted by `generate.mjs` (payer
= 32×`0xa4`, pool = 32×`0xb7`, tree = 32×`0xc8`, spend sig = 64×`0x71`, roots =
`0x00c0ffee…`). The only real values are the two program ids, which identify
programs, not transactions. Do not cite anything in here as evidence about
devnet, about any spend, or about any deposit.

## What it pins

A v4 withdrawal that proves against a Merkle root **four insertions older** than
the tree's state at spend time:

| | |
|---|---|
| age of the named root at spend time | 4 insertions |
| insertions after the spend | 1 — so the spend's own slot decides the age (fix round 2) |
| **P12** | **FAIL, measure 4** (`--max-root-age 2`) |
| P13 | PASS, measure 1 — the pool occupies one bucket; the printed detail must say `16 buckets of 2048 leaves` (`manifest.printed`, see ../v4-stale-root-at-tip/README.md) |

```bash
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-stale-root
```

**Why age is the measurement.** A root is created by exactly one insertion, and
the pool keeps its old roots in a ring, so a spend may name any of them and the
chain accepts it. Naming a root that is 0 insertions old says only "the tree as
everyone else sees it". Naming one that is 4 insertions old says "the tree as it
stood when my own deposit landed" — the stored path a client keeps at shield
time is built against exactly that root. The age is therefore how far back the
spend points, and 0 is the only value that points nowhere.

**It is the negative half of a pair.** `../v4-fresh-root` is the same world with
one field changed — the 32 bytes of `merkle_root` — and pins P12 PASS with
measure 0. Neither fixture is worth anything alone: this one alone is satisfied
by a probe that fails every spend, and its twin alone is satisfied by a probe
that passes every spend. Regenerate both and `diff verify/fixtures/v4-stale-root/rpc.json
verify/fixtures/v4-fresh-root/rpc.json` — it is one line, the spend instruction.

## Why it is synthetic, which is a choice and not a shortcut

The shape is real. **MEASURED on devnet 2026-09-15**, 1 SOL pool: of 34 v4
spends, 1 named a root 4 insertions old; the other 33 measured 0.

Recording that spend would freeze, in a public repository whose CI logs are also
public, the three things this probe exists to warn about: the root the spend
named, the insertion that created it, and therefore the deposit it dates. A
control that publishes the join it is guarding against is not a control. So the
geometry is copied and the identities are invented.

For the same reason the probe's own verdict text reports the age and the bound
and stops there — no insertion position and no tree size, since a size minus
the age is the position. It does not name the deposit. That is P4's job, and
P4 is silent on a v4 spend because no commitment is published.

## What it does NOT prove

- Not that any particular real spend is stale. One was, on the day named above;
  33 were not.
- Not that the root channel is the only one. P1, P2 and P4 pass on this fixture
  — the v4 instruction publishes no commitment at all — and the spend still
  dates its own deposit. That contrast is the reason this fixture exists.
- Nothing about P3b, which stays INCONCLUSIVE by construction here as everywhere.
- Nothing about the bucket bits beyond "one bucket is occupied". P13's other
  branch is exercised offline, in `selfTestChannelDecoders`.

## Regenerating

```bash
node verify/fixtures/v4-stale-root/generate.mjs
git diff verify/fixtures/v4-stale-root   # must be empty — the generator is deterministic
```

Edit `generate.mjs`, never `rpc.json` or `manifest.json` by hand, so the
committed bytes always remain reproducible from readable source. `NAMED_LEAF` is
the one constant this file does not share with its twin.
