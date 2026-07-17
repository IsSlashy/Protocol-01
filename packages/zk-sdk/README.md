# @protocol-01/zk-sdk

Zero-knowledge privacy SDK for Solana. Shield, transfer, and unshield tokens with mathematical privacy guarantees using Groth16 proofs and Poseidon hashing.

> **⚠️ Legacy — Groth16 was retired from the shipping Protocol 01 stack in March 2026.**
> This SDK still works with the original Circom + snarkjs pipeline for callers that need it, but the mobile app, extension, and on-chain programs (`zk_shielded`, `p01_zkspl`) now run on **ZK-STARKs** via [`@protocol-01/privacy-sdk`](../privacy-sdk/) and the custom FRI verifier in [`programs/p01_stark_verifier`](../../programs/p01_stark_verifier/). Use this SDK only for migration / backfill work — new integrations should target the STARK path.

## Install

```bash
npm install @protocol-01/zk-sdk @solana/web3.js
```

Requires Node.js >= 22.0.0 and `@solana/web3.js` ^1.98.0 as a peer dependency.

## Quick Start

> **1.0.0 changed the surface.** The all-in-one `ShieldedClient` (Groth16) was
> removed when this package migrated to STARKs. `@protocol-01/zk-sdk` now ships
> the note/Merkle/commitment primitives plus a thin re-export of the STARK
> prover. For a full high-level client (shield/transfer/unshield end-to-end),
> use [`@protocol-01/privacy-sdk`](../privacy-sdk/). Use this package when you
> want the primitives directly.

```typescript
import {
  createNote,
  computeCommitment,
  computeNullifier,
  MerkleTree,
  createStarkProver,
  STARK_CIRCUITS,
} from '@protocol-01/zk-sdk';
import { Connection, Keypair } from '@solana/web3.js';

// 1. Build a shielded note and its Poseidon commitment.
const note = createNote({ amount: 100_000_000n, ownerPubkey, tokenMint });
const commitment = computeCommitment(note.amount, note.ownerPubkey, note.randomness, note.tokenMint);

// 2. Track notes in a Poseidon Merkle tree (depth 20, ~1M leaves).
const tree = new MerkleTree(20);
const leafIndex = tree.insert(commitment);
const proof = tree.generateProof(leafIndex);

// 3. Generate + submit a post-quantum STARK proof on-chain.
const prover = createStarkProver({
  connection: new Connection('https://api.devnet.solana.com'),
  payer: Keypair.fromSecretKey(/* ... */),
});
const { proofBuffer } = await prover.generateStarkProof(STARK_CIRCUITS.transfer, privateInputs);
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
| `Note` | class | Represents a shielded UTXO note |
| `EncryptedNote` | class | Encrypted note for storage/transmission |
| `createNote` | function | Create a new shielded note with Poseidon commitment |
| `encryptNote` | function | Encrypt a note using NaCl authenticated encryption |
| `decryptNote` | function | Decrypt an encrypted note |
| `MerkleTree` | class | Sparse Merkle tree with Poseidon hashing |
| `generateMerkleProof` | function | Generate a Merkle inclusion proof |
| `verifyMerkleProof` | function | Verify a Merkle proof against a root |
| `createStarkProver` | function | Build a post-quantum STARK prover (re-exported from `@protocol-01/stark-prover`) |
| `STARK_CIRCUITS` | constant | Circuit-id enum for the STARK prover |
| `requestTransferProof` / `requestMerkleUpdateProof` | function | Circuit-specific proof helpers |
| `poseidonHash` | function | Poseidon hash over field elements |
| `computeCommitment` | function | Compute `Poseidon(amount, owner, randomness, mint)` |
| `computeNullifier` | function | Compute `Poseidon(commitment, spendingKeyHash)` |
| `deriveOwnerPubkey` | function | Derive owner public key from spending key |
| `computeSpendingKeyHash` | function | Derive spending key hash for nullifiers |
| `FIELD_MODULUS` | constant | Field modulus |
| `ZK_SHIELDED_PROGRAM_ID` | constant | Default devnet program ID |
| `PROGRAM_IDS` | constant | Program IDs by network |
| `getProgramId` | function | Get program ID for a network (with validation) |

### Sub-path Imports

```typescript
import { createNote, encryptNote } from '@protocol-01/zk-sdk/notes';
import { MerkleTree } from '@protocol-01/zk-sdk/merkle';
import { createStarkProver } from '@protocol-01/zk-sdk/prover';
import { poseidonHash, computeCommitment } from '@protocol-01/zk-sdk/circuits';
```

## Modules

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

### STARK Prover

Generate post-quantum STARK proofs and submit them on-chain. This re-exports
`@protocol-01/stark-prover`; see that package for the full circuit reference.

```typescript
import { createStarkProver, STARK_CIRCUITS } from '@protocol-01/zk-sdk';

const prover = createStarkProver({ connection, payer });
const { proofBuffer } = await prover.generateStarkProof(STARK_CIRCUITS.transfer, privateInputs);
```

### Circuits (Poseidon)

Low-level Poseidon hash primitives used throughout the system.

```typescript
import { poseidonHash, computeCommitment, computeNullifier } from '@protocol-01/zk-sdk';

const hash = await poseidonHash([field1, field2]);
const commitment = await computeCommitment(amount, owner, randomness, tokenMint);
const nullifier = await computeNullifier(commitment, spendingKeyHash);
```

## Proving

Proof generation runs through `@protocol-01/stark-prover` (Goldilocks field,
Blake3 Merkle, DEEP-ALI — no trusted setup, no `.wasm`/`.zkey` ceremony files).
The bundled `p01_stark_bg.wasm` ships inside that package and loads automatically
in Node and the browser. See [`@protocol-01/stark-prover`](../stark-prover/) for
the circuit-id table and runtime notes.

## Error Handling

### Common errors and solutions

| Error | Cause | Fix |
|---|---|---|
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
