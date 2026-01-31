# @p01/whitelist-sdk

Developer whitelist SDK for Protocol 01. Manages access control for the developer program through on-chain whitelist entries, encrypted IPFS storage, and Solana program interactions.

## Installation

```bash
npm install @p01/whitelist-sdk @solana/web3.js @coral-xyz/anchor
```

## Quick Start

### Check Developer Access

```typescript
import { WhitelistSDK, WhitelistStatus, statusToString } from '@p01/whitelist-sdk';
import { Connection, PublicKey } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com');
const sdk = new WhitelistSDK(connection);

// Check if a wallet has developer access
const wallet = new PublicKey('developer_wallet_address');
const { hasAccess, entry } = await sdk.checkAccess(wallet);

if (hasAccess) {
  console.log('Developer has access!');
  console.log('Project:', entry.projectName);
  console.log('Status:', statusToString(entry.status));
} else {
  console.log('No access. Apply at protocol01.com');
}
```

### Submit an Access Request

```typescript
import {
  encryptForAdmin,
  uploadToIPFS,
  getWhitelistEntryPDA,
} from '@p01/whitelist-sdk';

// Encrypt the application data (only the admin can read it)
const encryptedData = encryptForAdmin({
  email: 'dev@example.com',
  projectName: 'My DeFi App',
  projectDescription: 'A privacy-focused DEX',
  website: 'https://mydefiapp.com',
});

// Upload encrypted data to IPFS
const cid = await uploadToIPFS(encryptedData);
console.log('IPFS CID:', cid);

// The CID is then submitted on-chain via the whitelist program
const [entryPDA] = getWhitelistEntryPDA(walletPublicKey);
```

### Admin Operations

```typescript
import {
  WhitelistSDK,
  decryptAsAdmin,
  fetchFromIPFS,
  generateAdminKeyPair,
} from '@p01/whitelist-sdk';

// Generate admin encryption keys (run once, store securely)
const adminKeys = generateAdminKeyPair();
console.log('Public key:', adminKeys.publicKey);
console.log('Secret key:', adminKeys.secretKey); // Keep secret!

// Get all pending requests
const sdk = new WhitelistSDK(connection);
const pending = await sdk.getPendingRequests();

for (const entry of pending) {
  // Fetch and decrypt the application details
  const encryptedData = await fetchFromIPFS(entry.ipfsCid);
  const application = decryptAsAdmin(encryptedData, adminSecretKey);

  console.log('Applicant:', entry.wallet.toBase58());
  console.log('Email:', application.email);
  console.log('Project:', application.projectName);
}
```

## API Reference

### WhitelistSDK

| Method | Description |
|---|---|
| `constructor(connection, programId?)` | Create a new SDK instance |
| `checkAccess(wallet)` | Check if a wallet has approved developer access |
| `getEntry(wallet)` | Get the whitelist entry for a wallet |
| `getPendingRequests()` | Get all pending whitelist requests (admin) |

### Encryption

| Function | Description |
|---|---|
| `encryptForAdmin(data: AccessRequest)` | Encrypt application data so only the admin can read it |
| `decryptAsAdmin(encrypted, secretKey)` | Decrypt application data with the admin's secret key |
| `generateAdminKeyPair()` | Generate a new admin encryption keypair |

### IPFS

| Function | Description |
|---|---|
| `uploadToIPFS(data)` | Upload encrypted data to IPFS via web3.storage |
| `fetchFromIPFS(cid)` | Fetch encrypted data from IPFS |

### PDA Derivation

| Function | Description |
|---|---|
| `getWhitelistPDA()` | Get the global whitelist state PDA |
| `getWhitelistEntryPDA(wallet)` | Get the whitelist entry PDA for a specific wallet |

### Utility

| Function | Description |
|---|---|
| `statusToString(status)` | Convert a WhitelistStatus enum to a human-readable string |

### Types and Constants

- `WhitelistSDK` -- Main SDK class
- `WhitelistStatus` -- Enum: Pending, Approved, Rejected, Revoked
- `WhitelistEntry` -- On-chain entry data (wallet, ipfsCid, projectName, status, timestamps)
- `AccessRequest` -- Application data (email, projectName, projectDescription, website)
- `EncryptedData` -- Encrypted payload (nonce, encrypted -- both base64-encoded)
- `WHITELIST_PROGRAM_ID` -- The on-chain program address
- `ADMIN_ENCRYPTION_PUBKEY` -- The admin's public encryption key

## License

MIT
