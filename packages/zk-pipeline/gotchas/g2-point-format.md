# Gotcha: G2 Point Format (snarkjs vs EIP-197)

**Time lost discovering this: ~4 hours**

## The Problem

snarkjs outputs G2 points in a different order than the EIP-197 / alt_bn128
precompile expects. Specifically, the **real and imaginary components are swapped**.

## snarkjs format

```json
{
  "pi_b": [
    ["c0_x", "c1_x"],
    ["c0_y", "c1_y"],
    ["1", "0"]
  ]
}
```

## EIP-197 / alt_bn128 format

```
[c1_x, c0_x, c1_y, c0_y]  // imaginary FIRST, then real
```

## The Symptom

- Proof structure looks valid (correct sizes, valid field elements)
- Pairing check always fails
- Off-chain verification with snarkjs works perfectly

## The Fix

Swap real and imaginary when converting:

```typescript
// snarkjs -> on-chain
bytes.push(...fieldToBytes(proof.pi_b[0][1])); // x_imag (was index [0][1])
bytes.push(...fieldToBytes(proof.pi_b[0][0])); // x_real (was index [0][0])
bytes.push(...fieldToBytes(proof.pi_b[1][1])); // y_imag (was index [1][1])
bytes.push(...fieldToBytes(proof.pi_b[1][0])); // y_real (was index [1][0])
```

The `@p01/privacy-toolkit` package provides `proofToOnChainBytes()` which
handles this swap automatically.
