<div align="center">

# @protocol-01/privacy-toolkit

**Built by [Protocol 01](https://github.com/IsSlashy/Protocol-01) — The Privacy Layer for Solana**

[![License: PolyForm Strict 1.0.0](https://img.shields.io/badge/License-PolyForm%20Strict%201.0.0-blue.svg)](LICENSE)

</div>

TypeScript primitives for building privacy protocols on Solana. Merkle trees, Poseidon commitments, nullifiers, and proof format conversion.

> **Not the Styx pool hash.** Every hash in this package is Poseidon over the **BN254** scalar field, computed with [`poseidon-lite`](https://www.npmjs.com/package/poseidon-lite). The Styx pool uses Poseidon over the **Goldilocks** field (p = 2^64 - 2^32 + 1) in its STARK circuits, its on-chain verifier and the `zk_shielded` program. The two hashes give different values for the same input: the commitments, nullifiers, zero hashes and Merkle roots built here are 254-bit values that are **not compatible with the Styx pool**, and a note or a proof built from them cannot be used there. For the Goldilocks Poseidon of the pool, see [`stark/src/poseidon`](../../stark/src/poseidon) (Rust) and [`apps/mobile/services/zk/goldilocks-poseidon.ts`](../../apps/mobile/services/zk/goldilocks-poseidon.ts) (TypeScript port).
>
> **Groth16 helpers are legacy.** The `alt_bn128` proof-formatting helpers targeted the Circom + snarkjs pipeline, which the shipping stack no longer uses.

## What This Package Is

`@protocol-01/privacy-toolkit` is a set of BN254-Poseidon building blocks from the earlier Groth16 design of Protocol 01: note commitments, nullifier derivation, incremental Merkle tree helpers, and snarkjs proof format conversion. Inside this repository, the only other package that imports it is `@protocol-01/privacy-sdk`, and only for `randomFieldElement()`.

It can serve:
- A BN254 / Circom privacy design of your own -- commitments + nullifiers + Merkle proofs over BN254 Poseidon
- Any Groth16 application on Solana -- proof format conversion for the alt_bn128 precompile

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

Note commitments, nullifiers, and balance commitments using BN254 Poseidon (`poseidon-lite`).

They follow the note, nullifier, balance-commitment and key-derivation templates of the retired Circom circuits of Protocol 01; those `.circom` files are no longer in the repository. None of these values is accepted by the Styx pool (see the note at the top).

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

PolyForm Strict License 1.0.0 — see [LICENSE](LICENSE). The package is
source-available: anyone may read, build, run and verify it for noncommercial
purposes. Commercial use (including production deployment by a business),
changes or derivative works, and redistribution need a written license from
Volta Team ([styx.cash/licenses](https://styx.cash/licenses)).
PolyForm Strict is not an open-source license.

The versions already published to npm (1.0.0 to 1.0.4) were released under the
MIT License and remain MIT, as does every commit of this repository before the
one that replaced the MIT License with PolyForm Strict
([LICENSE-MIT-BEFORE-POLYFORM](../../LICENSE-MIT-BEFORE-POLYFORM)). Versions
published from 2026-09-22 on ship under PolyForm Strict 1.0.0.

---

## Part of the Protocol 01 Ecosystem

This library is extracted from [Protocol 01](https://github.com/IsSlashy/Protocol-01), the privacy layer for Solana. P01 uses denominated privacy pools with client-side STARK proving. Groth16 over BN254 was retired in April 2026 in favour of STARKs over the Goldilocks field: hash-based, no elliptic curves, no trusted setup.

The table below lists only packages that resolve on npm today.

| Library | Purpose |
|---------|---------|
| **@protocol-01/privacy-sdk** | Full privacy SDK: shield, stealth, streams, vault |
| **@protocol-01/stark-prover** | WASM STARK prover and on-chain verifier submitter |
| **@protocol-01/specter-sdk** | Stealth wallets, transfers, registry |
| **@protocol-01/privacy-toolkit** | BN254-Poseidon Merkle trees, commitments, Groth16 proof formatting (not the Styx pool hash) |

[Website](https://protocol-01.dev) · [Twitter](https://x.com/Styx_PQ) · [Discord](https://discord.gg/EfqnVmb2dV)
