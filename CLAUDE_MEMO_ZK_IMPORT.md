# Protocol 01 - Recent Changes

## P2P Subscriptions (Streaming Payments)

### Features
- **P2P Focused**: No predefined services (Netflix, Spotify removed)
- **Immediate First Payment**: Payment executes on creation, no "Pay Now" button
- **Commitment Model**: Amount cannot be edited after creation
- **Auto Privacy**: Random noise applied automatically (5-15% amount, 1-6h timing)

### Flow
1. User enters: name, recipient address, amount, interval
2. Click "Start & Pay Now"
3. First payment sent immediately
4. Future payments handled by background scheduler

### Key Files
- `apps/extension/src/popup/pages/CreateSubscription.tsx`
- `apps/extension/src/popup/pages/SubscriptionDetails.tsx`
- `apps/extension/src/shared/services/stream.ts`

### Bug Fixes
- Fixed double interval bug (weekly showing 14 days instead of 7)
- Removed stealth addresses from subscriptions (not useful for P2P)
- Removed scan buttons from desktop extension

---

## ZK Shielded Transfers

### Status: WORKING

All ZK shielded transfer features are functional:
- **Shield** - Deposit SOL into shielded pool
- **Transfer** - Private transfer with note export/import (p01note format)
- **Unshield** - Withdraw from shielded pool

### Note Import/Export
Recipients must import the note to access funds:
- Copy note data or download as file
- Use "Import Note" on ShieldedWallet page
- p01note format: `p01note:1:base64data`

### Key Files
- `apps/extension/src/popup/pages/ShieldedTransfer.tsx`
- `apps/extension/src/popup/pages/ShieldedWallet.tsx`
- `apps/extension/src/shared/services/zk.ts`
- `apps/mobile/services/zk/index.ts`

### Bug Fixes Applied
1. Missing `verification_key_data` account (Error 3005)
2. Wrong merkle root sent (Error 6002)
3. Poseidon syscall panic - using `insert_with_root()`
4. Cross-platform note format compatibility
