# Protocol 01 Features

## Payment Streams (Streams)

The flagship feature of Protocol 01 - programmable recurring payments on Solana.

### What Are Payment Streams?

Payment streams enable automated, recurring payments without requiring manual approval for each transaction. Think subscriptions, but on-chain and fully transparent.

### How It Works

```
┌─────────┐     Create Stream      ┌──────────────┐
│  User   │ ───────────────────► │ Smart Contract │
└─────────┘                       └──────────────┘
     │                                    │
     │ Authorize funds                    │
     ▼                                    ▼
┌─────────┐                       ┌──────────────┐
│ Wallet  │ ◄───────────────────  │   Merchant   │
└─────────┘     Claim payments    └──────────────┘
```

1. **User Creates Stream**: Specifies recipient, amount, interval, and duration
2. **Funds Authorized**: User pre-authorizes total expected payments
3. **Merchant Claims**: At each interval, merchant can claim payment
4. **User Control**: Can cancel anytime, remaining funds returned

### Stream Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| Recipient | Merchant wallet address | `ABC123...` |
| Amount | Payment per interval | `9.99` |
| Token | SOL or SPL token | `USDC` |
| Interval | Payment frequency | `monthly` |
| Max Payments | Total payments (optional) | `12` |
| Start Date | When to begin | `2025-02-01` |

### Use Cases

**SaaS Subscriptions**
- Monthly software access
- Automatic renewal
- No payment failures

**Content Memberships**
- Patreon-style support
- Tiered access levels
- Creator economy

**Rent & Utilities**
- Automated rent payments
- Utility subscriptions
- Property management

**Salary Streaming**
- Real-time compensation
- Freelancer payments
- Contractor billing

**DCA (Dollar Cost Averaging)**
- Automated investing
- Regular token purchases
- Portfolio building

### Stream States

- `active`: Stream is running, payments can be claimed
- `paused`: Temporarily stopped, can be resumed
- `cancelled`: Terminated by user, funds returned
- `completed`: All payments made, stream ended

---

## Stealth Addresses (Privacy Zone)

Advanced privacy for confidential transactions.

### The Problem

Standard blockchain transactions are fully transparent:
- Anyone can see your balance
- Transaction history is public
- Addresses can be linked to identity

### The Solution: Stealth Addresses

Stealth addresses are one-time addresses generated for each transaction:

```
Sender                          Receiver
  │                                │
  │   Generate stealth address     │
  │ ────────────────────────────►  │
  │                                │
  │   Send to stealth address      │
  │ ────────────────────────────►  │
  │                                │
  │   (Cannot link to receiver)    │
  │                                │
```

### How It Works

1. **Receiver Publishes Spend Key**: A public key for generating stealth addresses
2. **Sender Generates Address**: Creates unique one-time address
3. **Payment Sent**: Funds go to stealth address
4. **Receiver Scans**: Uses private key to detect and claim

### Privacy Score

Protocol 01 calculates a privacy score based on:
- Address reuse frequency
- Transaction patterns
- Stealth address usage
- Balance exposure

**Recommendations:**
- Use stealth addresses for receiving
- Consolidate small UTXOs
- Avoid round amounts
- Use multiple addresses

---

## AI Assistant (Agent)

Integrated AI for natural language wallet operations.

### Capabilities

**Balance Queries**
```
"What's my balance?"
"How much SOL do I have?"
"Show my tokens"
```

**Transaction Requests**
```
"Send 0.5 SOL to alice.sol"
"Pay 10 USDC to merchant"
"Transfer all SOL to savings"
```

**Information**
```
"What was my last transaction?"
"Show my subscription status"
"Explain this transaction"
```

**Recommendations**
```
"Should I stake my SOL?"
"Best DeFi yields right now"
"Optimize my portfolio"
```

### Architecture

```
User Input ──► NLP Processing ──► Intent Detection ──► Action Execution
                                         │
                                         ▼
                                  Confirmation ◄── Safety Checks
```

### Safety Features

- Confirmation required for transactions
- Spending limits
- Suspicious activity detection
- No private key access

---

## Mesh Networking (Mobile)

Peer-to-peer discovery and communication for nearby users.

### How It Works

Using Bluetooth Low Energy (BLE):

1. **Discovery**: Devices broadcast presence
2. **Connection**: Direct peer-to-peer link
3. **Exchange**: Share contact info, payment requests
4. **Offline**: Works without internet

### Features

**Nearby Discovery**
- Find P-01 users nearby
- See anonymous aliases
- Request connection

**Contact Exchange**
- Tap to share contact
- QR code backup
- Stealth address sharing

**Payment Requests**
- Send request to nearby user
- Instant notification
- One-tap payment

### Privacy

- Anonymous aliases (not real names)
- Optional visibility
- No location tracking
- Encrypted communication

---

## dApp Integration

Seamless connection to Solana applications.

### Wallet Standard

Protocol 01 follows Solana's Wallet Standard:
- Automatic detection by dApps
- Consistent user experience
- Permission management

### Connection Flow

```
dApp                     Extension                    User
  │                          │                          │
  │   Request connection     │                          │
  │ ─────────────────────►   │                          │
  │                          │   Show permission popup  │
  │                          │ ────────────────────────►│
  │                          │                          │
  │                          │   Approve/Reject         │
  │                          │ ◄────────────────────────│
  │   Connection result      │                          │
  │ ◄─────────────────────   │                          │
```

### Permissions

| Permission | Description |
|------------|-------------|
| `viewBalance` | See wallet balance |
| `requestTransaction` | Request transaction signing |
| `requestSubscription` | Create payment streams |
| `viewStealthAddress` | Generate stealth addresses |

### Security

- Per-site permissions
- Transaction simulation
- Revoke access anytime
- Clear permission history

---

## Real-Time Pricing

Live price tracking from CoinGecko.

### Features

- SOL/USD price
- Token prices
- Portfolio valuation
- Historical charts (planned)

### Integration

```typescript
// Price updates every 60 seconds
const price = await getSolPrice(); // $133.13
const value = balance * price; // 1 SOL = $133.13
```

### Supported Currencies

- USD (default)
- EUR
- GBP
- More planned

---

## Security Features

### Encryption

| Component | Algorithm |
|-----------|-----------|
| Seed phrase | AES-256-GCM |
| Key derivation | PBKDF2 (100k iterations) |
| Random IV | Crypto.getRandomValues |

### Authentication

- Password required for sensitive ops
- Biometric support (mobile)
- Auto-lock after inactivity
- Rate limiting on failed attempts

### Key Management

- Keys never leave device
- No external storage
- Memory cleared after use
- Secure enclave (mobile)

---

## Network Support

### Mainnet
- Production network
- Real transactions
- Full feature support

### Devnet
- Testing environment
- Free faucet
- Development mode
- No real value

### Testnet
- Validator testing
- Network upgrades
- Planned support
