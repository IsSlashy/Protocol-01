# The first subscription ever proved on circuit 7

Recorded from devnet on 2026-08-27:

```bash
node verify/p01-verify.mjs \
  --spend 66R9sqi27QWw3xGspFpN7tJ7JwuyPe1AuWRNFXAGbxFapkaFZYK7iexbZLsmvpbPbp9cskNSqbrqSxyuQNV8K3nB \
  --wallet 7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU \
  --rpc <archival endpoint> --record verify/fixtures/v4-subscribe
```

```
shield        57Ah97AG…  leaf 77
route         v4    job subscribe-v4:6NUS4E5P…:77:6Vo7Fifk…    float 570,000,000
subscribe     66R9sqi27QWw3xGspFpN7tJ7JwuyPe1AuWRNFXAGbxFapkaFZYK7iexbZLsmvpbPbp9cskNSqbrqSxyuQNV8K3nB
```

## What only a real transaction could say

`subscribe_private_stark_v4` was deployed inside `QvJqCsnw…` and, until this
signature, **nothing had ever called it**. The client passed 687 offline tests
throughout. Offline tests cannot tell you that:

* a 196-byte hand-rolled Borsh payload deserialises — the IDL is stale and
  carries neither v4 instruction, so the encoder is written by hand;
* eleven accounts arrive in the order `SubscribePrivateStarkV4<'info>` expects;
* the depth-15 subtree walk reaches a root the pool has vouched for;
* and the domain-tagged digest the CLIENT builds is the one the HANDLER
  recomputes.

Each of those fails as `InvalidProof` or `InstructionDidNotDeserialize` — after
a ~78-chunk upload and about 0.55 SOL of buffer rent. Landing is the only proof.

**The float is the circuit, visible in one number.** 570,000,000 lamports
against the C1 + C3 pair's ~1.02 SOL: one buffer instead of two, because
circuit 7 has nothing to pair with.

⚠️ **The harness took five attempts and the first four were all its own.** No
RPC variable, no `configurePoolHandlers`, no `Worker` in Node, and an unfunded
shield signer — that last one being the pool's own guard firing correctly on a
harness that had not paid. None of the four was visible offline, and the
subscribe path's tests were green through all of them.

## Read the class column, not the count

```
PASS  P1 P2 P3 P4        proven      — no commitment anywhere on the wire
????  P3b P7 P8 P9 P10   unread      — INCONCLUSIVE, counted as failures on purpose
FAIL  P6                 structural  — cannot reach PASS as this protocol is built
FAIL  P11                open        — the audit column, and the only to-do item
```

**P10 is `unread` here, and `structural` on a withdrawal.** That difference is
the whole reason the class is derived from the run rather than from a table
keyed by probe id. A withdrawal names its payee as a plaintext argument at
instruction byte 115, so P10 can never pass there. A subscription has no payee
argument at all — it pays a vault PDA, which is an ACCOUNT KEY, not instruction
data. So the probe says "I could not look" instead of reading 32 bytes of
something else and reporting an address that does not exist. A static table
would have printed the wrong word.

**P7, P8 and P9 are unreadable BECAUSE circuit 7 worked.** No commitment was
published, so P4 has nothing to match, so there is no deposit side to walk.

**P6 is Solana.** Every transaction carries a fee payer at `accountKeys[0]`
that must have held lamports before execution, so a payer always has a funding
history.

**P11 is the one that can close**, via a float drawn from the pool rather than
from a wallet — and even then it terminates at a permanent bootstrap edge.

⚠️ An eleven-PASS run of this suite would be a warning, not a success. P11
printed PASS on 2026-08-18 and it was FALSE: the wallet paid the funder two
hops away.
