# @protocol-01/zk-sdk

Zero-knowledge privacy SDK for Solana. Shield, transfer, and unshield tokens with mathematical privacy guarantees using Groth16 proofs and Poseidon hashing.

## Install

```bash
npm install @protocol-01/zk-sdk @solana/web3.js
```

Requires Node.js >= 22.0.0 and `@solana/web3.js` ^1.98.0 as a peer dependency.

## Quick Start

```typescript
import { ShieldedClient } from '@protocol-01/zk-sdk';
import { Connection } from '@solana/web3.js';

// Create and initialize the client
const client = new ShieldedClient({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: yourAnchorWallet,
  network: 'devnet',
  wasmPath: './circuits/transfer.wasm',
  zkeyPath: './circuits/transfer_final.zkey',
});

await client.initialize('your seed phrase');

// Get your ZK address to receive shielded payments
const zkAddr = client.getZkAddress();
console.log('Share this address:', zkAddr.encoded); // "zk:base64..."

// Shield 0.1 SOL into the shielded pool
const shieldTx = await client.shield(100_000_000n);

// Transfer privately within the pool
const recipient = ShieldedClient.decodeZkAddress('zk:...');
const transferTx = await client.transfer(recipient, 50_000_000n);

// Unshield back to a public address
const unshieldTx = await client.unshield(recipientPublicKey, 50_000_000n);
```

## Configuration

### Basic (devnet)

```typescript
const client = new ShieldedClient({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: anchorWallet,
  // Defaults: network='devnet', uses the deployed devnet program ID
});
```

### Custom program ID

```typescript
const client = new ShieldedClient({
  connection,
  wallet,
  programId: 'YourCustomProgramId11111111111111111111111111',
});
```

### Hosted circuit files

```typescript
const client = new ShieldedClient({
  connection,
  wallet,
  circuitBaseUrl: 'https://cdn.example.com/circuits/v1',
  // Prover will load transfer.wasm and transfer_final.zkey from this URL
});
```

### Network selection

```typescript
import { getProgramId } from '@protocol-01/zk-sdk';

getProgramId('devnet');       // 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c'
getProgramId('localnet');     // 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c'
getProgramId('mainnet-beta'); // throws: not yet deployed
```

## API Reference

### Exports from `@protocol-01/zk-sdk`

| Export | Type | Description |
|---|---|---|
| `ShieldedClient` | class | High-level client for shield/transfer/unshield operations |
| `ShieldedClientConfig` | type | Configuration interface for `ShieldedClient` |
| `Note` | class | Represents a shielded UTXO note |
| `EncryptedNote` | class | Encrypted note for storage/transmission |
| `createNote` | function | Create a new shielded note with Poseidon commitment |
| `encryptNote` | function | Encrypt a note using NaCl authenticated encryption |
| `decryptNote` | function | Decrypt an encrypted note |
| `MerkleTree` | class | Sparse Merkle tree with Poseidon hashing |
| `generateMerkleProof` | function | Generate a Merkle inclusion proof |
| `verifyMerkleProof` | function | Verify a Merkle proof against a root |
| `ZkProver` | class | Groth16 proof generation engine |
| `generateProof` | function | Convenience wrapper for proof generation |
| `poseidonHash` | function | Poseidon hash over field elements |
| `computeCommitment` | function | Compute `Poseidon(amount, owner, randomness, mint)` |
| `computeNullifier` | function | Compute `Poseidon(commitment, spendingKeyHash)` |
| `deriveOwnerPubkey` | function | Derive owner public key from spending key |
| `computeSpendingKeyHash` | function | Derive spending key hash for nullifiers |
| `FIELD_MODULUS` | constant | BN254 field modulus |
| `ZK_SHIELDED_PROGRAM_ID` | constant | Default devnet program ID |
| `PROGRAM_IDS` | constant | Program IDs by network |
| `getProgramId` | function | Get program ID for a network (with validation) |

### Sub-path Imports

```typescript
import { ShieldedClient } from '@protocol-01/zk-sdk/client';
import { createNote, encryptNote } from '@protocol-01/zk-sdk/notes';
import { MerkleTree } from '@protocol-01/zk-sdk/merkle';
import { ZkProver } from '@protocol-01/zk-sdk/prover';
import { poseidonHash, computeCommitment } from '@protocol-01/zk-sdk/circuits';
```

## Modules

### ShieldedClient

The main entry point for most users. Manages spending keys, note selection, proof generation, and transaction building.

```typescript
const client = new ShieldedClient(config);
await client.initialize(seedPhrase);

// Core operations
await client.shield(amount);                       // deposit to shielded pool
await client.transfer(recipientZkAddress, amount); // private transfer
await client.unshield(recipientPubkey, amount);    // withdraw to public

// State
const balance = await client.getShieldedBalance();
const zkAddr = client.getZkAddress();
client.destroy(); // securely wipe keys from memory
```

### Notes

Create and manage shielded UTXO notes.

```typescript
import { createNote, encryptNote, decryptNote } from '@protocol-01/zk-sdk';

const note = await createNote(amount, ownerPubkey, tokenMintField);
const encrypted = encryptNote(note, viewingKey);
const decrypted = decryptNote(encrypted, viewingSecretKey);
```

### Merkle Tree

Sparse Poseidon Merkle tree (depth 20, supports ~1M notes).

```typescript
import { MerkleTree } from '@protocol-01/zk-sdk';

const tree = new MerkleTree(20);
await tree.initialize();

const leafIndex = tree.insert(noteCommitment);
const proof = tree.generateProof(leafIndex);
const valid = tree.verifyProof(proof, noteCommitment, tree.root);
```

### ZK Prover

Generate Groth16 proofs client-side using snarkjs.

```typescript
import { ZkProver, generateProof } from '@protocol-01/zk-sdk';

// Class-based
const prover = new ZkProver('./transfer.wasm', './transfer_final.zkey');
const { proof, publicSignals } = await prover.generateTransferProof(pubInputs, privInputs);

// Function-based
const result = await generateProof(fullInputs, wasmPath, zkeyPath);

// With hosted circuits
const prover = new ZkProver(undefined, undefined, {
  circuitBaseUrl: 'https://cdn.example.com/circuits/v1',
});
```

### Viewing Keys

Zcash-style viewing key hierarchy for selective disclosure.

```typescript
import {
  generateSpendingKey,
  deriveFullViewingKey,
  deriveIncomingViewingKey,
} from '@protocol-01/zk-sdk/keys/viewKeys';

const sk = generateSpendingKey(entropy);
const fvk = deriveFullViewingKey(sk);         // view all transactions
const ivk = deriveIncomingViewingKey(fvk);    // view incoming only
```

### Circuits (Poseidon)

Low-level Poseidon hash primitives used throughout the system.

```typescript
import { poseidonHash, computeCommitment, computeNullifier } from '@protocol-01/zk-sdk';

const hash = await poseidonHash([field1, field2]);
const commitment = await computeCommitment(amount, owner, randomness, tokenMint);
const nullifier = await computeNullifier(commitment, spendingKeyHash);
```

## Circuit Files

The prover requires two circuit files to generate Groth16 proofs:

| File | Description | Size |
|---|---|---|
| `transfer.wasm` | Compiled circuit (WebAssembly) | ~11 MB |
| `transfer_final.zkey` | Proving key (Groth16) | ~24 MB |
| `verification_key.json` | Verification key (for local verify) | ~2 KB |

### Where to get them

Download pre-built circuit files from: https://github.com/protocol-01/circuits

### How to configure

```typescript
// Option 1: Local file paths (Node.js)
new ZkProver('./circuits/transfer.wasm', './circuits/transfer_final.zkey');

// Option 2: Hosted URL
new ZkProver(undefined, undefined, {
  circuitBaseUrl: 'https://cdn.example.com/circuits/v1',
});

// Option 3: Via ShieldedClient config
new ShieldedClient({
  connection,
  wallet,
  circuitBaseUrl: 'https://cdn.example.com/circuits/v1',
});
```

### Building circuits from source

```bash
# Requires circom v2.2.2 and snarkjs v0.7.5
cd circuits/
circom transfer.circom --wasm --r1cs
snarkjs groth16 setup transfer.r1cs pot20_final.ptau transfer_0000.zkey
echo "random entropy" | snarkjs zkey contribute transfer_0000.zkey transfer_final.zkey
snarkjs zkey export verificationkey transfer_final.zkey verification_key.json
```

## Error Handling

### Common errors and solutions

| Error | Cause | Fix |
|---|---|---|
| `Circuit file not found` | WASM/zkey files missing | Set `circuitBaseUrl`, or pass explicit `wasmPath`/`zkeyPath` |
| `Client not initialized` | Called methods before `initialize()` | Call `await client.initialize(seed)` first |
| `getProgramId: unknown network` | Invalid network name | Use `'devnet'`, `'mainnet-beta'`, or `'localnet'` |
| `getProgramId: not yet deployed on 'mainnet-beta'` | Mainnet not available | Use `'devnet'` for testing, or pass a custom `programId` |
| `Proof generation timeout` | Proof took > 2 minutes | Ensure circuit files are correct; check available memory |
| `Insufficient shielded balance` | Not enough notes to cover amount | Shield more tokens first |
| `createNote: amount must be non-negative` | Negative amount passed | Use `amount >= 0n` |
| `sync() is not yet implemented` | Called `sync()` | Use `scanForNotes()` with a custom indexer instead |
| `SPL token shielding requires token account resolution` | Tried to shield an SPL token | Use `@protocol-01/zkspl-sdk` for SPL tokens |

### Prover troubleshooting

If proof generation fails, verify:

1. Circuit files exist at the configured paths
2. The WASM file matches the zkey (same circuit, same trusted setup)
3. Input values are within the BN254 field (< FIELD_MODULUS)
4. Sufficient memory is available (~512 MB for the transfer circuit)

## Network Support

| Network | Status | Program ID |
|---|---|---|
| devnet | Fully supported | `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` |
| mainnet-beta | Deployment pending | Pass custom `programId` when available |
| localnet | Supported (same ID) | `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` |

## Security

- **Spending keys never leave the device.** All key derivation and proof generation happens client-side.
- **All proofs generated locally.** There is no remote prover fallback. If local proving fails, it fails.
- **No remote dependencies at runtime.** The SDK only talks to Solana RPC; there are no Protocol 01 servers in the path.
- **Viewing keys are separate from spending keys.** You can share an incoming viewing key for auditing without granting spend authority.
- **Nullifier-based double-spend prevention.** Each note can only be spent once, enforced on-chain.

## Migration from Internal Usage

If you were importing from the monorepo directly, the public API is identical. The only differences:

1. `sync()` now throws with a descriptive message instead of silently doing nothing
2. `scanForNotes()` logs a warning that it returns local cache only
3. `RelayerNetwork` logs a deprecation warning on construction

All existing function signatures, return types, and default values are preserved.

## Circuit Setup (Quick)

The ZK prover needs compiled circuit files (WASM + zkey) that are too large to bundle
with the npm package (~35 MB total). Run the setup script to copy them from the monorepo:

```bash
# From within the monorepo (after cloning Protocol-01):
cd packages/zk-sdk
npm run setup

# Or via npx (after installing @protocol-01/zk-sdk):
npx p01-setup
```

This copies all 6 circuits into a `circuits/` directory in your current working directory:

| Circuit | WASM | zkey | vkey |
|---|---|---|---|
| transfer | transfer.wasm | transfer_final.zkey | transfer_vk.json |
| confidential_balance | confidential_balance.wasm | confidential_balance_final.zkey | confidential_balance_vk.json |
| balance_proof | balance_proof.wasm | balance_proof_final.zkey | balance_proof_vk.json |
| denominated_pool | denominated_pool.wasm | denominated_pool_final.zkey | denominated_pool_vk.json |
| denominated_transfer | denominated_transfer.wasm | denominated_transfer_final.zkey | denominated_transfer_vk.json |
| subscriber_ownership | subscriber_ownership.wasm | subscriber_ownership_final.zkey | subscriber_ownership_vk.json |

If you are using the SDK outside the monorepo, download the circuit files from:
https://github.com/protocol-01/circuits/releases

Then point the prover at them:

```typescript
const prover = new ZkProver('./circuits/transfer.wasm', './circuits/transfer_final.zkey');
```

## License

MIT
