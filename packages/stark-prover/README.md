# @protocol-01/stark-prover

STARK proof generator and on-chain upload protocol for Protocol 01 / Styx.
Hash-based (Poseidon over the Goldilocks field, FRI), no trusted setup, no
elliptic curves in the proof. Drop-in prover for `@protocol-01/privacy-sdk`,
`@protocol-01/specter-sdk` and the Styx apps.

**Pairing.** A proof only verifies on the program it was built for. This
version ships the blob that the devnet verifier deployed on 2026-09-12 accepts
(`deployed-verifier.json` records the deployment and the acceptance
transaction; `npm run check:deployed:onchain` re-reads the chain). See
`CHANGELOG.md` for what each version pairs with.

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

| ID | Name                  | Public inputs                                          | Wire (bytes) |
|----|-----------------------|--------------------------------------------------------|--------------|
| 0  | subscriber_ownership  | `[commitment]`                                         | 74,365 |
| 1  | pool_commitment       | `[nullifier, commitment]`                              | 94,897 |
| 2  | balance_proof         | `[commitment, token_mint]`                             | 95,777 |
| 3  | merkle_path           | `[leaf, root, depth]`                                  | 79,597 |
| 4  | confidential_balance  | `[old_commitment, new_commitment, amount_hash, mint]`  | 75,085 |
| 5  | transfer              | `[null_1, null_2, out_1, out_2, public_amount, mint]`  | 91,261 |
| 6  | merkle_update         | `[old_leaf, new_leaf, old_root, new_root, depth]`      | 82,477 |
| 7  | spend                 | `[nullifier, root, rh_0, rh_1, rh_2, rh_3]`            | 79,405 |

Every circuit draws a fresh blinding mask per proof (`draw_blinding_mask`,
OS CSPRNG), so two proofs of one witness are different bytes; the wire length
per circuit is what is pinned (`src/wireFormat.test.ts`). Circuit 7 is the
one the v4 withdrawal and the v4 subscription spend on: it publishes the
nullifier, the root and the recipient hash, never the note commitment.

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
    ├── 1. initStarkWasm()          → wasm/p01_stark_bg.wasm (265,324 B)
    ├── 2. generateProofBytes()     → JSON parse, hex decode
    └── 3. uploadAndVerify()        → Solana RPC
            ├── createAccount + init_proof_buffer_v3   (one transaction; a keypair
            │     buffer derived from authority + circuit + attempt, sized to the proof;
            │     a buffer left by a failed attempt is re-armed with reset_proof_buffer)
            ├── write_proof_chunk × N
            │     transaction v1 (4,096-byte envelopes, SIMD-0385): 3,840-byte chunks,
            │     21 transactions for a circuit-7 proof, sent in paced waves;
            │     1,000-byte legacy chunks where the gate is not active (`txV1: false`)
            ├── verify_stark_proof_v2 + verify_deep_ali_phase2
            │     one transaction on C3/C4/C6/C7, two on C1/C2/C5 (budget)
            └── close_proof_buffer   (rent back; skipped with `retainBuffer: true`)
```

Returns `StarkProofOutcome { proofBuffer, circuitId, publicInputs,
verifySignatures }`. With `retainBuffer: true` the verified buffer stays on
chain for the consuming instruction (`zk_shielded.shield_denominated_v3`,
`unshield_denominated_stark_v4`, `subscribe_private_stark_v4`, …) to read
cross-program; close it afterwards with `closeProofBuffer`.

Measured on Helius devnet, one run each, prove + upload + verify + close from
Node (`docs/BENCHMARK-2026-09-13.md` §6/§6b): C7 8.0 s, C6 8.2 s, C1 5.8 s,
C2 5.5 s, C3 5.3 s, C4 8.1 s, C0 10.9 s, C5 15.9 s. The legacy 1,000-byte PDA
path measured 35–41 s for the same C7 proof.

`scripts/live-timing.ts` reproduces these figures against the deployed
verifier for any circuit; `scripts/c7-live-proof.ts` submits one honest proof
and reads the verdict back off the chain.

## License

MIT — see the [LICENSE](../../LICENSE) file at the repository root. (Earlier manifests pointed at a proprietary root license; the repository is MIT everywhere as of 2026-08-04.)

A soft license gate (`license.ts`) is included for production use. Development, evaluation, testing and hackathon use require no license key. For commercial production deployments, contact contact@protocol01.com.
