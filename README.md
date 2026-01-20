# Protocol 01 (P-01)

> The next-generation privacy-first Web3 wallet ecosystem built on Solana

![Protocol 01 Banner](docs/assets/banner.png)

---

> **PROPRIETARY SOFTWARE - ALL RIGHTS RESERVED**
>
> © 2026 Volta Team | Developed by Slashy Fx
>
> This repository is visible for **hackathon evaluation purposes only**.
> **No license is granted** to use, copy, modify, fork, or distribute this code.
> See [LICENSE](./LICENSE) for details.

---

## Overview

Protocol 01 is a comprehensive Web3 wallet ecosystem designed for the Solana blockchain, focusing on privacy, seamless payments, and innovative features. The project includes a browser extension, mobile application, web platform, and SDK for developers.

### Core Philosophy

- **Privacy First**: Stealth addresses, encrypted transactions, and privacy scoring
- **Seamless Payments**: Programmable payment streams for subscriptions and recurring payments
- **Cross-Platform**: Available on web, mobile, and browser extension
- **Developer Friendly**: Complete SDK for dApp integration

---

## Architecture

```
protocol-01/
├── apps/
│   ├── extension/     # Chrome/Brave browser extension
│   ├── mobile/        # React Native (Expo) mobile app
│   └── web/           # Next.js web application & SDK demo
├── packages/
│   └── sdk/           # JavaScript/TypeScript SDK
└── docs/              # Documentation
```

---

## Products

### Browser Extension

Full-featured Solana wallet as a Chrome/Brave extension.

**Features:**
- Wallet creation & import (BIP39 mnemonic)
- SOL & SPL token management
- Real-time price tracking (CoinGecko API)
- Transaction history with Solscan integration
- dApp connection (Wallet Standard compliant)
- Network switching (Mainnet/Devnet)
- Privacy Zone with stealth addresses
- Payment Streams management
- Secure password protection with AES-256 encryption

**Tech Stack:**
- React 18 + TypeScript
- Zustand (state management)
- Vite (build tool)
- TailwindCSS
- Chrome Extension Manifest V3
- @solana/web3.js

### Mobile Application

Native mobile wallet for iOS and Android.

**Features:**
- Biometric authentication (Face ID / Fingerprint)
- QR code scanning for payments
- Push notifications for transactions
- Offline transaction signing
- Contact management with stealth addresses
- AI-powered assistant
- Mesh networking for peer-to-peer discovery
- Payment streams dashboard

**Tech Stack:**
- React Native + Expo
- Expo Router (file-based navigation)
- NativeWind (TailwindCSS for RN)
- Reanimated 3 (animations)
- Expo Secure Store
- @solana/web3.js

### Web Application

Marketing website and SDK demonstration platform.

**Features:**
- Landing page with product showcase
- Interactive SDK demo
- dApp integration examples
- Documentation portal
- Devnet testing tools

**Tech Stack:**
- Next.js 14 (App Router)
- TypeScript
- TailwindCSS
- Framer Motion

### SDK (@p01/sdk)

JavaScript/TypeScript SDK for integrating Protocol 01 into any dApp.

```typescript
import { P01SDK } from '@p01/sdk';

const p01 = new P01SDK();

// Connect wallet
const wallet = await p01.connect();

// Request payment
const signature = await p01.requestPayment({
  amount: 1.5,
  token: 'SOL',
  recipient: 'your-address'
});

// Create subscription stream
const stream = await p01.createStream({
  recipient: 'merchant-address',
  amount: 9.99,
  interval: 'monthly',
  token: 'USDC'
});
```

---

## Key Features

### Payment Streams (Streams)

The flagship feature - programmable recurring payments on Solana.

**How it works:**
1. User authorizes a stream with amount, interval, and duration
2. Smart contract holds pre-authorized funds
3. Merchant can claim payments at each interval
4. User can cancel anytime, remaining funds returned

**Use Cases:**
- SaaS subscriptions
- Content creator memberships
- Rent payments
- Salary streaming
- DCA (Dollar Cost Averaging)

**Stream Parameters:**
- `amount`: Payment per interval
- `interval`: weekly, monthly, yearly
- `maxPayments`: Total number of payments (or unlimited)
- `token`: SOL, USDC, or any SPL token

### Privacy Zone

Advanced privacy features for confidential transactions.

**Stealth Addresses:**
- Generate one-time addresses for receiving
- Sender cannot link payment to your main wallet
- Receiver scans for incoming stealth payments

**Privacy Score:**
- Analyzes your wallet's privacy level
- Recommendations for improving anonymity
- Tracks address reuse and patterns

### AI Assistant

Integrated AI agent for wallet operations.

**Capabilities:**
- Natural language transaction requests
- Balance inquiries
- Transaction explanations
- DeFi recommendations
- Security alerts

### Mesh Networking (Mobile)

Peer-to-peer discovery and communication.

**Features:**
- Bluetooth Low Energy discovery
- Direct wallet-to-wallet connections
- Offline payment requests
- Contact exchange via proximity

---

## Security

### Encryption
- AES-256-GCM for seed phrase encryption
- PBKDF2 key derivation (100,000 iterations)
- Secure random IV generation

### Key Management
- Private keys never leave the device
- Seed phrase encrypted at rest
- Memory cleared after use
- No external key storage

### Authentication
- Password required for sensitive operations
- Biometric support on mobile
- Auto-lock after inactivity

---

## Development

### Prerequisites
- Node.js 18+
- pnpm 8+
- Chrome/Brave (for extension testing)
- Expo Go app (for mobile testing)

### Installation

```bash
# Clone repository
git clone https://github.com/your-username/protocol-01.git
cd protocol-01

# Install dependencies
pnpm install

# Start development
pnpm dev           # All apps
pnpm dev:web       # Web only
pnpm dev:extension # Extension only
pnpm dev:mobile    # Mobile only
```

### Building

```bash
# Build all
pnpm build

# Build specific apps
pnpm build:extension  # Chrome extension
pnpm build:web        # Next.js app
pnpm build:mobile     # Expo build
```

### Extension Installation

1. Run `pnpm build:extension`
2. Open Chrome → `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select `apps/extension/dist`

---

## Roadmap

### Current (v1.0)
- [x] Browser extension
- [x] Mobile app (iOS/Android)
- [x] Web application
- [x] SDK v1
- [x] Payment streams
- [x] Stealth addresses
- [x] dApp connections

### Coming Soon (v1.1)
- [ ] CLI tool
- [ ] Desktop app (Windows/macOS)
- [ ] Hardware wallet support
- [ ] Multi-signature wallets
- [ ] NFT gallery

### Future (v2.0)
- [ ] Cross-chain bridges
- [ ] Fiat on-ramp
- [ ] DeFi aggregator
- [ ] DAO governance
- [ ] Mobile mesh payments

---

## API Reference

### Extension API

The extension injects a `window.p01` provider:

```typescript
interface P01Provider {
  // Connection
  connect(): Promise<{ publicKey: string }>;
  disconnect(): Promise<void>;

  // Transactions
  signTransaction(tx: Transaction): Promise<Transaction>;
  signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;

  // Streams
  createStream(params: StreamParams): Promise<string>;
  cancelStream(streamId: string): Promise<string>;

  // Events
  on(event: 'connect' | 'disconnect' | 'accountChanged', callback: Function): void;
}
```

### SDK Methods

```typescript
class P01SDK {
  // Wallet
  connect(): Promise<WalletInfo>
  disconnect(): Promise<void>
  getBalance(): Promise<number>

  // Payments
  requestPayment(params: PaymentParams): Promise<string>

  // Streams
  createStream(params: StreamParams): Promise<StreamInfo>
  getStreams(): Promise<StreamInfo[]>
  cancelStream(id: string): Promise<string>

  // Privacy
  generateStealthAddress(): Promise<string>
  scanStealthPayments(): Promise<Payment[]>
}
```

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development Flow

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Write tests
5. Submit a pull request

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Links

- Website: [protocol01.xyz](https://protocol01.xyz)
- Documentation: [docs.protocol01.xyz](https://docs.protocol01.xyz)
- Twitter: [@protocol01](https://twitter.com/protocol01)
- Discord: [discord.gg/protocol01](https://discord.gg/protocol01)

---

<p align="center">
  <strong>Built on Solana</strong>
</p>
