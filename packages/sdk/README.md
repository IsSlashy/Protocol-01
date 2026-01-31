# @p01/sdk

Stream payments and subscription management for Solana.

## Installation

```bash
npm install @p01/sdk @solana/web3.js
```

## Quick Start

```typescript
import { P01StreamClient, createDevnetClient } from '@p01/sdk';
import { PublicKey } from '@solana/web3.js';

// Create a client
const client = new P01StreamClient({
  network: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
});

// Or use a pre-configured client
const devClient = createDevnetClient();

// Connect a wallet
client.connect(walletProvider);

// Create a payment stream (subscription)
const signature = await client.createStream({
  recipient: new PublicKey('recipient_address'),
  mint: new PublicKey('token_mint_address'),
  amountPerInterval: 1_000_000, // 1 USDC per interval
  intervalSeconds: 2_592_000,   // 30 days
  totalIntervals: 12,           // 12 months
  streamName: 'Monthly Subscription',
});

// Get all streams for the connected wallet
const { incoming, outgoing } = await client.getMyStreams();

// Withdraw from a stream (as recipient)
const withdrawSig = await client.withdrawFromStream(streamAddress);

// Cancel a stream and get refund (as sender)
const cancelSig = await client.cancelStream(streamAddress);
```

## API Reference

### P01StreamClient

Main client class for creating and managing payment streams.

| Method | Description |
|---|---|
| `constructor(config: P01Config)` | Create a new client with network and RPC configuration |
| `connect(wallet)` | Connect a wallet provider |
| `disconnect()` | Disconnect the wallet |
| `createStream(params)` | Create a new payment stream |
| `cancelStream(address)` | Cancel a stream and refund remaining balance |
| `withdrawFromStream(address)` | Withdraw available funds from a stream |
| `getStream(address)` | Get a stream by its on-chain address |
| `getOutgoingStreams(sender)` | Get all streams sent by a wallet |
| `getIncomingStreams(recipient)` | Get all streams received by a wallet |
| `getMyStreams()` | Get both incoming and outgoing streams for the connected wallet |
| `getWithdrawableAmount(stream)` | Calculate the withdrawable amount for a stream |
| `getRefundAmount(stream)` | Calculate the refund amount if a stream is cancelled |

### Factory Functions

| Function | Description |
|---|---|
| `createDevnetClient()` | Create a pre-configured client for devnet |
| `createMainnetClient()` | Create a pre-configured client for mainnet |

### Types

- `P01Config` -- SDK configuration (rpcUrl, network, programId, commitment)
- `Stream` -- Stream account data (sender, recipient, mint, amounts, status)
- `StreamStatus` -- Enum: Active, Paused, Cancelled, Completed
- `CreateStreamParams` -- Parameters for creating a stream
- `P01WalletProvider` -- Wallet provider interface

## License

MIT
