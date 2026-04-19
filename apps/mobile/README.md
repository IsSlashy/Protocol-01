# Protocol-01 Mobile App

Expo 54 / React Native 0.81 privacy-first wallet for Solana.

See the root repo for the big picture; this README focuses on what is and
is not wired up on mobile specifically.

## Privacy layers (mobile status)

## L0 — Nym mixnet

**Status: Phase 2 (scaffolded, not live)**

The web app at `apps/mugen/` has a working Nym 5-hop mixnet demo via `@nymproject/mix-fetch-full-fat`. Mobile doesn't yet have Nym because:

- The Nym TypeScript SDK is browser-only (WebSocket + WASM worker)
- React Native requires either (a) a WebView-based wrapper (same pattern as STARK prover — see `services/stark/`) or (b) a native Rust/Go port (not upstream yet)

See `services/nym/WebViewPlan.md` for the concrete implementation plan.

Until L0 ships on mobile, requests from the mobile app go via plain HTTPS. The user's IP IS exposed to the API server (and to Solana RPC when hitting mainnet/devnet directly).
