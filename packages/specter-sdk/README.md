# @protocol-01/specter-sdk

TypeScript SDK for Protocol 01 on Solana: wallet and stealth-key derivation, the on-chain service registry, the relay module, private subscriptions through the shielded pool, and the STARK client prover.

**0.5.0 (2026-09-13).** The on-chain `specter` program that carried stealth announcements, stealth claims and payment streams was closed on devnet on 2026-09-13 (`FgKhXakZGsd4PdiGgACYy8gwj1JLMYA691yQr2PhUNfL`). Every function that sent it an instruction or read its accounts is gone from this package; `CHANGELOG.md` lists them. The stealth key math stays, as client-side derivation only. Private payments are the shielded pool's job (`createPrivateSubscription` below, and `@protocol-01/privacy-sdk`).

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

// Read balances
const balance = await client.getBalance();

// Derive a one-time address from the wallet's meta-address (client-side key math)
const oneTime = client.generateStealthAddress();

// Plain transfer: sender, recipient and amount are public
const signature = await client.sendPublic(recipientPublicKey, 1.5);

// Private payments go through the shielded pool: see "Private Subscriptions"
// below and @protocol-01/privacy-sdk.
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

Use custom program IDs for testing with localnet or forked deployments. The registry and the relayer are the two programs this client addresses; the `programId` option (the retired `specter` program) is gone since 0.5.0.

```typescript
import { PublicKey } from '@solana/web3.js';

const client = new P01Client({
  cluster: 'localnet',
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

One-time addresses derived from a reusable stealth meta-address. The sender generates a unique address for each payment, using ECDH key exchange (with optional ML-KEM-768 post-quantum hybrid mode). Everything in this module is key math on the client: nothing is announced or scanned on chain (the on-chain announcement program was closed on 2026-09-13), so the sender has to hand the ephemeral key to the recipient through whatever channel the application provides.

> **Who can spend (audit v1 F44).** The address's secret key is derived from the shared secret and the recipient's spending PUBLIC key only; no recipient secret goes into it. So the **sender**, and anyone holding the recipient's **viewing key** (plus the ML-KEM secret key in hybrid mode), can derive it and **spend** from the address, not only the recipient. A viewing key given to an auditor is a spending key. Changing this means deriving the key from the recipient's spending secret (`P = B + H(s)·G`), which changes every address already derived; that is an open decision.

```typescript
import {
  generateStealthMetaAddress,
  generateStealthAddress,
  deriveStealthPrivateKey,
} from '@protocol-01/specter-sdk';

// Generate a stealth meta-address (share this publicly)
const meta = generateStealthMetaAddress(spendingKeypair, viewingKeypair);
console.log('Share this:', meta.encoded); // st:01...

// Sender: derive a one-time address for a payment, keep stealth.ephemeralPubKey for the recipient
const stealth = generateStealthAddress(meta);

// Recipient: recover the one-time keypair from the ephemeral key
const oneTimeKeypair = deriveStealthPrivateKey(
  spendingPubKey,
  viewingPrivateKey,
  stealth.ephemeralPubKey,
);
```

### ZK Proving (Client-Side)

> **Heads up — proving system migration.** All shipping clients (mobile + extension) generate **STARK** proofs on-device via the Winterfell-derived WASM prover bundled in `@protocol-01/privacy-sdk` (Goldilocks field, Poseidon hash, ~9–12 KB proofs verified by the on-chain FRI verifier). The Groth16 path documented below is the **legacy** snarkjs flow kept for migration tooling and the few callers that have not yet cut over. New integrations should use `privacy-sdk` and not import `ClientProver` from this package.

The spending key, balance, and salt never leave the user's device — true for both proving systems.

For the legacy Groth16 prover (zkSPL confidential balance circuit), circuit files (.wasm and .zkey) must be served from a URL or filesystem path:

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
import { CommitmentIndexer, MemoryCache } from '@protocol-01/specter-sdk';

// Index shielded pool commitments (replaces relayer /pool/state)
const commitmentIndexer = new CommitmentIndexer({
  connection,
  programId,
  cache: new MemoryCache(),
});
const status = await commitmentIndexer.sync();
```

### Quantum-Safe Vaults

Application-layer defenses against quantum attacks on Ed25519. Three mechanisms that protect funds even if Shor's algorithm breaks Ed25519. They are hash-based building blocks for an integrator's own program: the devnet vault program that consumed them was closed on 2026-09-13.

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
// Put the commitment in your own program's account; reveal the secret to unlock
```

### Private Subscriptions

Recurring payments that compose stealth addresses with shielded-pool withdrawals. No transaction names the subscriber's wallet; the amount (a pool denomination) and the timing remain observable on chain, and the deployment that funds the one-time key sees the request.

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

### Service Registry (on-chain merchant directory)

Any wallet can publish a subscription-accepting service as a `ServiceRegistry` PDA, and every Protocol 01 client picks it up automatically. This is the client-side read surface — merchants should use [`@protocol-01/merchant-sdk`](../merchant-sdk/) for server-side registration, payment polling, and access-token issuance.

```typescript
import {
  fetchAllServices,
  fetchService,
  getServicePDA,
  buildRegisterServiceIx,
  buildAttestServiceIx,
} from '@protocol-01/specter-sdk';
import { SystemProgram } from '@solana/web3.js';

// List every verified service on-chain (what the mobile UI shows by default)
const services = await fetchAllServices(connection, {
  verifiedOnly: true,
  activeOnly: true,
});

for (const s of services) {
  console.log(`${s.name} — ${Number(s.priceAtomic) / 1e9} SOL / ${s.intervalSlots} slots`);
  console.log(`  retailer: ${s.retailer.toBase58()}`);
  console.log(`  slug:     ${s.slug}`);
  console.log(`  icon:     ${s.iconKey}`);
}

// Fetch a specific service by (owner, slug)
const netflix = await fetchService(connection, merchantOwner, 'netflix-standard');

// Low-level: build the register ix yourself
const [pda] = getServicePDA(merchantOwner, 'my-saas-pro');
const ix = buildRegisterServiceIx(merchantOwner, {
  slug: 'my-saas-pro',
  name: 'My SaaS — Pro',
  iconKey: 'chatgpt',
  category: 'saas',
  metadataUri: '',
  retailer: merchantRetailer,
  tokenMint: SystemProgram.programId,  // native SOL
  priceAtomic: 50_000_000n,            // 0.05 SOL
  intervalSlots: 6_480_000n,           // 30 days
  supportsOneshot: true,
  supportsVault: true,
});
```

The `verified` flag can only be flipped by the `PROTOCOL_VERIFIED_AUTHORITY` (hardcoded in the program). Unverified services still appear behind a filter.

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

On-chain directory where users publish their stealth meta-address so anyone can look them up by wallet and derive one-time addresses for them.

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
| `generateStealthAddress()` | Derive a one-time stealth address (client-side key math) |

**Transfers**

| Method | Description |
|---|---|
| `sendPublic(to, amount)` | Send a regular (non-private) SOL transfer |

**Utility**

| Method | Description |
|---|---|
| `getConnection()` | Get the Solana connection instance |
| `getRegistryProgramId()` | Get the registry program ID |
| `getRelayerProgramId()` | Get the relayer program ID |
| `setCluster(cluster)` | Switch to a different network cluster |

### Key Types

- `P01Wallet` -- Wallet with stealth capabilities (publicKey, keypair, stealthMetaAddress)
- `StealthMetaAddress` -- Spending and viewing public keys for deriving stealth addresses
- `StealthAddress` -- A one-time address for receiving a single payment
- `P01ClientConfig` -- Client configuration (cluster, rpcEndpoint, commitment, debug, features)
- `P01Error` / `P01ErrorCode` -- Structured error types
- `WalletAdapter` -- Interface for external wallets ({ publicKey, signTransaction })

### Sub-path Imports

```typescript
import { createWallet } from '@protocol-01/specter-sdk/wallet';
import { generateStealthAddress, deriveStealthPrivateKey } from '@protocol-01/specter-sdk/stealth';
import { sendPublic } from '@protocol-01/specter-sdk/transfer';
import { ClientProver, CircuitLoader } from '@protocol-01/specter-sdk/proving';
import { CommitmentIndexer } from '@protocol-01/specter-sdk/indexing';
import { submitRelayJob } from '@protocol-01/specter-sdk/relay';
```

## Error Handling

All SDK errors use the `P01Error` class with structured error codes organized by category:

```typescript
import { P01Error, P01ErrorCode } from '@protocol-01/specter-sdk';

try {
  await client.sendPublic(recipient, 1.0);
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
| 4xxx | Stream | `STREAM_NOT_FOUND`, `STREAM_CREATION_FAILED`, `NOTHING_TO_WITHDRAW` (kept in the enum; no code in 0.5.0 raises them) |
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
| devnet | Deployed | Registry, relayer, shielded pool and STARK verifier; the specter program was closed on 2026-09-13 |
| localnet | Supported | Use with `anchor localnet` or `solana-test-validator` |
| testnet | Not deployed | Programs not yet deployed |
| mainnet-beta | Pending audit | Will be available after security audit |

## Feature Flags

| Flag | Default | Description |
|---|---|---|
| `ENABLE_RELAYER` | `false` | Enable decentralized transaction relay |

Override at runtime with `setFeature(name, enabled)` or at client creation via the `features` config option.

## Security Model

- **All proofs generated locally** -- The spending key, balance, and salt never leave the user's device. Production proofs are STARK (FRI-based, post-quantum, no trusted setup), generated by the Winterfell-derived WASM prover in `@protocol-01/privacy-sdk`. The legacy Groth16 path in this package uses snarkjs WASM running in-process and is being phased out.
- **Spending keys never leave device** -- There is no remote prover fallback. If local proving fails, the operation fails.
- **ML-KEM-768 hybrid encryption** -- v2 stealth addresses combine X25519 (classical) with ML-KEM-768 (post-quantum) for defense against future quantum computers.
- **On-chain nullifier records** -- Every spend writes a `NullifierRecord` PDA in the pool program, and a second spend with the same nullifier fails at that account. This does not guarantee that one deposit is spent only once in v1: a v1 leaf commitment is a single 64-bit Goldilocks element, so a depositor who finds two openings of one commitment (a collision search of about 2^32 Poseidon evaluations, classical birthday bound; about 2^21.3 for a quantum collision search, BHT) holds two different nullifiers for one deposit (finding F2, `docs/SECURITY-LEVELS.md` in the repository). The v2 design widens the commitment to four elements.

## License

PolyForm Strict License 1.0.0 — see [LICENSE](LICENSE). The package is
source-available: anyone may read, build, run and verify it for noncommercial
purposes. Commercial use (including production deployment by a business),
changes or derivative works, and redistribution need a written license from
Volta Team ([styx.cash/licenses](https://styx.cash/licenses)).
PolyForm Strict is not an open-source license.

The versions already published to npm (0.1.0 to 0.4.3) were released under the
MIT License and remain MIT, as does every commit of this repository before the
one that replaced the MIT License with PolyForm Strict
([LICENSE-MIT-BEFORE-POLYFORM](../../LICENSE-MIT-BEFORE-POLYFORM)). Versions
published from 2026-09-22 on ship under PolyForm Strict 1.0.0.
