<div align="center">

# @p01/solana-verifier

**Built by [Protocol 01](https://github.com/IsSlashy/Protocol-01) — The Privacy Layer for Solana**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

On-chain Groth16 proof verification for Solana programs using alt_bn128 syscalls.

## Why This Exists

Every Solana ZK project writes its own Groth16 verifier from scratch and hits the same bugs:

1. **LE/BE endianness mismatch** -- Solana stores values in little-endian, but alt_bn128 expects big-endian
2. **snarkjs G2 point format** -- snarkjs outputs `[real, imaginary]` but EIP-197 expects `[imaginary, real]`
3. **Compute budget guessing** -- How many CU for N public inputs? Nobody documents this
4. **VK management** -- Upload, hash, hot-swap verification keys without redeploying

This crate solves all of them in one place, extracted from a production Solana privacy protocol.

## Quick Start

Add to your `Cargo.toml`:

```toml
[dependencies]
p01-solana-verifier = "1.0"
```

Verify a proof in your Solana program:

```rust
use p01_solana_verifier::{verify_proof, Groth16Proof, VerifierError};

pub fn process_instruction(vk_data: &[u8], proof_bytes: &[u8], inputs: &[[u8; 32]]) -> Result<(), VerifierError> {
    let proof = Groth16Proof::from_bytes(proof_bytes)?;

    // Public inputs in LE (matching Solana storage) -- LE->BE conversion is automatic
    let valid = verify_proof(vk_data, &proof, inputs)?;

    if !valid {
        return Err(VerifierError::ProofInvalid);
    }
    Ok(())
}
```

Convert a snarkjs proof to on-chain format:

```rust
use p01_solana_verifier::proof_from_snarkjs;

// From snarkjs JSON output
let proof = proof_from_snarkjs(
    &[pi_a_x, pi_a_y],
    &[[pi_b_c0x, pi_b_c1x], [pi_b_c0y, pi_b_c1y]],
    &[pi_c_x, pi_c_y],
);
// pi_b real/imaginary components are swapped automatically
```

## Compute Budget Guide

| Public Inputs | Recommended CU | Notes |
|--------------|---------------|-------|
| 1-3 | 200,000 | Most circuits (nullifier check, simple proof) |
| 4-5 | 500,000 | Medium circuits (transfer with multiple commitments) |
| 6-8 | 700,000 | Large circuits (multi-input privacy proofs) |
| 9+ | 1,000,000+ | Very large circuits -- consider splitting |

Each additional public input adds ~1 G1 scalar multiplication (~45,000 CU) and ~1 G1 addition (~7,000 CU).

## Features

- **Automatic endianness conversion** -- Pass LE inputs (Solana-native), get correct BE for alt_bn128
- **snarkjs proof conversion** -- `proof_from_snarkjs()` handles the G2 real/imaginary swap
- **VK parsing and hashing** -- Binary VK format parser + keccak256 hash for on-chain comparison
- **Off-chain testing** -- `cfg(not(target_os = "solana"))` stubs let you run tests without a validator
- **Stack-safe** -- Heap-allocated VK parsing stays within BPF stack limits
- **Zero dependencies beyond Solana** -- Only `solana-program`, `solana-bn254`, `sha3`, `bytemuck`

## Included Patterns

The `patterns` module contains documented, battle-tested code examples for common Solana ZK tasks:

### PDA-per-Nullifier (`patterns::nullifier_pda`)
Atomic double-spend prevention using Solana's PDA system. Each nullifier gets its own account -- if it exists, `init` fails atomically. Zero false positives, no Bloom filter sizing headaches.

### VK Hot-Swap (`patterns::vk_hotswap`)
Update verification keys without recreating pools or migrating state. Store only the VK hash in your pool account, store the full VK data separately, and swap by updating the hash.

### Account Realloc (`patterns::account_realloc`)
Add fields to deployed accounts without recreation. Uses raw `AccountInfo` to bypass Anchor's typed deserialization (which fails on undersized accounts), manually validates ownership, then `realloc`s with zero-fill.

## VK Binary Format

The verification key binary format expected by `parse_vk()`:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 64 | alpha_g1 (G1 point) |
| 64 | 128 | beta_g2 (G2 point) |
| 192 | 128 | gamma_g2 (G2 point) |
| 320 | 128 | delta_g2 (G2 point) |
| 448 | 4 | ic_count (u32, little-endian) |
| 452 | 64 * ic_count | IC points (G1 points) |

## Known Gotchas

| Gotcha | Symptom | Fix |
|--------|---------|-----|
| G2 point ordering | Proof valid off-chain, fails on-chain | Use `proof_from_snarkjs()` -- it swaps real/imaginary |
| LE/BE mismatch | Wrong public inputs, proof always fails | Use `verify_proof()` (auto-converts) or `le_to_be()` manually |
| Compute budget too low | Transaction fails with "exceeded CU" | See budget table above; add `ComputeBudgetInstruction::set_compute_unit_limit()` |
| VK hash mismatch | "Invalid VK" error after circuit update | Use `compute_vk_hash()` on the new VK data and update the pool's stored hash |
| snarkjs circom >= 2.0.7 | Rust prover (ark-circom) produces wrong proofs | Use `CircomReduction` not `LibsnarkReduction` in your Rust prover |
| Stack overflow in BPF | "Access violation" on proof verify | VK parsing uses heap allocation (Vec) -- make sure your IC count is reasonable |

## API Reference

### Top-level

- `verify_proof(vk_data, proof, public_inputs_le)` -- Verify with automatic LE->BE conversion
- `proof_from_snarkjs(pi_a, pi_b, pi_c)` -- Convert snarkjs JSON proof to on-chain bytes
- `compute_vk_hash(vk_data)` -- Keccak256 hash of VK binary data
- `parse_vk(vk_data)` -- Parse VK binary into structured components
- `le_to_be(bytes)` / `be_to_le(bytes)` -- 32-byte endianness conversion

### Types

- `Groth16Proof` -- 256-byte proof (pi_a + pi_b + pi_c)
- `VerificationKey` -- Parsed VK with alpha, beta, gamma, delta, IC points
- `VerifierError` -- Error enum covering all failure modes

### Endianness Helpers

- `i64_to_field_le(value)` -- Signed integer to BN254 Fr field element (handles negatives)
- `u64_to_field_le(value)` -- Unsigned integer to 32-byte LE field element

## License

MIT

---

## Part of the Protocol 01 Ecosystem

This library is extracted from [Protocol 01](https://github.com/IsSlashy/Protocol-01), the privacy layer for Solana. P01 uses denominated privacy pools with client-side Groth16 proving to provide complete unlinkability on Solana.

| Library | Purpose |
|---------|---------|
| **@p01/react-native-zk** | Client-side ZK proving on mobile |
| **@p01/solana-verifier** | On-chain Groth16 verification |
| **@p01/privacy-toolkit** | Merkle trees, commitments, proof formatting |
| **@p01/zk-pipeline** | End-to-end guide: circuit → mobile → on-chain |

[Website](https://protocol-01.vercel.app) · [Twitter](https://twitter.com/Protocol01_) · [Discord](https://discord.gg/KfmhPFAHNH)
