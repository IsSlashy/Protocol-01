# ⚠️ SYNTHETIC FIXTURE — NOT A REAL TRANSACTION

Nothing in this directory ever touched a chain. Every address and every
"signature" is a repeated-byte pattern emitted by `generate.mjs` (payer =
32×`0xe5`, pool = 32×`0xf6`, spend sig = 64×`0x71`, …), all distinct from the
patterns in `../v4-synthetic` so the two fixtures cannot be mistaken for one
another. The only real values are the two program ids, which identify
programs, not transactions. Do not cite anything in here as evidence about
devnet, about v4, or about privacy.

## What it is for

This is a **regression pin**, not a third control direction. It is the same
clean hypothetical `unshield_denominated_stark_v4` spend as
`fixtures/v4-synthetic`, with one deliberate difference: the payer's history
of 5 signatures contains **two errored entries** (a failed `write_proof_chunk`
between the uploads, and an older unrelated failure).

```bash
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-synthetic-errored
```

asserts P3 **PASS** — the scan must be judged complete even though only 3 of
the 5 entries were actually fetched.

The regression it guards: `scanProofChunks` skips errored signatures without
fetching them (chunks go out with skipPreflight and the payer is a long-lived
wallet, so a failed transaction in its history is ordinary), and the
completeness test must count the skipped entries —
`scanned + errored >= sigs.length` (`p01-verify.mjs:557-566`). The pre-fix
arithmetic compared `scanned` alone against `sigs.length`, so ONE errored
entry anywhere in the payer's history made `complete` false forever and P3
reported INCONCLUSIVE with advice ("raise `--max-chunk-tx`") that could never
help — the shortfall was not a cap. That failure was closed (a false
INCONCLUSIVE, never a false PASS), which is exactly why it needs its own
fixture: the two control fixtures both have zero errored signatures, so the
bug's return would leave CI green without this one.

Two errored entries rather than one, on purpose: an off-by-one re-fix like
`scanned >= sigs.length - 1` survives one errored entry and dies on two. And
`rpc.json` holds **no** `getTransaction` response for either errored
signature — a change that starts fetching errored transactions is a replay
miss (exit 2), so that drift goes red too.

## What it does NOT prove

- Nothing about any real chain: see the warning at the top.
- Nothing `fixtures/v4-synthetic` does not already pin about clean-spend
  reporting — the P1/P2/P4 PASS pins here are incidental, kept only because a
  probe without a pin fails the replay self-test by design.
- Nothing about P3b: the interpolation witness-recovery channel stays
  INCONCLUSIVE until trace blinding ships (see `verify/README.md`).

## Regenerating

```bash
node verify/fixtures/v4-synthetic-errored/generate.mjs
git diff verify/fixtures/v4-synthetic-errored   # must be empty — the generator is deterministic
```

Edit `generate.mjs`, never `rpc.json` or `manifest.json` by hand, so the
committed bytes always remain reproducible from readable source.
