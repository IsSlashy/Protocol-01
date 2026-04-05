# @protocol-01/whitelist-sdk

Developer access control for Protocol 01. Check whitelist status, request access, and manage developer permissions through on-chain entries and encrypted IPFS storage.

## Installation

```bash
npm install @protocol-01/whitelist-sdk @solana/web3.js @coral-xyz/anchor
```

## For Developers (Checking Access)

Most integrations only need two methods: `checkAccess()` and `getEntry()`.

### Check if a wallet is whitelisted

```typescript
import { WhitelistSDK } from '@protocol-01/whitelist-sdk';
import { Connection, PublicKey } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com');
const sdk = new WhitelistSDK(connection);

const wallet = new PublicKey('your_wallet_address');
const { hasAccess, entry } = await sdk.checkAccess(wallet);

if (hasAccess) {
  console.log('Access granted! Project:', entry.projectName);
} else {
  console.log('No access. Apply at protocol01.com');
}
```

### Get full entry details

```typescript
import { statusToString } from '@protocol-01/whitelist-sdk';

const entry = await sdk.getEntry(wallet);
if (entry) {
  console.log('Status:', statusToString(entry.status));
  console.log('Project:', entry.projectName);
  console.log('Applied:', new Date(entry.requestedAt * 1000));
}
```

### PDA derivation (for on-chain integration)

```typescript
import { getWhitelistEntryPDA, WHITELIST_PROGRAM_ID } from '@protocol-01/whitelist-sdk';

const [entryPDA, bump] = getWhitelistEntryPDA(wallet);
// Use entryPDA in your Solana program CPI or instruction
```

## For Admins (Managing Whitelist)

Admin operations include reviewing applications, managing encryption keys, and working with IPFS.

### IPFS setup

IPFS storage uses [web3.storage](https://web3.storage). You need an API token for **uploads only** (reads are free through public gateways).

**Get a token:**
1. Sign up at https://web3.storage
2. Create an API token in your account dashboard

**Set the token:**

```bash
# Node.js (env var)
export WEB3_STORAGE_TOKEN="your_token_here"
# or
export IPFS_TOKEN="your_token_here"
```

```typescript
// Browser (global)
window.P01_WEB3_STORAGE_TOKEN = 'your_token_here';
```

If the token is missing when calling `uploadToIPFS()`, the SDK throws a clear error with setup instructions.

### Submit an access request

```typescript
import { encryptForAdmin, uploadToIPFS } from '@protocol-01/whitelist-sdk';

// Encrypt the application (only the admin can decrypt it)
const encrypted = encryptForAdmin({
  email: 'dev@example.com',
  projectName: 'My DeFi App',
  projectDescription: 'A privacy-focused DEX',
  website: 'https://mydefiapp.com',
});

// Upload to IPFS (requires WEB3_STORAGE_TOKEN)
const cid = await uploadToIPFS(encrypted);
console.log('IPFS CID:', cid);

// Submit the CID on-chain via the whitelist program
```

### Review pending applications

```typescript
import {
  WhitelistSDK,
  fetchFromIPFS,
  decryptAsAdmin,
} from '@protocol-01/whitelist-sdk';

const sdk = new WhitelistSDK(connection);
const pending = await sdk.getPendingRequests();

for (const entry of pending) {
  const encrypted = await fetchFromIPFS(entry.ipfsCid);
  const application = decryptAsAdmin(encrypted, adminSecretKey);

  console.log('Wallet:', entry.wallet.toBase58());
  console.log('Email:', application.email);
  console.log('Project:', application.projectName);
  console.log('Description:', application.projectDescription);
}
```

### Generate admin encryption keys

Run this once, store the secret key securely offline:

```typescript
import { generateAdminKeyPair } from '@protocol-01/whitelist-sdk';

const keys = generateAdminKeyPair();
console.log('Public key:', keys.publicKey);   // embed in SDK
console.log('Secret key:', keys.secretKey);   // keep secret!
```

## Configuration

| Setting | Description | Default |
|---|---|---|
| Program ID | On-chain whitelist program | `AjHD9r4VubPvxJapd5zztf1Yqym1QYiZaQ4SF5h3FPQE` (devnet) |
| IPFS token | web3.storage API token (uploads only) | `WEB3_STORAGE_TOKEN` or `IPFS_TOKEN` env var |
| RPC URL | Solana connection URL | Passed to `WhitelistSDK` constructor |
| Admin key | X25519 public key for encryption | Hardcoded in SDK (`ADMIN_ENCRYPTION_PUBKEY`) |

### Custom program ID

```typescript
import { WhitelistSDK } from '@protocol-01/whitelist-sdk';
import { PublicKey } from '@solana/web3.js';

const sdk = new WhitelistSDK(connection, new PublicKey('YourProgramId...'));
```

## Error Handling

The SDK throws descriptive errors for common failure modes:

| Error | Cause | Fix |
|---|---|---|
| `"IPFS upload requires a web3.storage API token..."` | `WEB3_STORAGE_TOKEN` not set | Set the env var or `window.P01_WEB3_STORAGE_TOKEN` |
| `"Failed to upload to IPFS..."` | Network error or invalid token | Check token validity and network connectivity |
| `"Failed to fetch from IPFS gateway..."` | All gateways returned errors | Content may not be pinned, or CID is invalid |
| `"Decryption failed - invalid key or corrupted data"` | Wrong admin secret key | Verify you are using the matching secret key |
| `"Admin encryption key not configured..."` | `ADMIN_ENCRYPTION_PUBKEY` is all zeros | SDK build error -- should not happen in production |

`checkAccess()` and `getEntry()` never throw -- they return `{ hasAccess: false }` or `null` on RPC errors.

## API Reference

### WhitelistSDK

| Method | Description |
|---|---|
| `constructor(connection, programId?)` | Create a new SDK instance |
| `checkAccess(wallet)` | Check if a wallet has approved developer access |
| `getEntry(wallet)` | Get the whitelist entry for a wallet (any status) |
| `getPendingRequests()` | Get all pending whitelist requests (admin) |

### Encryption

| Function | Description |
|---|---|
| `encryptForAdmin(data)` | Encrypt an access request for the admin |
| `decryptAsAdmin(encrypted, secretKey)` | Decrypt with the admin's X25519 secret key |
| `generateAdminKeyPair()` | Generate a new admin encryption keypair |

### IPFS

| Function | Description |
|---|---|
| `uploadToIPFS(data)` | Upload encrypted data to IPFS (requires token) |
| `fetchFromIPFS(cid)` | Fetch encrypted data from IPFS (no token needed) |

### PDA Derivation

| Function | Description |
|---|---|
| `getWhitelistPDA()` | Get the global whitelist state PDA |
| `getWhitelistEntryPDA(wallet)` | Get the whitelist entry PDA for a wallet |

### Utility

| Function | Description |
|---|---|
| `statusToString(status)` | Convert `WhitelistStatus` to readable string |

### Types

- `WhitelistSDK` -- Main SDK class
- `WhitelistStatus` -- Enum: `Pending`, `Approved`, `Rejected`, `Revoked`
- `WhitelistEntry` -- On-chain entry (wallet, ipfsCid, projectName, status, timestamps)
- `AccessRequest` -- Application data (email, projectName, projectDescription, website)
- `EncryptedData` -- Encrypted payload (`nonce`, `encrypted` -- both base64)
- `WHITELIST_PROGRAM_ID` -- Devnet program address
- `ADMIN_ENCRYPTION_PUBKEY` -- Admin X25519 public key

## License

MIT
