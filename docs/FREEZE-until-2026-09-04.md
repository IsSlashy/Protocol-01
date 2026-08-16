# Freeze: prover and verifier, until 2026-09-04

Written 2026-08-16, after measuring the zero-knowledge route rather than
estimating it. The demo on 4 September rests on two artefacts that currently
agree with each other. Nothing in this repository needs to change for that to
keep being true. Several things would break it.

## The two values the demo depends on

Both re-measured 2026-08-16. Check them before travelling, and again on the
morning of the 4th. Thirty seconds, read-only.

```bash
sha256sum packages/stark-prover/wasm/p01_stark_bg.wasm
# 51a947e304416077ad8c2dc11a11b389ee86e81ebdb92b0bfccadb94631af496

solana program show DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs \
  --url https://api.devnet.solana.com
# Last Deployed In Slot: 481214309
# Data Length: 840168
```

The first is the prover blob the web ships. The second is the verifier that must
accept it. They match the attestation in
`packages/stark-prover/deployed-verifier.json` on `b7-drop-aligned-checks`.

**If either has moved, the demo is dead and that is the only thing to work on
that day.** Do not investigate anything else first.

## Do not, before 2026-09-04

- **Do not rebuild the prover WASM.** No shipped blob is reproducible from any
  branch today: the web carries `51a947e3`, the extension and mobile carry
  `4ace8913`, and a rebuild on 2026-08-16 produced a third object, `b7f6e830`.
  A rebuild therefore cannot be undone by rebuilding again.
- **Do not redeploy any program.** The live verifier was built from
  `b7-drop-aligned-checks`, which is an ancestor of neither `master` nor the
  working tree. A deploy from here is a downgrade, not an upgrade.
- **Do not merge `b7-drop-aligned-checks`.** It is the right thing to do
  eventually and the wrong week to do it: it rewrites `stark/` and the verifier,
  and every measurement above would have to be redone.
- **Do not edit `stark/src/compact.rs`.**
- **Do not run any `solana` command without `-k`.** See below.

## The key

`solana address` on this machine returns
`7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU`, and that is the upgrade authority
of the deployed verifier, of `zk_shielded` and of `liquidity`. It is the CLI
default, it holds ~28.5 SOL, no multisig or timelock stands behind it, and it
travels with the laptop.

So any `solana` invocation that omits `-k` is signed by the key that can replace
the bytecode of every live program. Two consequences worth acting on, in this
order:

1. Back the keypair up somewhere that is not this laptop, before travelling.
   A copy on `D:` protects against a corrupted file and not against a lost bag.
2. After 4 September, move the upgrade authority off the CLI default, so that
   replacing a program requires an explicit, unusual gesture.

## Why the ZK route is not being attempted first

Measured 2026-08-16, and it corrects the plan of 2026-08-12 in both directions.

**Against the plan.** `R`, the free coefficients per column, is **90, not 46**.
The deployed wire publishes four rows per query, not two:
`trace_values | trace_mirror_values | next_trace_values | next_trace_mirror_values`.
The 46 was derived from the working tree's wire, which is not the one on chain.
That pushes the masked quotient to 4718, which needs **ten** quotient segments
rather than nine, and +720 wire bytes rather than +184. The CU cost of ten
segments has never been measured, on a verifier already split across two phases
under the 1.4M cap at eight segments with a 920,897 CU worst case. And it is a
loop, not a knob: if ten segments overflow, you cut `num_queries`, which lowers
`R`, which changes the geometry, which needs a new CU measurement.

`stark/tests/masking_deep_degree_gate.rs:96` still hardcodes
`MASK_COEFFS_R = 46`. That constant is the first thing to fix when this work
resumes, before any other line.

**For the plan.** Soundness is healthier than the notes claimed: the deployed
verifier holds **47 bits conjectured and 42 unconditional**, capped by the
base-field Fiat-Shamir floor, not the 22 to 27 that had been quoted. Masking
would cost 0 conjectured bits and 2 unconditional ones, recoverable by raising
grinding from 22 to 24. Masking does not destroy soundness. The schedule is what
makes it infeasible, not the cryptography.

**And it would not be enough anyway.** Masking hides the witness inside the
proof. It does not touch the commitment republished in the clear as an
instruction argument at both ends (`unshield_denominated_stark_v3.rs:77-82`).
Closing that needs the C7 spend circuit, costed at 79 to 96 hours by this
repository's own plan. So: 39 to 70 hours for masking, plus 79 to 96 for C7,
against 64 hours before departure, ending in a redeployed verifier during a
ten-day absence.

## What is already private, today, at zero cost

`apps/web/lib/privacy/noteTransfer.ts` hands a note over off chain. It builds no
transaction and needs no signature, so there is no send for an observer to pair
with a receive. That is unconditional, and it is the only leg of this protocol
that is genuinely unlinkable right now.

One precondition nobody had written down. The sealed blob carries a Merkle path
that resolves to `stored`, `rebuilt` or `none`
(`apps/web/lib/privacy/worker/poolHandlers.ts:1622-1652`). The `rebuilt` fallback
only sees the leaves the RPC still serves, and a pruned history yields a root the
pool never had. **A note handed over with `none` may be unspendable.** Any note
used in a demonstration must export with `merklePath: 'stored'`, checked before
the room, not during it.

## Before spending an hour on ZK again

In this order, and none of them is optional.

1. The CU cost of a tenth segment on the real SBF bytecode.
   `programs/p01_stark_verifier/tests/cu_budget.rs` on `b7`, never run.
2. `R` obtained by execution, not by reading the parser. Count openings per
   column on a real b7 proof.
3. The masked quotient degree on the real prover. The `+7R` growth is
   extrapolated from a measurement at n=32.
4. A reproducible recipe for the prover WASM. Three different objects circulate
   today and a fresh build reproduces none of them.
5. `zk_feasibility.rs` running against `b7` at all. Its parser is built for the
   two-row wire and panics on b7's four-row one, so b7's ZK status is currently
   unknown in both directions.
6. What the extension and mobile actually ship.
7. That the demo note exports with `merklePath: 'stored'`.

Two things do not need measuring again. The prover is not zero-knowledge, and the
withdrawal is linkable. Both were re-measured on 2026-08-16.
