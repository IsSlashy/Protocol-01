# X thread — 3 private subscription modes (benchmark + license + ZK/PQ)

## Tweet 1 (hook + image: showcase-3modes.png)

Subscribe to anything on Solana without the chain revealing who you pay, what you pay for, or how much.

Same subscription, three privacy modes, all finalized on devnet right now:

Classic, a normal transfer, fully public.
Stealth, an encrypted relay job, merchant and amount never touch the chain.
ZK Pool, same privacy, and the funds come from a shielded pool.

Open any signature below in an explorer and verify it yourself.

## Tweet 2 (license delivery)

So how do you actually get access after paying privately? No login, no email, no database of who subscribed.

The moment you pay, your license key is derived from your on-chain subscription state, locally: P01-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.

The merchant verifies it by re-deriving the exact same key from the chain and matching. They confirm you paid, without ever learning your wallet, and without storing a single subscriber identity anywhere.

Different service, different key. Two of your keys can never be linked back to the same person.

## Tweet 3 (why ZK + post-quantum)

Why zero-knowledge and post-quantum?

Zero-knowledge means you prove a payment is valid without revealing the amount, the merchant, or your identity. Privacy you can verify, not privacy you have to trust.

Post-quantum means the proofs are hash-based STARKs and the stealth encryption is ML-KEM-768. There are no elliptic curves to break. A quantum computer that cracks today's wallets still cannot retroactively unmask these payments.

That last point is the one people miss: anything captured on-chain today stays private later. Harvest-now-decrypt-later does not work against this.

## Tweet 4 (CTA)

All of this runs today on devnet. Built solo since January.

Privacy you can verify, not privacy you have to trust.

protocol-01.dev

## Explorer links (drop under Tweet 1)

Classic:  https://explorer.solana.com/tx/3ZetRSsUTX51gp5NRdGt8FXQVmMJVPAAoMY2kL3HfD5jrcTdLvhqbm1bCGvN1WRC2J31AKkXJGbfs7726FT5wji?cluster=devnet
Stealth:  https://explorer.solana.com/tx/42pzrXXGWrZnGuneSqFNXuXe2Ep3SpaiagiZL1kSiuvitQK9gYTMSFAx4PiM9pEtSpH2ETjvdTAdQRaxG615RfXd?cluster=devnet
ZK Pool:  https://explorer.solana.com/tx/4eREn4kJaf1aCrdbBh1xcdPqqMzDA8oV4cADNtKFtVm9EDns7bdCBBAwbQqo5GEgQ2oL9ZTvAusVRhGVEVFtDeGY?cluster=devnet
