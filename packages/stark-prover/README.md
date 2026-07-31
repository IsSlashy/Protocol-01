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

Do **not** add `--features test-probes`. That feature compiles the fails-closed
forgery knobs in `stark/src/compact.rs` (`OodForgery::Coordinated`, the
`ood_quotient` re-solve, `TerminalPoly::AliasedFold`, `TraceLeaf::LegacyRowLeaf`,
the non-canonical `PairIndexing` variants) into the artifact. It is off in
`default`, and `cargo test` turns it on by itself through
`programs/p01_stark_verifier`'s dev-dependency, so nothing you build by hand
needs it.

The wire format is agreed with the on-chain verifier and nothing on the wire
declares which version produced a proof, so a stale blob here means every proof
this package generates is rejected. Four gates cover it:

- `stark-wasm-twins.mjs --check` — the five artifacts carry the same bytes
  (partial reship).
- `src/wireFormat.test.ts` — all seven circuits' serialized proof LENGTH matches
  the Rust prover's literals, and all seven sha256 CONTENT digests match the
  Rust prover (stale reship). The digests are the half that catches B1-class
  skew, which is length-preserving by construction. MEASURED: restoring the
  pre-B1 blob leaves every length assertion green and turns all seven digests
  red.
- `src/wasmProbeScan.test.ts` — no probe identifier survives in the blob or in
  any twin (probe leak). MEASURED: the pre-gate 219,219-byte blob carried
  `OodForgery`, `Coordinated`, `AliasedFold`, `LegacyRowLeaf`, `forgery column `
  and `ood_quotient solve`; the gated 211,370-byte blob carries none of them.
  Those six are the whole list. Four others were banned until 2026-07-30 and
  were dropped, because a blob built with `--features wasm,test-probes` — the
  regression itself — still scored zero on all four. A banned string that cannot
  fire is decoration. The residual gap is written up in the file's header: the
  `PairIndexing` probe family carries no string literals at all and is covered
  only by sharing one cargo feature with the probes that do.
- `scripts/deployed-verifier-check.mjs` — the blob matches the verifier that is
  actually DEPLOYED (deployment skew). The three gates above all compare the blob
  to *this tree* and are green whenever the tree agrees with itself; this one is
  the only thing that reads the chain.

### The deployment interlock

`deployed-verifier.json` records what is deployed: program id, cluster,
programdata address, last deployed slot, the sha256 of the deployed ELF, and the
proof-format generation derived from that ELF's own bytes. Regenerate it with
`node scripts/deployed-verifier-check.mjs --measure`, which prints the block
straight off the programdata account.

```bash
node packages/stark-prover/scripts/deployed-verifier-check.mjs                  # offline, blocking
node packages/stark-prover/scripts/deployed-verifier-check.mjs --verify-onchain # + prove the record against the cluster
node packages/stark-prover/scripts/deployed-verifier-check.mjs --measure        # print a fresh `deployed` block
```

`--cluster <devnet|mainnet-beta>` names which deployment a run is about. It
defaults to devnet and it belongs to the **caller**, never to the record: the
label picks the endpoint out of a table in the script and the program id out of
`Anchor.toml`, and the record's own `cluster` and `program_id` are cross-checked
against that choice, with either disagreeing a hard failure.

It is **not** a CI-only gate. It runs in `apps/web` build, `apps/extension`
build, `apps/mobile` `eas-build-post-install`, and the `prepublishOnly` of both
this package and `@protocol-01/react-native-zk`. All seven call sites pass
`--verify-onchain --cluster devnet`.

**How each side's generation is decided.** The client blob's is MEASURED by
running it: `scripts/prover-behaviour.mjs` generates one proof per shipping
circuit on seven fixed witnesses and sha256s each, and all seven digests must
match one column of its fixture table. B1 is length-preserving on every circuit
— MEASURED 2026-07-31, the B1 blob and the last pre-B1 blob emit the same seven
byte counts — so content is the only discriminator there is. Anything else, a
mixture included, refuses to classify and fails. Until 2026-07-31 this was a scan
for panic-message literals, and it was cheated four rounds running: four bytes of
panic text in the blob plus three renames in `stark/src/compact.rs` and one
`msg!` line in the verifier crate printed the full `PASS` at exit 0 against a
genuinely pre-B1 devnet. The same cheat now exits 1. That is ~5 s per run, and
there is no cache, because a cache is a place to keep a verdict nobody measured.

The **deployed** side is still a scan of the on-chain ELF for `msg!` literals —
nothing in a build script can execute a BPF program. `KNOWN_ELF_GENERATIONS`
bounds that by pinning the sha256 of both live devnet deployments with the
generation each was measured to be by hand, so a marker table reworded to make a
pinned pre-B1 ELF read as B1 contradicts the pin and fails, offline as well as on
chain. What is left is an edit to the guardrail itself, which is louder than a
rename in a refactor but not impossible.

**It is RED today and that is correct.** MEASURED 2026-07-31: `wasm/` holds the
B1 prover (`11e6f004…`, 211,370 B, 7/7 circuits emitting the B1 proof digest) and devnet
`EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z` still runs pre-B1 bytes
(`c359ab53…`, 780,249 B, deployed at slot 456,289,287; B1's degree-bound `msg!`
literal absent while five sibling `msg!` literals from the same source file are
present). Every proof a client built from this tree generates would be rejected
on chain with `FriFoldCheckFailed` — at the end of a full chunked upload, not at
parse time.

The only legitimate way to make it green is to deploy the program and then
re-measure the record. Editing the record instead turns the *offline* half green
and changes nothing on chain, which is what `--verify-onchain` is for: it
refetches the programdata account and re-derives the generation from the deployed
bytes, so a record that claims a generation the chain does not have is rejected.

An unreachable cluster is a **hard failure** whenever nothing else was going to
fail the run. It used to be reported as SKIPPED so a network flake could not
block a merge, and that made the whole leg optional at the record's discretion:
the record supplied the RPC endpoint, so MEASURED, editing three fields
(`proof_format_generation` to `b1`, `accepts_client_blob_sha256` to the blob's
own hash, `rpc_url` to `https://api.devnet.solana.invalid`) made
`--verify-onchain` print `on-chain SKIPPED` and then `PASS`, exit code 0, with
the chain never contacted. The endpoint is now pinned in the script and keyed by
a cluster label, the program id comes from `Anchor.toml`, a record carrying an
`rpc_url` is rejected, and the chain read is retried three times before the run
is called red.

Removing `rpc_url` was not enough on its own, because the *label* was still the
record's to write and `localnet` was one of the labels. MEASURED 2026-07-30
against that revision: setting `cluster` to `localnet`, `program_id` to the id
`Anchor.toml [programs.localnet]` genuinely carries, `proof_format_generation` to
`b1` and `accepts_client_blob_sha256` to the blob's own hash, then answering
`getAccountInfo` on `127.0.0.1:8899` with 149 fabricated bytes carrying the two
B1 marker literals and the four controls, printed `PASS — the shipped prover
matches the deployment, and the chain was asked and agreed`, exit code 0. Killing
the listener and rerunning the same record exited 1, so the pass came entirely
from the listener. The forgery was not even necessary — `solana-test-validator`
plus `anchor deploy` of the current verifier answers all of those checks honestly
— but that variant was not run, because the forged one already shows the gate
believed whatever answered `127.0.0.1:8899`. CI was safe only by accident, since
nothing listens on 8899 on a fresh runner; the other six call sites are developer
and release machines.

So the cluster now comes from `--cluster`, `localnet` is **refused** by any run
that could be a shipping verdict, and a record naming a different cluster than
the caller fails the run. Local development keeps a way in that no build can take
by accident: `P01_ALLOW_LOCAL_VERIFIER_GATE=1` in the environment plus an
explicit `--cluster localnet`. That path never prints the word PASS, prints `THIS
IS NOT A SHIPPING VERDICT` instead, and is refused outright when `CI`,
`GITHUB_ACTIONS`, `VERCEL` or `EAS_BUILD` is set. Nothing in this repo sets the
variable.

One field in the record is believed rather than verified:
`accepts_client_blob_sha256`. Nothing on chain records which client blob a
deployment accepts, so no script can check it — it is a human attestation.

Reverting the blob to the older generation instead is caught by
`src/wireFormat.test.ts`, which then goes red on all seven digests (MEASURED:
9 failed / 3 passed), and by `src/wasmProbeScan.test.ts` (MEASURED: 2 failed /
9 passed, on its positive control and on `LegacyRowLeaf`).

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
