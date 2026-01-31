# @p01/specter-sdk

TypeScript SDK for privacy-preserving payments on Solana. Provides stealth addresses, private transfers, payment scanning, and stream payments through a unified client.

## Installation

```bash
npm install @p01/specter-sdk @solana/web3.js
```

Requires Node.js >= 18.0.0.

## Quick Start

```typescript
import { P01Client } from '@p01/specter-sdk';

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
| `getProgramId()` | Get the program ID |
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
- `P01ClientConfig` -- Client configuration (cluster, rpcEndpoint, commitment, debug)
- `P01Error` / `P01ErrorCode` -- Structured error types

### Sub-path Imports

```typescript
import { createWallet } from '@p01/specter-sdk/wallet';
import { generateStealthAddress, StealthScanner } from '@p01/specter-sdk/stealth';
import { sendPrivate, claimStealth } from '@p01/specter-sdk/transfer';
import { createStream, withdrawStream } from '@p01/specter-sdk/streams';
```

## License

MIT
