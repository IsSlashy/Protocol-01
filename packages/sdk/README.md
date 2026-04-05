# @protocol-01/streams

Payment streams for Solana. Create, manage, and withdraw from continuous payment streams with time-based token unlocking.

## Install

```bash
npm install @protocol-01/streams @solana/web3.js
```

`@solana/web3.js` is a peer dependency and must be installed alongside the SDK.

## Quick Start

```typescript
import { createDevnetClient, StreamStatus } from '@protocol-01/streams';
import { PublicKey } from '@solana/web3.js';

// 1. Create a client
const client = createDevnetClient();

// 2. Connect your wallet (any @solana/wallet-adapter-compatible provider)
client.connect(walletProvider);

// 3. Create a payment stream
const sig = await client.createStream({
  recipient: new PublicKey('recipient_address'),
  mint: new PublicKey('token_mint_address'),
  amountPerInterval: 1_000_000, // 1 USDC per interval
  intervalSeconds: 2_592_000,   // 30 days
  totalIntervals: 12,           // 12 months
  streamName: 'Monthly Subscription',
});
console.log('Stream created:', sig);

// 4. Check stream status
const { incoming, outgoing } = await client.getMyStreams();
for (const stream of incoming) {
  const withdrawable = client.getWithdrawableAmount(stream);
  console.log(`${stream.streamName}: ${withdrawable} tokens available`);
}

// 5. Withdraw unlocked funds (as recipient)
const withdrawSig = await client.withdrawFromStream(streamAddress);

// 6. Cancel a stream (as sender) -- remaining funds returned
const cancelSig = await client.cancelStream(streamAddress);
```

## Stream Lifecycle

1. **Create** -- Sender locks `amountPerInterval * totalIntervals` tokens in an escrow PDA.
2. **Active** -- Funds unlock linearly, one `amountPerInterval` per `intervalSeconds`.
3. **Withdraw** -- Recipient claims all unlocked funds at any time (batched).
4. **Complete** -- Stream ends naturally after all intervals are paid.
5. **Cancel** -- Sender cancels early; unstreamed remainder is refunded, already-withdrawn funds stay with recipient.

## API Reference

### P01StreamClient

| Method | Parameters | Returns | Description |
|---|---|---|---|
| `constructor(config)` | `P01Config` | `P01StreamClient` | Create a client with network/RPC configuration |
| `connect(wallet)` | `P01WalletProvider` | `void` | Connect a wallet provider |
| `disconnect()` | -- | `void` | Disconnect the wallet |
| `createStream(params)` | `CreateStreamParams` | `Promise<string>` | Create a new payment stream; returns tx signature |
| `cancelStream(address)` | `PublicKey` | `Promise<string>` | Cancel a stream and refund remaining balance; returns tx signature |
| `withdrawFromStream(address)` | `PublicKey` | `Promise<string>` | Withdraw available funds from a stream; returns tx signature |
| `getStream(address)` | `PublicKey` | `Promise<Stream \| null>` | Fetch and parse a stream by its on-chain address |
| `getOutgoingStreams(sender)` | `PublicKey` | `Promise<Stream[]>` | Get all streams sent by a wallet |
| `getIncomingStreams(recipient)` | `PublicKey` | `Promise<Stream[]>` | Get all streams received by a wallet |
| `getMyStreams()` | -- | `Promise<{ incoming, outgoing }>` | Get both directions for the connected wallet |
| `getWithdrawableAmount(stream)` | `Stream` | `bigint` | Calculate withdrawable amount (local, no RPC) |
| `getRefundAmount(stream)` | `Stream` | `bigint` | Calculate refund amount if cancelled now |

### Factory Functions

| Function | Parameters | Description |
|---|---|---|
| `createDevnetClient(overrides?)` | `ClientOverrides?` | Pre-configured client for devnet |
| `createMainnetClient(overrides?)` | `ClientOverrides?` | Pre-configured client for mainnet-beta |

Both accept an optional `{ programId?, rpcUrl? }` to override defaults:

```typescript
// Custom RPC endpoint (e.g. Helius for reliability)
const client = createDevnetClient({
  rpcUrl: 'https://devnet.helius-rpc.com/?api-key=YOUR_KEY',
});

// Custom program ID (local testing / fork)
const client = createDevnetClient({
  programId: new PublicKey('YourProgramId...'),
});
```

### Types

| Type | Description |
|---|---|
| `P01Config` | Full SDK config: `rpcUrl`, `network`, `programId?`, `commitment?` |
| `ClientOverrides` | Optional overrides for factory functions: `programId?`, `rpcUrl?` |
| `Stream` | Parsed stream account: sender, recipient, mint, amounts, status |
| `StreamStatus` | Enum: `Active`, `Paused`, `Cancelled`, `Completed` |
| `CreateStreamParams` | Parameters for `createStream()` |
| `P01WalletProvider` | Wallet provider interface (compatible with `@solana/wallet-adapter`) |
| `StreamEvent` | Discriminated union of stream lifecycle events |
| `SubscriptionTier` | SaaS tier configuration (name, price, features) |

### Constants

| Constant | Description |
|---|---|
| `STREAM_PROGRAM_ID_DEVNET` | Stream program address on devnet |
| `STREAM_PROGRAM_ID_MAINNET` | Stream program address on mainnet (placeholder until deployed) |
| `INTERVALS` | Named intervals: `HOURLY`, `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY` |
| `P01_TIERS` | Pre-defined subscription tiers: `basic`, `pro`, `enterprise` |
| `NATIVE_SOL_MINT` | Wrapped SOL mint address |
| `USDC_MINT_DEVNET` / `USDC_MINT_MAINNET` | USDC mint addresses per network |
| `IX_DISCRIMINATOR_CREATE_STREAM` | Anchor instruction discriminator for `create_stream` |
| `IX_DISCRIMINATOR_CANCEL_STREAM` | Anchor instruction discriminator for `cancel_stream` |
| `IX_DISCRIMINATOR_WITHDRAW` | Anchor instruction discriminator for `withdraw` |
| `STREAM_ACCOUNT_SIZE` | Approximate stream account size for `getProgramAccounts` filters |

### Utility Functions

| Function | Description |
|---|---|
| `deriveStreamPDA(programId, sender, recipient, mint)` | Derive the stream account PDA |
| `deriveEscrowPDA(programId, stream)` | Derive the escrow token account PDA |
| `calculateWithdrawableAmount(...)` | Calculate withdrawable tokens for a stream |
| `calculateRefundAmount(...)` | Calculate refund if stream is cancelled |
| `formatLamports(lamports)` | Format lamports as a SOL string |
| `formatTokenAmount(amount, decimals)` | Format token amount with decimal places |
| `parseSolToLamports(sol)` | Convert SOL to lamports |
| `parseTokenAmount(amount, decimals)` | Convert human-readable amount to base units |
| `formatInterval(seconds)` | Format seconds as "2 hours", "30 days", etc. |
| `hasPaymentsDue(...)` | Check if a stream has unclaimed payments |
| `generateStreamName(prefix?)` | Generate a unique stream name |

## Configuration

### Networks

```typescript
// Devnet (default for development)
const client = createDevnetClient();

// Mainnet (throws until program is deployed -- use programId override to test)
const client = createMainnetClient();

// Full manual config
const client = new P01StreamClient({
  network: 'devnet',
  rpcUrl: 'https://your-rpc.com',
  programId: new PublicKey('...'),
  commitment: 'finalized',
});
```

## Error Handling

All mutation methods throw descriptive errors:

| Error | Cause |
|---|---|
| `"Wallet not connected"` | Called a write method without connecting a wallet first |
| `"createStream: amount must be positive"` | `amountPerInterval` is zero or negative |
| `"createStream: invalid recipient address"` | `recipient` is not a valid Solana public key |
| `"createStream: intervalSeconds must be positive"` | Zero or negative interval duration |
| `"createStream: totalIntervals must be positive"` | Zero or negative interval count |
| `"Stream not found"` | No account exists at the given stream address |
| `"Only the stream sender can cancel"` | Connected wallet is not the stream creator |
| `"Only the stream recipient can withdraw"` | Connected wallet is not the designated recipient |
| `"Stream program is not yet deployed on mainnet-beta..."` | `createMainnetClient()` called without `programId` override before mainnet launch |

## Network Support

| Network | Status |
|---|---|
| devnet | Deployed and tested |
| mainnet-beta | Coming soon |
| testnet | Untested |

## License

MIT
