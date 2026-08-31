# The zero-knowledge argument, and exactly what it does and does not say

**2026-08-31.** Devnet. Circuits C1, C3, C6, C7 — the denominated-pool
production path.

Every claim below is backed by a measurement that runs in CI. Where a claim
rests on an assumption instead, the assumption is named. Where something is out
of scope, it is said so rather than left to be inferred.

---

## 1. The statement

> For circuits C1, C3, C6 and C7, the compact STARK proof system is
> **statistical zero-knowledge in the random-oracle model**.

Concretely: there is an efficient simulator `S` that, given only the public
inputs and **no witness**, produces a transcript the deployed verifier accepts,
and that transcript is distributed identically to an honest prover's on every
value the wire carries.

Two words in that sentence are load-bearing and neither is decoration.
**Statistical**, not perfect: `S` fails with probability about `2^-54`.
**In the random-oracle model**: the argument assumes SHA-256 behaves as a random
oracle.

---

## 2. The simulator

`S` runs in five steps. Step 1 is the one that makes the rest possible.

1. **Fix the query positions first.** The query-position derivation is the
   *terminal* node of the Fiat-Shamir chain — no challenge in this protocol is a
   function of an opening. So `S` may program the oracle to fix the positions
   before it commits to anything, and nothing it builds afterwards moves them.
   This is a structural property of the transcript, not an assumption. It was
   read off `derive_query_positions_generic` (`verify.rs:2023`), which consumes
   the two roots, the public inputs, the OOD frame, the OOD quotient claims, the
   FRI layer roots, the terminal polynomial and the grinding nonce — and nothing
   downstream of it feeds back into any challenge. The positions are the last
   value derived, and no opening is an input to them.

2. **Choose the challenges.** `S` programs the oracle for the OOD point `z` and
   for the RLC challenges `alpha`, `alpha_bnd`.

3. **Sample the out-of-domain trace frame.** `T_c(z)` and `T_c(z·g)` for every
   committed column, uniform.

4. **Solve the quotient claims.** `S` computes `C_total(z)` with the verifier's
   own evaluator from the frame it just sampled, sets
   `SUM_j z^(jn) Q_j(z) = C_total(z) / Z_T(z)` — the one equation the verifier
   checks — then samples `Q_0(z) .. Q_{k-2}(z)` uniform and solves `Q_{k-1}(z)`.

5. **Fake the openings.** `S` samples the opened trace rows uniform, derives the
   quotient and FRI openings consistently with them, and programs the oracle for
   the Merkle roots and authentication paths. Only the positions fixed in step 1
   have to be consistent — the other 99% of every tree is never revealed.

The verifier accepts `S`'s transcript with probability about `1 - 2^-54`.

---

## 3. Why the transcript is indistinguishable

A distinguisher sees the wire and nothing else. So the question is, value by
value: **is the honest law the same as the simulated one?** The simulator samples
uniform, so the honest side has to be uniform too.

| what the wire carries | honest law | why, and where it is measured |
|---|---|---|
| OOD trace frame `T_c(z)`, `T_c(zg)` | **exactly uniform** | `T_c(z) = SUM_r T[c][r]·L_r(z)` is affine in that column's blinding rows with every coefficient `L_r(z) != 0`, because `z` is outside the trace domain |
| opened trace rows | **exactly uniform** | the same argument at every committed position — which needs the LDE domain to be disjoint from the trace domain, and that is what the coset shift buys. Measured: `the_lde_domain_never_meets_the_trace_domain_on_any_circuit`, and 8192 of 8192 positions at degree 1 |
| unopened trace leaves | **exactly uniform** | same. 99.46% of the trace tree is hashed and never revealed, and each unopened leaf preimage carries `2 · width · 63` bits of min-entropy — unguessable, so the unsalted SHA-256 hides it in the ROM and **no salt is needed** |
| `Q_0(z) .. Q_{k-2}(z)` — the seven free claims | **exactly, jointly uniform** | rank **7 of 7** on all four circuits: `the_free_claims_are_jointly_uniform_on_every_circuit` |
| `Q_{k-1}(z)` | determined, not sampled | it is the claim the verifier's recombination solves; `S` computes it the same way the verifier does |
| committed quotient values | **exactly uniform** | **384 of 384** at degree 1 on all four circuits: `quotient_leaves_are_exactly_uniform_on_every_circuit` |
| FRI layers and the terminal polynomial | **exactly uniform** | they are linear functionals of the DEEP composition `D`, and `D` is affine in the lift column, so uniformity passes straight through |

### What "degree 1" proves, and why it is not a statistic

The measurements report the **degree** of each committed value as a polynomial
in a single blinding element. Degree 1 with a non-zero slope means the value is
`a·m + b` with `a != 0` and `m` uniform — so the value is **exactly uniform on
the field**, whatever the rest of the mask and the whole witness are. That is a
proof, not an estimate, and it does not weaken with sample size.

Degree 0 would mean the blinding never reaches the value. Degree 7 — which is
what the Poseidon columns give, and what every quotient value gave before this
work — means the value moves with the mask and is therefore not guessable, but
its law is **not** uniform-by-proof. High entropy is not a law. The contrast is
printed in the test output on purpose: the Poseidon column reads `0/384`, the
lift column `384/384`. An instrument that could not tell them apart would be
measuring nothing.

### The one thing that made it work

The lift constraint is

```
active(x) · nba(x) · v(x) · state0(x)^6
```

and the last factor **must be dense in `x`**. The first shape drafted for this
was `(x^n - c)^6`, and it measures **rank 1 of 7**, not 7: a polynomial in `x^n`
cannot smear randomness across segment boundaries, so all seven claims come out
as one scalar times a binomial coefficient and a single linear functional
separates them. Density in `x` is what creates rank.

---

## 4. What this rests on

Three assumptions, named rather than buried.

1. **SHA-256 is a random oracle.** This is not a new assumption introduced by the
   ZK argument. Fiat-Shamir has no soundness without it either, so the whole
   construction already stood on it.

2. **`alpha` and `z` are oracle outputs**, hence uniform and independent of their
   preimage. This is why the measurements fix them and vary the mask: in the ROM
   the conditional law of the mask given `alpha = a0, z = z0` is its
   unconditional law, so that is the correct experiment, not a convenient one.

3. **Honest-verifier.** The verifier is a fixed on-chain program, so this is the
   right notion here rather than a weakening.

---

## 5. What is NOT claimed

- ⛔ **Not perfect zero-knowledge.** `S` fails with probability about `2^-54`.
  No STARK of this shape is perfect ZK, and saying otherwise would be false.
- ⛔ **Not claimed for C0, C2 or C4.** They have no blinding region at all.
- ⛔ **Not claimed for C5.** It has neither a lift column nor a randomizer
  column, and both of its on-chain instructions are disabled — it proves no
  Merkle membership, which is a soundness defect, not a privacy one.
- ⛔ **Not a claim about what a transaction reveals on chain.** The proof hides
  the witness. It does not hide which program was called, which accounts were
  touched, or what the fee payer was. Those are separate properties with
  separate arguments.
- 🚨 **Not trustlessness.** The upgrade authority on both programs is a single
  CLI key with no multisig. Whoever holds it can replace the verifier. That is a
  deployment property, entirely independent of the cryptography, and it must not
  be blurred into the ZK claim.
- ⛔ **Devnet.** There is no mainnet deployment.

---

## 6. Reproducing it

```
cargo test -p p01-stark --release --lib zk_hiding -- --nocapture
```

Ten tests. The three that carry the argument:

- `the_lde_domain_never_meets_the_trace_domain_on_any_circuit` — the coset proof,
  per circuit, printing `n` and `lde` for each rather than asserting once
- `the_free_claims_are_jointly_uniform_on_every_circuit` — rank 7 of 7
- `quotient_leaves_are_exactly_uniform_on_every_circuit` — 384 of 384, against
  the degree-7 control

The harness is `stark/src/compact/zk_hiding.rs`, a `#[cfg(test)]` child module of
`compact` — no feature flag, so it cannot reach a shipped blob.

---

## 7. The sentence

What can be said, in full:

> Every value our prover publishes is provably uniform, and we measured it —
> rank 7 of 7 on the free quotient claims, 384 of 384 on the committed quotient
> values, on all four production circuits. The proof is statistically
> zero-knowledge in the random-oracle model.

The two qualifiers stay attached. **"Statistically"** and **"in the
random-oracle model"** are what make the sentence true, and a technical audience
will respect them far more than their absence.

And one thing to say separately, not folded in: **the upgrade key is a single
key.** Do not say "trustless" on the same breath as "zero-knowledge". They are
different properties and only one of them is proven.
