# Gotcha: CircomReduction vs LibsnarkReduction

**Time lost discovering this: ~6 hours**

## The Problem

When using the Rust `ark-circom` library (v0.5+) to generate Groth16 proofs
for circuits compiled with circom >= 2.0.7, the default reduction algorithm
(`LibsnarkReduction`) produces **structurally valid but mathematically wrong** proofs.

The proofs look correct (right sizes, valid G1/G2 points) but fail verification.

## The Symptom

- Proof generation succeeds without errors
- Proof has correct structure (valid points, right sizes)
- Verification fails both on-chain and off-chain
- snarkjs-generated proofs for the same inputs work fine

## The Root Cause

circom >= 2.0.7 changed the witness generation order. `LibsnarkReduction`
(the default) assumes the old order. `CircomReduction` handles the new order.

See: https://github.com/arkworks-rs/circom-compat/issues/35

## The Fix

```rust
use ark_circom::CircomReduction;
use ark_bn254::Bn254;
use ark_groth16::Groth16;

// CORRECT: Use CircomReduction
type GrothBn = Groth16<Bn254, CircomReduction>;

// WRONG: Default uses LibsnarkReduction
// type GrothBn = Groth16<Bn254>;  // DON'T DO THIS

let proof = GrothBn::prove(&pk, circuit, &mut rng)?;
let valid = GrothBn::verify(&vk, &public_inputs, &proof)?;
```

## Important Notes

- This applies to BOTH `prove()` and `verify()` — they must use the same reduction
- This affects ark-circom 0.5.x with circom >= 2.0.7 circuits
- snarkjs is not affected (it handles the reduction internally)
- If you're only using snarkjs for proving, you don't need to worry about this
