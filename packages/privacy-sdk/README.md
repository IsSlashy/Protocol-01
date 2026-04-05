<div align="center">

# @protocol-01/privacy-sdk

**The complete privacy SDK for Solana.**

Shield funds, send privately, manage stealth addresses, create payment streams, and more.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Built by [Protocol 01](https://protocol-01.vercel.app) -- The Privacy Layer for Solana

</div>

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
import { Connection, Keypair } from '@solana/web3.js';
import { PrivacySDK } from '@protocol-01/privacy-sdk';

// Initialize
const sdk = new PrivacySDK({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: myKeypair, // or any WalletAdapter
  network: 'devnet', // always specify explicitly
});

// Shield 1 SOL into the privacy pool
const shieldReceipt = await sdk.shield.shield({
  amount: 1_000_000_000,
  token: 'SOL',
});
console.log('Shielded:', shieldReceipt.commitment);

// Send a private transfer
await sdk.shield.transfer({
  to: recipientStealthAddress,
  amount: 500_000_000,
  token: 'SOL',
});

// Unshield back to your wallet
await sdk.shield.unshield({
  amount: 500_000_000,
  token: 'SOL',
});
```

## Modules

| Module | What It Does | Import |
|--------|-------------|--------|
| **Shield** | Deposit/withdraw from privacy pools | `@protocol-01/privacy-sdk/shield` |
| **Stealth** | Generate/scan stealth addresses | `@protocol-01/privacy-sdk/stealth` |
| **Confidential** | Private balances with ZK proofs | `@protocol-01/privacy-sdk/confidential` |
| **Streams** | Continuous payment streams | `@protocol-01/privacy-sdk/streams` |
| **Subscriptions** | Recurring private payments | `@protocol-01/privacy-sdk/subscriptions` |
| **Vault** | Quantum-safe key storage (WOTS+) | `@protocol-01/privacy-sdk/vault` |
| **Registry** | On-chain stealth address directory | `@protocol-01/privacy-sdk/registry` |
| **Relay** | Transaction relay for sender privacy | `@protocol-01/privacy-sdk/relay` |
| **MPC** | Multi-party computation via Arcium | `@protocol-01/privacy-sdk/mpc` |
| **Compliance** | ZK-KYC proofs (range proofs, sanctions innocence) | `@protocol-01/privacy-sdk/compliance` |
| **Airdrop** | Private token distribution (Merkle-based) | `@protocol-01/privacy-sdk/airdrop` |
| **OTC** | Private OTC trading desk (atomic P2P swaps) | `@protocol-01/privacy-sdk/otc` |
| **Payroll** | Confidential salary payments (batch) | `@protocol-01/privacy-sdk/payroll` |
| **Treasury** | Multi-sig treasury with privacy | `@protocol-01/privacy-sdk/treasury` |
| **Exchange** | P2P fiat-to-crypto (Mugen) | `@protocol-01/privacy-sdk` (main import) |

All modules are accessible through the main SDK instance:

```typescript
sdk.shield.shield(...)
sdk.stealth.send(...)
sdk.confidential.deposit(...)
sdk.streams.create(...)
sdk.subscriptions.create(...)
sdk.vault.create(...)
sdk.registry.register(...)
sdk.relay.submitJob(...)
sdk.mpc.vote(...)
sdk.compliance.proveRange(...)
sdk.airdrop.create(...)
sdk.otc.createOrder(...)
sdk.payroll.createBatch(...)
sdk.treasury.propose(...)
sdk.exchange.createOrder(...)
```

## Configuration

```typescript
import { PrivacySDK } from '@protocol-01/privacy-sdk';

const sdk = new PrivacySDK({
  // Required
  connection: myConnection,  // @solana/web3.js Connection
  wallet: myWallet,          // Keypair or WalletAdapter

  // Optional
  network: 'devnet',         // 'devnet' | 'mainnet' (warns if omitted)
  commitment: 'confirmed',   // 'processed' | 'confirmed' | 'finalized'
  programIds: {              // Override any program ID
    zkShielded: myCustomProgramId,
  },
});

// Check SDK health
const { balance, network, walletAddress } = await sdk.healthCheck();
```

### Custom Tokens

```typescript
import { PublicKey } from '@solana/web3.js';

// Register a custom SPL token
sdk.registerToken('BONK', new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), 5);

// Use it like any built-in token
await sdk.shield.shield({ amount: 1_000_000, token: 'BONK' });
```

### Checking Deployed Programs

```typescript
import { getDeployedProgramIds } from '@protocol-01/privacy-sdk';

// Returns only programs that are actually deployed on the target network
// Logs a warning listing any undeployed modules
const deployed = getDeployedProgramIds('mainnet');
```

## React Integration

Wrap your app with `PrivacyProvider` and use the hooks:

```tsx
import { PrivacyProvider, usePrivacy, useShield, useStealth } from '@protocol-01/privacy-sdk/react';

function App() {
  return (
    <PrivacyProvider config={{ connection, wallet, network: 'devnet' }}>
      <MyComponent />
    </PrivacyProvider>
  );
}

function MyComponent() {
  // Full SDK access
  const sdk = usePrivacy();

  // Shield operations with loading/error state
  const { shield, shieldState, unshield, transfer, getBalance } = useShield();

  // Stealth address operations
  const { generateMetaAddress, send, scan, claim } = useStealth();

  const handleShield = async () => {
    try {
      const receipt = await shield({ amount: 1e9, token: 'SOL' });
      console.log('Shielded!', receipt.commitment);
    } catch (err) {
      console.error('Shield failed:', err);
    }
  };

  return (
    <button onClick={handleShield} disabled={shieldState.loading}>
      {shieldState.loading ? 'Shielding...' : 'Shield 1 SOL'}
    </button>
  );
}
```

### Available Hooks

| Hook | Module | Operations |
|------|--------|-----------|
| `usePrivacy()` | All | Full SDK instance |
| `useShield()` | Shield | `shield`, `unshield`, `transfer`, `getBalance` |
| `useStealth()` | Stealth | `generateMetaAddress`, `send`, `scan`, `claim` |
| `useConfidential()` | Confidential | `deposit`, `transfer`, `withdraw`, `getBalance` |
| `useStreams()` | Streams | `create`, `withdraw`, `cancel`, `getStream`, `listStreams` |
| `useSubscriptions()` | Subscriptions | `create`, `cancel`, `pause`, `resume` |
| `useVault()` | Vault | `create`, `deposit`, `withdraw` |
| `useRegistry()` | Registry | `register`, `lookup`, `isRegistered` |
| `useRelay()` | Relay | `submitJob`, `listRelayers` |
| `useMPC()` | MPC | `createProposal`, `vote`, `submitBid`, `isAvailable` |

Each hook returns action functions with an associated state object (`{ data, loading, error }`).

## Error Handling

All SDK errors use the `PrivacyError` class with typed error codes:

```typescript
import { PrivacyError, PrivacyErrorCode } from '@protocol-01/privacy-sdk';

try {
  await sdk.shield.shield({ amount: 1e9, token: 'SOL' });
} catch (err) {
  if (err instanceof PrivacyError) {
    switch (err.code) {
      case PrivacyErrorCode.WALLET_NOT_CONNECTED:
        // Prompt user to connect wallet
        break;
      case PrivacyErrorCode.PROOF_GENERATION_FAILED:
        // ZK proof failed -- retry or check circuit files
        break;
      case PrivacyErrorCode.NULLIFIER_ALREADY_SPENT:
        // Note already spent (double-spend attempt)
        break;
      case PrivacyErrorCode.TRANSACTION_FAILED:
        // On-chain transaction failed
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
| 2xxx | Shield | `SHIELD_FAILED`, `NULLIFIER_ALREADY_SPENT`, `POOL_NOT_FOUND` |
| 3xxx | Stealth | `STEALTH_SEND_FAILED`, `INVALID_META_ADDRESS`, `SPENDING_KEY_REQUIRED` |
| 4xxx | Confidential | `CONFIDENTIAL_DEPOSIT_FAILED`, `BALANCE_PROOF_FAILED` |
| 5xxx | Streams | `STREAM_CREATE_FAILED`, `STREAM_EXHAUSTED` |
| 6xxx | Subscriptions | `SUBSCRIPTION_CREATE_FAILED`, `SUBSCRIPTION_NOT_FOUND` |
| 7xxx | Vault | `VAULT_CREATE_FAILED`, `WOTS_KEY_EXHAUSTED` |
| 8xxx | Relay | `RELAY_SUBMIT_FAILED`, `RELAY_NO_ACTIVE_RELAYERS` |
| 9xxx | MPC | `MPC_VOTE_FAILED`, `MPC_NOT_AVAILABLE` |
| 10xxx | Registry | `REGISTRY_NOT_FOUND`, `REGISTRY_ALREADY_EXISTS` |
| 11xxx | Exchange | `EXCHANGE_ORDER_NOT_FOUND`, `EXCHANGE_ESCROW_EXPIRED` |

## Events

Subscribe to SDK events for real-time updates:

```typescript
sdk.on('shield', (event) => {
  console.log('Shielded at', event.timestamp, event.data);
});

sdk.on('stealth:receive', (event) => {
  console.log('Incoming stealth payment:', event.data);
});

sdk.on('error', (event) => {
  console.error('SDK error:', event.data);
});
```

## Network Support

| Program | Devnet | Mainnet |
|---------|--------|---------|
| Shield (zkShielded) | Deployed | Deployed |
| Stealth (specter) | Deployed | Deployed |
| Confidential (zkspl) | Deployed | Deployed |
| Streams | Deployed | Deployed |
| Subscriptions | Deployed | Deployed |
| Fee Splitter | Deployed | Deployed |
| Whitelist | Deployed | Deployed |
| Trustless | Deployed | Not yet deployed |
| Relay | Deployed | Not yet deployed |
| Registry | Deployed | Not yet deployed |
| Quantum Vault | Deployed | Not yet deployed |
| STARK Verifier | Deployed | Not yet deployed |
| Arcium MPC | Deployed | Not yet deployed |
| Bundler | Deployed | Not yet deployed |
| Mugen Exchange | Deployed | Not yet deployed |

The SDK will throw `PrivacyError(INVALID_CONFIG)` if you try to use mainnet with undeployed programs. Use `getDeployedProgramIds('mainnet')` to check availability.

## Security

- **Spending keys never leave the client.** All ZK proofs are generated locally (snarkjs). There is no remote prover fallback.
- **Nullifier preimages are the spending authority.** Whoever knows the nullifier preimage can spend the note. Treat them like private keys.
- **Stealth private keys must be persisted securely.** The SDK returns them from `generateMetaAddress()` but does not store them. Use encrypted storage (e.g., SecureStore on mobile).
- **WOTS+ vault keys are one-time.** Each withdrawal rotates the key. If you lose the seed, you lose access to the vault.
- **The SDK warns loudly if no network is specified** (defaults to devnet). Always set `network` explicitly in production.

## Architecture

```
@protocol-01/privacy-sdk
  |
  +-- PrivacySDK (main client)
  |     |-- shield      (ShieldModule)
  |     |-- stealth     (StealthModule)
  |     |-- confidential (ConfidentialModule)
  |     |-- streams     (StreamsModule)
  |     |-- subscriptions (SubscriptionsModule)
  |     |-- vault       (VaultModule)
  |     |-- registry    (RegistryModule)
  |     |-- relay       (RelayModule)
  |     |-- mpc         (MPCModule)
  |     |-- compliance  (ComplianceModule)
  |     |-- airdrop     (AirdropModule)
  |     |-- otc         (OTCModule)
  |     |-- payroll     (PayrollModule)
  |     |-- treasury    (TreasuryModule)
  |     +-- exchange    (MugenExchangeModule)
  |
  +-- react/
  |     |-- PrivacyProvider
  |     +-- useShield, useStealth, useConfidential, ...
  |
  +-- errors (PrivacyError, PrivacyErrorCode)
  +-- constants (PROGRAM_IDS, TOKENS, SEEDS, ...)
  +-- types (all TypeScript interfaces)
```

The SDK depends on `@protocol-01/privacy-toolkit` for low-level cryptographic primitives (Poseidon commitments, Merkle trees, proof format conversion).

## License

MIT

---

[Website](https://protocol-01.vercel.app) · [Twitter](https://twitter.com/Protocol01_) · [Discord](https://discord.gg/KfmhPFAHNH) · [GitHub](https://github.com/IsSlashy/Protocol-01)
