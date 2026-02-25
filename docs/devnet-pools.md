# Devnet Denominated Pools

> Program: `zk_shielded` (GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c)
> Authority: `7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU`
> Epoch delay: 1 epoch (~1 hour)
> Created: 2026-02-25

---

## Native SOL Pools

Token mint: `11111111111111111111111111111111` (SystemProgram)

| Denomination | Lamports | Pool PDA | Tree PDA | Status |
|-------------|----------|----------|----------|--------|
| 0.1 SOL | 100,000,000 | `JDVrKu9cKZMKaxxVeC8QUBRTnkC81LcbNHFDcrbyZ2iv` | `FGrmPausuBJTV7V2VS2XjpfwGHYrUt79t5E3e3EvjrZ5` | ACTIVE |
| 1 SOL | 1,000,000,000 | `BoCTorE7dDyFTaK4oCEw8K3w7F6FxrKCSqbAGVv4cxXL` | `JCRDNgcXieJmjazUnAxo81SsqPQ2XcF38wvgfpjYgSco` | ACTIVE |
| 10 SOL | 10,000,000,000 | `2ZTWWSjnzAjEXxeK5PXF5hjvxixqTnnFyZt7Dd4vfFDJ` | `Ha3Ls6adGbJzEwqLcF4Y7x3T7vLtVyFhtc1aCas5C5GT` | ACTIVE |
| 100 SOL | 100,000,000,000 | `4t5nFqX9Xw1Bcv9kp2RQJF4vC8xPnbNZPViZjFWA9KQa` | `5bGshmezFLkUDZgex5xQEEiXaKaHHo7Xxnum9qumeQyJ` | ACTIVE |

## USDC Pools

Token mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals)

| Denomination | Atomic | Pool PDA | Tree PDA | Vault ATA | Status |
|-------------|--------|----------|----------|-----------|--------|
| 1 USDC | 1,000,000 | `GH2MCghPgZBqHoHaSqGpzQTwY9gw7V1cwMkd67ofp3w6` | `29Zc9jqVoEtKKmhV769dWZBj957U95pxJpyWDkbLsTb3` | `8QKdMJbSukL8fkHjU3xw8kFU9jZryPQmXmfvHEpZjTKa` | ACTIVE |
| 10 USDC | 10,000,000 | `zmaKYBQFpRkan5UrKrCxAjw1oDrtiu7X2AMGue843Kp` | `4bv2gyfdMTi46fjmU5ccSk21bW2cEr6NKQyH3NAxosdh` | `4EuSghk6zWzkLqzmxugTmEpchxYKyNmqZ8xBytzvgGsm` | ACTIVE |
| 100 USDC | 100,000,000 | `BixDeows6MrqXpxH9RZghnQi4ZihzevFagcq9HvW4sVS` | `2JSzffuT8f3dUZBEcZrMungLqmHFS21kZSRbdQ6tBbuT` | `Hybuu8qYN1HJ9Gk6gkJftGXjGQdiY1DFSrxUXm2k2BUY` | ACTIVE |
| 1000 USDC | 1,000,000,000 | `Dq7CHfsasR7VU3cVgDsyGnWmwBH3LtT4gTBBHEMDHvFF` | `EAicVNr5qitSzP7Dc1Z7DZUzV3Pidoqt21Lk7fBWfmtn` | `GmiMpZfWSUKsvvJeirZSnYuhcvkbs2GfrN1jfCDmxE2H` | ACTIVE |

## Verification

Shield test (0.1 SOL pool):
```
Tx: 4Lvsb76MENwVToghjnbMHmiTUuR77QytuMQ22aGXzf644NVSpX4KWL2Z1hD59QVSNBxg9PtP6eU814gQG2uFy9Jr
Leaf count: 0 -> 1
```

## Setup Scripts

| Script | Token | Command |
|--------|-------|---------|
| `scripts/setup-sol-denominated-pools.mjs` | SOL | `node scripts/setup-sol-denominated-pools.mjs` |
| `scripts/setup-usdc-denominated-pools.mjs` | USDC | `node scripts/setup-usdc-denominated-pools.mjs` |
| `scripts/test-shield-denominated.mjs` | SOL (0.1) | `node scripts/test-shield-denominated.mjs` |

All scripts support `--dry-run` flag for testing without sending transactions.

## Notes

- SOL pools hold SOL directly in the pool PDA (no vault ATA needed)
- USDC pools use Associated Token Accounts (ATAs) as vaults, owned by the pool PDA
- VK hash computed with SHA-256 fallback (js-sha3 not resolving via ESM import — does not affect pool functionality, only VK verification on-chain)
- Epoch delay = 1 means notes must age at least 1 epoch (~1 hour / 7200 slots) before withdrawal
- Tree depth 15 = max 32,768 notes per pool
