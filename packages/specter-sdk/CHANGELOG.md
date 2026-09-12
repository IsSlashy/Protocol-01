# Changelog — @protocol-01/specter-sdk

## 0.4.4 — 2026-09-12

- Rebuilt against `@protocol-01/stark-prover` 0.2.0, which `src/proving`
  inlines at build time: keypair proof buffers created in one transaction,
  transaction-v1 chunks (3,840 bytes, 21 transactions for a circuit-7 proof),
  merged verification phases where the budget allows, and the prover blob
  `0ad6d7f1…` that the verifier deployed on devnet on 2026-09-12 accepts.
- `wasm/` (published, gitignored) carries that same blob;
  `packages/stark-prover/scripts/stark-wasm-twins.mjs --check` passes over it.

## 0.4.3

Published before this changelog existed; carries the previous blob
(`36c1fd4e…`), which the current devnet verifier rejects.
