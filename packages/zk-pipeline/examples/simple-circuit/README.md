# Simple Circuit Example — Hash Preimage

This example demonstrates the complete ZK pipeline:
**circuit → compile → setup → prove → verify → on-chain format**

## What It Proves

Knowledge of a secret `preimage` whose Poseidon hash equals a known public `hash`.

- **Private input**: `preimage` (the secret)
- **Public input**: `hash` (Poseidon(preimage))
- **Constraint**: `hash === Poseidon(preimage)`

## Run It Yourself

```bash
# 1. Compile the circuit (from packages/zk-pipeline/)
bash scripts/compile-circuit.sh examples/simple-circuit/circuit.circom examples/simple-circuit/build ../../node_modules

# 2. Trusted setup
bash scripts/trusted-setup.sh examples/simple-circuit/build/circuit

# 3. Export VK
bash scripts/export-vk.sh examples/simple-circuit/keys/circuit

# 4. Generate proof, verify off-chain, convert to on-chain format
node examples/simple-circuit/test-proof.mjs
```

Or from this directory:

```bash
bash ../../scripts/compile-circuit.sh circuit.circom build ../../../../node_modules
bash ../../scripts/trusted-setup.sh build/circuit
bash ../../scripts/export-vk.sh keys/circuit
node test-proof.mjs
```

## Expected Output

```
=== ZK Pipeline E2E Test ===

Input: preimage=12345, hash=42675337744882959008...

--- Step 1: Generate Groth16 proof ---
Proof generated in ~230ms
Public signals: [42675337744882959008...]

--- Step 2: Off-chain verification ---
Off-chain verification: PASS

--- Step 3: On-chain format conversion (@p01/privacy-toolkit) ---
Proof bytes length: 256 (expected: 256)
Input count: 1 (expected: 1 — the hash)
Each input length: 32 (expected: 32)

On-chain format: OK

=== Results ===
Circuit compiled:       YES (216 constraints)
Trusted setup:          YES
Proof generated:        YES (~230ms)
Off-chain verified:     YES
On-chain format ready:  YES (256 bytes proof)

All checks passed!
```

## Files

| File | Description |
|------|-------------|
| `circuit.circom` | Poseidon hash preimage circuit (216 constraints) |
| `input.json` | Example input with preimage=12345 |
| `test-proof.mjs` | Automated E2E test script |
| `build/` | Compiled circuit (wasm + r1cs) |
| `keys/` | Proving key + verification key |

## Next Steps

- For mobile proving: bundle `.wasm` and `.zkey` using `@p01/react-native-zk`
- For on-chain verification: convert the VK to binary and upload using `@p01/solana-verifier`
- For proof format conversion: use `@p01/privacy-toolkit`
