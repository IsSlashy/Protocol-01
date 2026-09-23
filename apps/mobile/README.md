# Protocol-01 Mobile App

Expo 54 / React Native 0.81 privacy-first wallet for Solana.

See the root repo for the big picture; this README focuses on what is and
is not wired up on mobile specifically.

## Privacy layers (mobile status)

## L0 — Network anonymity

**Status: none.** There is no mixnet on mobile. An unwired Nym scaffold
existed and was deleted on 2026-09-23 (nothing imported it).

Requests from the mobile app go via plain HTTPS. The user's IP IS exposed to the API server (and to Solana RPC when hitting mainnet/devnet directly).
