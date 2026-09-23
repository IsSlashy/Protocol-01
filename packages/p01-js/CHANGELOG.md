# Changelog

All notable changes to the `p-01` SDK will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased] — ships as 0.4.0

### Removed (breaking)

- **The `shielded-pool` module.** `shield`, `unshield`, `getPoolInfo`, `getPools`, `validateShieldParams`, `validateUnshieldParams`, `resolveTokenMintForPool`, `computeCommitmentPlaceholder`, `estimateDelayTier`, `isValidDenomination` and the constants `ZK_SHIELDED_PROGRAM_ID`, `STANDARD_DENOMINATIONS`, `MERKLE_TREE_DEPTH`, `MAX_LEAVES`, `DELAY_TIERS`, plus the types `ShieldParams`, `UnshieldParams` and `PoolInfo`. Its `ZK_SHIELDED_PROGRAM_ID` was `EqppogLB…`, the old zkSPL program, not the pool; `shield()` returned a locally built placeholder receipt and sent nothing; `unshield`, `getPoolInfo` and `getPools` always threw. The pool id `GbVM5y…` stays exported as `VAULT_PROGRAM_ID`.
- `ShieldReceipt` stays exported (it moved to `types.ts`): `PrivateStream`, `PrivateSubscription` and the receipt-manager helpers carry it.
- The optional peer dependency on `@protocol-01/privacy-sdk` (nothing imported it).

### Fixed (audit v1, not yet on npm: 0.3.2 still has the old behaviour)

- **Pedersen generator `H`** (F76): RFC 9380 hash-to-curve under `PEDERSEN_H_DST` instead of `h·G` with a public `h`, which made every commitment openable to any value. Old commitments do not verify against the new `H`. A commitment to the value 0 no longer throws.
- **Stealth recipients** (F77): `PrivateStream` records `stealthTicks` (address, ephemeral public key, view tag) and passes the stealth data to `executeUnshield` as a third argument; before, it discarded the ephemeral key and no stealth tick could be spent. `scanIncomingPayments` returns the payment `address`; new `SecurityManager.signStealthPayment` and `stealthAddressFromPrivateKey`.

## [0.2.0] - 2026-04-27

### Changed

- **Repositioned as the merchant entry-point.** `p01-js` is now the dedicated drop-in surface for retailers (pay buttons, subscription widgets, webhook helpers). The full privacy stack lives in `@protocol-01/privacy-sdk`; both packages can be used together.
- Removed the runtime deprecation warning emitted by `import '@protocol-01/p01-js'`.

### Notes

- The internal `RelayerClient` (centralized HTTP relayer) remains marked `@deprecated` at the symbol level — prefer `@protocol-01/specter-sdk` for on-chain relay via the `p01_relayer` program.

## [0.1.0] - 2026-01-31

### Added

- **Core SDK** (`Protocol01` class) with wallet connection, one-time payments, and subscription management.
- **Stream Secure subscriptions** with configurable intervals (weekly, monthly, quarterly, yearly) and privacy options.
- **React components**: `P01Provider`, `WalletButton`, `PaymentButton`, `SubscriptionButton`, `SubscriptionWidget`, and `SubscriptionCard`.
- **Service Registry** with 60+ known services across streaming, music, AI, gaming, SaaS, news, fitness, VPN, cloud, and education categories.
- **Security module** with stealth addresses (DKSAP), end-to-end encryption, and confidential transactions built on `@noble/curves`, `@noble/hashes`, and `@noble/ciphers`.
- **Utility functions** for token resolution, amount formatting, interval handling, and merchant config validation.
- **Privacy-first design**: optional amount noise, timing noise, and stealth address generation for subscriber privacy.
- Dual CJS/ESM build output with full TypeScript declarations.
- Storybook integration for visual component development.

[0.1.0]: https://github.com/IsSlashy/protocol-01/releases/tag/p-01-v0.1.0
