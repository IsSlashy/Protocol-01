<div align="center">

# @protocol-01/privacy-sdk

**Stealth meta-address registry and privacy relay client for Solana.**

[![License: PolyForm Strict 1.0.0](https://img.shields.io/badge/License-PolyForm%20Strict%201.0.0-blue.svg)](LICENSE)

Built by [Protocol 01](https://styx.cash)

</div>

## Status (2026-09-23): read before you build on it

- **This SDK does not move funds in the shielded pool.** 2.0.0 removed the
  `shield`, `confidential`, `streams`, `subscriptions`, `compliance`,
  `airdrop`, `otc`, `payroll`, `treasury` and `liquidity` modules and the
  instant-unshield flow: each one built instructions for a program that is not
  deployed, or that the deployed `zk_shielded` program does not register
  (`CHANGELOG.md`). The live pool instructions are built by the web app, not
  by this package.
- **What is left:** the stealth meta-address registry (`sdk.registry`), the
  privacy relay (`sdk.relay`), the denomination split (`splitAmount`) and the
  identity key helpers.
- **Nothing of this SDK is deployed on mainnet.** See Network Support below.

## Install

```bash
npm install @protocol-01/privacy-sdk
```

Peer dependencies:

```bash
npm install @solana/web3.js
# For React hooks (optional):
npm install react
```

## Quick Start

```typescript
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PrivacySDK, deriveSpendingKeyFromSignature } from '@protocol-01/privacy-sdk';

// Derive the 32-byte spending key from a wallet signature (recommended default).
// Re-signing the same domain on another device yields the same key.
const spendingKey = await deriveSpendingKeyFromSignature(myKeypair);

const sdk = new PrivacySDK({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: myKeypair,    // Keypair, or any WalletAdapter exposing signMessage
  spendingKey,          // required — see `asSpendingKey()` for custom derivations
  network: 'devnet',    // always specify explicitly
});

// Look up a wallet's stealth meta-address
const entry = await sdk.registry.lookup(new PublicKey(someWallet));

// List the relayers registered on-chain
const relayers = await sdk.relay.listRelayers();
```

## Modules

| Module | What it does | Import |
|--------|-------------|--------|
| **Registry** | On-chain stealth meta-address directory: `register`, `update`, `deregister`, `lookup`, `lookupMultiple`, `isRegistered` | `@protocol-01/privacy-sdk/registry` |
| **Relay** | Encrypted relay jobs: `submitJob`, `getJobStatus`, `cancelJob`, `listRelayers`, `awaitCompletion` | `@protocol-01/privacy-sdk/relay` |
| **Denomination** | `splitAmount`: split an amount into the pool's fixed denominations | `@protocol-01/privacy-sdk` |

Both on-chain modules are reachable through the main SDK instance:

```typescript
sdk.registry.register(...)
sdk.relay.submitJob(...)
```

Removed in 2.0.0 (see `CHANGELOG.md`): `shield`, `confidential`, `streams`,
`subscriptions`, `compliance`, `airdrop`, `otc`, `payroll`, `treasury`,
`liquidity`, the instant-unshield flow, `stealth` and `vault`.

## Configuration

```typescript
import { PrivacySDK, asSpendingKey, deriveSpendingKeyFromSignature } from '@protocol-01/privacy-sdk';

// Option A — derive from a wallet signature (recommended)
const spendingKey = await deriveSpendingKeyFromSignature(myWallet);

// Option B — supply your own 32-byte material (hardware wallet, BIP-32 path, ...)
//   const spendingKey = asSpendingKey(myCustomBytes32);

const sdk = new PrivacySDK({
  // Required
  connection: myConnection,  // @solana/web3.js Connection
  wallet: myWallet,          // Keypair or WalletAdapter
  spendingKey,               // required — see helpers above

  // Optional
  network: 'devnet',         // 'devnet' | 'mainnet' (warns if omitted)
  commitment: 'confirmed',   // 'processed' | 'confirmed' | 'finalized'
  programIds: {              // Override any program ID
    registry: myCustomProgramId,
  },
});

// Check SDK health
const { balance, network, walletAddress } = await sdk.healthCheck();
```

### Checking Deployed Programs

```typescript
import { getDeployedProgramIds } from '@protocol-01/privacy-sdk';

// Returns the declared program ids minus System-program placeholders, and
// logs a warning naming the placeholders. It does not check the chain: an id
// it returns may have no program behind it (see Network Support).
const declared = getDeployedProgramIds('mainnet');
```

## React Integration

Wrap your app with `PrivacyProvider` and use the hooks:

```tsx
import { PrivacyProvider, usePrivacy, useRegistry } from '@protocol-01/privacy-sdk/react';

function App() {
  return (
    <PrivacyProvider config={{ connection, wallet, spendingKey, network: 'devnet' }}>
      <MyComponent />
    </PrivacyProvider>
  );
}

function MyComponent({ wallet }) {
  const { isRegistered, registeredState } = useRegistry();

  return (
    <button onClick={() => isRegistered(wallet)} disabled={registeredState.loading}>
      {registeredState.loading ? 'Checking...' : 'Is this wallet registered?'}
    </button>
  );
}
```

### Available Hooks

| Hook | Module | Operations |
|------|--------|-----------|
| `usePrivacy()` | All | Full SDK instance |
| `useRegistry()` | Registry | `register`, `lookup`, `isRegistered` |
| `useRelay()` | Relay | `submitJob`, `listRelayers` |

Each hook returns action functions with an associated state object (`{ data, loading, error }`).

## Error Handling

All SDK errors use the `PrivacyError` class with typed error codes:

```typescript
import { PrivacyError, PrivacyErrorCode } from '@protocol-01/privacy-sdk';

try {
  await sdk.registry.register({ spendingPubKey, viewingPubKey });
} catch (err) {
  if (err instanceof PrivacyError) {
    switch (err.code) {
      case PrivacyErrorCode.WALLET_NOT_CONNECTED:
        // Prompt user to connect wallet
        break;
      case PrivacyErrorCode.REGISTRY_ALREADY_EXISTS:
        // Use sdk.registry.update(...) instead
        break;
      default:
        console.error(`[${err.code}] ${err.message}`);
    }
  }
}
```

### Error Code Ranges

| Range | Module | Example Codes |
|-------|--------|--------------|
| 1xxx | General | `WALLET_NOT_CONNECTED`, `INVALID_CONFIG`, `TRANSACTION_FAILED` |
| 8xxx | Relay | `RELAY_SUBMIT_FAILED`, `RELAY_NO_ACTIVE_RELAYERS` |
| 10xxx | Registry | `REGISTRY_NOT_FOUND`, `REGISTRY_ALREADY_EXISTS` |

2xxx to 7xxx and 9xxx are retired with the modules that threw them; the
numbers are not reused.

## Events

`sdk.on` / `sdk.off` / `sdk.emit` give the host one event bus for relay work:

```typescript
sdk.on('relay:complete', (event) => {
  console.log('Relay job done at', event.timestamp, event.data);
});

sdk.on('error', (event) => {
  console.error('SDK error:', event.data);
});
```

## Network Support

As read on devnet on 2026-09-23:

| Program | Devnet | Mainnet |
|---------|--------|---------|
| Registry | Deployed | Not deployed |
| Relayer | Deployed; no node has operated it since 2026-08-28 | Not deployed |
| zk_shielded (id only; no module of this SDK calls it) | Deployed | Not deployed |
| STARK Verifier (id only) | Deployed | Not deployed |

`getDeployedProgramIds(network)` returns the declared ids minus System-program placeholders; it does not check the chain. On mainnet it still returns the declared `zkShielded` id, which the table above lists as not deployed. Go by this table, or read the account on the cluster, before relying on a module.

## Security

- **Spending keys never leave the client.** The SDK derives or wraps them in memory and does not send them anywhere.
- **Relay jobs are encrypted to the relayer's X25519 key** before they are submitted.
- **The SDK warns loudly if no network is specified** (defaults to devnet). Always set `network` explicitly in production.

## Architecture

```
@protocol-01/privacy-sdk
  |
  +-- PrivacySDK (main client)
  |     |-- registry    (RegistryModule)
  |     +-- relay       (RelayModule)
  |
  +-- splitAmount (denomination split)
  +-- identity (spending-key and HKDF identity helpers)
  |
  +-- react/
  |     |-- PrivacyProvider
  |     +-- usePrivacy, useRegistry, useRelay
  |
  +-- errors (PrivacyError, PrivacyErrorCode)
  +-- constants (PROGRAM_IDS, TOKENS, SEEDS, DENOMINATIONS, MERKLE_TREE_DEPTH)
  +-- types (all TypeScript interfaces)
```

## License

PolyForm Strict License 1.0.0 — see [LICENSE](LICENSE). The package is
source-available: anyone may read, build, run and verify it for noncommercial
purposes. Commercial use (including production deployment by a business),
changes or derivative works, and redistribution need a written license from
Volta Team ([styx.cash/licenses](https://styx.cash/licenses)).
PolyForm Strict is not an open-source license.

The versions already published to npm (1.0.0 to 1.0.5) were released under the
MIT License and remain MIT, as does every commit of this repository before the
one that replaced the MIT License with PolyForm Strict
([LICENSE-MIT-BEFORE-POLYFORM](../../LICENSE-MIT-BEFORE-POLYFORM)). Versions
published from 2026-09-22 on ship under PolyForm Strict 1.0.0.

---

[Website](https://styx.cash) · [Twitter](https://x.com/Styx_PQ) · [Discord](https://discord.gg/EfqnVmb2dV) · [GitHub](https://github.com/IsSlashy/Protocol-01)
