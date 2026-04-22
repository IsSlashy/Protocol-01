# @protocol-01/zkspl-sdk

Confidential SPL token operations for Solana. Private balances, shielded transfers, and zero-knowledge balance proofs powered by Groth16 ZK-SNARKs and Poseidon hashing.

> **⚠️ Legacy — Groth16 was retired from the shipping Protocol 01 stack in March 2026.**
> The `p01_zkspl` on-chain program now verifies **STARK proofs** via the shared FRI verifier. This SDK's Groth16 path still compiles and runs for anyone auditing the historical pipeline, but new integrations should target the STARK path. See the root [README](../../README.md) for the current architecture.

## Install

```bash
npm install @protocol-01/zkspl-sdk
```

**Peer dependency:** `@solana/web3.js ^1.98.0`

## Quick Start

```ts
import { Connection, Keypair } from '@solana/web3.js';
import { ZkSplClient, randomSalt } from '@protocol-01/zkspl-sdk';

const connection = new Connection('https://api.devnet.solana.com');
const wallet = /* your Wallet adapter */;

const client = new ZkSplClient({
  connection,
  wallet,
  spendingKey: randomSalt(), // generate once, store securely
  network: 'devnet',
});

// 1. Create a confidential account for USDC
await client.createAccount(USDC_MINT);

// 2. Deposit 10 USDC (10_000_000 atomic units)
const deposit = await client.deposit(USDC_MINT, 10_000_000n, userATA);

// 3. Check balance (local plaintext)
const balance = await client.getLocalBalance(USDC_MINT);

// 4. Prove balance >= 5 USDC without revealing actual amount
await client.proveBalance(USDC_MINT, 5_000_000n);
```

## How It Works

On-chain, every confidential account stores a **Poseidon commitment** instead of a plaintext balance:

```
commitment = Poseidon(balance, Poseidon(salt, nonce), owner_pubkey, token_mint)
```

Every state-changing operation (deposit, withdraw, transfer) generates a **Groth16 zero-knowledge proof** that the new commitment is correct -- without revealing the balance, salt, or spending key.

- **Deposits/withdrawals** are public-amount operations where the ZK proof validates the balance update.
- **Confidential transfers** hide the transfer amount behind an `amountHash = Poseidon(amount, amountSalt)`. The recipient needs `amount` and `amountSalt` (sent out-of-band) to apply the credit.
- **Balance proofs** prove `balance >= threshold` without revealing the actual balance. Useful for DeFi collateral checks.

## Configuration

### Network Selection

```ts
const client = new ZkSplClient({
  connection,
  wallet,
  network: 'devnet',       // 'devnet' | 'mainnet-beta' | 'localnet'
  spendingKey: myKey,
});
```

### Program ID Overrides

For local development or custom deployments:

```ts
import { PublicKey } from '@solana/web3.js';

const client = new ZkSplClient({
  connection,
  wallet,
  programId: new PublicKey('YourCustomProgramId...'),
  zkShieldedProgramId: 'YourShieldedProgramId...',
  spendingKey: myKey,
});
```

### Circuit File Setup

ZK proofs require WASM and zkey files. Point the SDK to their location:

```ts
const client = new ZkSplClient({
  connection,
  wallet,
  spendingKey: myKey,
  circuitBaseUrl: 'https://cdn.example.com/circuits/',
  // Or configure individually:
  prover: {
    balanceWasmPath: '/circuits/confidential_balance.wasm',
    balanceZkeyPath: '/circuits/confidential_balance_final.zkey',
    proofWasmPath: '/circuits/balance_proof.wasm',
    proofZkeyPath: '/circuits/balance_proof_final.zkey',
    timeout: 120_000, // ms
  },
});
```

### Custom Token Decimals

Register tokens your app uses so the SDK can format amounts correctly:

```ts
import { registerTokenDecimals } from '@protocol-01/zkspl-sdk';

registerTokenDecimals('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6); // mainnet USDC
registerTokenDecimals('So11111111111111111111111111111111111111112', 9);     // wrapped SOL
```

## API Reference

### ZkSplClient

The main entry point. Pass a config object or `(connection, wallet, programId)`.

| Method | Description | Returns |
|--------|-------------|---------|
| `createAccount(tokenMint, initialSalt?)` | Create a confidential account for a token | `Promise<string>` (tx sig) |
| `deposit(tokenMint, amount, userATA?, vaultATA?)` | Deposit SPL tokens into confidential balance | `Promise<ZkSplTxResult>` |
| `withdraw(tokenMint, amount, userATA?, vaultATA?)` | Withdraw from confidential to regular SPL tokens | `Promise<ZkSplTxResult>` |
| `confidentialTransfer(tokenMint, recipient, amount, salt?)` | Private transfer to another user | `Promise<ZkSplTxResult & { amountHash, amountSaltUsed }>` |
| `applyPending(tokenMint, amount, amountSalt)` | Apply a received pending credit | `Promise<ZkSplTxResult>` |
| `proveBalance(tokenMint, threshold)` | Prove balance >= threshold (ZK) | `Promise<string>` (tx sig) |
| `addViewer(tokenMint, viewer)` | Grant viewing access to an auditor | `Promise<string>` |
| `removeViewer(tokenMint, viewer)` | Revoke viewing access | `Promise<string>` |
| `getLocalBalance(tokenMint)` | Get locally-known plaintext balance | `Promise<bigint \| null>` |
| `getConfidentialAccount(tokenMint, owner?)` | Fetch on-chain account data | `Promise<ConfidentialAccountData \| null>` |
| `getPendingCredits(tokenMint)` | List pending credits to apply | `Promise<PendingCredit[]>` |
| `getMintConfig(tokenMint)` | Fetch on-chain mint config | `Promise<MintConfigAccount \| null>` |
| `validateState(tokenMint)` | Check local state matches on-chain | `Promise<{ isValid, ... }>` |
| `emergencyReset(tokenMint)` | Reset local state (forfeits balance) | `Promise<string \| null>` |
| `setSpendingKey(key)` | Set/change the spending key | `void` |
| `getOwnerPubkey()` | Derive owner pubkey from spending key | `FieldElement` |

### Crypto Utilities

Pure functions, no side effects. All field elements are BN254 scalars.

| Function | Description |
|----------|-------------|
| `poseidonHash(inputs)` | Poseidon hash of 1, 2, or 4 bigint inputs |
| `createBalanceCommitment(balance, salt, nonce, ownerPubkey, tokenMint)` | Compute a balance commitment |
| `createAmountCommitment(amount, amountSalt)` | Compute `Poseidon(amount, salt)` for transfers |
| `deriveOwnerPubkey(spendingKey)` | Derive owner pubkey: `Poseidon(spendingKey, 0)` |
| `randomSalt()` | Cryptographically random field element |
| `deriveDeterministicSalt(spendingKey, nonce)` | Recoverable salt: `Poseidon(spendingKey, nonce)` |
| `fieldToBytes(field)` | Field element to 32 bytes (little-endian) |
| `fieldToBytesBE(field)` | Field element to 32 bytes (big-endian) |
| `bytesToField(bytes)` | 32 bytes (LE) to field element |
| `pubkeyToField(pubkeyBytes)` | Solana pubkey bytes to field element |
| `zeroAmountHash()` | `Poseidon(0, 0)` -- used for deposit/withdraw |

### ZkSplProver

Generates Groth16 proofs locally via snarkjs. Spending key never leaves the device.

```ts
import { ZkSplProver } from '@protocol-01/zkspl-sdk';

const prover = new ZkSplProver({
  circuitBaseUrl: 'https://cdn.example.com/circuits/',
  timeout: 120_000,
});

const { proof, publicSignals } = await prover.generateBalanceProof(pubInputs, privInputs);
const { proof, publicSignals } = await prover.generateSufficiencyProof(pubInputs, privInputs);
```

Helper functions for building circuit inputs and converting proofs:

| Function | Description |
|----------|-------------|
| `buildBalanceCircuitInputs(pub, priv)` | Build snarkjs input object for balance circuit |
| `buildProofCircuitInputs(pub, priv)` | Build snarkjs input object for proof circuit |
| `snarkjsProofToBytes(proof)` | Convert snarkjs JSON proof to on-chain bytes |

### LocalStateManager

Manages plaintext state for confidential accounts. Plug in any storage backend.

```ts
import { LocalStateManager, InMemoryStateStore } from '@protocol-01/zkspl-sdk';

// Default: in-memory (lost on page reload)
const manager = new LocalStateManager();

// Custom: any StateStore implementation
const manager = new LocalStateManager(new MyIndexedDBStore());
```

**Custom backend:** Implement the `StateStore` interface:

```ts
interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

State is keyed by `"zkspl:<ownerPubkey>:<tokenMint>"` and stored as JSON with BigInt values serialized as strings.

## Confidential Transfer Flow

Confidential transfers involve out-of-band coordination between sender and recipient:

```
Sender                          Recipient
  |                                |
  |  1. confidentialTransfer()     |
  |  --> tx on-chain               |
  |  --> returns amountHash +      |
  |      amountSaltUsed            |
  |                                |
  |  2. Send amountHash + salt     |
  |  via secure channel            |
  |  (encrypted DM, QR, etc.)     |
  |  ----------------------------> |
  |                                |
  |                                |  3. applyPending(mint, amount, salt)
  |                                |  --> tx on-chain
  |                                |  --> balance updated
```

1. **Sender** calls `confidentialTransfer()` which creates an on-chain pending credit with a hidden amount hash.
2. **Sender** communicates `amountHash` and `amountSaltUsed` to the recipient through a secure channel.
3. **Recipient** calls `applyPending()` with the plaintext amount and salt to credit their balance.

## Circuit Files

The SDK requires four circuit files for proof generation:

| File | Circuit | Purpose |
|------|---------|---------|
| `confidential_balance.wasm` | confidential_balance | Balance update proof (deposit/withdraw/transfer) |
| `confidential_balance_final.zkey` | confidential_balance | Groth16 proving key |
| `balance_proof.wasm` | balance_proof | Balance sufficiency proof |
| `balance_proof_final.zkey` | balance_proof | Groth16 proving key |

These files are generated during the trusted setup ceremony (Groth16 with Powers of Tau). Place them in a directory accessible to your app and set `circuitBaseUrl` or individual paths in the config.

## Error Handling

The SDK throws descriptive errors with context about what went wrong and how to fix it:

| Error | Cause | Fix |
|-------|-------|-----|
| `"Spending key not set"` | Operation requires proof but no key provided | Call `setSpendingKey()` or pass in config |
| `"No local state found for mint..."` | Account not created yet | Call `createAccount(tokenMint)` first |
| `"Insufficient confidential balance..."` | Trying to withdraw/transfer more than available | Deposit more or reduce amount |
| `"Circuit file not found..."` | snarkjs cannot load WASM/zkey | Set `circuitBaseUrl` or individual paths |
| `"Proof generation timed out..."` | Proof took too long | Increase `timeout` in ProverConfig |
| `"Failed to send transaction..."` | On-chain error | Check SOL balance, account state, proof validity |
| `"Unknown network..."` | Invalid network name | Use `'devnet'`, `'mainnet-beta'`, or `'localnet'` |
| `"Program not deployed on..."` | Program not available on network | Use devnet or pass explicit programId |

## Network Support

| Network | Status | Notes |
|---------|--------|-------|
| `devnet` | Live | Default. Programs deployed and verified. |
| `mainnet-beta` | Not deployed | Program IDs are empty. Will throw if used without overrides. |
| `localnet` | Manual | Pass `programId` in config after deploying locally. |

## Security

- **Spending key never leaves the device.** All proofs are generated locally via snarkjs. There is no remote prover fallback -- it was removed as a security risk.
- **Deterministic salt recovery.** Salts are derived from `Poseidon(spendingKey, nonce)`, so if local state is lost but the spending key is preserved, state can be reconstructed by replaying on-chain events.
- **Rejection sampling for random values.** `randomSalt()` uses `crypto.getRandomValues()` with rejection sampling to avoid modular bias.
- **No secret material in error messages.** Error messages include context (operation, mint, balance) but never spending keys or salts.

## License

MIT
