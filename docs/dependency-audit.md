# Protocol 01 -- Dependency Audit

**Document version:** 1.0
**Date:** 2026-02-25
**Status:** Pre-audit preparation

---

## Critical Dependencies

### 1. circomlib (Circuit Library)

| Field | Value |
|-------|-------|
| **Package** | `circomlib` |
| **Version used** | ^2.0.5 |
| **Repository** | https://github.com/iden3/circomlib |
| **Used in** | All circuits (Poseidon, Num2Bits, comparators, MiMC, Mux) |
| **Known CVEs** | None published as of Feb 2026 |
| **Audits** | The circomlib library has been widely reviewed by the ZK community. Iden3/Hermez had internal reviews. No formal public audit certificate. |
| **Risk** | LOW -- battle-tested in production by Tornado Cash, Semaphore, WorldCoin, Polygon ID |
| **Notes** | The Poseidon implementation is the reference for BN254. Ensure the version matches the parameters used in snarkjs/circomlibjs. |

### 2. snarkjs (Groth16 Prover/Verifier)

| Field | Value |
|-------|-------|
| **Package** | `snarkjs` |
| **Version used** | ^0.7.4 (relayer, zk-sdk), ^0.7.6 (circuits) |
| **Repository** | https://github.com/iden3/snarkjs |
| **Used in** | Relayer (proof generation + verification), circuits (setup + tests), SDKs |
| **Known CVEs** | None published. Known bug: versions < 0.6 had issues with large circuits. |
| **Audits** | No formal audit. Widely used in production (Tornado Cash, Semaphore). |
| **Risk** | MEDIUM -- critical for proof correctness; no formal audit; JavaScript implementation |
| **Notes** | Version mismatch between relayer (0.7.4) and circuits (0.7.6) should be harmonized. The Groth16 implementation has been stable since v0.5+. Verify that the fullProve and verify functions produce consistent results across versions. |
| **Recommendation** | Pin to exact version across all packages. Consider adding a snarkjs proof round-trip test in CI. |

### 3. circomlibjs (Poseidon JavaScript)

| Field | Value |
|-------|-------|
| **Package** | `circomlibjs` |
| **Version used** | ^0.1.7 |
| **Repository** | https://github.com/iden3/circomlibjs |
| **Used in** | `packages/zk-sdk/` (Poseidon hashing, note commitments) |
| **Known CVEs** | None published |
| **Audits** | No formal audit |
| **Risk** | MEDIUM -- must produce identical Poseidon outputs as the circom circuit; any mismatch = broken commitments |
| **Notes** | The `poseidon-lite` package (v0.2.0) is also used in `packages/zkspl-sdk/`. Verify that both packages produce identical Poseidon hashes for the same inputs. A hash mismatch between SDK and circuit would cause proof failures. |
| **Recommendation** | Add cross-library Poseidon test vectors. Pin to exact version. |

### 4. poseidon-lite

| Field | Value |
|-------|-------|
| **Package** | `poseidon-lite` |
| **Version used** | ^0.2.0 |
| **Repository** | https://github.com/vimwitch/poseidon-lite |
| **Used in** | `packages/zkspl-sdk/` (confidential balance commitments) |
| **Known CVEs** | None published |
| **Audits** | No formal audit. Fork/reimplementation of circomlibjs Poseidon. |
| **Risk** | MEDIUM -- must be compatible with circomlibjs and the circom Poseidon |
| **Recommendation** | Verify hash compatibility with circomlibjs. Consider using a single Poseidon implementation across all SDKs. |

### 5. ark-circom (Rust Prover)

| Field | Value |
|-------|-------|
| **Package** | `ark-circom` |
| **Version used** | 0.5.0 |
| **Repository** | https://github.com/arkworks-rs/circom-compat |
| **Used in** | `services/prover/` (Rust native Groth16 prover) |
| **Known CVEs** | None published |
| **Known issues** | **CRITICAL:** Must use `CircomReduction` (not `LibsnarkReduction`) for circom >= 2.0.7. See https://github.com/arkworks-rs/circom-compat/issues/35 |
| **Audits** | No formal audit. Part of the arkworks ecosystem. |
| **Risk** | MEDIUM -- the `CircomReduction` issue was a significant footgun; other subtle issues may exist |
| **Notes** | `CircomConfig` is not `Clone` and `CircomBuilder::build()` consumes self. The prover reloads WASM+R1CS per proof (~50-100ms overhead). The `read_zkey` function handles snarkjs zkey format. |
| **Recommendation** | The `CircomReduction` fix is in place. The relayer also verifies Rust proofs with snarkjs (safety net). Consider adding automated cross-verification tests. |

### 6. ark-groth16 (Rust ZK)

| Field | Value |
|-------|-------|
| **Package** | `ark-groth16` |
| **Version used** | 0.5 (with `parallel` feature) |
| **Repository** | https://github.com/arkworks-rs/groth16 |
| **Used in** | `services/prover/` (proof generation + verification) |
| **Known CVEs** | None published |
| **Audits** | The arkworks ecosystem has been reviewed by Trail of Bits (2022, for the core ark-ec/ark-ff crates). The Groth16 implementation specifically was not in scope. |
| **Risk** | LOW-MEDIUM -- well-maintained, active community, but no formal Groth16-specific audit |
| **Notes** | Uses rayon for parallel MSM/NTT (multi-core proving). |

### 7. ark-bn254 (BN254 Curve)

| Field | Value |
|-------|-------|
| **Package** | `ark-bn254` |
| **Version used** | 0.5 |
| **Repository** | https://github.com/arkworks-rs/algebra |
| **Used in** | `services/prover/` (curve operations) |
| **Known CVEs** | None published |
| **Audits** | Trail of Bits reviewed ark-ec/ark-ff (2022). |
| **Risk** | LOW -- standard BN254 implementation |

### 8. anchor-lang (Solana Framework)

| Field | Value |
|-------|-------|
| **Package** | `anchor-lang` |
| **Version used** | 0.32.1 |
| **Repository** | https://github.com/coral-xyz/anchor |
| **Used in** | All on-chain programs (7 programs) |
| **Known CVEs** | Historical: CVE-2022-43680 (discriminator bypass, fixed in 0.25+) |
| **Audits** | Multiple audits by Neodyme, OtterSec, and others across versions |
| **Risk** | LOW -- most widely used Solana framework; v0.32.1 is recent |
| **Notes** | Uses `init-if-needed` feature (enabled). This feature was historically flagged as risky but is now considered safe in Anchor 0.30+. |
| **Recommendation** | Current version is appropriate. Monitor for updates. |

### 9. solana-bn254 (alt_bn128 Syscalls)

| Field | Value |
|-------|-------|
| **Package** | `solana-bn254` |
| **Version used** | 2 |
| **Repository** | https://github.com/solana-labs/solana (monorepo) |
| **Used in** | `programs/zk_shielded/`, `programs/p01_zkspl/` (on-chain Groth16 verification) |
| **Known CVEs** | None published |
| **Audits** | Part of Solana core; audited as part of SVM |
| **Risk** | LOW -- maintained by Solana Labs; matches Ethereum EIP-196/197 |
| **Notes** | The deprecated `alt_bn128_addition`/`alt_bn128_multiplication`/`alt_bn128_pairing` functions are used (marked `#[allow(deprecated)]`). These may be replaced in future Solana versions. |
| **Recommendation** | Monitor for API changes. Plan migration to non-deprecated equivalents. |

### 10. @solana/web3.js

| Field | Value |
|-------|-------|
| **Package** | `@solana/web3.js` |
| **Version used** | ^1.91.0 |
| **Repository** | https://github.com/solana-labs/solana-web3.js |
| **Used in** | Relayer, SDKs, mobile app, extension |
| **Known CVEs** | CVE-2024-XXXXX: Supply chain attack on v1.95.5-v1.95.7 (Dec 2024). These versions contained malicious code. Ensure installed version is NOT in this range. |
| **Audits** | Part of Solana ecosystem; widely used |
| **Risk** | LOW (if version is not in compromised range) |
| **Recommendation** | Verify lockfile does not resolve to 1.95.5-1.95.7. Pin to a known-safe version. |

### 11. @noble/hashes and @noble/curves

| Field | Value |
|-------|-------|
| **Package** | `@noble/hashes` |
| **Version used** | ^1.3.3 |
| **Repository** | https://github.com/paulmillr/noble-hashes |
| **Used in** | `packages/zkspl-sdk/`, `packages/zk-sdk/` |
| **Known CVEs** | None published |
| **Audits** | Audited by Cure53 (2022). High-quality, minimal-dependency library. |
| **Risk** | LOW -- one of the best-audited JS crypto libraries |

### 12. sha3 (Keccak256 On-Chain)

| Field | Value |
|-------|-------|
| **Package** | `sha3` (Rust crate) |
| **Version used** | 0.10 |
| **Repository** | https://github.com/RustCrypto/hashes |
| **Used in** | `programs/zk_shielded/`, `programs/p01_zkspl/` (VK hashing, nullifier hashing) |
| **Known CVEs** | None published |
| **Audits** | RustCrypto is audited; sha3 is a standard implementation |
| **Risk** | LOW |

### 13. bytemuck (Zero-Copy Serialization)

| Field | Value |
|-------|-------|
| **Package** | `bytemuck` |
| **Version used** | 1.14 |
| **Repository** | https://github.com/Lokathor/bytemuck |
| **Used in** | `programs/zk_shielded/`, `programs/p01_zkspl/` (zero-copy accounts) |
| **Known CVEs** | None published |
| **Audits** | No formal audit; widely used in Solana ecosystem |
| **Risk** | LOW -- used for `NullifierSet` zero-copy deserialization |

### 14. @coral-xyz/anchor (JS Client)

| Field | Value |
|-------|-------|
| **Package** | `@coral-xyz/anchor` |
| **Version used** | ^0.29.0 |
| **Repository** | https://github.com/coral-xyz/anchor |
| **Used in** | Relayer, SDKs |
| **Known CVEs** | None for JS client specifically |
| **Risk** | LOW |
| **Notes** | Version mismatch: Rust programs use anchor-lang 0.32.1, JS client uses ^0.29.0. Verify IDL compatibility. |
| **Recommendation** | Upgrade JS anchor to 0.32.x for consistency. |

### 15. express (HTTP Server)

| Field | Value |
|-------|-------|
| **Package** | `express` |
| **Version used** | ^4.18.2 |
| **Repository** | https://github.com/expressjs/express |
| **Used in** | `services/relayer/` |
| **Known CVEs** | Historical CVEs in older versions; 4.18.2+ is current |
| **Risk** | LOW for the relayer use case (not serving user-facing HTML) |
| **Notes** | Missing rate limiting (documented in security-model.md). JSON body limit set to 10MB which could be abused for memory exhaustion. |
| **Recommendation** | Add rate limiting. Consider reducing JSON body limit to 1MB. |

### 16. bn.js (BigNumber)

| Field | Value |
|-------|-------|
| **Package** | `bn.js` |
| **Version used** | ^5.2.1 |
| **Repository** | https://github.com/indutny/bn.js |
| **Used in** | SDKs (field arithmetic) |
| **Known CVEs** | None published for v5.x |
| **Risk** | LOW -- widely used, well-tested |

### 17. ffjavascript (Finite Field)

| Field | Value |
|-------|-------|
| **Package** | `ffjavascript` |
| **Version used** | ^0.3.0 |
| **Repository** | https://github.com/iden3/ffjavascript |
| **Used in** | `packages/zk-sdk/` (field operations for snarkjs) |
| **Known CVEs** | None published |
| **Risk** | LOW -- maintained by iden3, dependency of snarkjs |

---

## Dependency Version Matrix

| Package | circuits/ | relayer/ | zk-sdk/ | zkspl-sdk/ | prover/ |
|---------|-----------|----------|---------|------------|---------|
| snarkjs | ^0.7.6 | ^0.7.4 | ^0.7.4 | ^0.7.4 | -- |
| circomlib | ^2.0.5 | -- | -- | -- | -- |
| circomlibjs | ^0.1.7 | -- | ^0.1.7 | -- | -- |
| poseidon-lite | -- | -- | ^0.2.0 | ^0.2.0 | -- |
| @solana/web3.js | -- | ^1.91.0 | ^1.91.0 | ^1.91.0 | -- |
| @coral-xyz/anchor | -- | ^0.29.0 | ^0.29.0 | ^0.29.0 | -- |
| @noble/hashes | -- | -- | ^1.3.3 | ^1.3.3 | -- |
| anchor-lang (Rust) | -- | -- | -- | -- | -- |
| ark-circom (Rust) | -- | -- | -- | -- | 0.5.0 |
| ark-groth16 (Rust) | -- | -- | -- | -- | 0.5 |

**Note:** anchor-lang 0.32.1 is in programs/zk_shielded/Cargo.toml and programs/p01_zkspl/Cargo.toml.

---

## Version Mismatch Concerns

| Issue | Packages | Risk | Recommendation |
|-------|----------|------|----------------|
| snarkjs 0.7.4 vs 0.7.6 | relayer vs circuits | LOW | Pin all to 0.7.6 |
| @coral-xyz/anchor 0.29 vs anchor-lang 0.32.1 | JS SDK vs Rust programs | MEDIUM | Upgrade JS to 0.32.x -- IDL format may differ |
| Two Poseidon libraries (circomlibjs + poseidon-lite) | zk-sdk vs zkspl-sdk | MEDIUM | Verify hash compatibility; standardize on one |

---

## Supply Chain Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| npm registry compromise (snarkjs, circomlibjs) | HIGH | Use lockfile with integrity hashes; verify package signatures |
| @solana/web3.js supply chain attack (Dec 2024) | CRITICAL | Verify lockfile does not resolve to v1.95.5-1.95.7 |
| Rust crate typosquatting | LOW | Verify crate names and publishers on crates.io |
| circomlib compatibility break | MEDIUM | Pin to exact version in lockfile |
| GitHub account compromise of iden3 | HIGH | Verify package hashes against known-good builds |

---

## Recommendations

### Before Audit

1. **Harmonize snarkjs version** across all packages to 0.7.6
2. **Upgrade @coral-xyz/anchor** JS client to 0.32.x
3. **Add cross-library Poseidon test vectors** (circomlibjs vs poseidon-lite)
4. **Verify @solana/web3.js** lockfile does not contain compromised versions
5. **Pin all dependencies** to exact versions in lockfiles

### Before Mainnet

1. **Multi-party Phase 2 ceremony** for all circuits (minimum 3 contributors)
2. **Implement rate limiting** on relayer endpoints
3. **Replace deprecated solana-bn254 APIs** when new APIs are available
4. **Add lockfile integrity verification** to CI pipeline
5. **Set up dependency monitoring** (Dependabot / Snyk) for CVE alerts
