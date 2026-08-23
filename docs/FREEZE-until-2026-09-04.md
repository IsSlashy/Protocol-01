# THAWED 2026-08-24 — this freeze is lifted

This file was a freeze written 2026-08-16. It is no longer in force. It is kept
under its old name so existing links resolve, and because its measurements and
warnings are still true and still useful; only its *conclusion* changed.

## Why it is lifted

Two things the freeze rested on are no longer the case.

1. **The 4 September demo is pre-recorded, and the 4th is a deck presentation.**
   The founder confirmed this on 2026-08-24. The freeze existed to protect a
   LIVE run whose prover and verifier had to agree on the day. There is no live
   run, so that risk is gone.

2. **The prover WASM IS reproducible.** The freeze's central claim was "no
   shipped blob is reproducible from any branch today." Re-measured 2026-08-24
   and that is FALSE: it was true *from master*, which lacks the coset code. From
   the `b7-drop-aligned-checks` worktree, the documented recipe

   ```bash
   wasm-pack build stark --target web --out-dir wasm-out --release -- --features wasm
   ```

   reproduces the shipped blob **byte-identically** — `sha256` `51a947e3…`,
   229,640 bytes, in ~41 s. `cmp` against
   `packages/stark-prover/wasm/p01_stark_bg.wasm` reports identical. The keystone
   blocker never existed on b7; it was a symptom of the master↔b7 divergence.

## The pipeline, measured end to end on 2026-08-24

- **Algebraic prover → verifier:** 7 end-to-end DEEP-ALI tests green
  (`stark/src/compact.rs` + `verifier.rs`, `cargo test -p p01-stark -- end_to_end`).
- **WASM prover:** reproducible from b7, byte-identical to the deployed blob.
- **Deployed-lineage verifier accepts a real proof:** b7
  `cargo test -p p01_stark_verifier --test fri_end_to_end` → 5 green, including
  tampered-proof rejection.
- **Public verify harness:** `verify/p01-verify.mjs --self-test --replay` on all
  three fixtures → exit 0, every probe as pinned. The `v3-subscribe` fixture
  records the true current on-chain state: P6/P9/P11 FAIL, i.e. **the live v3
  subscribe path is linkable**. A clean unlinkable spend exists only as the
  `v4-synthetic` fixture — hand-built bytes, nothing on chain.

So the pipeline is wired and correct where it is exercised. What is NOT done:
C7 is unwired (no `CONFIG_SPEND`, no circuit-7 arm), the withdrawal is still
linkable on chain, and the prover is not zero-knowledge. Those are build items,
not frozen ones.

## The real task the freeze was hiding: reconcile master ↔ b7

The correct, sound, reproducible code (coset LDE, dropped aligned checks, the
verifier that ships) lives on `b7-drop-aligned-checks`. Day-to-day development
lives on `master`. They meet nowhere, which is why master's CI hunts for
soundness pins whose code is only on b7, and why master cannot rebuild the blob
it ships. Unfreezing "for real" means choosing b7 as the source of truth for
`stark/` and the verifier and merging it into master. The divergence was mapped
in `head-b7-divergence-mapped-2026-08-21`: 98 files intersect, 50 conflict, 2 in
Rust; take `verify.rs` from b7 verbatim; the danger is `spend.rs` merging cleanly
and going silently wrong, so it must be diffed by hand, not trusted.

## Two rails that stay up regardless — these are NOT the freeze

1. **No program redeploy without an explicit founder go-ahead, per deploy.** The
   upgrade authority `7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU` is the CLI
   default, holds ~28.5 SOL, has no multisig or timelock, and can replace the
   bytecode of every live program. Any `solana` call without `-k` is signed by
   it. Redeploy is hard to reverse, costs SOL, and 20.5 SOL is already stuck in
   `ProofBuffer` accounts. Back this key up off the laptop before doing anything
   that could brick a program.

2. **No mainnet while a fund-loss class is open.** Two are:
   `pool-v3-64bit-leaf-collision-2026-08-23` (measured, ~0.5 core-hours) and
   `unshield-c5-no-membership-proof-2026-08-16`. "Functional" without these
   closed means "drainable."

## One precondition that survives from the old freeze

A note handed over off chain carries a Merkle path resolving to `stored`,
`rebuilt` or `none` (`apps/web/lib/privacy/worker/poolHandlers.ts:1622-1652`).
`rebuilt` only sees leaves the RPC still serves; a pruned history yields a root
the pool never had, and a `none` note may be unspendable. Any note used in a
demonstration must export with `merklePath: 'stored'`, checked beforehand.

## Suggested order for the two weeks

1. Reconcile master ↔ b7 (the item above). Everything else depends on it.
2. Rebuild + re-attest the prover and verifier from the unified branch; confirm
   the blob still hashes `51a947e3` and the verifier still accepts it.
3. Re-point master's CI at code that exists on the unified branch.
4. Wire C7 (Step 4/6/7 of `docs/C7_SPEND_CIRCUIT_PLAN.md`), on the unified
   branch, then measure the real C7 CU and rodata.
5. Close the two fund-loss bugs before any mainnet.
