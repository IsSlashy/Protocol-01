<div align="center">

# @p01/zk-pipeline

**Built by [Protocol 01](https://github.com/IsSlashy/Protocol-01) — The Privacy Layer for Solana**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

# ZK Mobile Pipeline

The complete end-to-end guide for building zero-knowledge proof applications on mobile (React Native / Expo) with on-chain verification on Solana. This package documents every step of the pipeline -- from writing a circom circuit to verifying a Groth16 proof on-chain -- along with the hard-won gotchas discovered during production development.

This is not a theoretical guide. Every script has been used in production. Every gotcha cost real debugging hours. The goal is to save you the weeks of trial-and-error that ZK mobile development currently requires.

## The Pipeline

```
  +-------------------+     +------------------+     +-------------------+
  | 1. Write Circuit  | --> | 2. Compile       | --> | 3. Trusted Setup  |
  |    (circom)       |     |    (circom CLI)   |     |    (snarkjs)      |
  +-------------------+     +------------------+     +-------------------+
                                                              |
                                                              v
  +-------------------+     +------------------+     +-------------------+
  | 6. Generate Proof | <-- | 5. Load in App   | <-- | 4. Bundle Assets  |
  |    (snarkjs)      |     |    (Expo/RN)     |     |    (.wasm, .zkey) |
  +-------------------+     +------------------+     +-------------------+
          |
          v
  +-------------------+     +------------------+
  | 7. Submit to      | --> | 8. On-Chain       |
  |    Solana         |     |    Verification   |
  +-------------------+     +------------------+
```

## Step-by-Step Guide

### Step 1: Write Your Circuit

Write a circom circuit that encodes your proof logic. Circuits define the relationship between public inputs (visible on-chain) and private inputs (known only to the prover).

```circom
pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";

template MyCircuit() {
    signal input private_value;       // private
    signal input public_commitment;   // public

    component hasher = Poseidon(1);
    hasher.inputs[0] <== private_value;

    // Constrain: commitment == hash(private_value)
    public_commitment === hasher.out;
}

component main {public [public_commitment]} = MyCircuit();
```

See `examples/simple-circuit/` for a complete working example.

**Key considerations:**
- Minimize constraints -- each constraint costs proving time on mobile
- Use circomlib components (Poseidon, MerkleTree, etc.) rather than rolling your own
- Keep public inputs minimal -- each one adds ~50K compute units on Solana

### Step 2: Compile the Circuit

Use the provided script to compile your circuit to WASM (for witness generation) and R1CS (for setup):

```bash
./scripts/compile-circuit.sh my_circuit.circom
```

This produces:
- `build/my_circuit_js/my_circuit.wasm` -- WASM witness generator
- `build/my_circuit.r1cs` -- Rank-1 constraint system

**Prerequisites:** circom >= 2.1.0 installed and on your PATH.

### Step 3: Trusted Setup

Generate the proving key (zkey) and verification key (vk):

```bash
# Development (generates a local PTAU -- NOT for production)
./scripts/trusted-setup.sh my_circuit

# Production (use a community ceremony PTAU file)
./scripts/trusted-setup.sh my_circuit path/to/hermez-raw-20.ptau
```

This produces:
- `keys/my_circuit_final.zkey` -- Proving key (used by the prover)
- `keys/my_circuit_vk.json` -- Verification key (uploaded on-chain)

**For production:** Use a Powers of Tau file from a community ceremony (e.g., Hermez or Zcash). The development PTAU is a single-party setup and is NOT secure for production use.

### Step 4: Bundle Assets for Mobile

Copy the WASM and zkey files into your Expo app's assets directory:

```bash
./scripts/bundle-expo.sh my_circuit apps/mobile/assets/circuits/
```

Configure Metro to handle these file types in `metro.config.js`:

```javascript
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('wasm', 'zkey');

module.exports = config;
```

**File sizes matter:** A typical zkey is 5-50 MB. Consider hosting large files on a CDN and downloading them at runtime instead of bundling in the APK.

### Step 5: Load Circuit in the App

Use `@p01/react-native-zk` to load the circuit files in your React Native app:

```typescript
import { SnarkjsProver } from '@p01/react-native-zk';

const prover = new SnarkjsProver();

// Load circuit (handles both Expo Asset and APK injection loading)
await prover.loadCircuit({
  wasmPath: 'my_circuit.wasm',
  zkeyPath: 'my_circuit_final.zkey',
});
```

The `@p01/react-native-zk` package runs snarkjs inside a hidden WebView, avoiding native module dependencies. It handles the Expo asset naming gotcha (see `gotchas/expo-asset-naming.md`) automatically.

### Step 6: Generate a Proof

Generate a Groth16 proof with your private inputs:

```typescript
const { proof, publicSignals } = await prover.prove({
  private_value: "42",
  public_commitment: commitmentHash,
});
```

**Performance expectations:**
- Simple circuits (<1000 constraints): ~500ms on modern phones
- Medium circuits (1000-5000 constraints): ~1-3s
- Large circuits (5000-20000 constraints): ~3-10s

For faster proving, consider using a Rust-based prover service (see `gotchas/circom-reduction.md` for ark-circom setup).

### Step 7: Submit to Solana

Convert the snarkjs proof format to the on-chain format and submit:

```typescript
import { proofToOnChainBytes, publicInputsToLE } from '@p01/privacy-toolkit';
import { ComputeBudgetProgram, Transaction } from '@solana/web3.js';

// Convert proof format (handles G2 point swap -- see gotchas/g2-point-format.md)
const proofBytes = proofToOnChainBytes(proof);

// Convert public inputs to little-endian (see gotchas/endianness.md)
const inputBytes = publicInputsToLE(publicSignals);

// Build transaction with sufficient compute budget
const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));
tx.add(verifyInstruction);

await sendAndConfirmTransaction(connection, tx, [payer]);
```

### Step 8: On-Chain Verification

Your Solana program uses `p01-solana-verifier` to verify the proof via the `alt_bn128` precompile:

```rust
use p01_solana_verifier::{verify_proof, Groth16Proof};

let proof = Groth16Proof::from_bytes(&proof_bytes)?;
let valid = verify_proof(&vk_data, &proof, &public_inputs)?;
require!(valid, MyError::InvalidProof);
```

The verification key must be uploaded to a Solana account beforehand. See `examples/solana-verifier/` for the complete pattern.

## Fast Development Cycle (APK Injection)

Full native rebuilds via EAS take 30+ minutes. For ZK circuit development, use APK injection to reduce the cycle to 2-3 minutes:

```bash
# 1. Export the JS bundle
npx expo export --platform android

# 2. Inject into existing APK (also injects circuit files)
python scripts/inject-apk.py \
  --apk base.apk \
  --dist dist/ \
  --circuit-dir assets/circuits/ \
  --output patched.apk

# 3. Sign and install
zipalign -f -v 4 patched.apk aligned.apk
apksigner sign --ks ~/.android/debug.keystore aligned.apk
adb install -r aligned.apk
```

## Related Packages

| Package | Purpose |
|---------|---------|
| [@p01/react-native-zk](../react-native-zk/) | Run snarkjs in React Native via hidden WebView |
| [@p01/solana-verifier](../solana-verifier/) | On-chain Groth16 verification using alt_bn128 precompile |
| [@p01/privacy-toolkit](../privacy-toolkit/) | Proof format conversion, public input encoding, utilities |

## Gotcha Index

These are real bugs discovered during production development. Each one links to a detailed writeup with the problem, symptoms, root cause, and fix.

| Gotcha | Time Lost | Category | File |
|--------|-----------|----------|------|
| [LE/BE Endianness Mismatch](gotchas/endianness.md) | ~8 hours | Solana | `gotchas/endianness.md` |
| [CircomReduction vs LibsnarkReduction](gotchas/circom-reduction.md) | ~6 hours | Rust / ark-circom | `gotchas/circom-reduction.md` |
| [G2 Point Format (snarkjs vs EIP-197)](gotchas/g2-point-format.md) | ~4 hours | Proof format | `gotchas/g2-point-format.md` |
| [__rust_probestack Linker Error](gotchas/rust-probestack.md) | ~4 hours | Rust / Linux | `gotchas/rust-probestack.md` |
| [Expo Asset Hash-Based Naming](gotchas/expo-asset-naming.md) | ~3 hours | React Native | `gotchas/expo-asset-naming.md` |
| [Solana Compute Budget](gotchas/compute-budget.md) | ~2 hours | Solana | `gotchas/compute-budget.md` |
| **Total** | **~27 hours** | | |

*Every gotcha in this guide is a real bug discovered during production development.*

## Examples

- [`examples/simple-circuit/`](examples/simple-circuit/) -- Minimal Poseidon hash preimage circuit with step-by-step instructions
- [`examples/solana-verifier/`](examples/solana-verifier/) -- Minimal Solana program structure for on-chain Groth16 verification

## Scripts Reference

| Script | Purpose |
|--------|---------|
| `scripts/compile-circuit.sh` | Compile a circom circuit to WASM + R1CS |
| `scripts/trusted-setup.sh` | Run Powers of Tau + Phase 2 setup |
| `scripts/export-vk.sh` | Export verification key in JSON and binary formats |
| `scripts/bundle-expo.sh` | Copy circuit assets to an Expo app |
| `scripts/inject-apk.py` | Inject JS bundle and circuit files into an APK |

## Prerequisites

- **circom** >= 2.1.0 -- Circuit compiler ([install guide](https://docs.circom.io/getting-started/installation/))
- **snarkjs** >= 0.7.0 -- Trusted setup and proof generation (`npm install -g snarkjs`)
- **Node.js** >= 18 -- For snarkjs and build scripts
- **Rust** >= 1.70 -- For Solana programs and optional Rust prover
- **Anchor** >= 0.29 -- For Solana program framework
- **Android SDK** -- For APK injection (zipalign, apksigner, adb)

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
