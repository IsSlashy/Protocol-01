# ⚠️ SYNTHETIC FIXTURE — NOT A REAL TRANSACTION

Nothing in this directory ever touched a chain. Every address and every
"signature" is a repeated-byte pattern emitted by `generate.mjs` (payer =
32×`0xa1`, pool = 32×`0xb2`, spend sig = 64×`0x51`, …). The only real values
are the two program ids, which identify programs, not transactions. Do not
cite anything in here as evidence about devnet, about v4, or about privacy.

## What it is for

This is the **positive control** of the self-test pair. It describes a
hypothetical `unshield_denominated_stark_v4` spend whose instruction carries
**no commitment**, plus the minimal world around it: a payer history with two
`write_proof_chunk` uploads (so P3 has bytes to scan) and a pool account (so
P5 has context).

```bash
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-synthetic
```

asserts P1, P2, P3 and P4 **PASS** and P3b stays **FAIL**, exactly as pinned
in `manifest.json`.

Why this half matters: `fixtures/v3-subscribe` (the negative control, recorded
from a real devnet spend) proves the tool can *detect* a leak. On its own that
proves too little — a tool that hard-failed everything would pass it. This
fixture proves the tool can also *report a clean result*, so that a future
green on a real v4 spend is falsifiable rather than assumed.

## What it does NOT prove

- Not that v4 exists, shipped, or was designed. `SPEND_KINDS` merely reserves
  the name with `commitmentOffset: null`.
- Not that a real v4 would be private. When v4 ships, record a **real** spend
  with `--record` and let the probes speak; this directory is only the proof
  that they *can* say "clean" when clean is true.
- Nothing about P3b: the interpolation witness-recovery channel stays
  INCONCLUSIVE until trace blinding ships (see `verify/README.md`).

## Regenerating

```bash
node verify/fixtures/v4-synthetic/generate.mjs
git diff verify/fixtures/v4-synthetic   # must be empty — the generator is deterministic
```

Edit `generate.mjs`, never `rpc.json` or `manifest.json` by hand, so the
committed bytes always remain reproducible from readable source.
