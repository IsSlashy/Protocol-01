# Protocol 01 Mobile Application

## Overview

The Protocol 01 mobile app brings the full power of the P-01 wallet to iOS and Android devices. Built with React Native and Expo, it offers native performance with features like biometric authentication, QR scanning, and mesh networking.

## Features

### Wallet
- Create/import wallet with seed phrase
- Biometric authentication (Face ID, Touch ID, Fingerprint)
- Real-time balance and price tracking
- Transaction history
- Send/receive SOL and SPL tokens
- QR code payments

### Payment Streams
- Create subscriptions
- Monitor active streams
- Visual progress indicators
- Pause/cancel management

### Social Features
- Contact management
- Stealth address book
- Payment requests
- QR code sharing
- Mesh networking (peer discovery)

### AI Assistant
- Natural language queries
- Transaction assistance
- Balance inquiries
- DeFi recommendations

### Privacy
- Stealth addresses
- Privacy scoring
- Anonymous contacts

## Installation

### iOS (TestFlight)
Coming soon

### Android (APK)
Coming soon

### Development Build

```bash
# Clone repository
git clone https://github.com/your-username/protocol-01.git
cd protocol-01

# Install dependencies
pnpm install

# Start Expo
cd apps/mobile
npx expo start

# Or with tunnel for external devices
npx expo start --tunnel
```

## User Guide

### First Launch

1. Open Protocol 01 app
2. Choose "Create New Wallet" or "Import Wallet"
3. For new wallets:
   - Write down your 12-word seed phrase
   - Verify by selecting words in order
   - Set up biometric/PIN security
4. Your wallet is ready!

### Home Screen

The home screen displays:
- Current SOL balance
- USD equivalent
- Quick action buttons (Send, Receive, Swap)
- Recent transactions
- Active streams summary

### Sending Payments

**Manual Entry:**
1. Tap "Send"
2. Enter recipient address
3. Enter amount
4. Add memo (optional)
5. Review and confirm
6. Authenticate with biometrics

**QR Code:**
1. Tap "Send"
2. Tap QR icon
3. Scan recipient's QR code
4. Confirm pre-filled details
5. Authenticate

### Receiving Payments

1. Tap "Receive"
2. Share your QR code
3. Or copy address to clipboard
4. For privacy: "Generate Stealth Address"

### Managing Streams

**View Streams:**
1. Go to Streams tab
2. See active subscriptions
3. Tap for details

**Create Stream:**
1. Tap "+" in Streams tab
2. Enter recipient
3. Set amount and interval
4. Choose duration
5. Review and confirm

**Cancel Stream:**
1. Open stream details
2. Tap "Cancel Stream"
3. Confirm cancellation
4. Remaining funds returned

### Social Features

**Add Contact:**
1. Go to Social tab
2. Tap "Add Contact"
3. Scan QR or enter address
4. Set nickname
5. Save

**Payment Request:**
1. Tap "Request Payment"
2. Enter amount
3. Generate request QR
4. Share with payer

**Mesh Discovery:**
1. Enable Bluetooth
2. Open Social tab
3. Nearby P-01 users appear
4. Tap to connect

### AI Assistant

1. Go to Agent tab
2. Type or speak your request
3. Examples:
   - "What's my balance?"
   - "Send 0.5 SOL to john.sol"
   - "Show my subscriptions"
   - "Explain my last transaction"

### Settings

- **Security**: Biometrics, PIN, auto-lock
- **Network**: Mainnet/Devnet switch
- **Privacy**: Stealth settings, privacy zone
- **Backup**: View seed phrase
- **Notifications**: Push settings
- **About**: Version, support links

## Technical Architecture

```
mobile/
├── app/                    # Expo Router pages
│   ├── (auth)/            # Authentication screens
│   ├── (onboarding)/      # First-time setup
│   └── (main)/            # Main app
│       ├── (wallet)/      # Wallet screens
│       ├── (streams)/     # Stream management
│       ├── (social)/      # Contacts & mesh
│       ├── (agent)/       # AI assistant
│       └── (settings)/    # Settings
├── components/            # Reusable components
├── hooks/                 # Custom React hooks
├── services/              # Business logic
├── stores/                # Zustand state
└── utils/                 # Utilities
```

### Technology Stack

| Layer | Technology |
|-------|------------|
| Framework | React Native + Expo |
| Navigation | Expo Router |
| Styling | NativeWind (Tailwind) |
| State | Zustand |
| Storage | Expo SecureStore |
| Animations | Reanimated 3 |
| Blockchain | @solana/web3.js |

### Security

- Seed phrases encrypted with Expo SecureStore
- Biometric gate for sensitive operations
- No plaintext key storage
- Memory cleared after signing

## Platform Requirements

### iOS
- iOS 13.0+
- iPhone 6s or newer
- Face ID / Touch ID recommended

### Android
- Android 8.0+
- ARM64 devices
- Fingerprint sensor recommended

## Troubleshooting

### App crashes on launch
- Clear app cache
- Reinstall application
- Check for updates

### Biometrics not working
- Verify device has biometric hardware
- Check system biometric settings
- Re-enroll biometrics

### Transaction pending
- Check network status
- Verify sufficient balance
- Try switching networks

### QR scanner not working
- Grant camera permission
- Ensure adequate lighting
- Clean camera lens

## Support

- GitHub Issues
- Discord Community
- Twitter @protocol01
- Email: support@protocol01.xyz
