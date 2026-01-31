# @p01/zk-sdk

Zero-knowledge SDK for Protocol 01 shielded transactions on Solana. Uses Groth16 proofs and Poseidon hashing to enable fully private token transfers through a shielded pool.

## Installation

```bash
npm install @p01/zk-sdk @solana/web3.js
```

Requires Node.js >= 18.0.0.

## Quick Start

```typescript
import {
  ShieldedClient,
  MerkleTree,
  ZkProver,
  createNote,
  poseidonHash,
  computeCommitment,
} from '@p01/zk-sdk';
import { Connection } from '@solana/web3.js';

// Initialize the shielded client
const client = new ShieldedClient({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: anchorWallet,
  wasmPath: './circuits/transfer.wasm',
  zkeyPath: './circuits/transfer.zkey',
});

// Initialize with a seed phrase to derive spending keys
await client.initialize('your seed phrase here');

// Get your ZK address for receiving shielded payments
const zkAddress = client.getZkAddress();
console.log('Share this address:', zkAddress.encoded);

// Shield tokens (deposit from transparent to shielded)
const shieldResult = await client.shield(1_000_000n); // 1 USDC

// Transfer within the shielded pool
const recipientAddress = ShieldedClient.decodeZkAddress('zk:...');
const transferResult = await client.transfer(recipientAddress, 500_000n);

// Unshield tokens (withdraw from shielded to transparent)
const unshieldResult = await client.unshield(recipientPublicKey, 500_000n);

// Check shielded balance
const balance = await client.getShieldedBalance();
```

## API Reference

### ShieldedClient

High-level client for shielded pool interactions.

| Method | Description |
|---|---|
| `constructor(config: ShieldedClientConfig)` | Create a new client with connection, wallet, and circuit paths |
| `initialize(seedPhrase)` | Initialize spending keys from a seed phrase |
| `getZkAddress()` | Get your ZK address for receiving shielded payments |
| `shield(amount)` | Deposit tokens from transparent to shielded pool |
| `transfer(recipient, amount)` | Transfer tokens within the shielded pool |
| `unshield(recipient, amount)` | Withdraw tokens from shielded pool to a public address |
| `getShieldedBalance()` | Get total shielded balance |
| `scanForNotes(fromIndex?)` | Scan for incoming shielded payments |
| `sync()` | Sync local state with on-chain state |
| `static decodeZkAddress(encoded)` | Decode a ZK address from its string representation |

### Note Management

| Export | Description |
|---|---|
| `createNote(amount, owner, tokenMint)` | Create a new encrypted note |
| `encryptNote(note)` | Encrypt a note for storage |
| `decryptNote(encrypted)` | Decrypt an encrypted note |
| `Note` | Note class |
| `EncryptedNote` | Encrypted note class |

### Merkle Tree

| Export | Description |
|---|---|
| `MerkleTree` | Merkle tree implementation for commitment tracking |
| `generateMerkleProof(tree, leafIndex)` | Generate a Merkle proof for a leaf |
| `verifyMerkleProof(proof)` | Verify a Merkle proof |

### ZK Prover

| Export | Description |
|---|---|
| `ZkProver` | Proof generation engine (Groth16) |
| `generateProof(inputs)` | Generate a zero-knowledge proof |

### Circuit Utilities

| Export | Description |
|---|---|
| `poseidonHash(...)` | Poseidon hash function |
| `computeCommitment(amount, owner, randomness)` | Compute a note commitment |
| `computeNullifier(commitment, key)` | Compute a nullifier for spending |
| `deriveOwnerPubkey(spendingKey)` | Derive the owner public key from a spending key |
| `FIELD_MODULUS` | The BN254 field modulus constant |

### Sub-path Imports

```typescript
import { ShieldedClient } from '@p01/zk-sdk/client';
import { createNote, encryptNote } from '@p01/zk-sdk/notes';
import { MerkleTree } from '@p01/zk-sdk/merkle';
import { ZkProver } from '@p01/zk-sdk/prover';
import { poseidonHash, computeCommitment } from '@p01/zk-sdk/circuits';
```

## License

MIT
