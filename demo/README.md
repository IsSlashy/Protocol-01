# demo/

Scripts an audience can run themselves, from an empty directory, against public
devnet. Rehearsed and measured — every signature here was verified by running
it, not read off a type definition.

## merchant-gate.mjs — the entitlement check

```bash
mkdir castle && cd castle && npm init -y
npm pkg set type=module
npm install @protocol-01/merchant-sdk @solana/web3.js
# copy merchant-gate.mjs here
node merchant-gate.mjs
```

No key, no SOL, no account, no repo access. Measured 2026-08-13: install 2 s
(`@protocol-01/merchant-sdk@0.1.3` from the public registry), script runtime
**273 ms**, and the public devnet endpoint did not throttle.

Measured output that day:

```
vaults on chain      : 18
entitlement spread   : ended=9  current=7  paused=2

CURRENT  46d6mEYBrktEFqMkhBjLsEA1rJZDmh2DLzmsafPuDjt7
  the real subscriber  : GRANTED
  a different merchant : DENIED
  a made-up subscriber : DENIED
  is_active on chain   : true   <- the program never sets it false

ENDED  72n5rpWb2qaPSnnzUjbnoWqQ7qJkESWrA3MQbN3K1TZ
  the real subscriber  : DENIED
  is_active on chain   : true
```

Nothing is hardcoded: the script enumerates the live vaults and picks a current
one and an ended one at run time. Devnet moves, so the addresses and the spread
will differ — read the numbers off the screen, never off a slide.

### The beat worth narrating

The last line. Every vault on chain carries `is_active = true`, including the
ones that ended: the program writes it true at subscribe and false nowhere. The
SDK ignores that field and computes entitlement from the funding and the clock,
so it answers DENIED where the account's own flag says the subscription is
alive. The library is more honest than the field it reads.

### Two signatures the first draft got wrong

Both would have failed live. They are the reason this file exists in the repo
rather than in a slide.

- `fetchVaultByAddress(rpc, pda)` returns **`{ ok, vault }`**, not the vault.
- `hasActiveVaultAccessForVault(connection, vaultPda, retailer, subscriberIdBytes, opts?)`
  takes the PDA, the retailer and the 32-byte subscriber commitment, and returns
  **the vault account or `null`** — not a boolean, and not a `{ service }`
  options object.

## What this does NOT show, and must not be claimed

A merchant's subscribers are **publicly enumerable**. `retailer` sits at a fixed
offset in an unencrypted account, so one `getProgramAccounts` filtered on the
discriminator returns every vault, its retailer, deposit, rate, interval and
start slot — from `curl`, with no SDK and no auth. The SDK's own documentation
says so and records the measurement (17 accounts across 6 retailers, devnet
2026-08-01). This script does exactly that query in its first ten lines.

What the design does buy: the vault is addressed by a commitment to a note
secret rather than by a wallet, so nobody can re-derive an address to ask
whether a given wallet subscribes to a given merchant. That is a narrower claim
than "private subscriptions" and it is the one to make.

⚠️ Two of the eighteen live vaults are legacy normal-mode and name the
subscriber's wallet in the clear.
