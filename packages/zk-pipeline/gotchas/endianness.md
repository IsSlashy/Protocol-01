# Gotcha: LE/BE Endianness Mismatch

**Time lost discovering this: ~8 hours**

## The Problem

Solana stores all values in **little-endian** (LE) format. The `alt_bn128`
precompile (used for BN254 pairing operations) expects **big-endian** (BE).

If you pass LE public inputs directly to the verifier, the proof will fail
with no useful error message — just "pairing check failed."

## The Symptom

- Proof verifies correctly off-chain (snarkjs.groth16.verify returns true)
- Same proof fails on-chain with a generic verification error
- No obvious difference in the inputs

## The Fix

Convert every 32-byte public input from LE to BE before passing to the verifier:

```rust
fn le_to_be(bytes: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    for i in 0..32 {
        result[i] = bytes[31 - i];
    }
    result
}
```

Or use the `p01-solana-verifier` crate which handles this automatically.

## TypeScript equivalent

```typescript
function bigintToLeBytes32(n: bigint): number[] {
  const bytes = new Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(tmp & 0xFFn);
    tmp >>= 8n;
  }
  return bytes;
}
```

The `@p01/privacy-toolkit` package provides `publicInputsToLE()` and
`publicInputsToBE()` for this conversion.
