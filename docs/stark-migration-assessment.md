# Protocol 01 -- Groth16 to STARK Migration Assessment

**Document version:** 1.0
**Date:** 2026-03-06
**Status:** Research assessment (no code changes)
**Companion doc:** [quantum-resistance.md](quantum-resistance.md)

---

## Executive Summary

Protocol 01 currently relies on Groth16 ZK-SNARKs over BN254 for all six circuits, verified on-chain via Solana's `alt_bn128` syscalls at approximately 200K compute units per proof with a compact 256-byte proof size. Migrating to STARKs would achieve post-quantum security (hash-based, immune to Shor's algorithm) but introduces severe on-chain cost challenges: native STARK proofs are 40-200 KB and consume around 1.1M compute units for verification. The two practical paths today are (1) zkVM wrappers (SP1/Risc0) that compress STARKs into Groth16 proofs -- which defeats the post-quantum purpose -- or (2) native STARK verification on Solana using Winterfell, which is academically proven feasible but not yet production-ready. The recommended strategy is to prepare for STARK migration now (abstract the verifier interface, write circuit logic in Rust, monitor Solana SIMD-0296 for 4KB transactions) while continuing to run Groth16 in production until either native STARK verification matures on Solana or the quantum threat timeline accelerates.

---

## 1. STARK Proving Systems Compatible with Solana

### 1.1 SP1 (Succinct) -- zkVM with Solana Verifier

**Status:** Most mature Solana integration. Production-ready for wrapped proofs.

SP1 is a RISC-V zkVM that lets developers write provable programs in standard Rust. The proof pipeline is:

1. Write logic in Rust, compile to RISC-V
2. SP1 generates a STARK proof of correct execution
3. STARK proof is recursively compressed
4. Final proof is wrapped into a Groth16 SNARK on BN254

The `sp1-solana` crate (https://github.com/succinctlabs/sp1-solana) verifies these Groth16-wrapped proofs on Solana using the same `alt_bn128` pairing syscalls Protocol 01 already uses. Verification costs approximately 280K compute units.

**Post-quantum assessment:** SP1 itself uses STARKs internally, but the on-chain verifier consumes a Groth16 proof on BN254. This means the final on-chain verification step is NOT post-quantum secure. A quantum adversary with access to a CRQC could forge the Groth16 wrapper and submit invalid proofs. SP1 would only provide post-quantum security if Solana added a native STARK verifier syscall or if SP1 shipped a non-BN254 final wrapper.

**Migration effort:** Medium. Circuits would need to be rewritten from Circom DSL to Rust programs. The logic (Poseidon hashing, Merkle proofs, range checks) translates directly into Rust code, but the programming model shifts from "define constraints" to "write a program whose execution is proven."

**Key references:**
- Crate: https://crates.io/crates/sp1-solana
- Blog: https://blog.succinct.xyz/learn/solana-sp1/

### 1.2 Risc0 + Bonsol -- zkVM Co-Processor for Solana

**Status:** Active development. Bonsol provides Solana-native integration.

Risc0 is another RISC-V zkVM using zk-STARKs (FRI protocol, DEEP-ALI, HMAC-SHA-256 PRFs). Bonsol (https://bonsol.sh) wraps Risc0 as a Solana co-processor with a decentralized prover network.

**Critical detail:** Like SP1, Bonsol converts STARK proofs to Groth16 SNARKs for on-chain verification. The same post-quantum limitation applies -- the final on-chain proof is BN254 Groth16.

**Migration effort:** Similar to SP1. Circuits rewritten in Rust, compiled to RISC-V. Bonsol adds a deployment/execution framework but ties you to their prover network.

**Key references:**
- Bonsol docs: https://bonsol.sh/docs/explanation/what-is-bonsol
- Risc0 repo: https://github.com/risc0/risc0
- Risc0-solana: https://github.com/risc0/risc0-solana

### 1.3 Winterfell -- Native STARK Verification on Solana

**Status:** Academic proof-of-concept. The only path to TRUE post-quantum on-chain verification.

A 2025 research paper (ePrint 2025/1741) demonstrated that Winterfell 0.12 STARK proofs can be verified entirely on Solana L1 within the transaction compute budget. Key measurements (100 runs):

| Metric | Value |
|--------|-------|
| Proof size | ~4,437 bytes |
| Verification compute units | ~1,104,510 CU (mean) |
| CU per proof byte | ~248.9 |
| Security level | 127-bit conjectured |
| Hash function | SHA-256 (via Solana `hashv` syscall) |
| Prover config | ~30 queries, 16x blowup, 8x grinding, 4x folding |

The implementation required:
- Routing SHA-256 to Solana's `hashv` syscall to reduce hashing overhead
- Suppressing inlining in FRI hotspots to respect SBF stack limits (BPF has 4KB stack frames)
- Custom bump allocator synchronized with heap frame requests
- Proof artifacts uploaded in <=900 byte chunks under a rolling hash chain

**Post-quantum assessment:** Fully post-quantum secure. The proof system relies only on SHA-256 (collision-resistant hash function), not on any elliptic curve assumptions. Combined with SLH-DSA (SPHINCS+) signatures, this gives a complete PQ verification pipeline.

**Current limitations:**
- The 4,437-byte proof exceeds Solana's current 1,232-byte transaction limit
- Requires SIMD-0296 (4,096-byte transactions) or multi-transaction upload
- 1.1M CU is close to the 1.4M CU transaction budget -- leaves little room for program logic
- No production-grade Solana program exists yet; the paper is a measurement study
- Proof size grows logarithmically with computation size; larger circuits produce larger proofs

**Key references:**
- Paper: https://eprint.iacr.org/2025/1741
- Winterfell repo: https://github.com/facebook/winterfell

### 1.4 Stwo (StarkWare) -- Next-Gen STARK Prover

**Status:** Production on Starknet mainnet. No Solana integration.

Stwo (pronounced "Stew") replaced Stone as Starknet's prover in late 2025, delivering ~100x efficiency improvement. It is fully open-source (Apache 2.0, published on crates.io).

**Solana compatibility:** Stwo is designed for Starknet's Cairo VM execution traces, not general-purpose Solana programs. There is no Solana verifier for Stwo proofs. A Groth16 wrapper exists (https://github.com/HerodotusDev/stwo-gnark-verifier), but this again defeats PQ security.

**Relevance:** If someone builds a Solana verifier for Stwo proofs, it could be a compelling option due to its proving speed. For now, it is Starknet-only.

### 1.5 Plonky2/Plonky3 (Polygon) -- PLONK+FRI

**Status:** Plonky2 deprecated; Plonky3 active. No Solana verifier.

Plonky3 is Polygon's modular proving framework using FRI polynomial commitments. It achieves sub-200ms proving for small circuits on modern CPUs. However:

- Proofs are ~43 KB (much larger than Groth16)
- Existing verifiers target EVM (Solidity), not Solana
- A Solana verifier would need to be built from scratch
- Post-quantum security depends on the hash function used (not on elliptic curves), so it qualifies as PQ-secure if configured properly

**Migration effort:** High. Circuits would need rewriting in Plonky3's constraint system (not Circom). No existing tooling for Solana deployment.

### 1.6 Solana-Native STARK Infrastructure

**Status:** Emerging, not production-ready.

| Project | Description | PQ-Secure? |
|---------|-------------|------------|
| `sp1-solana` (Succinct) | Groth16-wrapped SP1 STARK proofs | No (BN254 wrapper) |
| Bonsol (Risc0) | Groth16-wrapped Risc0 STARK proofs | No (BN254 wrapper) |
| Winterfell on Solana (ePrint 2025/1741) | Native STARK verification | **Yes** |
| Light Protocol `groth16-solana` | Groth16 verifier (used by ZK Compression) | No |
| Sovereign Labs `solana-proofs` | Solana state proofs infrastructure | N/A |

**Bottom line:** As of March 2026, there is no production-ready, post-quantum-secure STARK verifier on Solana. The Winterfell study proves it is feasible but requires engineering to productionize. All existing zkVM integrations (SP1, Risc0/Bonsol) wrap their STARKs in Groth16 for the on-chain step, negating PQ security.

---

## 2. Circuit Migration Effort

### 2.1 Can Circom Circuits Be Compiled to STARK?

**Short answer: No.** There is no automated Circom-to-STARK compiler.

Circom compiles to R1CS (Rank-1 Constraint System), which is the native format for Groth16 and other SNARK systems. STARKs operate over AIR (Algebraic Intermediate Representation) or similar execution traces. These are fundamentally different representations:

| Property | R1CS (Groth16) | AIR (STARK) |
|----------|---------------|-------------|
| Constraint format | A*B = C (rank-1) | Polynomial transition constraints |
| Witness model | Single assignment | Execution trace (rows of state) |
| Field | BN254 scalar field (254-bit) | Configurable (e.g., Goldilocks 64-bit, BabyBear 31-bit) |
| Proof size | 256 bytes (constant) | 4-200 KB (logarithmic in trace length) |

There was an early experiment (`circom_export_to_cairo` by LambdaClass) to translate Circom verifiers to Cairo, but it was for the Groth16 verifier template, not for converting the circuit logic itself to a STARK-compatible format.

### 2.2 What Needs to Be Rewritten

Each circuit must be re-implemented in the target system's language. Here is the effort assessment per circuit:

| Circuit | Constraints | Public Inputs | Complexity | Rewrite Effort | Notes |
|---------|-------------|---------------|------------|----------------|-------|
| `transfer` | 12,222 | 7 | High | 3-4 weeks | 2-in-2-out Zcash model, Merkle proofs (depth 20), nullifiers, range proofs |
| `confidential_balance` | 1,382 | 7 | Medium | 1-2 weeks | Balance commitments, conservation law, direction flag |
| `balance_proof` | 644 | 3 | Low | 3-5 days | Balance sufficiency (range proof) |
| `denominated_pool` | 4,273 | 5 | Medium | 1-2 weeks | Tornado-style pool, Merkle proof (depth 15), epoch maturity |
| `denominated_transfer` | ~4,500 | 5 | Medium | 1-2 weeks | Pool transfer, old note consumption + new note creation |
| `subscriber_ownership` | ~250 | 1 | Trivial | 1-2 days | Single Poseidon hash preimage proof |

**Total estimated rewrite effort:** 8-12 weeks for one developer.

### 2.3 Target Languages for Rewrite

| Target System | Language | Pros | Cons |
|---------------|----------|------|------|
| **SP1 / Risc0** | Rust (standard) | Familiar language, std library, no DSL learning curve | Wraps to Groth16 on Solana (not PQ) |
| **Winterfell** | Rust (AIR trait impl) | True PQ, proven on Solana L1 | Must define AIR manually, less tooling |
| **Cairo** | Cairo | Mature ecosystem, Stwo prover | Starknet-only, no Solana verifier |
| **Noir** | Noir DSL | Backend-agnostic (ACIR), closest to Circom style | No Solana verifier, primarily EVM |

**Recommendation:** Write the circuit logic as pure Rust library functions (Poseidon hashing, Merkle verification, nullifier computation, range checks). These can be wrapped in either SP1/Risc0 programs (for near-term deployment) or Winterfell AIR definitions (for future PQ deployment). This "write once, wrap twice" approach minimizes duplication.

### 2.4 Key Dependencies That Must Be Ported

| Dependency | Current (Circom) | STARK Equivalent |
|------------|-------------------|------------------|
| Poseidon hash | `circomlib/poseidon.circom` | `poseidon-rs` or implement over target field |
| Merkle tree | Custom `merkle.circom` (depth 15/20) | Standard Merkle with Poseidon in Rust |
| Range proofs | `Num2Bits(64)` (bit decomposition) | Native integer checks in zkVM; explicit in AIR |
| Comparators | `circomlib/comparators.circom` | Standard Rust comparisons |

**Field compatibility concern:** Circom circuits operate over the BN254 scalar field (p = 21888...87). SP1 and Risc0 use different fields internally (BabyBear for SP1, 32-bit primes for Risc0). Poseidon constants are field-specific. If you want Poseidon hashes to be compatible with existing on-chain commitments, you either need to (a) use the BN254 field in the STARK prover (expensive), or (b) migrate all on-chain commitments to a new field (breaking change, requires fund migration).

---

## 3. Proof Size, Cost, and Solana Constraints

### 3.1 Current Groth16 Baseline

| Metric | Value |
|--------|-------|
| Proof size (on-chain) | 256 bytes (pi_a: 64B, pi_b: 128B, pi_c: 64B) |
| Verification key size | ~452 bytes (for 5 public inputs) |
| Compute units | ~200,000 CU |
| Fits in single tx? | Yes (well within 1,232-byte limit) |
| Post-quantum secure? | **No** (BN254 DLP breakable by Shor) |

### 3.2 Native STARK (Winterfell) on Solana

| Metric | Value |
|--------|-------|
| Proof size | ~4,437 bytes (for small computation) |
| Verification CU | ~1,104,510 CU |
| Security level | 127-bit conjectured |
| Fits in single tx (current)? | **No** (exceeds 1,232-byte limit) |
| Fits in single tx (SIMD-0296)? | **Borderline** (fits 4,096 byte limit for proof data, but needs instruction data too) |
| Post-quantum secure? | **Yes** |

### 3.3 zkVM-Wrapped STARK (SP1/Risc0 via Groth16)

| Metric | Value |
|--------|-------|
| Proof size | 256 bytes (same as Groth16 -- it IS Groth16) |
| Verification CU | ~280,000 CU (SP1 Solana verifier) |
| Fits in single tx? | Yes |
| Post-quantum secure? | **No** (Groth16 wrapper on BN254) |

### 3.4 The Core Dilemma

```
                     PQ Secure?    Fits Solana Tx?    Production Ready?
                     ----------    ---------------    -----------------
Groth16 (current)    No            Yes                Yes
STARK-to-Groth16     No            Yes                Yes (SP1/Risc0)
Native STARK         YES           No (needs SIMD)    No (research only)
```

There is currently no option that is simultaneously post-quantum secure, fits in a Solana transaction, and is production-ready.

### 3.5 Proof Compression: STARK -> Groth16 Wrapper

This is exactly what SP1 and Risc0 do: recursively compress the STARK proof, then produce a final Groth16 proof for on-chain verification. The Groth16 proof is constant-size (~256 bytes) regardless of the original computation complexity.

**Why this defeats PQ security:** The Groth16 verifier checks a pairing equation on BN254:

```
e(-A, B) * e(alpha, beta) * e(IC_sum, gamma) * e(C, delta) = 1
```

A quantum computer running Shor's algorithm can compute discrete logarithms on BN254, enabling an attacker to forge any Groth16 proof. The STARK part is irrelevant if the final verification step is breakable.

**Alternative compression approach:** A hash-based SNARK (e.g., FRI-based SNARK over a hash-friendly field) could compress proofs without introducing EC assumptions. This does not exist as a production system today.

### 3.6 Account-Based Verification (Multi-Transaction Approach)

For native STARK proofs that exceed the transaction size limit, verification can be split across multiple transactions:

1. **Upload phase:** Store proof chunks in a PDA across multiple transactions (<=900 bytes per chunk, as demonstrated in ePrint 2025/1741). Use a rolling hash chain for integrity.
2. **Verify phase:** A final transaction reads the proof from the PDA and executes verification.

This approach works today within Solana's constraints but has drawbacks:
- Requires 5-6 transactions for a ~4.5 KB proof
- Increases latency (multiple block confirmations)
- Increases total cost (multiple transaction fees)
- Adds complexity to the client SDK

With SIMD-0296 (4,096-byte transactions), a small STARK proof could fit in 1-2 transactions.

---

## 4. Timeline and Feasibility

### 4.1 Maturity of STARK Verifiers on Solana

| System | Maturity Level | Solana Support | Audit Status |
|--------|---------------|----------------|--------------|
| SP1 (`sp1-solana`) | Beta | Official crate | Not audited |
| Risc0/Bonsol | Alpha-Beta | Via Bonsol | Risc0 core audited |
| Winterfell native | Research PoC | Paper only | Not audited |
| Stwo | Production (Starknet) | None | Starknet audited |
| Plonky3 | Active dev | None | Not audited |

### 4.2 Solana Infrastructure Timeline

| Milestone | Status | Impact on STARK Migration |
|-----------|--------|---------------------------|
| BN254 `alt_bn128` syscalls | **Live** (mainnet since 1.18.x) | Enables current Groth16 verification |
| SIMD-0296: 4,096-byte transactions | **In review** (active PR) | Would allow small STARK proofs in 1-2 txs |
| SIMD-0286: 100M CU block limit | **Proposed** | More room for STARK verification in blocks |
| Native STARK verifier syscall | **Not proposed** | Would be the ideal solution; unlikely near-term |
| SHA-256 syscall optimization | **Live** | Already leveraged by Winterfell PoC |

### 4.3 Estimated Migration Effort Per Circuit

**Phase A: Rewrite circuits in Rust (enables SP1/Risc0 path)**

| Circuit | Effort | Dependencies |
|---------|--------|-------------|
| `subscriber_ownership` | 1-2 days | Poseidon |
| `balance_proof` | 3-5 days | Poseidon, range check |
| `confidential_balance` | 1-2 weeks | Poseidon, range check, conservation law |
| `denominated_pool` | 1-2 weeks | Poseidon, Merkle (depth 15), epoch check |
| `denominated_transfer` | 1-2 weeks | Poseidon, Merkle (depth 15), dual commitment |
| `transfer` | 3-4 weeks | Poseidon, Merkle (depth 20), 2-in-2-out, nullifiers |

**Phase B: Implement Winterfell AIR definitions (enables native STARK path)**

Add 50-100% overhead to Phase A estimates. AIR definitions require thinking in terms of execution traces and transition constraints rather than direct constraint specification or program execution.

### 4.4 Can We Do Incremental Migration?

**Yes, with careful architecture.** The key insight is that each circuit operates independently:

- New circuits (new features) can be built on STARK from the start
- Existing circuits can continue using Groth16 until migration is ready
- The on-chain programs need a verifier abstraction that can dispatch to either Groth16 or STARK verification based on the proof type

**Current codebase coupling points:**

The Groth16 verifier is well-isolated in Protocol 01's architecture:
- `programs/p01_trustless/src/verifier/groth16.rs` -- self-contained module
- `programs/zk_shielded/src/verifier/groth16.rs` -- same pattern
- `programs/p01_zkspl/src/verifier/groth16.rs` -- same pattern
- `packages/solana-verifier/src/verifier.rs` -- shared library

Each program's verifier is behind a clean module boundary. Adding a STARK verifier alongside the Groth16 verifier is architecturally straightforward:

```
verifier/
  mod.rs          -- dispatch: proof_type -> groth16 | stark
  groth16.rs      -- existing (no changes)
  stark.rs        -- new: Winterfell or other STARK verifier
```

Client-side, the prover abstraction in `packages/zk-sdk/src/prover/index.ts` and `packages/specter-sdk/src/proving/client-prover.ts` already use a class-based pattern that could support a backend switch.

---

## 5. Hybrid Approach and Recommended Strategy

### 5.1 The Pragmatic Middle Ground

Given the current state of the ecosystem, the recommended approach is a **three-phase migration** that balances urgency against readiness:

#### Phase 1: Prepare (Now -- Q2 2026) -- 2-3 weeks effort

Goal: Reduce future migration cost without changing production behavior.

1. **Abstract the verifier interface.** Refactor the three on-chain verifier modules (`p01_trustless`, `zk_shielded`, `p01_zkspl`) to dispatch through a `ProofVerifier` trait with variants for `Groth16` and (future) `Stark`. This is a small refactor since the modules are already well-isolated.

2. **Write circuit logic as pure Rust.** Extract the core computation from each Circom circuit (Poseidon hashing, Merkle verification, nullifier computation, range checks) into a shared `p01-circuits` Rust library. This library will serve as the source of truth for circuit correctness and can be wrapped in Circom (current), SP1, Risc0, or Winterfell AIR.

3. **Add proof-type versioning to on-chain accounts.** Reserve a byte in proof submission instructions to indicate `proof_type: u8` (0 = Groth16, 1 = STARK, 2 = SP1-wrapped). This allows the programs to route verification without breaking existing transactions.

4. **Monitor SIMD-0296.** The 4,096-byte transaction proposal is critical for native STARK viability. Track its status and prepare account-based proof upload as a fallback.

#### Phase 2: Build STARK Pipeline (Q3 2026 -- Q1 2027) -- 8-12 weeks effort

Goal: Have a working STARK proof pipeline ready to deploy, gated behind a feature flag.

1. **Port circuits to SP1/Risc0.** Start with the simplest circuit (`subscriber_ownership`) and progress to the most complex (`transfer`). Use the Rust circuit library from Phase 1 as the implementation base.

2. **Deploy SP1 verifier on devnet.** Even though SP1 wraps to Groth16 (not PQ-secure), this validates the pipeline: Rust circuit -> STARK proof -> on-chain verification. It also provides a performance improvement path (SP1's recursive compression can handle arbitrarily complex programs).

3. **Prototype Winterfell AIR for one circuit.** Choose `denominated_pool` (4,273 constraints, moderate complexity) and implement a Winterfell AIR definition. Test on-chain verification on devnet. Measure proof size and CU consumption for Protocol 01's actual circuit complexity.

4. **Implement multi-tx proof upload.** Build the PDA-based proof upload mechanism for proofs that exceed the transaction size limit. This infrastructure is needed regardless of which STARK system wins.

#### Phase 3: Activate STARK Verification (When Ready -- Estimated 2027-2030)

Goal: Enable post-quantum-secure proof verification on mainnet.

Trigger conditions (any one):
- SIMD-0296 ships and STARK proofs fit in transactions
- Solana adds a native STARK verifier syscall
- Winterfell (or another STARK verifier) has an audited Solana program
- Quantum computing threat timeline accelerates materially

Steps:
1. Deploy dual-verifier programs (accept both Groth16 and STARK proofs)
2. Migrate clients to generate STARK proofs (with Groth16 fallback)
3. After sufficient soak time, deprecate Groth16 path
4. Rotate verification keys

### 5.2 What to Do NOW (Priority Action Items)

**Immediate (this week):**
- [ ] Reserve `proof_type` byte in instruction formats (forward-compatible, zero-cost)
- [ ] Track SIMD-0296 status: https://github.com/solana-foundation/solana-improvement-documents/pull/296

**Short-term (next 4 weeks):**
- [ ] Refactor verifier modules behind a `ProofVerifier` trait
- [ ] Begin extracting circuit logic into `p01-circuits` Rust library
- [ ] Evaluate SP1 crate: `cargo add sp1-solana` and test Groth16-wrapped verification on devnet

**Medium-term (next quarter):**
- [ ] Port `subscriber_ownership` (simplest) to SP1
- [ ] Port `balance_proof` to SP1
- [ ] Benchmark SP1 proving time vs snarkjs Groth16 for these circuits
- [ ] Prototype Winterfell AIR for `denominated_pool`

**Long-term (next year):**
- [ ] Port remaining 4 circuits to SP1
- [ ] Build multi-tx proof upload infrastructure
- [ ] Monitor quantum computing milestones (IBM, Google, PsiQuantum)
- [ ] Engage with Solana foundation on native STARK syscall proposal

### 5.3 Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SIMD-0296 delayed or rejected | Medium | STARK proofs require multi-tx upload (more complex) | Build multi-tx upload as backup |
| SP1/Risc0 abandon Solana support | Low | Must build custom integration | Use Winterfell directly; it's library-level |
| Quantum timeline accelerates (pre-2030 CRQC) | Low | Urgent need for PQ verification | Phase 2 readiness ensures we can deploy quickly |
| Poseidon field incompatibility | High | Existing commitments use BN254 field | Must plan commitment migration or use BN254 Poseidon in STARK |
| Proving time regression | Medium | STARKs typically slower for small circuits | SP1 prover network offloads computation |
| Client-side STARK proving too slow for mobile | High | Current snarkjs WebView already borderline | Use server-side proving with PQ-signed proof delivery |

### 5.4 The Poseidon Field Problem (Critical)

This deserves special attention. All of Protocol 01's on-chain state (commitments, nullifiers, Merkle roots) uses Poseidon hashes over the BN254 scalar field. If we migrate to a STARK system using a different field (BabyBear, Goldilocks, etc.), we face a choice:

**Option A: Compute BN254-field Poseidon inside the STARK.**
- Pro: Backward compatible. Existing commitments remain valid.
- Con: BN254 field arithmetic is expensive in STARKs (non-native field simulation). Proof generation could be 10-100x slower.

**Option B: Migrate to a STARK-native field for Poseidon.**
- Pro: Efficient proving. Native field operations.
- Con: Breaking change. All existing commitments become invalid. Requires a full fund migration event where every user re-shields their funds.

**Option C: Use SHA-256 instead of Poseidon in STARK circuits.**
- Pro: SHA-256 is natively optimized on Solana (`hashv` syscall). STARKs work well with hash-based commitments.
- Con: Complete commitment scheme redesign. Breaking change.

**Recommendation:** For Phase 2 (SP1/Risc0), use Option A. The BN254-field Poseidon library exists in Rust (`poseidon-rs`, `ark-poseidon`) and can run inside a zkVM, albeit slowly. For Phase 3 (native STARK/Winterfell), plan for Option B or C with a user migration event -- by that time, the protocol may have evolved enough to justify a v2 commitment scheme anyway.

---

## 6. Comparison Matrix

| Dimension | Groth16 (Current) | SP1-Wrapped | Risc0/Bonsol | Winterfell Native | Plonky3 |
|-----------|-------------------|-------------|--------------|-------------------|---------|
| **PQ Secure** | No | No | No | **Yes** | Yes (if hash-based) |
| **Proof Size** | 256 B | 256 B | 256 B | ~4.5 KB | ~43 KB |
| **Verify CU** | ~200K | ~280K | ~200K | ~1.1M | Unknown (no Solana verifier) |
| **Trusted Setup** | Yes (phase 1 + phase 2) | No (STARK core) / Yes (Groth16 wrapper) | No / Yes | **No** | **No** |
| **Circuit Language** | Circom DSL | Rust | Rust | Rust (AIR traits) | Rust (Plonky3 API) |
| **Solana Verifier** | Production | Beta crate | Via Bonsol | Research PoC | None |
| **Client Prover** | snarkjs (JS/WASM) | SP1 prover (Rust/network) | Risc0 prover | Winterfell prover (Rust) | Plonky3 prover (Rust) |
| **Mobile Proving** | WebView snarkjs | Server-side (too heavy) | Server-side | Server-side | Server-side |
| **Migration Effort** | N/A (current) | Medium (rewrite to Rust) | Medium | High (AIR definitions) | High (no Solana infra) |
| **Production Ready** | Yes | Beta | Alpha | No | No |

---

## 7. Conclusion

The Groth16-to-STARK migration is a question of "when," not "if." The quantum threat to BN254 is real, with expert consensus placing cryptographically relevant quantum computers in the 2030-2040 window. Protocol 01's internal cryptographic primitives (Poseidon commitments, Merkle trees) are already quantum-resistant -- only the proof system needs migration.

The ecosystem is not ready for post-quantum-secure on-chain verification today. Every practical Solana STARK integration wraps the final proof in Groth16 on BN254, preserving the exact vulnerability we want to eliminate. The Winterfell research paper proves native STARK verification is feasible on Solana L1, but it remains a proof of concept.

The recommended strategy is to invest modestly now in preparation (verifier abstraction, Rust circuit library, proof-type versioning) so that when the infrastructure matures -- likely catalyzed by SIMD-0296 and growing demand for PQ security -- Protocol 01 can migrate quickly. The estimated total effort is 2-3 weeks for Phase 1 preparation, 8-12 weeks for Phase 2 pipeline build, and deployment timing dependent on ecosystem readiness.

Meanwhile, Protocol 01's hybrid post-quantum stealth addresses (ML-KEM-768 + X25519, already implemented in `specter-sdk`) demonstrate that the project takes quantum resistance seriously and is ahead of most Solana protocols in PQ preparedness.

---

## Sources

- [SP1 Solana Verifier](https://blog.succinct.xyz/learn/solana-sp1/)
- [SP1 GitHub](https://github.com/succinctlabs/sp1-solana)
- [Risc0 GitHub](https://github.com/risc0/risc0)
- [Bonsol Documentation](https://bonsol.sh/docs/explanation/what-is-bonsol)
- [Full L1 On-Chain ZK-STARK+PQC Verification on Solana (ePrint 2025/1741)](https://eprint.iacr.org/2025/1741)
- [Winterfell STARK Prover](https://github.com/facebook/winterfell)
- [Stwo Prover (StarkWare)](https://starkware.co/blog/stwo-prover-the-next-gen-of-stark-scaling-is-here/)
- [Plonky3 (Polygon)](https://github.com/0xPolygonZero/plonky2)
- [Stwo Gnark Groth16 Wrapper](https://github.com/HerodotusDev/stwo-gnark-verifier)
- [groth16-solana (Light Protocol)](https://github.com/Lightprotocol/groth16-solana)
- [SIMD-0296: Larger Transaction Size](https://github.com/solana-foundation/solana-improvement-documents/pull/296)
- [SIMD-0286: 100M CU Block Limit](https://www.coindesk.com/markets/2025/07/24/solana-eyes-66-block-size-bump-with-new-developer-proposal-as-network-demand-grows)
- [Quantum Computing Threat Survey](https://www.sciencedirect.com/science/article/pii/S1574013725001224)
- [STARK Scalability Paper (Ben-Sasson et al.)](https://eprint.iacr.org/2018/046.pdf)
- [Noir Language](https://noir-lang.org/)
- [Zero-Knowledge Proofs on Solana (Helius)](https://www.helius.dev/blog/zero-knowledge-proofs-its-applications-on-solana)
- [ZK-SNARKs vs ZK-STARKs Comparison (Consensys)](https://consensys.io/blog/zero-knowledge-proofs-starks-vs-snarks)
- [SP1 Hypercube Announcement](https://www.theblock.co/post/355013/succinct-introduces-zkvm-sp1-hypercube-claims-real-time-ethereum-proving)
