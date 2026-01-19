# Protocol 01 Browser Extension

## Overview

The Protocol 01 browser extension is a full-featured Solana wallet that runs in Chrome, Brave, and other Chromium-based browsers. It provides secure key management, transaction signing, and seamless dApp integration.

## Features

### Wallet Management
- Create new wallet with BIP39 mnemonic (12 words)
- Import existing wallet from seed phrase
- Multiple account support (planned)
- Password-protected access

### Asset Management
- View SOL balance with real-time USD value
- SPL token support
- Transaction history with categorization
- Network switching (Mainnet/Devnet)

### Security
- AES-256-GCM encryption for seed phrases
- PBKDF2 key derivation (100k iterations)
- Auto-lock after inactivity
- No external key storage

### dApp Integration
- Wallet Standard compliant
- Transaction signing
- Message signing
- Connection management
- Permission system

### Privacy Features
- Stealth address generation
- Privacy scoring
- Transaction obfuscation (planned)

### Payment Streams
- Create recurring payments
- View active subscriptions
- Cancel/pause streams
- Payment history

## Installation

### From Chrome Web Store (Coming Soon)
1. Visit the Chrome Web Store
2. Search for "Protocol 01"
3. Click "Add to Chrome"

### Manual Installation (Development)
1. Clone the repository
2. Install dependencies: `pnpm install`
3. Build extension: `pnpm build:extension`
4. Open `chrome://extensions`
5. Enable "Developer mode"
6. Click "Load unpacked"
7. Select `apps/extension/dist`

## User Guide

### Creating a Wallet

1. Click the P-01 extension icon
2. Click "Create New Wallet"
3. Set a strong password (min 8 characters)
4. **Important**: Write down your 12-word seed phrase
5. Store it safely offline
6. Confirm you've backed up the phrase
7. Your wallet is ready!

### Importing a Wallet

1. Click "Import Existing Wallet"
2. Enter your 12-word seed phrase
3. Set a password
4. Click "Import"

### Sending SOL

1. Click "Send" on the home screen
2. Enter recipient address or scan QR
3. Enter amount
4. Review transaction details
5. Click "Confirm"
6. Enter password if prompted

### Receiving SOL

1. Click "Receive"
2. Share your address or QR code
3. For privacy, use "Generate Stealth Address"

### Connecting to dApps

1. Visit a dApp that supports Protocol 01
2. Click "Connect Wallet" on the dApp
3. P-01 popup will appear
4. Review permissions requested
5. Click "Connect"
6. Manage connections in Settings → Connected Sites

### Managing Subscriptions

1. Go to Subscriptions tab
2. View active streams
3. Click on a stream for details
4. Cancel or modify as needed

### Settings

- **Network**: Switch between Mainnet and Devnet
- **Hide Balance**: Mask amounts for privacy
- **Notifications**: Transaction alerts
- **Backup Seed Phrase**: View your recovery words
- **Change Password**: Update wallet password
- **Connected Sites**: Manage dApp permissions

## Security Best Practices

1. **Never share your seed phrase** with anyone
2. **Store seed phrase offline** (paper, metal backup)
3. **Use a strong, unique password**
4. **Lock wallet when not in use**
5. **Verify transaction details** before signing
6. **Check website URLs** for phishing

## Technical Architecture

```
extension/
├── src/
│   ├── popup/           # React UI
│   │   ├── pages/       # Route components
│   │   ├── components/  # Reusable UI
│   │   └── layouts/     # Page layouts
│   ├── background/      # Service worker
│   │   └── index.ts     # Message handling
│   ├── content/         # Content scripts
│   │   └── inject.ts    # Provider injection
│   └── shared/          # Shared code
│       ├── services/    # Crypto, wallet, etc.
│       ├── store/       # Zustand stores
│       └── types/       # TypeScript types
├── public/              # Static assets
└── manifest.json        # Extension manifest
```

### Manifest V3

The extension uses Chrome's Manifest V3 with:
- Service worker (background script)
- Content scripts for provider injection
- Declarative permissions
- chrome.storage for persistence

### State Management

Zustand stores with chrome.storage persistence:
- `walletStore`: Wallet state, balances, transactions
- `privacyStore`: Privacy settings and stealth keys
- `streamStore`: Payment streams

### Message Flow

```
dApp → Content Script → Background → Popup → User
                    ↑                      ↓
                    ←──────────────────────←
```

## Troubleshooting

### Extension not appearing
- Ensure Chrome is updated
- Check `chrome://extensions` for errors
- Try disabling and re-enabling

### dApp not connecting
- Refresh the dApp page
- Check Connected Sites in Settings
- Clear site permissions and reconnect

### Transaction failing
- Check SOL balance for fees
- Verify network matches dApp
- Check transaction simulation errors

### Forgot password
- Use "Reset Wallet" option
- You'll need your seed phrase to recover
- **No way to recover without seed phrase**

## Support

- GitHub Issues: Report bugs
- Discord: Community support
- Twitter: Updates and announcements
