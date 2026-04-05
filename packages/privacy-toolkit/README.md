<div align="center">

# @protocol-01/privacy-toolkit

**Built by [Protocol 01](https://github.com/IsSlashy/Protocol-01) — The Privacy Layer for Solana**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

TypeScript primitives for building privacy protocols on Solana. Merkle trees, Poseidon commitments, nullifiers, and proof format conversion.

## Why This Package

`@protocol-01/privacy-toolkit` is the **foundation layer** of the Protocol 01 stack. It provides the core cryptographic building blocks that every higher-level SDK depends on: note commitments, nullifier derivation, Merkle tree operations, and proof format conversion.

If you are building:
- A privacy pool (shielded transactions) -- you need commitments + nullifiers + Merkle proofs
- Confidential balances (zkSPL) -- you need balance commitments + proof formatting
- Any ZK-SNARK application on Solana -- you need proof format conversion for the alt_bn128 precompile

This package has **zero Solana dependencies** -- it is pure TypeScript + Poseidon and works in Node.js, browsers, and React Native.

## Security Notes

These are **cryptographic primitives**. Incorrect usage can compromise privacy:

- **Never reuse secrets or nullifier preimages** across different notes. Use `generateSecret()` and `generateNullifierPreimage()` for each new note.
- **Never expose nullifier preimages** before spending. The nullifier preimage is the spending authority for a note.
- **BN254 field constraint**: All field elements must be less than the BN254 scalar field modulus (`21888242871839275222246405745257275088548364400416034343698204186575808495617`). Values outside this range will produce incorrect results that may break proof verification.
- The `randomFieldElement()` function uses rejection sampling from `crypto.getRandomValues` (CSPRNG). There is no insecure fallback.

## Install

```bash
npm install @protocol-01/privacy-toolkit
```

## Modules

### Merkle Trees

Incremental Merkle tree utilities optimized for on-chain state. The key innovation is `computeRootAndProofFromSubtrees`, which reads the minimal `filledSubtrees` array from an on-chain account and computes both the new root and Merkle proof in a single pass -- no local tree synchronization needed.

```typescript
import {
  computeZeroHashes,
  getZeroHashes,
  computeRootAndProofFromSubtrees,
  computeRootFromSubtrees,
} from '@protocol-01/privacy-toolkit';

// Compute zero hashes for a depth-15 tree
const zeros = computeZeroHashes(15);

// Insert a leaf using on-chain filledSubtrees
const { newRoot, updatedSubtrees, pathElements, pathIndices } =
  computeRootAndProofFromSubtrees(leaf, leafIndex, filledSubtrees, 15);
```

### Poseidon Commitments

Note commitments, nullifiers, and balance commitments using Poseidon hash.

These primitives map directly to the circom circuit templates:
- `createCommitment` -> `circuits/transfer.circom` (NoteCommitment template)
- `computeNullifier` -> `circuits/transfer.circom` (NullifierDerivation template)
- `createBalanceCommitment` -> `circuits/confidential_balance.circom` (BalanceCommitment template)
- `deriveOwnerPubkey` -> `circuits/poseidon.circom` (SpendingKeyDerivation template)

```typescript
import {
  createCommitment,
  computeNullifier,
  createBalanceCommitment,
  deriveOwnerPubkey,
} from '@protocol-01/privacy-toolkit';

// 4-input note commitment
const commitment = createCommitment(nullifierPreimage, secret, epoch, tokenId);

// Nullifier for double-spend prevention
const nullifier = computeNullifier(nullifierPreimage, secret);

// Account-model balance commitment (with nonce binding)
const balanceCommitment = createBalanceCommitment(balance, salt, nonce, owner, mint);
```

### Amount Hashes

Link sender and recipient proofs without revealing amounts.

```typescript
import { createAmountHash, zeroAmountHash } from '@protocol-01/privacy-toolkit';

// Shared between sender and recipient
const hash = createAmountHash(amount, salt);

// For deposit/withdraw (no private transfer)
const zero = zeroAmountHash();
```

### Proof Format Conversion

Convert snarkjs Groth16 proofs to the 256-byte format expected by Solana's alt_bn128 pairing precompile.

```typescript
import {
  proofToOnChainBytes,
  publicInputsToLE,
  publicInputsToBE,
} from '@protocol-01/privacy-toolkit';

// Convert snarkjs proof to on-chain format (handles G2 real/imaginary swap)
const proofBytes = proofToOnChainBytes(snarkjsProof);

// Convert public inputs to little-endian for on-chain storage
const inputsLE = publicInputsToLE(publicSignals);
```

### Utilities

BigInt conversion helpers and cryptographic random field element generation.

```typescript
import {
  bigintToLeBytes32,
  bigintToBeBytes32,
  hexToBigint,
  bigintToHex,
  leBytesToBigint,
  beBytesToBigint,
  randomFieldElement,
  generateSecret,
  generateNullifierPreimage,
} from '@protocol-01/privacy-toolkit';
```

## API Reference

### Merkle

| Function | Description |
|---|---|
| `computeZeroHashes(depth, zeroValue?)` | Compute zero hashes for a tree of given depth |
| `getZeroHashes(depth?, zeroValue?)` | Cached version of computeZeroHashes |
| `computeRootAndProofFromSubtrees(leaf, leafIndex, filledSubtrees, depth?, zeroValue?)` | Compute new root + Merkle proof from on-chain subtrees |
| `computeRootFromSubtrees(filledSubtrees, nextLeafIndex, depth?, zeroValue?)` | Compute root only (no proof) |

### Commitment

| Function | Description |
|---|---|
| `createCommitment(nullifierPreimage, secret, epoch, tokenIdentifier)` | 4-input Poseidon note commitment |
| `computeNullifier(nullifierPreimage, secret)` | 2-input Poseidon nullifier |
| `createBalanceCommitment(balance, salt, nonce, ownerPubkey, tokenMint)` | Account-model balance commitment with nonce binding |
| `deriveOwnerPubkey(spendingKey)` | Derive owner pubkey from spending key |
| `createAmountHash(amount, salt)` | Amount commitment linking sender/recipient |
| `zeroAmountHash()` | Zero amount hash for deposits/withdrawals |

### Proof

| Function | Description |
|---|---|
| `proofToOnChainBytes(proof)` | Convert snarkjs proof to 256-byte on-chain format |
| `publicInputsToLE(inputs)` | Convert public inputs to LE byte arrays |
| `publicInputsToBE(inputs)` | Convert public inputs to BE byte arrays |

### Utils

| Function | Description |
|---|---|
| `bigintToLeBytes32(n)` | BigInt to 32-byte LE array |
| `bigintToBeBytes32(n)` | BigInt to 32-byte BE Uint8Array |
| `hexToBigint(hex)` | Hex string to BigInt |
| `bigintToHex(n)` | BigInt to 64-char hex string |
| `leBytesToBigint(bytes)` | LE Uint8Array to BigInt |
| `beBytesToBigint(bytes)` | BE Uint8Array to BigInt |
| `randomFieldElement()` | Crypto-random BN254 field element |
| `generateSecret()` | Random secret for commitments |
| `generateNullifierPreimage()` | Random nullifier preimage |

## Input Validation

All public commitment and proof functions validate their inputs at runtime and throw `TypeError` with a descriptive message if validation fails. For example:

```typescript
createCommitment(123 as any, 0n, 0n, 0n);
// TypeError: createCommitment: nullifierPreimage must be a bigint, got number

proofToOnChainBytes(null as any);
// TypeError: proofToOnChainBytes: proof must be a SnarkjsProof object with pi_a, pi_b, and pi_c fields

publicInputsToLE([]);
// TypeError: publicInputsToLE: inputs must be a non-empty array of numeric strings
```

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT

---

## Part of the Protocol 01 Ecosystem

This library is extracted from [Protocol 01](https://github.com/IsSlashy/Protocol-01), the privacy layer for Solana. P01 uses denominated privacy pools with client-side Groth16 proving to provide complete unlinkability on Solana.

| Library | Purpose |
|---------|---------|
| **@protocol-01/privacy-sdk** | Full privacy SDK (shield, stealth, streams, vault, MPC) |
| **@protocol-01/react-native-zk** | Client-side ZK proving on mobile |
| **@protocol-01/solana-verifier** | On-chain Groth16 verification |
| **@protocol-01/privacy-toolkit** | Merkle trees, commitments, proof formatting |
| **@protocol-01/zk-pipeline** | End-to-end guide: circuit -> mobile -> on-chain |

[Website](https://protocol-01.vercel.app) · [Twitter](https://twitter.com/Protocol01_) · [Discord](https://discord.gg/KfmhPFAHNH)
