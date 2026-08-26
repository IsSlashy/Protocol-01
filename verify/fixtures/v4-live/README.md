# REAL FIXTURE — the first circuit-7 spend that ever landed

Recorded from devnet on 2026-08-26 with:

```bash
node verify/p01-verify.mjs \
  --spend 22psv1tFJUJB8TZANonuXFcJdq87EFA84Fcy1EXHfDzxbqs3h5nagMijjeZfaVviJcSuFGAP8nLzsVLs82Bf2rez \
  --wallet 7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU \
  --rpc <archival endpoint> --record verify/fixtures/v4-live
```

Everything in here is real: a real `unshield_denominated_stark_v4` at slot
487982698 against pool `GbVM5yve…`, paying 0.995 SOL out of leaf 35 on a single
circuit-7 proof. It replays with

```bash
node verify/p01-verify.mjs --self-test --replay verify/fixtures/v4-live
```

## What it pins, and what that is worth

**P1, P2, P4 PASS, and they are the point.** The v4 instruction carries no
commitment argument at all — not hidden, absent — so there is nothing for P2 to
match and nothing for P4 to trace back to a deposit. On the v3 fixture next door
the same three probes FAIL, because v3 publishes the commitment at a fixed
offset. That contrast is the measurement C7 was built to produce, and this is
where it is frozen.

**P11 FAILS, and that is also the point.** The fee payer of this spend is
`7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU`. That address is the on-chain
upgrade authority of both the pool and the verifier (checked against
`getAccountInfo` on their programData accounts, 2026-08-26), it is
`TREASURY_AUTHORITY` in `programs/zk_shielded/src/fee.rs`, it is the Solana CLI
default key this repo deploys with, and it is printed in `README.md` and in
`demo/README.md`. It is the single most publicly identified address the project
owns.

So the withdrawal publishes no field of the deposit and is still attributable to
the protocol operator in one `getTransaction`. **A commitment-free instruction is
not an anonymous transaction.** The fixture pins that sentence rather than
letting a future reader infer the opposite from three green probes.

## Why six probes are INCONCLUSIVE

P3, P6, P7, P8, P9 and P3b all report INCONCLUSIVE, which this tool counts as
FAIL on purpose — an unread channel is not a clean one.

- **P7, P8, P9** have nothing to read *because* P1 passed. No commitment was
  published, so there is no argument to count and no deposit side to walk. Their
  FAIL is a consequence of the good result, not evidence against it.
- **P3** cannot reach the proof upload. The chunks were written by this same
  payer about 22 000 slots earlier, and `p01_relayer` has been writing a
  `Heartbeat` from that key once a minute ever since, so the uploads now sit far
  past the 1000-signature ceiling of a single `getSignaturesForAddress` page.
- **P6** stops for the same reason: the payer's history filled the requested
  page, so the oldest entry held is not provably its first.

Both of those are re-readable from an archival endpoint with a deeper walk. They
are not claims about privacy in either direction.

## The trap this fixture was born from

The first recording of this exact command **could not replay**. `wrapRecorder`
stored the first response for a key and returned the live one on every repeat,
so the heartbeat that fired mid-run shifted `getSignaturesForAddress` by one
entry: the walk followed the second list, the fixture froze the first, and the
replay hard-stopped on the one signature only the frozen list held — 201
signatures pinned against 200 transactions fetched. Recording now serves repeats
from the store, so a fixture that records is a fixture that replays. If you ever
see a fresh recording miss on replay, suspect a second read of a growing history
before you suspect the probes.
