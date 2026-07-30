# @protocol-01/stark-prover

Quantum-resistant STARK proof generator for Protocol 01. Drop-in prover for `@protocol-01/privacy-sdk`. No trusted setup, no elliptic curves.

## Install

```bash
pnpm add @protocol-01/stark-prover @protocol-01/privacy-sdk @solana/web3.js
```

## Usage

```ts
import { Connection, Keypair } from '@solana/web3.js';
import { Privacy } from '@protocol-01/privacy-sdk';
import { createStarkProver } from '@protocol-01/stark-prover';

const connection = new Connection(process.env.RPC_URL!, 'confirmed');
const payer = Keypair.fromSecretKey(/* ... */);

// 1. Spin up a prover bound to your connection + payer.
const prover = createStarkProver({
  connection,
  payer,
  onProgress: (step) => console.log('[STARK]', step),
});

// 2. Wire it into the privacy-sdk.
const sdk = new Privacy({ connection, wallet: payer });
sdk.setProverConfig({
  generateStarkProof: prover.generateStarkProof,
});

// 3. All shield/transfer/unshield operations on the variable-amount pool now
//    use STARK proofs end-to-end. No snarkjs anywhere.
await sdk.shield({ amount: 1_000_000n, mint: USDC_MINT });
```

## Circuit IDs

| ID | Name                  | Public inputs                                         |
|----|-----------------------|--------------------------------------------------------|
| 0  | subscriber_ownership  | `[commitment]`                                         |
| 1  | pool_commitment       | `[nullifier, commitment]`                              |
| 2  | balance_proof         | `[commitment, token_mint]`                             |
| 3  | merkle_path           | `[leaf, root]`                                         |
| 4  | confidential_balance  | `[old_commitment, new_commitment, amount_hash, mint]`  |
| 5  | transfer              | `[null_1, null_2, out_1, out_2, public_amount, mint]`  |
| 6  | merkle_update         | `[old_leaf, new_leaf, old_root, new_root, depth]`*     |

\* Circuit 6 **is** exported by the bundled WASM. This note used to say it was
not; MEASURED against `wasm/p01_stark_bg.wasm`, `generate_merkle_update_stark_proof`
is present and `src/wireFormat.test.ts` drives it. The export surface is 14
functions and has not changed across the Route C reship.

Rebuilding the WASM (the `-- --features wasm` is **mandatory** — `mod wasm_api`
is cfg-gated and without it the blob exports zero proof functions):

```bash
wasm-pack build stark --target web --out-dir wasm-out -- --features wasm
cp stark/wasm-out/p01_stark_bg.wasm stark/wasm-out/p01_stark.js packages/stark-prover/wasm/
node packages/stark-prover/scripts/stark-wasm-twins.mjs --write   # the four inlined base64 twins
```

The wire format is agreed with the on-chain verifier and nothing on the wire
declares which version produced a proof, so a stale blob here means every proof
this package generates is rejected. Two CI gates cover it: `--check` above
(partial reship) and `src/wireFormat.test.ts`, which pins all seven circuits'
serialized proof length (stale reship).

## Runtime support

| Runtime              | Status     | Notes |
|----------------------|------------|-------|
| Node 22+             | First-class | Loads `wasm/p01_stark_bg.wasm` via `import.meta.url`. |
| Modern browsers       | First-class | Same path; bundlers should copy `wasm/` to the output. |
| Browser extensions    | Supported  | Pass `WasmSource.base64` (MV3 disallows `wasm-eval`). |
| React Native (WebView) | Supported | Pass the WASM base64 to the WebView and proxy the bindings. |
| React Native (native)  | Unsupported | No WebAssembly engine in Hermes. Use the WebView fallback. |

## Architecture

```
generateStarkProof(circuitId, privateInputs)
    │
    ├── 1. initStarkWasm()          → wasm/p01_stark_bg.wasm
    ├── 2. generateProofBytes()     → JSON parse, hex decode
    └── 3. uploadAndVerify()        → Solana RPC
            ├── init_proof_buffer
            ├── resize × N (10 KB each)
            ├── write_proof_chunk × N (1000 B each)
            ├── verify_stark_proof_v2  (Phase 1: FRI + boundary)
            └── verify_deep_ali_phase2 (Phase 2: DEEP-ALI at OOD)
```

Returns `StarkProofOutcome { proofBuffer, circuitId, publicInputs }` —
the proof buffer PDA is retained on-chain so the consuming instruction
(`zk_shielded.shield_stark`, `transfer_stark`, etc.) can read it
cross-program.

## License

This package is released under the same terms as the Protocol 01 monorepo. See the [LICENSE](../../LICENSE) file at the repository root.

A soft license gate (`license.ts`) is included for production use. Development, evaluation, testing and hackathon use require no license key. For commercial production deployments, contact contact@protocol01.com.
