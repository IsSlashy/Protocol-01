# REAL FIXTURE — the first circuit-7 spend that went through the app

Recorded from devnet on 2026-08-26:

```bash
node verify/p01-verify.mjs \
  --spend 4WJ2kvzdGFV9SBDHnHFFkoyRbuXChDhEdrb8hE9ZGYBeJLrdCC1s2CT7zambsTPh5QU9Tyda3HZDYxwbF4QqYTwh \
  --wallet 7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU \
  --rpc <archival endpoint> --record verify/fixtures/v4-wired
```

## What makes this different from `v4-live`

`v4-live` froze the first C7 spend that ever landed. It was made by calling
`prepareUnshieldV4` and `unshieldDenominatedStarkV4` DIRECTLY — the service
layer, reached past everything an application actually goes through.

This one went through the worker protocol: `poolUnshieldPrepare` carrying the
payee, then `poolUnshieldExecute`. So it is the first spend that exercised
`prepareUnshieldJobV4`, the routing branch in `handlePoolUnshieldPrepare`, the
XOR guard on a half-specified request, the pre-blinding refusal, the job store's
version tag, and the execute-side payee comparison. Every one of those was
written on 2026-08-26 and none of them had met a real transaction.

The harness asserts `prep.version === 'v4'` before it spends. Without that line
the whole run passes on either circuit — a withdrawal lands both ways — and the
only thing proven is that *a* withdrawal works.

```
shield    4vGTC18kG7xCcQ1zc7iG32QTuEBdS6LXaVSW3ATkke9n4cBYkRfKwpKrPCy58PrrvMT5n5ugTUfyGJbYg4pgaQ3d  leaf 75
route     v4    job unshield-v4:6NUS4E5P…:75:BBunxg3e…    float 590,000,000
withdraw  4WJ2kvzdGFV9SBDHnHFFkoyRbuXChDhEdrb8hE9ZGYBeJLrdCC1s2CT7zambsTPh5QU9Tyda3HZDYxwbF4QqYTwh
payee     BBunxg3eSgBrBdrdzHMeft9a4Dw5Ly1QnupecoLRCLu3 received 0.995 SOL
```

## What it pins, and what each pin costs

**P1, P2, P3, P4 PASS.** No commitment in the instruction, no 8-byte window of
it anywhere in the instruction, none in the uploaded proof chunks, and no
deposit reachable from the spend. That is the property C7 exists for, measured
on a transaction the application produced rather than a script.

**P6 FAILS, and the detail is the result.** The report ends:

> `7gWpzSZA… is NOT among the spend payer's 11 counterparty edge(s) over 92
> transaction(s) read.`

The operator does not appear as a counterparty of this spend at all. That is the
difference from `v4-live`, where the operator WAS the fee payer and P11 found it
directly on the withdrawal. Here the withdrawal was paid by a key this repository
has never named. What P6 still finds is the funding edge itself: an ephemeral
cannot pay a fee from nothing, so something transferred to it, and that something
is a wallet.

**P11 FAILS at TWO HOPS, not one.** It reports the operator as

> `NAMED in the spend payer's funder 9vwdxkUo…'s own history`

— the fresh payer was funded from the operator's key, because on devnet there was
no third party to fund it. So the chain is withdrawal → ephemeral → fresh payer →
its history → operator. One hop longer than `v4-live`, and still there. This is
the shape recorded as "the funder moves a name, not an edge": paying through a
new key relocates the name, it does not delete it.

**P10 FAILS, and it failed because of a deliberate act.** It passed at first: the
payee had exactly one transaction and had sent nothing onward. Then the harness's
0.995 SOL was swept home, which gave the payee an outbound edge, and P10 went red.

That is not a defect in the sweep and not a defect in the probe. It is the
sentence the probe has always carried — *"read it as 'not swept yet', never as
'cannot be traced'"* — happening. **Recovering the money re-links the address.**
Anyone reading this fixture should understand that the P10 PASS on `v4-live` is a
statement about time, and that this fixture shows what the other side of that
statement looks like.

## Cost, measured

Isolated on the successful attempt, from the payer's own balance deltas:

```
float out            -0.590005
float back           +0.588368     buffer closed, ephemeral swept
                     ----------
round trip            -0.001637     99.7% of the float returns by itself
payee sweep fee       -0.000005
protocol fee 0.5%     -0.005000     into the fee escrow
                     ----------
one withdrawal        ~0.0066 SOL
```

⚠️ The 0.005 is NOT recoverable against the currently deployed program.
`sweep_fee_escrow` cannot execute — it debits a `SystemAccount` the program does
not own — so the escrow is a one-way sink until `419f683e` is deployed. At that
point the per-withdrawal cost drops to ~0.0016 SOL, and 0.30 SOL of accumulated
fees become reachable.

## The one thing this still does not exercise

`handlePoolRequest` is called in-process. The `postMessage` boundary and its
structured clone are not under test. The payloads are plain JSON-shaped objects,
which is why that is an acceptable gap rather than an ignored one — but it is a
gap, and a fixture that did not say so would be overstating itself.
