# The zero-knowledge argument, and exactly what it does and does not say

**2026-08-31, revised 2026-09-01.** Devnet. Circuits C1, C3, C6, C7 — the
denominated-pool production path.

> **What the revision changed.** The table in §3 asserted the FRI layers and the
> terminal polynomial were uniform *by an argument* — linear functionals of an
> affine `D` — with no measurement behind it, and the committed-value sweeps
> read a SAMPLE while the prose read like the committed domain. Both are now
> measured, exhaustively. Two results were added that did not exist: the
> published transcript measured **jointly** rather than value by value (§3.1),
> and the mask draw itself, which every other result is conditional on (§4).

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
| opened trace rows | **exactly uniform** | the same argument at every committed position — which needs the LDE domain to be disjoint from the trace domain, and that is what the coset shift buys. Measured on all four by `the_lde_domain_never_meets_the_trace_domain_on_any_circuit`; the per-position sweep that confirms it empirically, 8192 of 8192 at degree 1, has been run on C7 only — the coset proof is what carries the other three, and it is a proof, not a sample |
| unopened trace leaves | **exactly uniform** | same. 99.46% of the trace tree is hashed and never revealed, and each unopened leaf preimage carries `2 · width · 63` bits of min-entropy — unguessable, so the unsalted SHA-256 hides it in the ROM and **no salt is needed** |
| `Q_0(z) .. Q_{k-2}(z)` — the seven free claims | **exactly, jointly uniform** | rank **7 of 7** on all four circuits: `the_free_claims_are_jointly_uniform_on_every_circuit` |
| `Q_{k-1}(z)` | determined, not sampled | it is the claim the verifier's recombination solves; `S` computes it the same way the verifier does |
| committed quotient values | **exactly uniform** | degree 1 at **every** committed position on all four circuits: `quotient_leaves_are_exactly_uniform_on_every_circuit`. On C7 that is **65,536 of 65,536**. ⚠️ This read *384 of 384* until 2026-09-01, which was 8 segments times **48 sampled positions** — a true sentence that read like a statement about the committed domain |
| the DEEP composition | **exactly uniform** | degree 1 at **8,192 of 8,192** positions: `deep_and_every_fri_layer_are_exactly_uniform_in_one_blinding_element`. `D` is FRI layer 0 and is never given a tree of its own, so every one of its values is a preimage no verifier sees |
| FRI layers and the terminal polynomial | **exactly uniform** | degree 1 on **all seven committed layers entire**, 4,096 down to 64, and on both live terminal coefficients. ⚠️ Until 2026-09-01 this row carried an ARGUMENT and no measurement: linear functionals of an affine `D`, so uniformity passes through. The argument was right. It was also short, and short arguments about this prover have been wrong before, so the chain is now measured link by link |
| terminal coefficients above the degree bound | **identically zero** | not a hiding property at all: the FRI degree bound forces them, the prover asserts it (`compact.rs:5404`) and the verifier re-checks it. The sweep independently rediscovered `SPEND_FRI_FINAL_POLY_DEGREE_BOUND = 2` — exactly two of the thirty-two coefficients move |

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

### 3.1 The transcript jointly, not value by value

Everything above is a **marginal**. Every published value can be exactly uniform
while some linear combination of them is **constant**, and a distinguisher that
computes that combination gets the same answer from every honest proof and
separates honest from simulated in one query. Marginal uniformity does not
exclude that. Rank does.

So `the_published_transcript_is_jointly_uniform` assembles the vector a verifier
actually receives — the OOD claims, the live terminal coefficients, and the
opened pair values at each query position — and takes the rank of its slope
matrix in the mask.

**The rank is not full, and that is the correct answer.** A transcript the
verifier accepts satisfies the verifier's equations, so it lives in a proper
subspace. Measured twice:

```
1 query  :  88 published values, rank  80  →  deficiency  8
2 queries: 142 published values, rank 126  →  deficiency 16
```

The deficiency is exactly `queries × (committed FRI layers + 1)`: the seven
fold-consistency checks, each layer's opened value being determined by the pair
opened one layer below it, plus the terminal check. So the transcript is exactly
uniform **on the subspace the verifier's own checks cut out**, and nowhere less.

That is precisely the law `S` produces. Step 4 samples seven quotient claims and
solves the eighth; §3.1 says the same shape holds for every field element on the
wire — sample the free coordinates, solve the checked ones. The **scaling** is
the evidence rather than the single number: a deficiency of 16 alone could be a
coincidence, a deficiency that moves 8 → 16 when the query count moves 1 → 2 is
the verifier's equation count and little else.

⛔ **The additivity check is not a formality.** A slope matrix only describes the
map if the map is additive in the mask, and degree 1 in each element *separately*
still permits cross terms `m_i·m_j`. Under a cross term the single-element slopes
do not compose and the rank would describe a linearization this prover does not
implement. So perturbing two elements together is checked against perturbing them
apart, on all 142 values, before the rank is believed.

🚨 **The first run of this measurement read rank 55 of 142, and that was the
experiment failing rather than the prover.** It swept the lift column alone,
while the published vector carries the opened values of all twelve trace columns
— a mask element in column 10 moves column 10, and the other twenty-two
coordinates per query were constant by construction. A sweep must cover the
columns whose values it takes the rank of.

---

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

4. ~~**The mask is uniform.**~~ **No longer an assumption.** Every result above
   is of the form *the value is `a·m + b`, therefore uniform because `m` is*, and
   all of them are conditional on the last three words. That condition was FALSE
   on the shipping path as recently as 2026-08-30, when `draw_blinding_mask`
   lived behind `#[cfg(feature = "wasm")]` and every other caller wrote its own
   deterministic xorshift — `bin/gen_proof.rs` seeded all four of its arms with
   the same literal, so a proof it emitted blinded nothing at all, and no
   measurement here would have noticed. `the_mask_every_other_measurement_assumes_is_uniform`
   now checks it: in-field by rejection rather than reduction, two draws differ,
   no repeat inside a draw, bit frequencies balanced, and a structural scan that
   `gen_proof` binds no mask it did not draw from the CSPRNG. ⚠️ It is a sanity
   floor, not a randomness certification: rejection-not-reduction is pinned at
   the source because no sample size can see a one-in-`2^32` remap.

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
- ⛔ **Measurements, not a quantified proof.** Every number here is taken on
  **one witness, one query set and one baseline mask**. A simulation argument
  quantifies over all witnesses and all challenges; these measurements do not,
  and the gap between them is the honest distance still to travel. They are
  exhaustive over the committed domain, which is a different axis entirely.
- ⛔ **The grinding nonce and the query-position derivation are not measured.**
  §2 step 1 argues *structurally* that the positions are the terminal node of the
  Fiat-Shamir chain, and that argument is read off the verifier's own source. It
  is not a measurement, and nothing here measures the nonce at all.
- ⛔ **Soundness is unchanged and is not what this document is about.** 42 to 52
  bits, floor-bound by the field, and no ZK result moves it.

---

## 6. Reproducing it

```
cargo test -p p01-stark --release --lib zk_hiding -- --nocapture
```

Thirteen tests. The five that carry the argument:

- `the_lde_domain_never_meets_the_trace_domain_on_any_circuit` — the coset proof,
  per circuit, printing `n` and `lde` for each rather than asserting once
- `the_free_claims_are_jointly_uniform_on_every_circuit` — rank 7 of 7
- `quotient_leaves_are_exactly_uniform_on_every_circuit` — every committed
  position on every circuit, against the degree-7 control
- `deep_and_every_fri_layer_are_exactly_uniform_in_one_blinding_element` — the
  DEEP composition, all seven committed FRI layers and the terminal, exhaustive
- `the_published_transcript_is_jointly_uniform` — §3.1, rank against the
  verifier's own equation count

⛔ Every one of them prints a **control** alongside its result: a Poseidon column
reaching the same values at degree 7. Every value in this pipeline moves when the
mask moves, so *it changed* proves nothing, and an instrument that answered 1
unconditionally would pass every assertion while measuring the mask's own
arithmetic.

The harness is `stark/src/compact/zk_hiding.rs`, a `#[cfg(test)]` child module of
`compact` — no feature flag, so it cannot reach a shipped blob.

---

## 7. The sentence

What can be said, in full:

> Every value our prover publishes is provably uniform, and we measured it at
> every committed position — rank 7 of 7 on the free quotient claims, degree 1 on
> all 65,536 committed quotient values, on the DEEP composition and on all seven
> FRI layers, on all four production circuits. Taken jointly, the published
> transcript is exactly uniform on the subspace the verifier's own checks cut
> out. The proof is statistically zero-knowledge in the random-oracle model.

The two qualifiers stay attached. **"Statistically"** and **"in the
random-oracle model"** are what make the sentence true, and a technical audience
will respect them far more than their absence.

🚨 **And there is a third qualifier that belongs in any conversation where this
sentence is challenged**, even though it does not fit in the sentence: these are
**measurements**, exhaustive over the committed domain but taken on one witness
and one query set. The construction of `S` in §2 is the argument; §3 is evidence
for it, not a substitute. Anyone who asks for the simulation argument should be
pointed at §2 and told plainly which parts of §3 are measured and which are
structural. Do not let the exhaustiveness of the sweeps stand in for a
quantification over witnesses — they are different claims, and only one of them
is finished.

And one thing to say separately, not folded in: **the upgrade key is a single
key.** Do not say "trustless" on the same breath as "zero-knowledge". They are
different properties and only one of them is proven.
