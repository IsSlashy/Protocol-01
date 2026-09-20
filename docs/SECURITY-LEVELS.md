# Security levels (generated)

<!-- GENERATED FILE: do not edit by hand. Regenerate with
       cargo run --manifest-path tools/security-levels/Cargo.toml -- --write
     `cargo test --manifest-path tools/security-levels/Cargo.toml` fails while it is stale. -->

This file is written by `tools/security-levels` and is the one place a Protocol 01 soundness figure may be copied from. A figure is the base-2 logarithm of what a cheating prover has to spend: hash evaluations, or one over its probability of success. Each one below stands next to the regime it holds in and the assumptions it needs, and a figure quoted without them is not a figure from this file.

Figures are truncated to two decimals, never rounded up. The integer a document may quote is the floor of the figure.

## Where the parameters come from

- **v1, deployed.** The eight `CircuitConfig` constants and `GRINDING_BITS` of `programs/p01_stark_verifier/src/compact_proof.rs`, and `MODULUS` of `programs/p01_stark_verifier/src/goldilocks.rs`. The calculator compiles those two files (a `#[path]` module), so it reads the verifier's own numbers, not a copy of them.
- **v2, candidates behind decision D1.** Profiles Q, R and R-128 of the v2 design, defined in `tools/security-levels/src/params.rs`. Some of their inputs stay assumptions until the v2 AIR exists; they are marked [E] under Assumptions.

## Regimes

Every regime lists the error terms of the protocol the verifier runs (DEEP-ALI over a batched, arity-2 FRI; Fiat-Shamir over SHA-256; grinding before the queries) and adds them up: a union bound. Notation: n trace length, w columns, k quotient segments, |D0| LDE size, rho the FRI rate the verifier enforces (final-polynomial degree bound over its size), rho+ = (n + 2)/|D0|, L = w + k functions batched with the powers of one challenge gamma, r folds, q queries, g grinding bits, C constraints, |F| the challenge field.

1. **Unique decoding (theorem).** Proximity theta = (1 - rho)/2 - 3/((1 - rho)|D0|), just inside the unique-decoding radius. Batching: BCHKS25 (eprint 2025/2055) Thm 4.1, (L - 1)(theta |D0| + 1) bad values of gamma, plus gamma = 0. Folds: BCIKS20 (eprint 2020/654) Thm 4.1, |D(i+1)| bad values per fold. ALI and DEEP: Haböck (eprint 2022/1216, version of 2024-12-17) Thm 8 with list size 1. Queries: (1 - theta)^q 2^-g.
2. **Johnson, BCIKS20 (theorem, headline).** BCIKS20 Thm 8.3 in the batched form of Haböck Thm 2, eq. (7): (L - 1/2)(m + 1/2)^7 |D0|^2 / (3 rho^(3/2) |F|) + (2m + 1)(|D0| + 1) sum(a_i) / (sqrt(rho) |F|). ALI and DEEP: Haböck Thm 8 with list size L+ = (m + 1/2)/sqrt(rho+). Queries: (sqrt(rho+)(1 + 1/2m))^q 2^-g. The analysis parameter m >= 3 is chosen by exhaustive search over 3..65535 for the largest figure; the verifier never sees it. The public headline is this column.
3. **Johnson, BCHKS25 (theorem, 2025, informational).** BCHKS25 Thm 4.2, whose error grows with |D| instead of |D|^2, for the batching and for each fold, composed over the rounds as the Ethereum Foundation's `soundcalc` does (BCIKS20 Thm 5.1 on a fold whose code has dimension 1, where Thm 4.2 is void). Same ALI, DEEP and query terms as regime 2. Newer and tighter than regime 2, and not the headline.
4. **Conjectured (repository formula).** The formula of `programs/p01_stark_verifier/tests/b1_deep_binding.rs`: a field floor (8n + w + k + 1 + r|D0|)/|F| and a query term 2^-(q log2(1/rho) + g), here added as a union instead of taking their minimum. It assumes proximity gaps up to list-decoding capacity (BCIKS20 Conjecture 8.4, which the repository's comments cite as "ethSTARK Conjecture 8.4"). Counterexamples to strong forms of that conjecture were published in 2025 (Diamond and Gruen, eprint 2025/2010; Crites and Stewart, eprint 2025/2046; BCHKS25). This column is never quoted without the two theorem columns beside it.
5. **Quantum.** Chiesa, Manohar and Spooner (TCC 2019) prove the Fiat-Shamir (BCS) transform sound against t quantum oracle queries up to O(t^2 eps + t^3 / 2^256) for SHA-256. The quantum line is half the classical figure of its regime, capped at 256/3 = 85.33 by SHA-256. It is a floor the proof gives, not a known attack.
6. **Hash lines.** Generic collision bounds on the nominal output size: the birthday bound (classical, output/2) and Brassard-Høyer-Tapp (quantum, output/3, with about as much quantum memory as it makes queries). In the random-oracle model the classical non-interactive figure is also capped at 256/2 by the Merkle and transcript hash.

## Assumptions

- **A1. Challenges.** v2 draws every challenge uniformly from its extension field (rejection sampling). v1 draws each one as `u64 % p`; see the next section.
- **A2. DEEP degree.** The prover commits k segments of degree below n, so the DEEP identity has degree at most k(n + 1) + n - 1 in z.
- **A3. Constraints.** At most C = 64 constraints (transition and boundary) are combined with random powers. Not read from the AIRs; the largest v1 transition count is 29 (`TRANSFER_NUM_CONSTRAINTS`). Raising C to 1024 moves no figure by 0.01 (`tests/v1_reproduction.rs`).
- **A4. Rate.** The FRI rate is the one the verifier enforces, `fri_final_poly_degree_bound / fri_final_poly_size`: 1/16 on every v1 circuit, never assumed from the blowup.
- **A5. Queries.** `verify.rs` draws query positions uniformly in D0 (a u32 reduced modulo a power of two) and keeps them distinct, which can only lower the query term.
- **A6. Union bound.** soundcalc and the ethSTARK documentation report the minimum over rounds; the union bound here is lower by up to log2 of the number of terms.
- **A7. [E] v2 inputs.** n = 1024, w = 36, k = 8, C <= 64, a final polynomial of 32 coefficients with degree bound 32/blowup, arity-2 folds, a Poseidon2 digest of four elements. Taken from the v2 design, not from code.
- **A8. Hashes.** The hash lines count generic attacks only. The v1 Poseidon constants have no published provenance (finding F1); nothing here covers a structural attack on them.

## The v1 challenge sampler costs up to one bit

`verify.rs` turns a transcript hash into a challenge as `u64 % p`. It maps 0 to 1 for the constraint-combination (RLC), DEEP-combination and FRI-fold challenges, and re-draws the DEEP point z instead. Since 2^64 = p + 2^32 - 1, every residue below 2^32 - 1 has two preimages, and the value 1 has four (0, 1, p and p + 1). A set of s bad challenge values can therefore carry (2s + 2)/2^64 instead of s/p, so every field-bound term can double. The figures pinned in `b1_deep_binding.rs` use the uniform model; the deployed verifier's figures are the as-shipped ones, and those are the ones published at the end of this file.

| Circuit | Pinned in b1: UD / conj. | Repository formula, uniform: UD / conj. | Union bound, uniform: UD / UD with BCIKS20 bounds only / conj. | Union bound, as shipped: UD / conj. |
|---|---|---|---|---|
| C0 | 42 / 47 | 42.07 / 47.91 | 42.03 / 42.03 / 47.91 | 42.01 / 46.91 |
| C1 | 46 / 47 | 46.63 / 47.75 | 46.18 / 45.90 / 47.75 | 45.85 / 46.75 |
| C2 | 46 / 47 | 46.63 / 47.75 | 46.16 / 45.86 / 47.75 | 45.81 / 46.75 |
| C3 | 42 / 47 | 42.07 / 47.75 | 42.02 / 42.02 / 47.75 | 42.00 / 46.75 |
| C4 | 42 / 47 | 42.07 / 47.91 | 42.03 / 42.03 / 47.91 | 42.00 / 46.91 |
| C5 | 42 / 46 | 42.07 / 46.60 | 42.01 / 41.97 / 46.60 | 41.96 / 45.60 |
| C6 | 42 / 47 | 42.07 / 47.75 | 42.02 / 42.01 / 47.75 | 41.99 / 46.75 |
| C7 | 42 / 47 | 42.07 / 47.91 | 42.02 / 42.01 / 47.91 | 41.99 / 46.91 |

The column "Pinned in b1" is the floor of the repository formula, which is what `b1_deep_binding.rs` asserts. The union bound over every term reproduces it under uniform challenges. Two things move it: the shipped sampler, and, for unique decoding, which theorem bounds the batching step (BCHKS25 or the older BCIKS20).

## v1, as shipped (the deployed verifier)

| Circuit | Name | n | w | k | LDE | rho | r | q | g | Unique decoding | Johnson, BCIKS20 (m) | Johnson, BCHKS25 (m) | Conjectured | Quantum: UD / Johnson BCIKS20 / conj. |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C0 | subscriber_ownership | 512 | 5 | 8 | 8192 | 1/16 | 8 | 22 | 22 | 42.01 | 16.28 (m=3) | 31.84 (m=3) | 46.91 | 21.00 / 8.14 / 23.45 |
| C1 | pool_commitment | 512 | 5 | 8 | 8192 | 1/16 | 9 | 27 | 22 | 45.85 | 16.28 (m=3) | 31.81 (m=3) | 46.75 | 22.92 / 8.14 / 23.37 |
| C2 | balance_proof | 512 | 6 | 8 | 8192 | 1/16 | 9 | 27 | 22 | 45.81 | 16.17 (m=3) | 31.71 (m=3) | 46.75 | 22.90 / 8.08 / 23.37 |
| C3 | merkle_path | 512 | 8 | 8 | 8192 | 1/16 | 9 | 22 | 22 | 42.00 | 15.97 (m=3) | 31.52 (m=3) | 46.75 | 21.00 / 7.98 / 23.37 |
| C4 | confidential_balance | 512 | 6 | 8 | 8192 | 1/16 | 8 | 22 | 22 | 42.00 | 16.17 (m=3) | 31.73 (m=3) | 46.91 | 21.00 / 8.08 / 23.45 |
| C5 | transfer | 1024 | 9 | 8 | 16384 | 1/16 | 10 | 22 | 22 | 41.96 | 13.88 (m=3) | 30.44 (m=3) | 45.60 | 20.98 / 6.94 / 22.80 |
| C6 | merkle_update | 512 | 12 | 8 | 8192 | 1/16 | 9 | 22 | 22 | 41.99 | 15.64 (m=3) | 31.20 (m=3) | 46.75 | 20.99 / 7.82 / 23.37 |
| C7 | spend | 512 | 12 | 8 | 8192 | 1/16 | 8 | 22 | 22 | 41.99 | 15.64 (m=3) | 31.21 (m=3) | 46.91 | 20.99 / 7.82 / 23.45 |

On every v1 circuit the BCIKS20 Johnson figure is set by its batching term, which grows with |D0|^2/|F| on a 64-bit challenge field: that is why it sits below unique decoding.
The largest v1 figure in a theorem regime is 45.85 (C1, Unique decoding (theorem)).

## v2 candidates (C6v2 and C7v2 share one shape)

| Profile | e | n | w | LDE | rho | r | q | g | Unique decoding | Johnson, BCIKS20 (m) | Johnson, BCHKS25 (m) | Conjectured | With the SHA-256 cap: UD / Johnson BCIKS20 / conj. | Quantum: UD / Johnson BCIKS20 / conj. |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Q | 2 | 1024 | 36 | 16384 | 1/16 | 9 | 36 | 16 | 48.83 | 77.24 (m=3) | 84.76 (m=9) | 110.75 | 48.83 / 77.24 / 110.75 | 24.41 / 38.62 / 55.37 |
| R | 3 | 1024 | 36 | 32768 | 1/32 | 10 | 36 | 16 | 50.39 | 105.42 (m=56) | 105.88 (m=492) | 173.64 | 50.39 / 105.42 / 128.00 | 25.19 / 52.71 / 85.33 |
| R-128 | 3 | 1024 | 36 | 32768 | 1/32 | 10 | 47 | 16 | 60.90 | 128.32 (m=7) | 132.57 (m=46) | 173.64 | 60.90 / 128.00 / 128.00 | 30.45 / 64.16 / 85.33 |

The master plan's Phase 3 exit asks for at least 100 in the Johnson (theorem) regime for C6v2 and C7v2. Under BCIKS20 it is met by R and R-128 and not by Q (`tests/v2_profiles.rs`).
For R and R-128 the conjectured column is above what SHA-256 allows a non-interactive proof: its collision bound caps the classical figure, and its quantum bound caps the quantum line at 85.33.

## Hash-collision lines

| Hash | Used for | Output, nominal | Classical collision (birthday) | Quantum collision (BHT) |
|---|---|---|---|---|
| SHA-256 | Merkle trees and the Fiat-Shamir transcript, v1 and v2 | 256 | 128.00 | 85.33 |
| Poseidon t=3, one Goldilocks element (v1) | leaf commitments and pool Merkle nodes (finding F2: deposit once, spend twice) | 64 | 32.00 | 21.33 |
| Poseidon2 width 12, four Goldilocks elements (v2 design) | leaf commitments, nullifiers and Merkle nodes | 256 | 128.00 | 85.33 |

The v1 digest line is not a proof-system term: it is the cost of two openings with one commitment, which lets a depositor spend twice (finding F2). It bounds every v1 pool circuit, whatever its soundness column says.

## Every error term

Each cell is the term's own figure, -log2 of its probability. Folds are summed over their rounds (`--terms` prints each round). n/a: the regime has no such term.

### C0 subscriber_ownership (v1, as shipped)

n = 512, w = 5, k = 8, L = 13, LDE = 8192, rho = 1/16, rho+ = 514/8192, r = 8, q = 22, g = 22, e = 1, C <= 64, challenges: u64-mod-p.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=3) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 56.95 | 53.19 | 53.19 | n/a |
| DEEP | 50.82 | 47.02 | 47.02 | n/a |
| FRI batching | 47.50 | 16.28 | 31.95 | n/a |
| FRI folds (8 rounds, summed) | 50.00 | 41.19 | 35.51 | n/a |
| FRI queries + grinding | 42.05 | 61.04 | 61.04 | 110.00 |
| Field floor | n/a | n/a | n/a | 46.91 |
| **All terms, union bound** | **42.01** | **16.28** | **31.84** | **46.91** |
| With the SHA-256 cap (classical, random-oracle model) | 42.01 | 16.28 | 31.84 | 46.91 |
| Quantum (CMS19, half, capped at 85.33) | 21.00 | 8.14 | 15.92 | 23.45 |

### C1 pool_commitment (v1, as shipped)

n = 512, w = 5, k = 8, L = 13, LDE = 8192, rho = 1/16, rho+ = 514/8192, r = 9, q = 27, g = 22, e = 1, C <= 64, challenges: u64-mod-p.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=3) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 56.95 | 53.19 | 53.19 | n/a |
| DEEP | 50.82 | 47.02 | 47.02 | n/a |
| FRI batching | 47.50 | 16.28 | 31.95 | n/a |
| FRI folds (9 rounds, summed) | 50.00 | 41.02 | 35.26 | n/a |
| FRI queries + grinding | 46.60 | 69.91 | 69.91 | 130.00 |
| Field floor | n/a | n/a | n/a | 46.75 |
| **All terms, union bound** | **45.85** | **16.28** | **31.81** | **46.75** |
| With the SHA-256 cap (classical, random-oracle model) | 45.85 | 16.28 | 31.81 | 46.75 |
| Quantum (CMS19, half, capped at 85.33) | 22.92 | 8.14 | 15.90 | 23.37 |

### C2 balance_proof (v1, as shipped)

n = 512, w = 6, k = 8, L = 14, LDE = 8192, rho = 1/16, rho+ = 514/8192, r = 9, q = 27, g = 22, e = 1, C <= 64, challenges: u64-mod-p.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=3) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 56.95 | 53.19 | 53.19 | n/a |
| DEEP | 50.82 | 47.02 | 47.02 | n/a |
| FRI batching | 47.39 | 16.17 | 31.84 | n/a |
| FRI folds (9 rounds, summed) | 50.00 | 41.02 | 35.26 | n/a |
| FRI queries + grinding | 46.60 | 69.91 | 69.91 | 130.00 |
| Field floor | n/a | n/a | n/a | 46.75 |
| **All terms, union bound** | **45.81** | **16.17** | **31.71** | **46.75** |
| With the SHA-256 cap (classical, random-oracle model) | 45.81 | 16.17 | 31.71 | 46.75 |
| Quantum (CMS19, half, capped at 85.33) | 22.90 | 8.08 | 15.85 | 23.37 |

### C3 merkle_path (v1, as shipped)

n = 512, w = 8, k = 8, L = 16, LDE = 8192, rho = 1/16, rho+ = 514/8192, r = 9, q = 22, g = 22, e = 1, C <= 64, challenges: u64-mod-p.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=3) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 56.95 | 53.19 | 53.19 | n/a |
| DEEP | 50.82 | 47.02 | 47.02 | n/a |
| FRI batching | 47.18 | 15.97 | 31.63 | n/a |
| FRI folds (9 rounds, summed) | 50.00 | 41.02 | 35.26 | n/a |
| FRI queries + grinding | 42.05 | 61.04 | 61.04 | 110.00 |
| Field floor | n/a | n/a | n/a | 46.75 |
| **All terms, union bound** | **42.00** | **15.97** | **31.52** | **46.75** |
| With the SHA-256 cap (classical, random-oracle model) | 42.00 | 15.97 | 31.52 | 46.75 |
| Quantum (CMS19, half, capped at 85.33) | 21.00 | 7.98 | 15.76 | 23.37 |

### C4 confidential_balance (v1, as shipped)

n = 512, w = 6, k = 8, L = 14, LDE = 8192, rho = 1/16, rho+ = 514/8192, r = 8, q = 22, g = 22, e = 1, C <= 64, challenges: u64-mod-p.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=3) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 56.95 | 53.19 | 53.19 | n/a |
| DEEP | 50.82 | 47.02 | 47.02 | n/a |
| FRI batching | 47.39 | 16.17 | 31.84 | n/a |
| FRI folds (8 rounds, summed) | 50.00 | 41.19 | 35.51 | n/a |
| FRI queries + grinding | 42.05 | 61.04 | 61.04 | 110.00 |
| Field floor | n/a | n/a | n/a | 46.91 |
| **All terms, union bound** | **42.00** | **16.17** | **31.73** | **46.91** |
| With the SHA-256 cap (classical, random-oracle model) | 42.00 | 16.17 | 31.73 | 46.91 |
| Quantum (CMS19, half, capped at 85.33) | 21.00 | 8.08 | 15.86 | 23.45 |

### C5 transfer (v1, as shipped)

n = 1024, w = 9, k = 8, L = 17, LDE = 16384, rho = 1/16, rho+ = 1026/16384, r = 10, q = 22, g = 22, e = 1, C <= 64, challenges: u64-mod-p.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=3) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 56.95 | 53.19 | 53.19 | n/a |
| DEEP | 49.82 | 46.02 | 46.02 | n/a |
| FRI batching | 46.09 | 13.88 | 30.54 | n/a |
| FRI folds (10 rounds, summed) | 49.00 | 39.87 | 34.39 | n/a |
| FRI queries + grinding | 42.06 | 61.07 | 61.07 | 110.00 |
| Field floor | n/a | n/a | n/a | 45.60 |
| **All terms, union bound** | **41.96** | **13.88** | **30.44** | **45.60** |
| With the SHA-256 cap (classical, random-oracle model) | 41.96 | 13.88 | 30.44 | 45.60 |
| Quantum (CMS19, half, capped at 85.33) | 20.98 | 6.94 | 15.22 | 22.80 |

### C6 merkle_update (v1, as shipped)

n = 512, w = 12, k = 8, L = 20, LDE = 8192, rho = 1/16, rho+ = 514/8192, r = 9, q = 22, g = 22, e = 1, C <= 64, challenges: u64-mod-p.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=3) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 56.95 | 53.19 | 53.19 | n/a |
| DEEP | 50.82 | 47.02 | 47.02 | n/a |
| FRI batching | 46.84 | 15.64 | 31.29 | n/a |
| FRI folds (9 rounds, summed) | 50.00 | 41.02 | 35.26 | n/a |
| FRI queries + grinding | 42.05 | 61.04 | 61.04 | 110.00 |
| Field floor | n/a | n/a | n/a | 46.75 |
| **All terms, union bound** | **41.99** | **15.64** | **31.20** | **46.75** |
| With the SHA-256 cap (classical, random-oracle model) | 41.99 | 15.64 | 31.20 | 46.75 |
| Quantum (CMS19, half, capped at 85.33) | 20.99 | 7.82 | 15.60 | 23.37 |

### C7 spend (v1, as shipped)

n = 512, w = 12, k = 8, L = 20, LDE = 8192, rho = 1/16, rho+ = 514/8192, r = 8, q = 22, g = 22, e = 1, C <= 64, challenges: u64-mod-p.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=3) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 56.95 | 53.19 | 53.19 | n/a |
| DEEP | 50.82 | 47.02 | 47.02 | n/a |
| FRI batching | 46.84 | 15.64 | 31.29 | n/a |
| FRI folds (8 rounds, summed) | 50.00 | 41.19 | 35.51 | n/a |
| FRI queries + grinding | 42.05 | 61.04 | 61.04 | 110.00 |
| Field floor | n/a | n/a | n/a | 46.91 |
| **All terms, union bound** | **41.99** | **15.64** | **31.21** | **46.91** |
| With the SHA-256 cap (classical, random-oracle model) | 41.99 | 15.64 | 31.21 | 46.91 |
| Quantum (CMS19, half, capped at 85.33) | 20.99 | 7.82 | 15.60 | 23.45 |

### Q C6v2 / C7v2 shape (v2 candidate)

n = 1024, w = 36, k = 8, L = 44, LDE = 16384, rho = 1/16, rho+ = 1026/16384, r = 9, q = 36, g = 16, e = 2, C <= 64, challenges: uniform.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=3) | Johnson, BCHKS25 (theorem, 2025, informational) (m=9) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 121.99 | 118.19 | 116.75 | n/a |
| DEEP | 114.82 | 111.02 | 109.58 | n/a |
| FRI batching | 109.66 | 77.49 | 86.91 | n/a |
| FRI folds (9 rounds, summed) | 114.00 | 105.02 | 92.32 | n/a |
| FRI queries + grinding | 48.83 | 79.94 | 85.14 | 160.00 |
| Field floor | n/a | n/a | n/a | 110.75 |
| **All terms, union bound** | **48.83** | **77.24** | **84.76** | **110.75** |
| With the SHA-256 cap (classical, random-oracle model) | 48.83 | 77.24 | 84.76 | 110.75 |
| Quantum (CMS19, half, capped at 85.33) | 24.41 | 38.62 | 42.38 | 55.37 |

### R C6v2 / C7v2 shape (v2 candidate)

n = 1024, w = 36, k = 8, L = 44, LDE = 32768, rho = 1/32, rho+ = 1026/32768, r = 10, q = 36, g = 16, e = 3, C <= 64, challenges: uniform.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=56) | Johnson, BCHKS25 (theorem, 2025, informational) (m=492) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 185.99 | 177.68 | 174.55 | n/a |
| DEEP | 178.82 | 170.51 | 167.38 | n/a |
| FRI batching | 172.61 | 109.90 | 119.93 | n/a |
| FRI folds (10 rounds, summed) | 177.00 | 163.35 | 113.47 | n/a |
| FRI queries + grinding | 50.39 | 105.48 | 105.89 | 196.00 |
| Field floor | n/a | n/a | n/a | 173.64 |
| **All terms, union bound** | **50.39** | **105.42** | **105.88** | **173.64** |
| With the SHA-256 cap (classical, random-oracle model) | 50.39 | 105.42 | 105.88 | 128.00 |
| Quantum (CMS19, half, capped at 85.33) | 25.19 | 52.71 | 52.94 | 85.33 |

### R-128 C6v2 / C7v2 shape (v2 candidate)

n = 1024, w = 36, k = 8, L = 44, LDE = 32768, rho = 1/32, rho+ = 1026/32768, r = 10, q = 47, g = 16, e = 3, C <= 64, challenges: uniform.

| Term | Unique decoding (theorem) | Johnson, BCIKS20 (theorem, headline) (m=7) | Johnson, BCHKS25 (theorem, 2025, informational) (m=46) | Conjectured (repository formula) |
|---|---|---|---|---|
| ALI | 185.99 | 180.59 | 177.96 | n/a |
| DEEP | 178.82 | 173.42 | 170.79 | n/a |
| FRI batching | 172.61 | 130.29 | 136.96 | n/a |
| FRI folds (10 rounds, summed) | 177.00 | 166.27 | 137.26 | n/a |
| FRI queries + grinding | 60.90 | 128.75 | 132.70 | 251.00 |
| Field floor | n/a | n/a | n/a | 173.64 |
| **All terms, union bound** | **60.90** | **128.32** | **132.57** | **173.64** |
| With the SHA-256 cap (classical, random-oracle model) | 60.90 | 128.00 | 128.00 | 128.00 |
| Quantum (CMS19, half, capped at 85.33) | 30.45 | 64.16 | 66.28 | 85.33 |

## Published v1 figures

`tools/security-levels/tests/prose.rs` reads the block below. A figure in README.md, docs/, apps/web/i18n/ or apps/web/app/ must be one of these for the regime its sentence names and for every circuit it is about (the circuits it names, or every v1 circuit when it names none), or be listed with a reason in `tools/security-levels/prose-ledger.tsv`. What is read, exactly: every file under those four roots whose extension is one of md, mdx, html, htm, ts, tsx, js, jsx, mjs, txt, except this file, the directories node_modules, .next, .turbo, dist and build, and the local-only files listed in `prose::LOCAL_ONLY_FILES` (gitignored or untracked, so a clean checkout does not have them). Every other file under those roots is checked by `prose::unread_files_with_figures`, which fails the test if it states a figure; a PDF or PPTX is not read at all and must have a text source of the same name that is. The figures below are the floors of the as-shipped v1 figures above. The v2 figures are candidates and are not published.

<!-- published-figures:begin -->
```text
C0 unique-decoding 42
C0 quantum-unique-decoding 21
C0 johnson-bciks20 16
C0 quantum-johnson-bciks20 8
C0 johnson-bchks25 31
C0 quantum-johnson-bchks25 15
C0 conjectured 46
C0 quantum-conjectured 23
C1 unique-decoding 45
C1 quantum-unique-decoding 22
C1 johnson-bciks20 16
C1 quantum-johnson-bciks20 8
C1 johnson-bchks25 31
C1 quantum-johnson-bchks25 15
C1 conjectured 46
C1 quantum-conjectured 23
C2 unique-decoding 45
C2 quantum-unique-decoding 22
C2 johnson-bciks20 16
C2 quantum-johnson-bciks20 8
C2 johnson-bchks25 31
C2 quantum-johnson-bchks25 15
C2 conjectured 46
C2 quantum-conjectured 23
C3 unique-decoding 42
C3 quantum-unique-decoding 21
C3 johnson-bciks20 15
C3 quantum-johnson-bciks20 7
C3 johnson-bchks25 31
C3 quantum-johnson-bchks25 15
C3 conjectured 46
C3 quantum-conjectured 23
C4 unique-decoding 42
C4 quantum-unique-decoding 21
C4 johnson-bciks20 16
C4 quantum-johnson-bciks20 8
C4 johnson-bchks25 31
C4 quantum-johnson-bchks25 15
C4 conjectured 46
C4 quantum-conjectured 23
C5 unique-decoding 41
C5 quantum-unique-decoding 20
C5 johnson-bciks20 13
C5 quantum-johnson-bciks20 6
C5 johnson-bchks25 30
C5 quantum-johnson-bchks25 15
C5 conjectured 45
C5 quantum-conjectured 22
C6 unique-decoding 41
C6 quantum-unique-decoding 20
C6 johnson-bciks20 15
C6 quantum-johnson-bciks20 7
C6 johnson-bchks25 31
C6 quantum-johnson-bchks25 15
C6 conjectured 46
C6 quantum-conjectured 23
C7 unique-decoding 41
C7 quantum-unique-decoding 20
C7 johnson-bciks20 15
C7 quantum-johnson-bciks20 7
C7 johnson-bchks25 31
C7 quantum-johnson-bchks25 15
C7 conjectured 46
C7 quantum-conjectured 23
sha256 collision 128
sha256 collision-quantum 85
v1-digest collision 32
v1-digest collision-quantum 21
```
<!-- published-figures:end -->
