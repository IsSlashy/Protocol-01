# ⚠️ SYNTHETIC FIXTURE — NOT A REAL TRANSACTION

Nothing in this directory ever touched a chain. Every address, signature, root
and leaf is a repeated-byte or counter pattern emitted by `generate.mjs` (payer
= 32×`0xa4`, pool = 32×`0xb7`, tree = 32×`0xc8`, spend sig = 64×`0x71`, roots =
`0x00c0ffee…`). The only real values are the two program ids, which identify
programs, not transactions. Do not cite anything in here as evidence about
devnet, about any spend, or about any deposit.

## What it pins

A v4 withdrawal that proves against the **newest root the tree had** at spend
time:

| | |
|---|---|
| age of the named root at spend time | 0 insertions |
| **P12** | **PASS, measure 0** (`--max-root-age 2`) |
| P13 | PASS, measure 1 — the pool occupies one bucket; the printed detail must say `16 buckets of 2048 leaves` (`manifest.printed`, see ../v4-stale-root-at-tip/README.md) |

```bash
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-fresh-root
```

## Why this half exists

`../v4-stale-root` proves the probe can say FAIL. On its own that proves too
little: a probe that hard-failed every spend would satisfy it while measuring
nothing, and a future green on a real spend would be unfalsifiable. This fixture
is the same world with one field changed — the 32 bytes of `merkle_root` — so a
P12 that stopped reading the root would turn one of the two red whichever way it
broke.

```bash
node verify/fixtures/v4-stale-root/generate.mjs
node verify/fixtures/v4-fresh-root/generate.mjs
diff verify/fixtures/v4-stale-root/rpc.json verify/fixtures/v4-fresh-root/rpc.json
```

That diff is **one line**: the spend instruction. Same tree, same nine
insertions (eight before the spend, one after it), same slots, same payer, same payee, same proof uploads.

It is the same argument `../v4-synthetic` makes for P1/P2/P4, applied to the
channel those three probes cannot see.

## What it does NOT prove

- **Not that any real spend names a fresh root.** What decides that is the
  client: a stored Merkle path kept at shield time names the root of the
  depositor's own deposit. MEASURED on devnet 2026-09-15, 1 SOL pool: of 34 v4
  spends, 1 named a root 4 insertions old. This fixture describes the world
  after that is fixed, not the world as it was measured.
- Not that a fresh root makes a spend private. It removes one dating channel.
  P6 and P10 are pinned here too, and P3b stays INCONCLUSIVE by construction.
- Nothing about the bucket bits beyond "one bucket is occupied". P13's other
  branch is exercised offline, in `selfTestChannelDecoders`.

## Regenerating

```bash
node verify/fixtures/v4-fresh-root/generate.mjs
git diff verify/fixtures/v4-fresh-root   # must be empty — the generator is deterministic
```

Edit `generate.mjs`, never `rpc.json` or `manifest.json` by hand, so the
committed bytes always remain reproducible from readable source. `NAMED_LEAF` is
the one constant this file does not share with its twin.
