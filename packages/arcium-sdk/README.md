# @protocol-01/arcium-sdk

Multi-party computation (MPC) privacy layer for Protocol 01, powered by the [Arcium Network](https://arcium.com).

> **Internal SDK** -- This package requires deep understanding of MPC concepts and the Arcium network. For most use cases, use `@protocol-01/privacy-sdk` which provides higher-level abstractions.

## What is MPC?

Multi-party computation allows N parties to jointly compute a function over their private inputs without revealing those inputs to each other. In Protocol 01, Arcium's MPC network (ARX nodes) executes cryptographic circuits on secret-shared data. As long as at least one node is honest, no party ever sees the plaintext inputs -- only the final result is revealed.

## Modules

| Module | Circuit | What It Does |
|--------|---------|-------------|
| **Relay** | `threshold_decrypt` | Threshold TX decryption -- N-of-M Arcium nodes must agree to decrypt and submit a transaction. The user's wallet never appears on-chain. |
| **Registry** | `private_lookup` | Private meta-address queries -- look up a stealth recipient without revealing who you're looking up to the RPC node. |
| **Nullifier** | `nullifier_commit` | Unlinkable spent-note tracking -- prevents double-spend by computing SHA3 commitments without revealing the actual nullifier. |
| **Audit** | `balance_audit` | Solvency proofs -- prove total balance across accounts without revealing individual amounts. |
| **Stealth** | `stealth_scan` | Protected viewing key scanning -- scan for incoming stealth payments without exposing your viewing key to any single party. |
| **Governance** | `private_vote` / `private_vote_binary` | Encrypted ballot tallying -- vote privately, results computed via MPC. Supports multi-option and binary (yes/no) voting. |
| **Auction** | `sealed_bid_auction` / `finalize_auction` | Encrypted bid matching -- bids are sealed until MPC reveals the winner. Losing bids remain confidential. |
| **Mugen** | `mugen_submit_offer` / `mugen_blind_take` / `mugen_cancel_offer` | Encrypted P2P order matching for the Mugen fiat-to-crypto exchange. Trade terms are invisible to everyone until a match occurs. |

## Install

```bash
npm install @protocol-01/arcium-sdk
```

### Peer dependencies

The Arcium client libraries must be available:

```bash
npm install @arcium-hq/client@0.9.2 @arcium-hq/reader@0.9.2
```

## Quick Start

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, submitConfidentialRelayJob, awaitRelayCompletion } from '@protocol-01/arcium-sdk';

// 1. Create and initialize the client
const connection = new Connection('https://api.devnet.solana.com');
const wallet = new anchor.Wallet(Keypair.generate());

const client = new ArciumClient({ connection, wallet });
await client.initialize(); // establishes x25519 shared secret with MXE

// 2. Encrypt data for MPC
const payload = client.encrypt([100n, 200n, 300n]);
// payload.ciphertexts -- Rescue CTR-mode blocks
// payload.publicKey   -- ephemeral x25519 key
// payload.nonce       -- random 16-byte nonce

// 3. Submit to an MPC circuit (example: confidential relay)
const program = new anchor.Program(idl, client.getProvider());
const job = await submitConfidentialRelayJob(
  client,
  program,
  serializedTx,
  10_000n,      // fee in lamports
  BigInt(slot + 100), // deadline slot
);

// 4. Wait for MPC result
const result = await awaitRelayCompletion(client, job.computationOffset);
console.log('Relayed TX:', result.relayedTxSignature);
```

## Configuration

```typescript
import { ArciumClient, P01_ARCIUM_PROGRAM_ID, ARCIUM_CLUSTER_OFFSET } from '@protocol-01/arcium-sdk';

const client = new ArciumClient({
  connection,            // Solana Connection (devnet or mainnet)
  wallet,                // Anchor-compatible wallet
  programId: P01_ARCIUM_PROGRAM_ID,  // default: FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT
  clusterOffset: ARCIUM_CLUSTER_OFFSET, // default: 456
});

// Must call initialize() before encrypt/decrypt
await client.initialize();
```

## Architecture

```
User App
  |
  v
ArciumClient  -- x25519 key exchange + RescueCipher encryption
  |
  v
P01 Arcium Program (on-chain)  -- CPIs into Arcium runtime
  |
  v
Arcium MPC Network (ARX nodes)  -- Cerberus protocol, secret shares
  |
  v
Callback  -- signed result delivered on-chain
  |
  v
ArciumClient.decrypt()  -- user decrypts with same shared secret
```

- **ArciumClient** wraps the Arcium network client with Protocol 01 conventions
- Each module uses **RescueCipher** for field-level encryption (Rescue hash-based CTR mode)
- **x25519** key exchange establishes a shared secret with the MXE (MPC execution environment)
- Ephemeral keys rotate every 10 operations to limit exposure windows
- All computation happens on Arcium's decentralized MPC network -- no single party sees plaintext

## API Reference

### ArciumClient

| Method | Description |
|---|---|
| `constructor(config)` | Create client with connection, wallet, optional program ID and cluster offset |
| `initialize()` | Establish x25519 shared secret with MXE (required before encrypt/decrypt) |
| `encrypt(values)` | Encrypt `bigint[]` into Rescue CTR-mode ciphertext blocks |
| `decrypt(ciphertexts, nonce)` | Decrypt MPC result back to `bigint[]` |
| `newComputationOffset()` | Generate a unique random offset for a new MPC job |
| `nonceToU128(nonce)` | Convert 16-byte nonce to Anchor BN for instruction args |
| `getComputationAccounts(circuit, offset)` | Derive all Arcium PDA addresses for a computation |
| `awaitFinalization(offset)` | Block until MPC result callback arrives |
| `rotateKeys()` | Manually rotate ephemeral keys (auto-rotates every 10 ops) |
| `deriveProxyPDA()` | Derive an unlinkable PDA from the ephemeral session key |
| `getProxyIdentifier()` | Get a 32-byte SHA-256 pseudonymous identifier |

### Module Functions

Each module exports async functions that take an `ArciumClient` and an Anchor `Program`:

| Module | Functions |
|---|---|
| Relay | `submitConfidentialRelayJob()`, `awaitRelayCompletion()`, `relayTransaction()` |
| Registry | `privateLookup()` |
| Nullifier | `commitNullifier()`, `checkNullifierSpent()` |
| Audit | `submitBalanceForAudit()`, `finalizeAudit()` |
| Stealth | `registerViewingKey()`, `scanAnnouncements()` |
| Governance | `createProposal()`, `castVote()`, `finalizeTally()`, `castBinaryVote()`, `finalizeBinaryTally()` |
| Auction | `createAuction()`, `submitSealedBid()`, `finalizeAuction()`, `writeEscrowOutcome()`, `releaseEscrow()` |
| Mugen | `submitEncryptedOffer()`, `blindTakeOrder()`, `cancelEncryptedOffer()` |

### PDA Helpers

| Function | Module | Description |
|---|---|---|
| `getRelayJobAddress(programId, jobId)` | Relay | Derive relay job PDA |
| `getRegistryAddress(wallet)` | Registry | Derive registry PDA for a wallet |
| `getNullifierSetAddress(programId, poolId)` | Nullifier | Derive encrypted nullifier set PDA |
| `getNullifierCommitmentAddress(programId, commitment)` | Nullifier | Derive commitment PDA |
| `getAuditAccumulatorAddress(programId, auditId)` | Audit | Derive audit accumulator PDA |
| `getViewingKeyAddress(programId, owner)` | Stealth | Derive encrypted viewing key PDA |
| `getProposalAddress(programId, proposalId)` | Governance | Derive proposal PDA |
| `getBallotAddress(programId, proposalId, voter)` | Governance | Derive ballot receipt PDA |
| `getAuctionAddress(programId, auctionId)` | Auction | Derive auction PDA |
| `getEscrowAddress(programId, auctionId, nullifier)` | Auction | Derive auction escrow PDA |

## Error Handling

All module functions wrap MPC failures with descriptive messages:

| Error Pattern | Cause |
|---|---|
| `"Failed to connect to Arcium network..."` | MXE account unreadable -- program not deployed or RPC unreachable |
| `"Cipher initialization failed..."` | MXE x25519 key is zeroed or missing -- wrong program ID for cluster |
| `"Client not initialized..."` | Called `encrypt()`/`decrypt()` before `initialize()` |
| `"{Module} MPC computation failed: {original}..."` | On-chain submission or Arcium finalization failed -- cluster may be down or inputs invalid |

## Subpath Imports

Individual modules can be imported directly for tree-shaking:

```typescript
import { submitConfidentialRelayJob } from '@protocol-01/arcium-sdk/relay';
import { privateLookup } from '@protocol-01/arcium-sdk/registry';
import { commitNullifier } from '@protocol-01/arcium-sdk/nullifier';
import { submitBalanceForAudit } from '@protocol-01/arcium-sdk/audit';
import { scanAnnouncements } from '@protocol-01/arcium-sdk/stealth';
import { castVote } from '@protocol-01/arcium-sdk/governance';
```

## Requirements

- `@arcium-hq/client` and `@arcium-hq/reader` (peer dependencies)
- Active Arcium network connection (devnet cluster)
- `@coral-xyz/anchor` ^0.32.1
- `@solana/web3.js` ^1.98.4
- Node.js >= 22

## License

MIT
