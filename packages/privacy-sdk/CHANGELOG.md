# Changelog — @protocol-01/privacy-sdk

## 1.0.6 — 2026-09-12

- Reads transactions with `maxSupportedTransactionVersion: 1`: the proof
  uploads of the current `@protocol-01/stark-prover` travel as transaction-v1
  envelopes (SIMD-0385), and a reader pinned to version 0 skips them.
- `modules/instantUnshield.ts` is marked LEGACY in its header: it carries its
  own copy of the pre-2026-09 upload protocol (PDA buffer, 1,000-byte chunks).
  No app calls it. Proof upload and verification belong to
  `@protocol-01/stark-prover`'s `uploadAndVerify`, which the host-supplied
  `generateStarkProof` should use — see that package's CHANGELOG 0.2.0 for the
  verifier this pairs with (devnet slot 497235406).

## 1.0.5

Published before this changelog existed.
