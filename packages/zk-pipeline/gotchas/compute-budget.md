# Gotcha: Solana Compute Budget for ZK Verification

**Time lost discovering this: ~2 hours**

## The Problem

Groth16 verification on Solana uses the `alt_bn128` precompile which costs
a significant number of compute units (CU). The default 200,000 CU limit
is not enough for most ZK proofs.

## Compute Budget Guide

| Public Inputs | Recommended CU | Why |
|--------------|----------------|-----|
| 1-3 | 200,000 | Default limit is sufficient |
| 4-5 | 500,000 | Each input adds ~50K CU for scalar mul + add |
| 6-8 | 700,000 | Getting close to single-tx limit |
| 9+ | 1,000,000+ | May need to split verification |

## The Fix

Add `ComputeBudgetInstruction` to your transaction:

```typescript
import { ComputeBudgetProgram } from '@solana/web3.js';

const tx = new Transaction();

// Set compute unit limit
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));

// Set compute unit price (for priority)
tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));

// Add your verification instruction
tx.add(verifyInstruction);
```

## Raw instruction format (if not using @solana/web3.js helpers)

```typescript
const COMPUTE_BUDGET_PROGRAM = new PublicKey('ComputeBudget111111111111111111111111111111');

// SetComputeUnitLimit (discriminator = 2)
const limitData = Buffer.alloc(5);
limitData.writeUInt8(2, 0);
limitData.writeUInt32LE(500_000, 1);

// SetComputeUnitPrice (discriminator = 3)
const priceData = Buffer.alloc(9);
priceData.writeUInt8(3, 0);
priceData.writeBigUInt64LE(1000n, 1);
```
