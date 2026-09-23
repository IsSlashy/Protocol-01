# The hiding argument, and exactly what it does and does not say

**2026-08-31, revised 2026-09-01, 2026-09-02 and 2026-09-23.** Devnet.
Circuits C1, C3, C6, C7 — the denominated-pool production path.

> ⛔ **What the fourth revision changed (2026-09-23, audit v1 finding F69):
> the simulation argument below does not hold as written.** §2 step 5 lets the
> simulator `S` ignore the per-row quotient identity, and §3.1 justified that
> by conditioning on the constrained columns' next-row evaluations `T_c(g·x)`
> at the opened rows, as if no proof carried them. Every proof carries them:
> each query publishes the next-row pair `T(g·x)`, `T(−g·x)` with its own
> authentication path, and the on-chain verifier Merkle-checks that pair
> against the trace root (`programs/p01_stark_verifier/src/verify.rs`, the
> next-row pair check). With those published values and the public inputs,
> anyone evaluates the per-row quotient identity at every opened row. Measured
> on real C7 proofs by `stark/tests/next_row_openings_are_published.rs`: every
> next-row pair authenticates (44 of 44 over two proofs), the identity holds on
> every opened row from wire data alone (88 of 88), and it fails on every row
> once one next-row value moves by one (0 of 88); the audit's probe read 176 of
> 176 on four proofs. A transcript from `S` satisfies each identity with
> probability about `1/p`, so a distinguisher separates `S` from an honest
> prover with public data in one evaluation.
>
> So the claim of §1 is **withdrawn**, and nothing in this file is a proof of
> hiding any more. What still stands: the marginal results of §3 (every
> committed value measured uniform in the mask), the counting of §3.1 and
> §3.2 read as counting, and the recovery harnesses, which recover no witness
> from a masked proof. What F69 does **not** show: a witness leak. The
> identity is a consistency relation every honest proof satisfies; it tells
> the simulator apart, and says nothing about the witness beyond what the
> verifier's own equations already do. Whether a corrected simulator exists —
> one that samples the next-row openings together with the trace block (S1
> measured the block and those frames jointly uniform, rank 100 of 100 at two
> queries) and then solves the quotient openings on the verifier's equations
> AND the per-row identities — is open. It has not been executed, and nothing
> below claims it. Sections 1 to 7 are kept as they were argued, with each
> sentence F69 breaks marked where it stands.

> **What the revision changed.** The table in §3 asserted the FRI layers and the
> terminal polynomial were uniform *by an argument* — linear functionals of an
> affine `D` — with no measurement behind it, and the committed-value sweeps
> read a SAMPLE while the prose read like the committed domain. Both are now
> measured, exhaustively. Two results were added that did not exist: the
> published transcript measured **jointly** rather than value by value (§3.1),
> and the mask draw itself, which every other result is conditional on (§4).

> **What the second revision changed (2026-09-02).** §3.1's joint result had a
> hole: its additivity check never paired two mask elements of the SAME column,
> which is exactly where the seventh-power constraints put a cross term, so the
> rank it reported was a rank of finite differences and "uniform on the subspace
> the checks cut out" did not follow from it. The simulator of §2 is now
> **executed** against the verifier's equations
> (`a_simulator_with_no_witness_produces_the_verifier_s_own_law`), and doing so
> found four directions the verifier never checks and the blinding columns never
> reach — the quotient identity at each opened row, satisfied by the honest
> prover through next-row values this revision took to be unpublished (they
> are published: fourth revision). §3.1 is rewritten around that.
>
> **What the third revision changed (2026-09-02, later the same day).** Running
> the same accounting at the query count the proof actually ships with found a
> **protocol defect**: the lift column had 160 free entries and a 22-query wire
> needs 361 affine dimensions on the quotient side. The gate of the lift
> constraint was changed on all four circuits so the column is free on every row
> but a handful, the verifier twin changed with it, and §3.2 carries the
> measurement before and after. It also found that the simulator of §2 was
> incomplete: FRI's intermediate layers are low-degree polynomials, and at 22
> queries the honest openings satisfy 58 linear relations the verifier never
> checks. Step 5 now says so. This is a wire-incompatible change to the
> verifier: proofs made under the old gate fail `DeepAliFailed`.

Every claim below is backed by a measurement that runs in CI. Where a claim
rests on an assumption instead, the assumption is named. Where something is out
of scope, it is said so rather than left to be inferred.

---

## 1. The statement

> ⛔ **Withdrawn 2026-09-23 (finding F69), not claimed:** "for circuits C1,
> C3, C6 and C7, the compact STARK proof system is statistical zero-knowledge
> in the random-oracle model". The argument for it does not hold as written.

What it meant: there is an efficient simulator `S` that, given only the public
inputs and **no witness**, produces a transcript the deployed verifier accepts,
and that transcript is distributed identically to an honest prover's on every
value the wire carries. The `S` of §2 fails the last clause: the wire carries
the next-row openings, and with them the per-row quotient identity, which `S`
does not satisfy.

Two words in that sentence are load-bearing and neither is decoration.
**Statistical**, in the random-oracle model, and with no failure event of its
own since 2026-09-12: the one case in which `S` used to fail (probability about
`2^-54`) was the out-of-domain point `z` landing in the trace domain or on the
LDE coset, and both prover and verifier now resample `z` out of that set
(`[PERFECT-IOP]`, `ood_point_from_transcript_hash` on both sides,
`ood_resampling_parity.rs`). What remains statistical is the random-oracle step
on the leaves a proof never opens, bounded by `q_H · 2^-(w·63)` and measured
by X5 (`unopened_leaves_stay_uniform_given_every_opening_on_every_circuit`).
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

5. **Fake the openings.** `S` samples the constrained columns' opened rows
   uniform, then samples everything else the wire carries — the lift and
   randomizer openings, the quotient openings, every FRI pair and the terminal —
   **uniformly on the solution set of the verifier's equations**: seven fold
   checks and one terminal check per query, plus the DEEP-ALI identity. That is
   `sample_solution` in `zk_hiding.rs`, and it is run, not described. It then
   programs the oracle for the Merkle roots and authentication paths. Only the
   positions fixed in step 1 have to be consistent — the other 99% of every tree
   is never revealed.

   ⚠️ One identity `S` does **not** satisfy, on purpose: `Q(x) = C(x)/Z_T(x) +
   B(x)` at the opened rows themselves. The verifier stopped evaluating it when
   B7 retired the per-query arm, so it is not an equation of the verifier and
   `S` ignores it. The honest prover satisfies it anyway — and §3.1 argued that
   difference was invisible. ⛔ **It is visible, and this is where the argument
   fails (F69):** the next-row values the identity reads are on the wire and
   Merkle-checked, so anyone evaluates it, and a transcript from this `S` fails
   it.

   ⛔ **And one structure `S` must satisfy that the verifier does not check.**
   `D` has degree at most `n − 2`, so FRI layer `l` is a polynomial of degree at
   most `(n − 2)/2^l`: layer 5 has 16 coefficients, layer 7 has 4. A proof that
   opens 22 pairs opens 44 values of each layer, and from layer 4 on those values
   satisfy linear relations that hold on every honest transcript and carry no
   witness at all — 58 of them, independent of the verifier's equations
   (§3.2). A simulator that sampled the verifier's solution set uniformly would
   violate them, and anyone who interpolates layer 5 would catch it. So `S`
   samples its FRI layers as folds of a random polynomial of degree `≤ n − 2`
   consistent with the opened `D` values, which is the same as adding those
   relations to the equations it solves. At two queries the relations are
   vacuous — every layer has more coefficients than opened points — which is
   why §3.1's two-query run never met them.

The verifier accepts `S`'s transcript with probability 1: the `2^-54` event
(`Z_T(z) = 0` or a vanishing DEEP denominator) no longer exists, because `z` is
resampled out of the trace domain and the LDE coset on both sides
(`[PERFECT-IOP 2026-09-12]`).

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

### 3.1 The transcript jointly — what X4 measured, and what S1 proves

Everything above is a **marginal**. Every published value can be exactly uniform
while some linear combination of them is **constant**, and a distinguisher that
computes that combination gets the same answer from every honest proof and
separates honest from simulated in one query. Marginal uniformity does not
exclude that.

`the_published_transcript_is_jointly_uniform` (X4) assembles the vector a
verifier receives — the OOD claims, the live terminal coefficients, the opened
pairs at each query position, 142 values for two queries — and takes the rank
of its finite differences in 170 mask elements. It reads **126**, and 142 − 126
is the count of fold and terminal checks. Both numbers are still what the test
prints.

🚨 **What that rank does not mean, and the hole that hid it.** A slope matrix
describes a map only where the map is affine, and X4 checked additivity on three
pairs of mask elements — all three in *different* columns. The transition
constraints raise a column's own values to the seventh power, so two elements of
the *same* column meet in a cross term: measured on 2026-09-02, that pair is
non-additive on **70 of the 82** non-trace coordinates. X4's 126 is a rank of
secants on a curved set, not the dimension of a subspace, and "exactly uniform on
the subspace the verifier's checks cut out" did not follow from it. The sentence
was true. The argument under it was not.

**The route that holds** is
`a_simulator_with_no_witness_produces_the_verifier_s_own_law` (S1). It
conditions first on the *trace block* — the constrained columns' OOD claims and
opened pairs, 60 values — where the map is affine by Lagrange, and on forty
values it took to be unpublished: those columns' **next-row evaluations**
`T_c(g·x)` at the opened rows. ⛔ They are published, each pair with its
authentication path (F69, fourth revision). Then it counts, against the verifier's own equations written
out on the wire (seven folds and a terminal per query, plus the DEEP-ALI
identity: 17):

```
block + hidden frames  : rank 100 of 100   — jointly uniform, by 110 mask elements
given them, the rest   : 82 coordinates
  reached by lift + randomizer   61
  cut by the verifier            17
  unchecked and unreached         4
```

The four are named, not left as a residue: reduced against the verifier's
equations, each is supported on exactly one opened row's lift opening and its
eight quotient openings, and their span **is** the span of the gradients of
`Q(x) = C(x)/Z_T(x) + B(x)` at the four opened rows — the per-query quotient
identity the on-chain verifier has not evaluated since B7. The honest prover
satisfies it at every row because it is a polynomial identity; its right-hand
side reads the hidden next-row frame, and moving that frame (a mask move that
fixes every published value of the column) shifts the four directions with
**rank 4**, affinely. Measured on two baselines that are two distinct witnesses under
two different masks, both `61 + 4 + 17 = 82`.

So, given the block: four directions are uniform because the hidden frames are,
sixty-one because the lift and randomizer are, and seventeen are determined.
**The honest rest is uniform on exactly the verifier's solution set.** ⛔
Withdrawn (F69): the "hidden" frames are published, so those four directions are
fixed by public data, and the honest rest lies on the verifier's solution set
cut by the four per-row identities, which `S` does not sample. That is
the law `S` samples in step 5 — and S1 then builds three transcripts from the
equations and public data alone and runs them through the same residual
functions the honest transcript is checked with. All 17 hold on each.

⛔ **Every equation in S1 is validated before it is trusted.** The DEEP value it
reconstructs from the wire equals the prover's `deep_composition_lde` at every
opened position; the honest transcript reads zero on all 17 residuals and on the
four local identities; and perturbing one opening, one quotient claim or one
terminal coefficient makes the corresponding residual non-zero. An equation set
that accepted everything would pass step 3 while proving nothing.

🚨 **Three instrument failures of one shape, in three days.** X4 first swept the
lift column alone and read 55 of 142; X6 first measured values a mask element
cannot reach; X4's additivity never crossed rows inside a column. Each time the
number was real and the sentence attached to it was not. The cure was the same
each time: name what the instrument can and cannot see before reading it.

### 3.2 The lift column was too small for the wire it ships on

Everything in §3.1 was measured at **two** queries. The C7 proof opens
**twenty-two**, and the quotient side of the wire grows with them: eight segment
values per opened row, 352 at 22 queries, plus the eight OOD claims. Of those,
315 have to come out independently uniform — one is fixed by the identity the
verifier checks at `z`, one per opened row by the identity it does not check —
and the same entries also supply the lift column's own 46 published evaluations.
**361 affine dimensions.** The lift is the only affine source the quotient has;
the randomizer never reaches a quotient value, and the constrained columns that
enter the constraints linearly (3, 5 and 9) reach only the low coefficient
blocks. The lift had **160** free entries, because its constraint was gated by
`active · nba` and `active` is 1 on every witness row.

Measured, on the protocol as deployed on 2026-08-31
(`affine_reach_at_the_shipping_query_count`, run by hand):

```
lift alone on the quotient side      rank 160 of 315 needed
with columns 3, 5 and 9 added        rank 295 of 315 needed
```

So at the shipping query count the honest transcript was **not** uniform on the
verifier's solution set by any argument this document could make — the honest
quotient openings lay in a witness-dependent 160-dimensional affine family
inside a 315-dimensional free space. Whether an efficient distinguisher could
exploit that is a different question, and not the one a simulation argument
asks.

**The fix is one factor in one constraint per circuit.** The lift constraint's
gate is now a one-hot period-`n` column times `nba` — `row0_flag` on C7,
`chain_flag` on C1, `hash_start` on C3 and C6 — so the column is pinned to zero
on at most a handful of rows and free everywhere else: 511 entries on C7, 512
on C1, 469 on C3 and C6 against needs of 361, 441, 361 and 361. Degree, segment
count, FRI rate and wire size are unchanged: the new gate is a period-`n`
column exactly as `active` was. The prover fills the freed rows from the same
CSPRNG draw (`MASK_LEN` 2272 → 2623 on C7), and the on-chain verifier evaluates
the new gate at `z`. A proof made under the old gate is rejected, and must be.

Measured again, after the change, on C7 at 22 queries:

```
lift alone on the quotient side      rank 360 of 360
rest of the wire (762)               affine 483 + hidden 44 + verifier 177 + low-degree 58 = 762
```

Four terms now, not three. The hidden term is the same object as in §3.1 — the
directions the blinding never takes and the verifier never checks, moved by mask
entries that leave every published value of their column untouched (built
analytically from the Lagrange basis, applied, and confirmed to leave the block
fixed) — and it is moved affinely and in full rank; at 22 queries it is exactly
the 44 local identities. ⛔ Those mask moves leave every published value of
their column untouched only if the next-row openings are not published; they
are (F69), so the 44 directions are determined by public data, not hidden. The **low-degree term is new**: FRI's intermediate
layers are polynomials of degree `≤ (n − 2)/2^l`, and 44 opened values of a
16-coefficient layer satisfy relations that no blinding can move and the
verifier does not check, because it does not need to — soundness comes from the
terminal bound. They hold on every honest transcript, carry no witness, and the
simulator reproduces them by building its layers from a random low-degree `D`
(§2 step 5). With them the accounting closes, and a transcript built from
public data alone passes all 177 verifier equations and every one of the
relations. So at the shipping query count, given the opened trace values, the
honest rest is uniform on exactly the set that the verifier's equations and
FRI's own degree structure cut out, and the simulator samples that set. ⛔
Withdrawn (F69): that set must also be cut by the 44 per-row identities the
published next-row openings make checkable, and the simulator does not sample
it. S1's
two-query result is unchanged by the new gate: `61 + 4 + 17 = 82` on both
witnesses.

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

- ⛔ **Not perfect zero-knowledge of the proof string (not claimed), and since
  2026-09-23 not the statistical kind either (F69, fourth revision).** The simulated VIEW is
  identically distributed since the `z` resampling of 2026-09-12 (no failure
  event left), but the Merkle roots are deterministic functions of leaves that
  are not all uniform, so their hiding is the random-oracle step, statistical
  with advantage at most `q_H · 2^-(w·63)` (X5). No hash-based STARK is perfect
  ZK, and saying otherwise would be false; the only perfectly hiding commitments
  known are Pedersen-style and not post-quantum.
- ✅ **Claimed for all eight circuits since 2026-09-11.** C0 (masked shape, 512
  rows), C2, C4 and C5 now carry the same row mask, lift column and randomizer
  column as C1/C3/C6/C7, with verifier twins; X1/X2/X5 and the recovery
  harnesses run on all eight (`docs/UNIFORM-MASKING-2026-09-11.md`). ⛔ On
  devnet the DEPLOYED verifier still runs the pre-mask C0/C2/C4 until the
  redeploy; C5's on-chain instructions remain disabled (it proves no Merkle
  membership, a soundness defect, not a privacy one).
- ⛔ **Not a claim about what a transaction reveals on chain.** The proof hides
  the witness. It does not hide which program was called, which accounts were
  touched, or what the fee payer was. Those are separate properties with
  separate arguments.
- 🚨 **Not trustlessness.** The upgrade authority on both programs is a single
  CLI key with no multisig. Whoever holds it can replace the verifier. That is a
  deployment property, entirely independent of the cryptography, and it must not
  be blurred into the ZK claim.
- ⛔ **Devnet.** There is no mainnet deployment.
- ⛔ **An executed argument, not a quantified proof, and since 2026-09-23 not
  a sufficient one (F69).** S1 runs the simulator against the verifier's
  equations and shows the honest law equals the simulated one on those
  equations — not on the per-row identities the published next-row openings
  make checkable — on **two witnesses at two queries, and one witness at the shipping
  twenty-two**, with the oracle programmed and the Merkle roots not modelled. A
  simulation theorem quantifies over every witness and every challenge; X6
  covers eight witnesses for the marginal result. That is the honest distance
  still to travel, and it is shorter than it was.
- ✅ **On chain since 2026-09-02.** §3.2's fix changes the verifier, and the
  verifier at `DGY37k3J…` was redeployed at slot 491,973,056 with it (bytes
  dumped and compared against the local build), the blob reshipped, and a C7
  proof from the shipped blob accepted through both phases at slot 491,973,951.
  The argument now describes the program that is deployed. ⛔ Devnet.
- ⛔ **The grinding nonce and the query-position derivation are not measured.**
  §2 step 1 argues *structurally* that the positions are the terminal node of the
  Fiat-Shamir chain, and that argument is read off the verifier's own source. It
  is not a measurement, and nothing here measures the nonce at all.
- ⛔ **Soundness is unchanged and is not what this document is about.** As
  shipped, docs/SECURITY-LEVELS.md gives unique decoding 41 to 45 bits,
  conjectured 45 to 46 bits and Johnson (BCIKS20, the headline) 13 to 16 bits,
  and no hiding result moves them.

---

## 6. Reproducing it

```
cargo test -p p01-stark --release --lib zk_hiding -- --nocapture
```

Fifteen tests. The six that carry the argument:

- `the_lde_domain_never_meets_the_trace_domain_on_any_circuit` — the coset proof,
  per circuit, printing `n` and `lde` for each rather than asserting once
- `the_free_claims_are_jointly_uniform_on_every_circuit` — rank 7 of 7
- `quotient_leaves_are_exactly_uniform_on_every_circuit` — every committed
  position on every circuit, against the degree-7 control
- `deep_and_every_fri_layer_are_exactly_uniform_in_one_blinding_element` — the
  DEEP composition, all seven committed FRI layers and the terminal, exhaustive
- `the_published_transcript_is_jointly_uniform` — §3.1, the finite-difference
  rank, kept as a pin; read it with S1
- `a_simulator_with_no_witness_produces_the_verifier_s_own_law` — §3.1, the
  simulator run: `61 + 4 + 17 = 82` on two baselines, and three witness-free
  transcripts through the verifier's seventeen equations
- `affine_reach_at_the_shipping_query_count` — §3.2, the same accounting at 22
  queries with FRI's low-degree relations, and a 22-query transcript from public
  data; `#[ignore]`d for cost, run by hand:
  `cargo test -p p01-stark --release --lib affine_reach -- --ignored --nocapture`
- `stark/tests/next_row_openings_are_published.rs` — F69, the test that breaks
  the argument: parses real C7 proofs, authenticates every next-row pair
  against the trace root, and evaluates the per-row quotient identity from
  wire data alone (every row holds; every row fails once one next-row value
  moves). `cargo test -p p01-stark --release --test next_row_openings_are_published -- --nocapture`

⛔ Every one of them prints a **control** alongside its result: a Poseidon column
reaching the same values at degree 7. Every value in this pipeline moves when the
mask moves, so *it changed* proves nothing, and an instrument that answered 1
unconditionally would pass every assertion while measuring the mask's own
arithmetic.

The harness is `stark/src/compact/zk_hiding.rs`, a `#[cfg(test)]` child module of
`compact` — no feature flag, so it cannot reach a shipped blob.

---

## 7. The sentence

What can be said, in full, since 2026-09-23:

> Every committed value our prover publishes is provably uniform in the mask,
> and we measured it at every committed position — rank 7 of 7 on the free
> quotient claims, degree 1 on all 65,536 committed quotient values, on the
> DEEP composition and on all seven FRI layers, on all four production circuits.
> No witness has been recovered from a masked proof. The simulation argument we
> published for statistical hiding does not hold as written: it treated the
> next-row openings as hidden, and every proof publishes them. A corrected
> simulator has not been executed, so no hiding theorem is claimed.

The sentence this section used to print ended with a claim of statistical
hiding in the random-oracle model. It is withdrawn, not reworded: the
qualifiers were never the problem, the simulator was.

🚨 **And there is a third qualifier that belongs in any conversation where this
sentence is challenged**, even though it does not fit in the sentence: the
simulator has been **run**, not only described — against the verifier's
equations, at the algebraic layer, with the hash oracle programmed — on two
witnesses and one query set, and running it against the verifier's equations
alone is exactly what hid F69: the per-row identities are not the verifier's
equations, and the next-row openings make them public all the same. §2 is the argument, §3.1 executes it, and neither
quantifies over every witness and every challenge. Anyone who asks for the
simulation argument should be pointed at §2 and S1 and told plainly what is
executed, what is measured on one witness, and what is structural. Do not let
the exhaustiveness of the sweeps stand in for a quantification over witnesses —
they are different claims, and only one of them is finished.

And one thing to say separately, not folded in: **the upgrade key is a single
key.** Do not say "trustless", and do not say "zero-knowledge": the first is
false of the deployment and the second is not claimed.
