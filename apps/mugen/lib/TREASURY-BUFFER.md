# Treasury Buffer (Layer 2 routing)

A server-side SOL forwarding wallet that sits between the on-ramp
(MoonPay) and the end user's stealth address, breaking the chain-visible
timing link between the KYC'd fiat deposit and the final recipient.

## What it does

```
MoonPay ── SOL ──▶ Buffer Wallet (A) ── delay(20–120s) + mixing ──▶ Stealth Addr (B)
  t0                       t1                                           t2
```

An observer on-chain sees:

- `A receives X SOL from MoonPay at t1`
- `A sends ~X SOL to B at t2`

But `t2 - t1` is randomized per-route and `A` is a pool holding many
users' concurrent routes, so direct timing correlation between the fiat
purchase and the stealth recipient is broken.

## Honesty disclaimer (MVP)

- Single buffer wallet. Not multi-jurisdictional, not rotated.
- Uniform-random delay in `[20s, 120s]`. Not true Poisson arrivals.
- No anonymity-set proof. Only direct timing correlation is broken — a
  sophisticated adversary correlating amounts can still de-mix.
- In-process state. Registry is lost on server restart (on-chain funding
  transactions are the source of truth; the poller re-discovers them).

Production hardening would require: multiple regional buffer wallets,
Poisson-distributed release schedule, coin-joined outbound transactions,
and proof-of-delivery receipts.

## Env vars

| Name | Default | Purpose |
|------|---------|---------|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | RPC endpoint for the runner |
| `MUGEN_TREASURY_BUFFER_KEYPAIR` | `<cwd>/.secrets/treasury-buffer-keypair.json` | Path to the buffer wallet keypair |

## One-shot setup

1. First call to any treasury API (or a direct `getBufferWalletPubkey()`)
   auto-generates a keypair at
   `apps/mugen/.secrets/treasury-buffer-keypair.json` and logs the pubkey.
2. Fund that pubkey with devnet SOL so it can cover outbound fees + the
   expected payout amounts:

   ```bash
   solana airdrop 2 <BUFFER_PUBKEY> --url devnet
   ```

3. Start the Next.js dev server; the poller boots on the first
   `register-route` request and runs on a 15s interval for the lifetime
   of the Node process.

## API surface

- `POST /api/treasury/register-route` — pre-register an expected payout.
  Returns `{ id, bufferAddress, scheduledPayoutAt }`.
- `GET /api/treasury/status/:id` — poll a single route's status.
- `GET /api/treasury/routes` — dev-only dump of the full registry
  (gated on `NODE_ENV !== 'production'`).

## Runner

`startTreasuryBufferRunner()` is idempotent (guarded via `globalThis`
symbol). Every 15s it:

1. Calls `pollForIncomingFunds(connection)` — scans the buffer's recent
   signatures, marks matching `pending` routes as `funded`.
2. Calls `executeReadyPayouts(connection, bufferKeypair)` — pays out any
   `funded` routes past their `scheduledPayoutAt`; expires stale pending
   routes older than 30 min.

Not suitable for serverless / multi-instance deployments — on Vercel
production this would need to move to an external cron worker.
