# Protocol 01 — Blind Auction with Shielded Pool Escrow

## Overview

Protocol 01's Blind Auction system combines Arcium MPC encrypted bid accumulation with a ZK shielded pool escrow layer, enabling sealed-bid auctions where:

- Bid amounts are **never visible** to anyone — not bidders, not the auctioneer, not validators
- Settlement is **automatic and enforced** — winners pay, losers are refunded, no manual action required
- Bidder identity is **unlinkable** — bids are identified by nullifiers, not wallet addresses
- **No one can cheat** — the circuit, the MPC, and the on-chain program enforce outcomes independently

This goes beyond a standard blind auction. Most implementations reveal the winner and expect voluntary payment. Protocol 01 locks bids into escrow *before* the auction starts, so settlement is trustless and permissionless.

## How Arcium Is Used

### MPC Bid Accumulation (`sealed_bid_auction`)

Bidders encrypt their bid amount + escrow nullifier using Arcium's x25519 key exchange with the MXE. The encrypted bid is submitted to the `sealed_bid_auction` circuit, which runs across Arcium's ARX node cluster via threshold MPC.

```rust
#[instruction]
pub fn sealed_bid_auction(
    bid: Enc<Shared, SealedBidInput>,
    accumulator: Enc<Mxe, AuctionAccumulator>,
) -> Enc<Mxe, AuctionAccumulator> {
    let b = bid.to_arcis();
    let mut acc = accumulator.to_arcis();

    // Constant-time conditional update (MPC-safe)
    let is_higher: u64 = if b.bid_amount > acc.highest_bid { 1 } else { 0 };
    let is_not: u64 = 1 - is_higher;

    acc.highest_bid = is_higher * b.bid_amount + is_not * acc.highest_bid;
    // ... update winner nullifier chunks
    acc.bid_count = acc.bid_count + 1;

    Mxe::get().from_arcis(acc)
}
```

The accumulator persists in MXE-encrypted state between calls. No single ARX node ever sees a plaintext bid.

### MPC Result Revelation (`finalize_auction`)

After the bidding deadline, the authority calls `finalize_auction`. The MPC circuit reveals only the winning nullifier and winning bid amount. All losing bid amounts remain permanently hidden.

```rust
#[instruction]
pub fn finalize_auction(accumulator: Enc<Mxe, AuctionAccumulator>) -> AuctionAccumulator {
    let acc = accumulator.to_arcis();
    AuctionAccumulator {
        highest_bid: acc.highest_bid.reveal(),
        winner_null_0: acc.winner_null_0.reveal(),
        // ...
        bid_count: acc.bid_count.reveal(),
    }
}
```

The callback writes the winner to the on-chain `Auction` PDA, which triggers the escrow settlement flow.

## Privacy Benefits

| Property | How It's Achieved |
|---|---|
| **Bid confidentiality** | Arcium MPC — bids encrypted with x25519, computed in threshold secret-shares |
| **Bidder anonymity** | ZK nullifiers — bids linked to escrow notes, not wallet addresses |
| **Payment privacy** | Shielded pool — funds move through a Tornado Cash-style denominated pool |
| **Anti-collusion** | MXE encrypted state — no single party can see bid distribution |
| **MEV resistance** | Encrypted bids on-chain — validators cannot front-run or sandwich |
| **Settlement integrity** | Groth16 ZK-SNARK — escrow commitments verified by the circuit |

## Architecture

```
BIDDING PHASE (private):
  Bidder → shield note into denominated pool
        → escrow_shield (Groth16 proof: locks note, stores pay + refund commitments)
        → sealed_bid_auction (Arcium MPC: encrypted bid accumulation)

SETTLEMENT PHASE (permissionless):
  Authority → finalize_auction (MPC reveals winner nullifier)
  Cranker   → write_escrow_outcome (reads Auction PDA, writes win/lose to each escrow)
  Cranker   → escrow_release (inserts correct commitment into Merkle tree)

POST-SETTLEMENT:
  Winner's note → seller can unshield
  Losers' notes → bidders can unshield (refund)
```

### Components

**ZK Circuit — `escrow_bid.circom`**
- 4,954 constraints, Groth16 over BN254
- 7 public inputs: merkle_root, nullifier, min_epoch, token_mint, auction_id, pay_commitment, refund_commitment
- Proves: note ownership, Merkle membership, maturity, commitment correctness, auction binding
- Anti-replay: auction_id prevents cross-auction proof reuse

**Arcium MPC Circuits — `encrypted-ixs`**
- `sealed_bid_auction`: Accumulates encrypted bids with constant-time comparison
- `finalize_auction`: Reveals only winning nullifier + amount

**On-Chain Programs**
- `zk_shielded` (Anchor): `escrow_shield`, `escrow_release`, `write_escrow_outcome`
- `p01_arcium` (Anchor + Arcium macros): `create_auction`, `sealed_bid_auction`, `finalize_auction` + callbacks

**SDK — `@protocol-01/arcium-sdk`**
- `createAuction()`, `submitSealedBid()`, `finalizeAuction()`
- `writeEscrowOutcome()`, `releaseEscrow()`
- `nullifierToChunks()` / `chunksToNullifier()` for MPC encoding

## What Makes This Different

Most blind auction implementations stop at the MPC layer — they determine the winner but don't enforce payment. The winner's wallet is revealed, and someone has to manually send funds. This creates two problems:

1. **No enforcement** — the winner can refuse to pay
2. **Privacy leak** — the winner's identity is revealed to everyone

Protocol 01 solves both:

**Escrow before auction**: When a bidder places a bid, their funds are already locked in the shielded pool via `escrow_shield`. The ZK proof pre-authorizes two outcomes — pay the seller OR refund the bidder. The bidder cannot choose which outcome activates.

**Nullifier-based identity**: The MPC identifies the winner by their escrow nullifier, not their wallet address. The nullifier is cryptographically unlinkable to the bidder's identity. Only the bidder knows which nullifier is theirs.

**Permissionless settlement**: After the MPC reveals the winner, anyone can crank `write_escrow_outcome` and `escrow_release`. No cooperation from bidders or the auctioneer is needed. The correct commitment (pay or refund) is inserted into the Merkle tree automatically.

## Technical Stack

- **Solana** — Anchor 0.32.1, deployed on devnet
- **Arcium** — MXE encrypted state, ARX cluster (offset 456), x25519 + Rescue cipher
- **ZK** — Circom 2.2.2, snarkjs 0.7.5, Groth16 over BN254, Poseidon hashing
- **Merkle Tree** — Depth 15 (32K notes per pool), on-chain state
- **Nullifier System** — PDA-based double-spend prevention

## Repository

GitHub: [Protocol-01](https://github.com/SlashyFx/Protocol-01) (open source)

Key files:
- `circuits/escrow_bid.circom` — ZK escrow circuit
- `programs/p01_arcium/encrypted-ixs/src/lib.rs` — MPC auction circuits
- `programs/p01_arcium/src/lib.rs` — Auction program (create, bid, finalize, callback)
- `programs/zk_shielded/src/instructions/escrow_shield.rs` — Escrow lock
- `programs/zk_shielded/src/instructions/escrow_release.rs` — Escrow release
- `programs/zk_shielded/src/instructions/write_escrow_outcome.rs` — Outcome bridge
- `packages/arcium-sdk/src/auction/index.ts` — TypeScript SDK
- `tests/sealed-bid-auction.test.ts` — Integration tests

## Devnet Program IDs

- **p01_arcium**: `FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT`
- **zk_shielded**: `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`
