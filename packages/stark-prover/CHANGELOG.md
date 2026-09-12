# Changelog — @protocol-01/stark-prover

Every entry names what was MEASURED, with the log or the transaction it came
from. A number without a log is a quote, and this file does not carry quotes.

## 0.2.0 — 2026-09-12

The version paired with the verifier deployed on devnet on 2026-09-12
(slot 497235406, `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs`).
The version on npm before this one, 0.1.3, carries a pre-circuit-7 blob that
this verifier refuses at the parser; do not pair it with the current program.

### The prover blob

- `wasm/p01_stark_bg.wasm` is `0ad6d7f1eaed14a8…`, 265,324 bytes. All eight
  circuits carry the same three-part mask (row mask, lift column, randomizer)
  and the out-of-domain point is resampled from the transcript hash on both
  prover and verifier. Every circuit draws a fresh mask per proof, so no proof
  is byte-reproducible; what is pinned is the wire length per circuit
  (`src/wireFormat.test.ts`) and the freshness of two proofs of one witness.
- Wire lengths: C0 74,365 · C1 94,897 · C2 95,777 · C3 79,597 · C4 75,085 ·
  C5 91,261 · C6 82,477 · C7 79,405 bytes.
- `deployed-verifier.json` records the deployment this blob was proved
  against and the acceptance transaction (`2H5p3dqE…`, slot 497236376, C7,
  both phases, 889,570 CU). `npm run check:deployed:onchain` reads the chain
  and compares.

### The upload protocol (`uploadAndVerify`)

- Proof buffers are keypair accounts created and initialised in ONE
  transaction (`init_proof_buffer_v3`), derived from the authority, the
  circuit and an attempt counter; a buffer left behind by a failed attempt is
  re-armed with `reset_proof_buffer` instead of paid for twice. The PDA path
  with its resize steps is still available as `legacyBuffer: true`.
- Chunks travel as transaction-v1 envelopes (SIMD-0385, 4,096-byte
  transactions, feature gate `txv1aq4pp…`): 3,840-byte chunks, 21 transactions
  for a circuit-7 proof instead of 80. Built with `@solana/kit`; the gate is
  detected on the connection and the 1,000-byte legacy chunks are used where
  it is not active (`txV1: false` forces them).
- Phase 1 and phase 2 of the verification go in one transaction where the
  circuit's budget allows (C3, C4, C6, C7); C1, C2 and C5 keep two.
- Chunk sending is paced (`chunkPacing`: waves, delay, batch size) and every
  send retries on the RPC's rate limit; a torn upload is resumed at the
  missing chunks.
- `verifySignatures` on the outcome lists every verification transaction.

### Measured on devnet (Helius, one run each, `docs/BENCHMARK-2026-09-13.md` §6/§6b)

prove + allocate + upload + verify + close, from Node with this blob:
C0 10.9 s · C1 5.8 s · C2 5.5 s · C3 5.3 s · C4 8.1 s · C5 15.9 s (9.7 s of it
proving) · C6 8.2 s · C7 8.0 s. The 1,000-byte PDA path measured 35–41 s for
the same C7 proof on the same endpoint.

### Harness

- `scripts/live-timing.ts` drives all eight circuits against the deployed
  verifier (`--circuit 0,2,4,5 --v1 --rpc … --keypair …`).
- `scripts/c7-live-proof.ts` submits one honest circuit-7 proof and reads the
  verdict back off the chain; `--tamper` / `--forge` show the refusals.

## 0.1.3 — 2026-08-11

Published carrying the pre-circuit-7 blob (`51a947e3…`, 229,640 bytes). Kept
on npm; superseded.
