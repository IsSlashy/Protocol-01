# @protocol-01/specter-sdk

TypeScript SDK for privacy-preserving payments on Solana. Provides stealth addresses, private transfers, payment scanning, and stream payments through a unified client.

## Installation

```bash
npm install @protocol-01/specter-sdk @solana/web3.js
```

Requires Node.js >= 22.0.0.

## Quick Start

```typescript
import { P01Client } from '@protocol-01/specter-sdk';

// Create a client
const client = new P01Client({ cluster: 'devnet' });

// Create a new wallet
const wallet = await P01Client.createWallet();
console.log('Public key:', wallet.publicKey.toBase58());
console.log('Stealth address:', wallet.stealthMetaAddress.encoded);

// Or import an existing wallet
const imported = await P01Client.importWallet('your seed phrase ...');

// Connect the wallet to the client
await client.connect(wallet);

// Send a private transfer
const signature = await client.sendPrivate(
  recipientStealthMetaAddress,
  1.5, // SOL
  { level: 'enhanced' }
);

// Scan for incoming stealth payments
const payments = await client.scanForIncoming();
for (const payment of payments) {
  console.log('Received:', payment.amount, 'from', payment.signature);
}

// Claim a stealth payment
const claimSig = await client.claimStealth(payments[0]);

// Create a payment stream
const stream = await client.createStream(
  recipientAddress,
  10,   // 10 SOL total
  30,   // 30 days duration
  { privacyLevel: 'standard', cancellable: true }
);
```

## Configuration

### Network Switching

```typescript
import { P01Client } from '@protocol-01/specter-sdk';

// Default: devnet
const client = new P01Client({ cluster: 'devnet' });

// Switch at runtime
client.setCluster('localnet');
```

### Custom RPC Endpoint

Public Solana RPCs are rate-limited. For production, use a provider like Helius or QuickNode:

```typescript
// Per-client override
const client = new P01Client({
  cluster: 'devnet',
  rpcEndpoint: 'https://devnet.helius-rpc.com/?api-key=YOUR_KEY',
});

// Global override (affects all new clients that don't specify rpcEndpoint)
import { setCustomRpcEndpoint } from '@protocol-01/specter-sdk';
setCustomRpcEndpoint('devnet', 'https://devnet.helius-rpc.com/?api-key=YOUR_KEY');
```

### Program ID Overrides

Use custom program IDs for testing with localnet or forked deployments:

```typescript
import { PublicKey } from '@solana/web3.js';

const client = new P01Client({
  cluster: 'localnet',
  programId: new PublicKey('YourCustomProgramId...'),
  registryProgramId: new PublicKey('YourRegistryProgramId...'),
  relayerProgramId: new PublicKey('YourRelayerProgramId...'),
});
```

### Feature Flags

Feature flags control optional SDK behavior. Override them at client creation or at runtime:

```typescript
// At client creation
const client = new P01Client({
  features: {
    ENABLE_RELAYER: true,
    ENABLE_MULTI_HOP: false,
  },
});

// At runtime
import { setFeature, getFeature } from '@protocol-01/specter-sdk';
setFeature('ENABLE_RELAYER', true);

if (getFeature('ENABLE_RELAYER')) {
  // relay functionality is available
}
```

## Modules

### Stealth Addresses

One-time addresses derived from a reusable stealth meta-address. The sender generates a unique address only the recipient can spend from, using ECDH key exchange (with optional ML-KEM-768 post-quantum hybrid mode).

```typescript
import {
  generateStealthMetaAddress,
  generateStealthAddress,
  StealthScanner,
} from '@protocol-01/specter-sdk';

// Generate a stealth meta-address (share this publicly)
const meta = generateStealthMetaAddress(spendingKeypair, viewingKeypair);
console.log('Share this:', meta.encoded); // st:01...

// Sender: generate a one-time address for a payment
const stealth = generateStealthAddress(meta);
// Send SOL/tokens to stealth.address

// Recipient: scan for incoming payments
const scanner = new StealthScanner(connection, viewingPrivateKey, spendingPubKey);
const payments = await scanner.scan({ fromSlot: 280000000 });
```

### Private Transfers

Send SOL or SPL tokens to stealth addresses with configurable privacy levels.

```typescript
import { sendPrivate, claimStealth } from '@protocol-01/specter-sdk';

// Send a private transfer
const result = await sendPrivate({
  sender: keypair,
  connection,
  recipient: 'st:01abc...', // stealth meta-address
  amount: 2.5,              // SOL
  privacyOptions: { level: 'enhanced' },
});

// Claim a received stealth payment
const claim = await claimStealth({
  connection,
  payment,
  spendingPubKey,
  viewingPrivateKey,
  destination: myWalletPubkey,
});
```

### Payment Streams

Create continuous payment streams where funds are released linearly over time.

```typescript
import { createStream, withdrawStream } from '@protocol-01/specter-sdk';

// Create a 30-day stream
const stream = await createStream({
  connection,
  sender: keypair,
  recipient: 'st:01abc...', // or a plain public key
  totalAmount: 10,           // 10 SOL total
  durationDays: 30,
  options: { cancellable: true, pausable: true },
});

// Recipient: withdraw available funds
const result = await withdrawStream({
  connection,
  streamId: stream.id,
  recipient: recipientKeypair,
});
```

### ZK Proving (Client-Side)

Generate Groth16 proofs entirely on the user's device. The spending key, balance, and salt never leave the machine.

Circuit files (.wasm and .zkey) must be served from a URL or filesystem path. Download them from [github.com/protocol-01/circuits](https://github.com/protocol-01/circuits).

```typescript
import { ClientProver, CircuitLoader } from '@protocol-01/specter-sdk';

// Check what files are needed
console.log(CircuitLoader.listRequiredCircuits());
// ['confidential_balance.wasm', 'confidential_balance_final.zkey',
//  'balance_proof.wasm', 'balance_proof_final.zkey']

// Initialize the prover with a base URL
const prover = new ClientProver({
  circuitBaseUrl: 'https://cdn.example.com/circuits/',
  balanceCircuit: {
    wasmUrl: 'confidential_balance.wasm',
    zkeyUrl: 'confidential_balance_final.zkey',
  },
  sufficiencyCircuit: {
    wasmUrl: 'balance_proof.wasm',
    zkeyUrl: 'balance_proof_final.zkey',
  },
});

// Preload circuit files (recommended on app startup)
await prover.preloadCircuits();

// Generate a deposit proof
const result = await prover.proveDeposit(publicInputs, privateInputs);
// result.proof, result.publicSignals, result.provingTimeMs
```

### Blockchain Indexing

Client-side indexers that replace the need for a centralized backend. Users talk directly to Solana RPC.

```typescript
import { CommitmentIndexer, StealthIndexer, MemoryCache } from '@protocol-01/specter-sdk';

// Index shielded pool commitments (replaces relayer /pool/state)
const commitmentIndexer = new CommitmentIndexer({
  connection,
  programId,
  cache: new MemoryCache(),
});
const status = await commitmentIndexer.sync();

// Index stealth payments (replaces relayer /relay/stealth-payments)
const stealthIndexer = new StealthIndexer({
  connection,
  viewingPrivateKey,
  spendingPubKey,
});
const payments = await stealthIndexer.scan();
```

### Quantum-Safe Vaults

Application-layer defenses against quantum attacks on Ed25519. Three mechanisms that protect funds even if Shor's algorithm breaks Ed25519.

```typescript
import {
  generateWotsKeypair,
  wotsSign,
  wotsVerify,
  computeHashVaultCommitment,
  generateVaultSecret,
} from '@protocol-01/specter-sdk';

// WOTS+ (Winternitz One-Time Signature): hash-based, quantum-resistant
const wots = generateWotsKeypair();
const message = new Uint8Array(32); // your withdraw message
const signature = wotsSign(message, wots.secretKey);
const valid = wotsVerify(message, signature, wots.publicKey);

// Hash-timelock vault: SHA-256 preimage lock for cold storage
const secret = generateVaultSecret();
const commitment = computeHashVaultCommitment(secret);
// Store commitment on-chain, reveal secret to unlock
```

### Private Subscriptions

Fully untraceable recurring payments that compose stealth addresses with ZK shielded pool unshields.

```typescript
import { createPrivateSubscription, generatePrivatePaymentData } from '@protocol-01/specter-sdk';

// Set up a private subscription
const sub = await createPrivateSubscription({
  connection,
  subscriber: keypair,
  merchantAddress: 'st:01abc...', // merchant's stealth meta-address
  amount: 9.99,
  frequency: 'monthly',
  name: 'Streaming Service',
});

// For each recurring payment, generate fresh stealth data
const paymentData = generatePrivatePaymentData('st:01abc...', 9.99);
// Send to paymentData.stealthAddress via ZK unshield
```

### Relay (Transaction Privacy)

Submit transactions through encrypted relay jobs so your wallet address never appears on-chain. An ephemeral keypair posts the job; a staked relayer executes it.

> Note: The relay feature requires the `ENABLE_RELAYER` feature flag to be enabled.

```typescript
import { submitRelayJob, monitorJob, setFeature } from '@protocol-01/specter-sdk';

// Enable the relay feature
setFeature('ENABLE_RELAYER', true);

// Submit an encrypted relay job
const job = await submitRelayJob({
  connection,
  programId: relayerProgramId,
  transaction: myTransaction,
  ephemeralKeypair, // funded from shielded pool, not your main wallet
});

// Monitor for completion
const result = await monitorJob(connection, job.jobAddress, relayerProgramId);
if (result.success) {
  console.log('Relayed tx:', result.txSignature);
}
```

### Registry (Stealth Address Directory)

On-chain directory where users publish their stealth meta-address so anyone can look them up by wallet and send private payments.

```typescript
import { lookupMetaAddress, lookupMultiple, isRegistered, entryToMetaAddress } from '@protocol-01/specter-sdk';

// Look up a user's stealth meta-address
const entry = await lookupMetaAddress(connection, walletPubkey);
if (entry) {
  const meta = entryToMetaAddress(entry);
  // Now you can send them a private payment
  const stealth = generateStealthAddress(meta);
}

// Batch lookup
const entries = await lookupMultiple(connection, [wallet1, wallet2, wallet3]);

// Check if registered
const registered = await isRegistered(connection, walletPubkey);
```

## API Reference

### P01Client

Main client class for all Protocol 01 operations.

**Static Methods**

| Method | Description |
|---|---|
| `P01Client.createWallet()` | Create a new wallet with a fresh seed phrase |
| `P01Client.importWallet(seedPhrase)` | Import a wallet from a BIP39 mnemonic |

**Connection**

| Method | Description |
|---|---|
| `connect(wallet)` | Connect a P01Wallet, Keypair, or external WalletAdapter |
| `disconnect()` | Disconnect the current wallet |
| `isConnected` | Whether a wallet is connected (getter) |
| `publicKey` | The connected wallet's public key (getter) |
| `stealthMetaAddress` | The stealth meta-address for receiving private payments (getter) |

**Balance**

| Method | Description |
|---|---|
| `getBalance()` | Get SOL and token balances for the connected wallet |

**Stealth Addresses**

| Method | Description |
|---|---|
| `generateStealthAddress()` | Generate a one-time stealth address for receiving |
| `scanForIncoming(options?)` | Scan the chain for incoming stealth payments |
| `subscribeToIncoming(callback)` | Subscribe to real-time incoming payment notifications |

**Transfers**

| Method | Description |
|---|---|
| `sendPrivate(to, amount, options?)` | Send a private transfer to a stealth meta-address |
| `sendPublic(to, amount)` | Send a regular (non-private) SOL transfer |
| `claimStealth(payment)` | Claim a received stealth payment |
| `estimateFee(privacyLevel?)` | Estimate the transaction fee |

**Streams**

| Method | Description |
|---|---|
| `createStream(recipient, amount, durationDays, options?)` | Create a payment stream |
| `withdrawStream(streamId, amount?)` | Withdraw from a stream (as recipient) |
| `cancelStream(streamId)` | Cancel a stream (as sender) |
| `getStream(streamId)` | Get stream details |
| `getMyStreams()` | Get all streams for the connected wallet |

**Utility**

| Method | Description |
|---|---|
| `getConnection()` | Get the Solana connection instance |
| `getProgramId()` | Get the Specter program ID |
| `getRegistryProgramId()` | Get the registry program ID |
| `getRelayerProgramId()` | Get the relayer program ID |
| `setCluster(cluster)` | Switch to a different network cluster |
| `on(event, listener)` | Listen for SDK events |
| `off(event, listener)` | Remove an event listener |

### Key Types

- `P01Wallet` -- Wallet with stealth capabilities (publicKey, keypair, stealthMetaAddress)
- `StealthMetaAddress` -- Spending and viewing public keys for deriving stealth addresses
- `StealthAddress` -- A one-time address for receiving a single payment
- `StealthPayment` -- A detected incoming stealth payment
- `PrivacyOptions` -- Privacy level and transfer options (standard, enhanced, maximum)
- `Stream` -- Payment stream data (id, sender, recipient, amounts, status)
- `P01ClientConfig` -- Client configuration (cluster, rpcEndpoint, commitment, debug, features)
- `P01Error` / `P01ErrorCode` -- Structured error types
- `WalletAdapter` -- Interface for external wallets ({ publicKey, signTransaction })

### Sub-path Imports

```typescript
import { createWallet } from '@protocol-01/specter-sdk/wallet';
import { generateStealthAddress, StealthScanner } from '@protocol-01/specter-sdk/stealth';
import { sendPrivate, claimStealth } from '@protocol-01/specter-sdk/transfer';
import { createStream, withdrawStream } from '@protocol-01/specter-sdk/streams';
import { ClientProver, CircuitLoader } from '@protocol-01/specter-sdk/proving';
import { CommitmentIndexer, StealthIndexer } from '@protocol-01/specter-sdk/indexing';
import { submitRelayJob } from '@protocol-01/specter-sdk/relay';
```

## Error Handling

All SDK errors use the `P01Error` class with structured error codes organized by category:

```typescript
import { P01Error, P01ErrorCode } from '@protocol-01/specter-sdk';

try {
  await client.sendPrivate(recipient, 1.0);
} catch (error) {
  if (error instanceof P01Error) {
    switch (error.code) {
      case P01ErrorCode.WALLET_NOT_CONNECTED:
        console.log('Connect a wallet first');
        break;
      case P01ErrorCode.INSUFFICIENT_BALANCE:
        console.log('Not enough SOL');
        break;
      case P01ErrorCode.RPC_ERROR:
        console.log('Network issue:', error.message);
        break;
    }
  }
}
```

**Error Code Ranges**

| Range | Category | Examples |
|---|---|---|
| 1xxx | Wallet | `WALLET_NOT_CONNECTED`, `INVALID_SEED_PHRASE`, `DERIVATION_FAILED` |
| 2xxx | Stealth | `STEALTH_KEY_GENERATION_FAILED`, `INVALID_STEALTH_ADDRESS`, `SCAN_FAILED` |
| 3xxx | Transfer | `INSUFFICIENT_BALANCE`, `TRANSFER_FAILED`, `CLAIM_FAILED`, `INVALID_RECIPIENT` |
| 4xxx | Stream | `STREAM_NOT_FOUND`, `STREAM_CREATION_FAILED`, `NOTHING_TO_WITHDRAW` |
| 5xxx | Network | `RPC_ERROR`, `TIMEOUT`, `CONFIRMATION_FAILED` |
| 9xxx | General | `UNKNOWN_ERROR` |

**Common Errors and Fixes**

| Error | Cause | Fix |
|---|---|---|
| "Using public Solana RPC" | Default endpoint | Set a custom `rpcEndpoint` (Helius, QuickNode) |
| "not yet deployed on mainnet-beta" | Mainnet program ID requested | Use `cluster: 'devnet'` for testing |
| "Circuit files not found" | Missing .wasm/.zkey | Set `circuitBaseUrl` or download from GitHub |
| "Invalid wallet adapter" | Adapter missing methods | Ensure wallet has `publicKey` and `signTransaction` |
| "Relayer config not initialized" | ENABLE_RELAYER flag off | Call `setFeature('ENABLE_RELAYER', true)` |

## Network Support

| Network | Status | Notes |
|---|---|---|
| devnet | Fully deployed | All programs active, use for testing |
| localnet | Supported | Use with `anchor localnet` or `solana-test-validator` |
| testnet | Not deployed | Programs not yet deployed |
| mainnet-beta | Pending audit | Will be available after security audit |

## Feature Flags

| Flag | Default | Description |
|---|---|---|
| `ENABLE_RELAYER` | `false` | Enable decentralized transaction relay |
| `ENABLE_MULTI_HOP` | `false` | Enable multi-hop privacy routing |
| `ENABLE_TOKEN_STREAMS` | `true` | SPL token payment streams |
| `ENABLE_NFT_TRANSFERS` | `false` | NFT stealth transfers |

Override at runtime with `setFeature(name, enabled)` or at client creation via the `features` config option.

## Security Model

- **All proofs generated locally** -- The spending key, balance, and salt never leave the user's device. Proof generation uses snarkjs WASM running in-process.
- **Spending keys never leave device** -- There is no remote prover fallback. If local proving fails, the operation fails.
- **Stealth scanning uses direct RPC** -- No relayer or backend dependency for payment detection. The `StealthIndexer` talks directly to Solana.
- **ML-KEM-768 hybrid encryption** -- v2 stealth addresses combine X25519 (classical) with ML-KEM-768 (post-quantum) for defense against future quantum computers.
- **On-chain nullifier PDAs** -- Double-spend prevention via the p01_trustless program.

## License

MIT
