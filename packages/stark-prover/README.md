# @protocol-01/stark-prover

STARK proof generator and on-chain upload protocol for Protocol 01 / Styx.
Hash-based (Poseidon over the Goldilocks field, FRI), no trusted setup, no
elliptic curves in the proof. It is the prover of the Styx apps (web,
extension, mobile); privacy-sdk 2.0.0 and specter-sdk 0.5.0 no longer wire a
prover in.

**Pairing.** A proof only verifies on the program it was built for. This
version ships the blob that the devnet verifier deployed on 2026-09-12 accepts
(`deployed-verifier.json` records the deployment and the acceptance
transaction; `npm run check:deployed:onchain` re-reads the chain). See
`CHANGELOG.md` for what each version pairs with.

## Install

```bash
pnpm add @protocol-01/stark-prover @solana/web3.js
```

## Usage

```ts
import { Connection, Keypair } from '@solana/web3.js';
import { createStarkProver } from '@protocol-01/stark-prover';

const connection = new Connection(process.env.RPC_URL!, 'confirmed');
const payer = Keypair.fromSecretKey(/* ... */);

// 1. Spin up a prover bound to your connection + payer.
const prover = createStarkProver({
  connection,
  payer,
  onProgress: (step) => console.log('[STARK]', step),
});

// 2. Prove one circuit locally, upload the proof in chunks to
//    p01_stark_verifier and run the two-phase verify. The outcome names the
//    verified proof buffer PDA the consuming instruction reads.
const outcome = await prover.generateStarkProof(circuitId, privateInputs);
console.log(outcome.proofBuffer.toBase58(), outcome.circuitId);
```

## Circuit IDs

| ID | Name                  | Public inputs                                          | Wire (bytes) |
|----|-----------------------|--------------------------------------------------------|--------------|
| 0  | subscriber_ownership  | `[commitment]`                                         | 74,365 |
| 1  | pool_commitment       | `[nullifier, commitment]`                              | 94,897 |
| 3  | merkle_path           | `[leaf, root, depth]`                                  | 79,597 |
| 6  | merkle_update         | `[old_leaf, new_leaf, old_root, new_root, depth]`      | 82,477 |
| 7  | spend                 | `[nullifier, root, rh_0, rh_1, rh_2, rh_3]`            | 79,405 |

Every circuit draws a fresh blinding mask per proof (`draw_blinding_mask`,
OS CSPRNG), so two proofs of one witness are different bytes; the wire length
per circuit is what is pinned (`src/wireFormat.test.ts`). The deployed
verifier also accepts ids 2, 4 and 5; this package does not prove them and the
blob has no export for them (removed 2026-09-23). Circuit 7 is the
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
    ├── 1. initStarkWasm()          → wasm/p01_stark_bg.wasm (240,172 B)
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
            │     one transaction on C3/C6/C7, two on C1 (budget)
            └── close_proof_buffer   (rent back; skipped with `retainBuffer: true`)
```

Returns `StarkProofOutcome { proofBuffer, circuitId, publicInputs,
verifySignatures }`. With `retainBuffer: true` the verified buffer stays on
chain for the consuming instruction (`zk_shielded.shield_denominated_v3`,
`unshield_denominated_stark_v4`, `subscribe_private_stark_v4`, …) to read
cross-program; close it afterwards with `closeProofBuffer`.

Measured on Helius devnet on 2026-09-13, one run each, prove + upload +
verify + close from Node, with the blob shipped that day, `0ad6d7f1…`
(265,324 B; `docs/BENCHMARK-2026-09-13.md` §6/§6b): C7 8.0 s, C6 8.2 s,
C1 5.8 s, C3 5.3 s, C0 10.9 s. The legacy 1,000-byte PDA path measured
35–41 s for the same C7 proof. The blob this version ships, `241caaab…`
(240,172 B, reshipped 2026-09-23 after `d5583d41…` on 2026-09-20), has not
been re-measured end to end; these figures are not its own.

`scripts/live-timing.ts` reproduces these figures against the deployed
verifier for any circuit; `scripts/c7-live-proof.ts` submits one honest proof
and reads the verdict back off the chain.

## License

PolyForm Strict License 1.0.0 — see [LICENSE](LICENSE). The package is
source-available: anyone may read, build, run and verify it for noncommercial
purposes. Commercial use (including production deployment by a business),
changes or derivative works, and redistribution need a written license from
Volta Team ([styx.cash/licenses](https://styx.cash/licenses)).
PolyForm Strict is not an open-source license.

The four versions already published to npm (0.1.0 to 0.1.3) are available
under the MIT License, as is every commit of this repository before the one
that replaced the MIT License with PolyForm Strict
([LICENSE-MIT-BEFORE-POLYFORM](../../LICENSE-MIT-BEFORE-POLYFORM)). 0.1.2 and
0.1.3 were released under MIT; 0.1.0 and 0.1.1 were released pointing at the
root license, which was proprietary at the time, and the same MIT grant covers
them. Versions published from 2026-09-22 on ship under PolyForm Strict 1.0.0.

(The repository was MIT everywhere from 2026-08-04, and new work moved to
PolyForm Strict 1.0.0 on 2026-09-22.)

A soft license gate (`license.ts`) warns when no commercial license key is
given; it never blocks proving. Noncommercial research, audit, evaluation and
testing need no key. For a commercial license, see
[styx.cash/licenses](https://styx.cash/licenses) (the URL lives in
one exported constant, `COMMERCIAL_LICENSE_URL`).
