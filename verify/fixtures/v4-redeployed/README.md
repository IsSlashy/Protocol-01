# The only fixture recorded against the program that is deployed TODAY

Recorded from devnet on 2026-08-27:

```bash
node verify/p01-verify.mjs \
  --spend 2wvtpJLrdnKu795ZyrCkqTcpvodHsSRSNTrJLRTa5U29QVCQKNJA5XumuqbpELRjPiSdZqfTWXxL4bbTwUqaK6Cx \
  --wallet 7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU \
  --rpc <archival endpoint> --record verify/fixtures/v4-redeployed
```

## Why a third v4 fixture

There are now three real circuit-7 withdrawals frozen in this directory, and
only one of them exercises the binary currently on chain:

| fixture | spend | what it exercised |
|---|---|---|
| `v4-live` | `22psv1tF…` | the first C7 proof ever, by calling the services directly |
| `v4-wired` | `4WJ2kvzd…` | the first through the worker protocol, 2026-08-26 |
| **this one** | `2wvtpJLr…` | the first against the **redeployed** program, `QvJqCsnw…` |

The redeploy carried the canonical nullifier bound that closed a double spend,
plus `subscribe_private_stark_v4`, the SPL destination binding, and a fee escrow
that can be swept. `v4-wired` pins the shape of the program that existed
*before* all of that. Keeping it is right — it is a historical record — but
citing it as "the current state" is not.

## What it proves, and what it does not

**The client needed no change.** This withdrawal was produced by the same
`handlePoolRequest` path as `v4-wired`, against a binary rebuilt an hour
earlier, and it landed. Anchor discriminators are `sha256("global:<name>")`, so
adding an instruction renumbers nothing, and the canonical bound is a runtime
check rather than an argument change — both were expected to be invisible to
callers, and this is the measurement rather than the expectation.

**The bound rejects nothing honest.** Poseidon-GL reduces by construction
(`[a % MODULUS, b % MODULUS, 0]`, and its reducer returns `s - MODULUS` above
the modulus), so an honest nullifier is already canonical. That was an argument
from the source; this transaction is the proof.

**Privacy did not move, and should not have.** The measures are identical to
`v4-wired` — `P6: 11, P10: 1, P11: 1`. The bound is a soundness fix. A fixture
that showed privacy improving here would mean something else changed by
accident.

## The verdicts, read with the class column

```
PASS  P1  P2  P3  P4     proven      — no commitment anywhere on the wire
????  P3b P7  P8  P9     unread      — INCONCLUSIVE, counted as failures on purpose
FAIL  P6  P10            structural  — cannot reach PASS as this protocol is built
FAIL  P11                open        — the audit column, and the only to-do item
```

⛔ **Seven non-PASS lines are not seven defects**, and that misreading is what
the class column added on 2026-08-27 exists to prevent:

* **P7, P8 and P9 are unreadable *because* circuit 7 worked.** No commitment was
  published, so P4 has nothing to match, so there is no deposit side to walk.
  Their INCONCLUSIVE is a consequence of the win, not a gap in it.
* **P3b can never pass.** The tool detects a value present verbatim; recovery
  from a STARK proof is polynomial, not a byte copy.
* **P6 and P10 are Solana, not this protocol.** Every transaction carries a fee
  payer at `accountKeys[0]` that must have held lamports beforehand, so a payer
  always has a funding history; and the payee is a plaintext argument at
  instruction byte 115, because the pool has to be told where to send money.
* **P11 is the one that can close**, via a float drawn from the pool rather than
  from a wallet — and even then it terminates at a permanent bootstrap edge.

⚠️ A run of this suite that printed eleven PASS lines would be a warning, not a
success. This repository has already shipped that exact false green: P11 printed
PASS on 2026-08-18 while the wallet paid the funder two hops away.
