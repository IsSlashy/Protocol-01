# Closing the commitment channel — what v4 actually has to do

**Written 2026-08-17. NOT FOR DEPLOYMENT.** The prover and verifier are frozen
until **2026-09-04** (`docs/FREEZE-until-2026-09-04.md`) for measured soundness
reasons. This is the plan to execute after that date, written now so the freeze
is spent deciding rather than discovering.

---

## 0. The one-sentence version

**Removing the commitment from `subscribe_private_stark` closes 1 of the 5
places it is published, and would turn four probes green while the chain stays
fully readable.** The channel is in the *verifier's instruction arguments*, not
in the pool program, and it does not close unless all of it closes together.

---

## 1. What is actually published — measured, not remembered

`node verify/p01-verify.mjs --replay verify/fixtures/v3-subscribe`, probe P7:

> 5 instruction(s) publish the commitment in the clear (`GbVM5yve…`×1,
> `DGY37k3J…`×4; 172/172 tx scanned). **This is a FLOOR.**

- `GbVM5yve…` = `zk_shielded` — the subscribe itself, commitment at byte **160**.
- `DGY37k3J…` = `p01_stark_verifier` — **four** instructions.

| # | instruction | where the commitment sits | does v4-on-the-pool remove it? |
|---|---|---|---|
| 1 | `subscribe_private_stark` | instruction arg, byte 160 | **yes** |
| 2 | `verify_stark_proof_v2` (C1) | `public_inputs: Vec<u64>` arg | **no** |
| 3 | `verify_stark_proof_v2` (C3) | same | **no** |
| 4 | `verify_deep_ali_phase2` (C1) | same | **no** |
| 5 | `verify_deep_ali_phase2` (C3) | same | **no** |

Source: `programs/p01_stark_verifier/src/lib.rs:172-175` —
`pub fn verify_stark_proof_v2(ctx, public_inputs: Vec<u64>)`. The doc comment at
`:104` says it plainly: **circuit 1 (`pool_commitment`) has
`public_inputs = [nullifier, commitment]`.** The pair that *is* the linkage is a
public instruction argument, ~116 slots before the subscription exists.

And P7's own caveat: `shield_denominated_v3` publishes it too, on the **deposit**
side, which belongs to a different payer and is outside P7's walk. The floor is
5; the true count is higher.

## 2. The oracle that survives removing all five

`programs/p01_stark_verifier/src/lib.rs:204-216`:

```rust
let mut pub_buf = Vec::with_capacity(public_inputs.len() * 8);
for v in &public_inputs { pub_buf.extend_from_slice(&v.to_le_bytes()); }
let public_inputs_hash = solana_sha256_hasher::hashv(&[&pub_buf]).to_bytes();
buffer.public_inputs_hash = public_inputs_hash;
```

`ProofBuffer.public_inputs_hash` is stored on a public account. For C1 the
preimage is `nullifier ‖ commitment`, and **every candidate commitment is already
published** as a `LeafInserted` leaf. So an attacker enumerates the pool's
leaves, hashes each against the known nullifier, and recovers the match in **one
sha256 per leaf**.

Deleting the instruction argument and leaving this hash is not a fix. It is the
same value behind a lookup table anyone can build from public data.

## 3. Therefore: three changes, or none

They must ship together. Any subset is a **false green**.

**(a) `subscribe_private_stark` stops taking the commitment.**
Removes site 1. Necessary, nowhere near sufficient.

**(b) `public_inputs` stops being an instruction argument.**
Move it into the `ProofBuffer`, written by the same authority that uploads the
chunks. The current justification in the source is *"not stored in the buffer to
save space"* — that trade bought a few hundred bytes of account rent and cost
the entire linkage. Removes sites 2-5.

**(c) `public_inputs_hash` stops being invertible.**
Salt it with a value the buffer's authority chooses and does not publish:
`hash(salt ‖ public_inputs)`, salt stored in the buffer. The verifier's own
integrity check still works — it compares what it computed against what it
stored — while the dictionary attack needs the salt.
⚠️ Whatever is chosen must be checked against `verify::verify_generic`'s use of
`public_inputs`: the values must still reach the verification, they must merely
stop being *published*.

## 4. What still will not be closed, and must be said

**The deposit still names somebody.** A deposit moves real value into the pool,
so an address is named by arithmetic, not by design. All (a)+(b)+(c) buy is that
the *spend* can no longer be matched to *that particular deposit*. That is the
right goal and it is not the same as "the deposit is private".

**The anonymity set is still the pool.** Measured 2026-08-16: 0.1 SOL pool 34
leaves / 8 unspent, 1 SOL pool 25 / 6, 10 SOL pool 0 / 0. A perfect unlinkable
spend over six unspent notes is a one-in-six guess. **The commitment work is
worth nothing without deposit volume**, and that is a product problem, not a
cryptography one.

**Probe P3b, P7 and the deposit-side publications** need re-measuring after any
change. P7 counts a FLOOR and says so; do not read a drop from 5 to 0 as a
closure without extending the walk to the deposit payer.

## 5. Order, and the control that must exist first

1. **Extend P7 to the deposit side** before changing anything. Today it walks the
   spend payer only, so a v4 run would report 0 while
   `shield_denominated_v3` still publishes. A probe that cannot see the
   remaining sites will certify the change.
2. Add a **positive control fixture** for the closed state, the way
   `v4-synthetic` exists for a clean spend, so "the tool can still report a
   leak" and "the tool can report closure" are both exercised.
3. Then (b) — the verifier, the deepest and the one everything else depends on.
4. Then (c) — the salt.
5. Then (a) — the pool program, which is the cheapest and the most visible.
6. Re-record every fixture and re-pin every manifest. **A green run against a
   stale fixture proves nothing about the new program.**

## 6. What this does NOT touch

Two open fund-loss-class defects are independent of all of the above and outrank
it for anything beyond devnet:

- `unshield` (C5) proves no membership — `_merkle_root` is received and dropped,
  no root among C5's public inputs. Anyone running the honest prover drains the
  pool.
- C0 is a spend authorisation for the quantum wallet, not the subscription
  circuit.

See the memory notes `unshield-c5-no-membership-proof-2026-08-16` and
`c0-quantum-wallet-spend-auth-2026-08-16`. **No mainnet until both are closed**,
whatever the commitment channel looks like.
